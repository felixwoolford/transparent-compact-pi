import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Settings } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SelectItem } from "@earendil-works/pi-tui";
import { capBudgetText, DEFAULT_PREFERENCES, parseCapBudget, PREFERENCE_KEYS, preferenceState, recoveryLocked,
  SETTINGS_ENTRY, validCapBudget, validPreference } from "./config.js";
import type { Preferences, PreferenceKey, PreferencePatch } from "./config.js";

type Scope = "session" | "project" | "global";
export interface SettingsChoice { changes: PreferencePatch; scope: Scope }
export interface SettingSourceLayer { label: string; values: Readonly<Preferences> }
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f]/g, " ");
const same = (a: unknown, b: unknown) => a === b ||
  (validCapBudget(a) && validCapBudget(b) && a.unit === b.unit && a.value === b.value);
const labels: Record<PreferenceKey, string> = {
  compactionMethod: "Compaction method", capMode: "Cap mode", capBudget: "Cap budget",
  lookupModel: "Lookup model", lookupTurns: "Lookup search turns", lookupMaxCalls: "Consecutive lookups", mainAgentLookup: "Recovery mode",
};
const descriptions: Record<PreferenceKey, string> = {
  compactionMethod: "Summary uses Pi's original compaction, effectively disabling transparent-compact. Context pruning is incompatible; context_lookup remains available but may be used less effectively.",
  capMode: "Warn asks before trimming; on trims automatically; off disables the verbatim cap.",
  capBudget: "Enter a percentage, characters (c), or estimated tokens (t), e.g. 25%, 80000c, 20000t. Tokens use 4 characters each.",
  lookupModel: "Choose from Pi's scoped models, or use the session model. With no model scope configured, all available models are listed.",
  lookupTurns: "Positive integer: maximum substantive search turns per subagent lookup. Continuation pages have a separate ceiling.",
  lookupMaxCalls: "Non-negative integer: consecutive subagent lookup limit. Zero means unlimited.",
  mainAgentLookup: "Subagent searches in a separate context; direct recovery exposes history tools to the main agent. Direct mode is experimental.",
};
export function settingText(key: PreferenceKey, value: Preferences[PreferenceKey]): string {
  if (key === "capBudget") return capBudgetText(value as Preferences["capBudget"]);
  if (key === "compactionMethod" && value === "summary") return "summary (Pi original)";
  if (key === "mainAgentLookup") return value ? "direct (experimental)" : "subagent";
  if (typeof value === "boolean") return value ? "on" : "off";
  return key === "lookupModel" && !value ? "session model" : String(value);
}

/** Candidate values at each persistent scope, before any session overrides. */
export function settingSourceLayers(globalSettings: unknown, projectSettings: unknown, env: Record<string, string | undefined> = process.env): SettingSourceLayer[] {
  const scoped = (settings: unknown): Partial<Settings> => ({
    transparentCompact: settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).transparentCompact : undefined,
  } as Partial<Settings>);
  const merged = SettingsManager.inMemory(scoped(globalSettings));
  const global = preferenceState(merged.getSettings(), [], {}).values;
  // Use Pi's merge semantics, including nulls masking inherited cap units.
  merged.applyOverrides(scoped(projectSettings));
  const project = preferenceState(merged.getSettings(), [], {}).values;
  const environment = preferenceState(merged.getSettings(), [], env).values;
  return [
    { label: "global setting", values: global },
    { label: "project setting", values: project },
    { label: "environment setting", values: environment },
  ];
}

export function settingBadge(key: PreferenceKey, value: Preferences[PreferenceKey], layers: readonly SettingSourceLayer[]): string {
  const matches = (candidate: Preferences[PreferenceKey]) => same(value, candidate) ||
    (validCapBudget(value) && validCapBudget(candidate) && value.unit !== "percent" && candidate.unit !== "percent" &&
      value.value * (value.unit === "tokens" ? 4 : 1) === candidate.value * (candidate.unit === "tokens" ? 4 : 1));
  if (matches(DEFAULT_PREFERENCES[key])) return "default";
  return layers.find((layer) => matches(layer.values[key]))?.label ?? "session setting";
}

/** Read only for badges; effective behavior still comes from pi.getSettings(). */
export function readSettingSourceLayers(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, agentDir = getAgentDir(), env: Record<string, string | undefined> = process.env): SettingSourceLayer[] {
  const read = (filename: string): unknown => {
    try {
      const value = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; } // Missing/unreadable/invalid files cannot supply badge matches.
  };
  return settingSourceLayers(read(path.join(agentDir, "settings.json")),
    ctx.isProjectTrusted() ? read(path.join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")) : {}, env);
}

/** Read-merge-write inside Pi's file queue; never replace malformed configuration. */
export async function savePreferences(cwd: string, scope: "project" | "global", changes: PreferencePatch, agentDir = getAgentDir()): Promise<string> {
  const filename = path.join(scope === "global" ? agentDir : path.join(cwd, CONFIG_DIR_NAME), "settings.json");
  await withFileMutationQueue(filename, async () => {
    let settings: Record<string, any> = {};
    try { settings = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const object = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
    if (!object(settings) || (settings.transparentCompact !== undefined && !object(settings.transparentCompact)))
      throw new Error("Settings and transparentCompact must be JSON objects; the file was not changed.");
    const config = { ...settings.transparentCompact };
    for (const key of PREFERENCE_KEYS) {
      if (!(key in changes)) continue;
      const value = changes[key];
      if (value !== null && !validPreference(key, value)) throw new Error(`Invalid ${key}; the file was not changed.`);
      const remove = value === null || (scope === "global" && same(value, DEFAULT_PREFERENCES[key]));
      if (key === "capBudget") {
        if (remove) { delete config.maxSummaryChars; delete config.maxSummaryPercent; }
        else {
          const budget = value as Preferences["capBudget"];
          // Null masks an inherited alternative unit in Pi's deep-merged settings.
          config.maxSummaryChars = budget.unit === "percent" ? null : budget.value * (budget.unit === "tokens" ? 4 : 1);
          config.maxSummaryPercent = budget.unit === "percent" ? budget.value : null;
        }
      } else if (remove) delete config[key];
      else config[key] = value;
    }
    if (scope === "global" && Object.keys(config).length === 0) delete settings.transparentCompact;
    else settings.transparentCompact = config;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    // Synchronous read/merge/write preserves symlinks and existing permissions.
    fs.writeFileSync(filename, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  });
  return filename;
}

export function lookupModelItems(ctx: Pick<ExtensionContext, "scopedModels" | "modelRegistry" | "model">): SelectItem[] {
  const models = ctx.scopedModels.length ? ctx.scopedModels.map((item) => item.model) : ctx.modelRegistry.getAvailable();
  const seen = new Set<string>();
  return [{ value: "", label: "Use session model", description: ctx.model
    ? clean(`Default; follows ${ctx.model.provider}/${ctx.model.id}`) : "Default; follows the session model" },
    ...[...models].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)).flatMap((model) => {
      const value = `${model.provider}/${model.id}`;
      if (seen.has(value)) return [];
      seen.add(value);
      return [{ value, label: clean(`${model.id} [${model.provider}]`), description: clean(model.name ?? "") }];
    })];
}

/** Local draft only. Enter reviews; a second Enter applies the selected scope. */
export async function pickSettings(ctx: ExtensionContext, state: ReturnType<typeof preferenceState>, locked: boolean,
  layers: readonly SettingSourceLayer[] = []): Promise<SettingsChoice | undefined> {
  return ctx.ui.custom<SettingsChoice | undefined>((tui, theme, kb, done) => {
    const changes: Partial<Preferences> = {};
    let cursor = 0, top = 0, review = false, reviewTop = 0, scopeIndex = 0, notice = "", editing: PreferenceKey | undefined;
    let input: Input | undefined, focused = true, finished = false;
    let modelItems: SelectItem[] = [], modelMatches: SelectItem[] = [], modelList: SelectList | undefined, modelRows = 1;
    const scopes: Scope[] = ["session", "project", "global"];
    const scopeLabels = ["Apply to this session", "Apply and save project defaults", "Apply and save global defaults"];
    const value = (key: PreferenceKey) => changes[key] ?? state.values[key];
    const edit = (key: PreferenceKey, next: Preferences[PreferenceKey]) => {
      if (same(next, state.values[key])) delete changes[key]; else Object.assign(changes, { [key]: next });
      notice = "";
    };
    const closeEditor = () => { editing = undefined; input = undefined; modelList = undefined; notice = ""; };
    const buildModelList = (selectedValue: string | undefined) => {
      const query = input!.getValue();
      modelMatches = query ? fuzzyFilter(modelItems, query, (item) => `${item.value} ${item.label} ${item.description ?? ""}`) : modelItems;
      modelList = new SelectList(modelMatches, modelRows, {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.bg("selectedBg", theme.fg("accent", text)),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: () => theme.fg("muted", "No matching models"),
      });
      modelList.setSelectedIndex(Math.max(0, modelMatches.findIndex((item) => item.value === selectedValue)));
      modelList.onSelect = (item) => { edit("lookupModel", item.value); closeEditor(); };
      modelList.onCancel = closeEditor;
    };
    const beginEdit = () => {
      const key = PREFERENCE_KEYS[cursor], current = value(key);
      if (key === "compactionMethod") edit(key, current === "verbatim" ? "summary" : "verbatim");
      else if (key === "capMode") { const modes = ["warn", "on", "off"] as const; edit(key, modes[(modes.indexOf(current as any) + 1) % modes.length]); }
      else if (typeof current === "boolean") edit(key, !current);
      else if (key === "lookupModel") {
        modelItems = lookupModelItems(ctx);
        editing = key; input = new Input({ prompt: "Search: " }); input.focused = focused;
        input.onEscape = closeEditor;
        modelRows = Math.max(1, tui.terminal.rows - 9);
        buildModelList(String(current));
      } else {
        editing = key; input = new Input(); input.focused = focused;
        input.setValue(clean(settingText(key, current)));
        input.onSubmit = (raw) => {
          const next = key === "capBudget" ? parseCapBudget(raw) : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
          if (!validPreference(key, next)) { notice = "Invalid value. " + descriptions[key]; return; }
          edit(key, next!); closeEditor();
        };
        input.onEscape = closeEditor;
      }
    };
    const finish = (choice?: SettingsChoice) => { if (finished) return; finished = true; done(choice); };
    const render = (width: number): string[] => {
      const rows = Math.max(1, tui.terminal.rows), framed = width >= 8, inner = Math.max(1, width - (framed ? 4 : 0));
      const line = (text: string, selected = false) => {
        const clipped = truncateToWidth(text, inner), padded = clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
        const content = selected ? theme.bg("selectedBg", padded) : padded;
        return framed ? theme.fg("borderMuted", "│ ") + content + theme.fg("borderMuted", " │") : content;
      };
      const rule = (caption: string, end = false) => {
        if (!framed) return truncateToWidth(caption, width);
        const text = truncateToWidth(caption ? `─ ${caption} ` : "", Math.max(1, width - 2));
        return theme.fg("borderMuted", (end ? "╰" : "╭") + text + "─".repeat(Math.max(0, width - 2 - visibleWidth(text))) + (end ? "╯" : "╮"));
      };
      const out = [rule(theme.fg("accent", theme.bold(`Compaction settings · ${review ? "2/2 Review" : "1/2 Edit"}`)))];
      const room = rows >= 16;
      if (room) out.push(line(theme.fg("muted", "Changes stay in this draft until you confirm. d restores the built-in default.")));
      const footer = editing === "lookupModel" ? "↑/↓ Select · Type Search · Enter Choose · Esc Back" : editing ? "Enter Accept · Esc Back"
        : review ? "↑/↓ Scope · Enter Confirm · Esc Back" : "↑/↓ Move · Space/e Edit · d Reset · Enter Review · Esc Cancel";
      const footerLines = wrapTextWithAnsi(footer, inner);
      let content: string[];
      if (editing === "lookupModel") {
        out.push(line(theme.fg("accent", ctx.scopedModels.length ? "Lookup model · scoped models" : "Lookup model · available models")));
        if (room) out.push(line(theme.fg("muted", "Search by model, provider or name. Choosing a model only changes this draft.")));
        out.push(...input!.render(inner).map((part) => line(part)));
        const height = Math.max(1, rows - out.length - footerLines.length - 3);
        if (height !== modelRows) { modelRows = height; buildModelList(modelList?.getSelectedItem()?.value); }
        content = modelList!.render(Math.max(8, inner)).map((part) => line(part));
      } else if (editing) {
        out.push(line(theme.fg("accent", labels[editing])));
        for (const part of wrapTextWithAnsi(descriptions[editing], inner).slice(0, 3)) out.push(line(theme.fg("muted", part)));
        content = input!.render(inner).map((part) => line(part));
      } else if (review) {
        const keys = PREFERENCE_KEYS.filter((key) => key in changes);
        content = scopes.map((_scope, i) => line(`${i === scopeIndex ? "›" : " "} ${scopeLabels[i]}`, i === scopeIndex));
        const height = Math.max(1, rows - (room ? 11 : 8));
        reviewTop = Math.max(0, Math.min(reviewTop, keys.length - height));
        if (room) content.push(line(theme.fg("muted", `Changes ${reviewTop + 1}–${Math.min(keys.length, reviewTop + height)} / ${keys.length} · PgUp/PgDn scroll`)));
        content.push(...keys.slice(reviewTop, reviewTop + height).map((key) => line(clean(`${labels[key]}: ${settingText(key, state.values[key])} → ${settingText(key, value(key))}${locked && key === "mainAgentLookup" ? " (new sessions only)" : ""}`))));
        if (room) content.push(line(theme.fg("muted", "Only edited settings are saved. Project/environment defaults can mask global saves.")));
      } else {
        const height = Math.max(1, rows - (room ? 9 : 5));
        top = Math.max(0, Math.min(top, cursor));
        if (cursor >= top + height) top = cursor - height + 1;
        content = PREFERENCE_KEYS.slice(top, top + height).map((key, i) => {
          const source = settingBadge(key, value(key), layers);
          const label = key === "mainAgentLookup" && locked ? "Recovery default (next session)" : labels[key];
          return line(clean(`${top + i === cursor ? "›" : " "} ${label}: ${settingText(key, value(key))}  [${source}]${key in changes ? "*" : ""}`), top + i === cursor);
        });
        if (room) {
          content.push(line(""));
          const hint = PREFERENCE_KEYS[cursor] === "mainAgentLookup" && locked
            ? "Recovery mode is locked in this session. This row edits defaults for new sessions only." : descriptions[PREFERENCE_KEYS[cursor]];
          for (const part of wrapTextWithAnsi(hint, inner).slice(0, 2)) content.push(line(theme.fg("muted", clean(part))));
        }
      }
      const tail = [line(theme.fg(notice ? "warning" : "muted", clean(notice || (review ? "Session changes persist through resume and forks." : "All settings are optional. * Unsaved changes.")))),
        ...footerLines.map((part) => line(theme.fg("accent", part))), rule("", true)];
      out.push(...content.slice(0, Math.max(1, rows - out.length - tail.length)), ...tail);
      return out.map((part) => truncateToWidth(part, width)).slice(0, rows);
    };
    return {
      capturesViewportInput: true,
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; if (input) input.focused = value; },
      render,
      invalidate() { input?.invalidate(); modelList?.invalidate(); },
      handleInput(data: string) {
        if (finished) return;
        if (editing === "lookupModel") {
          const before = input!.getValue();
          if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some((action) => kb.matches(data, action))) modelList!.handleInput(data);
          else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
            const index = modelMatches.findIndex((item) => item.value === modelList!.getSelectedItem()?.value);
            modelList!.setSelectedIndex(index + (matchesKey(data, Key.pageUp) ? -modelRows : modelRows));
          } else input!.handleInput(data);
          if (editing === "lookupModel" && input!.getValue() !== before) buildModelList(undefined);
        } else if (editing) input!.handleInput(data);
        else if (kb.matches(data, "tui.select.cancel")) { if (review) { review = false; notice = ""; } else finish(); }
        else if (review) {
          if (kb.matches(data, "tui.select.up")) scopeIndex = Math.max(0, scopeIndex - 1);
          else if (kb.matches(data, "tui.select.down")) scopeIndex = Math.min(2, scopeIndex + 1);
          else if (matchesKey(data, Key.pageUp)) reviewTop = Math.max(0, reviewTop - 3);
          else if (matchesKey(data, Key.pageDown)) reviewTop += 3;
          else if (kb.matches(data, "tui.select.confirm")) {
            if (locked && "mainAgentLookup" in changes && scopes[scopeIndex] === "session") notice = "Recovery mode is locked; save project/global defaults for new sessions instead.";
            else finish({ changes, scope: scopes[scopeIndex] });
          }
        } else if (kb.matches(data, "tui.select.up")) cursor = Math.max(0, cursor - 1);
        else if (kb.matches(data, "tui.select.down")) cursor = Math.min(PREFERENCE_KEYS.length - 1, cursor + 1);
        else if (matchesKey(data, Key.home)) cursor = 0;
        else if (matchesKey(data, Key.end)) cursor = PREFERENCE_KEYS.length - 1;
        else if (matchesKey(data, Key.pageUp)) cursor = Math.max(0, cursor - 5);
        else if (matchesKey(data, Key.pageDown)) cursor = Math.min(PREFERENCE_KEYS.length - 1, cursor + 5);
        else if (matchesKey(data, "d")) {
          const key = PREFERENCE_KEYS[cursor];
          Object.assign(changes, { [key]: structuredClone(DEFAULT_PREFERENCES[key]) });
          notice = "";
        }
        else if (matchesKey(data, Key.space) || matchesKey(data, "e") || matchesKey(data, Key.right) || matchesKey(data, Key.left)) beginEdit();
        else if (kb.matches(data, "tui.select.confirm")) {
          if (!Object.keys(changes).length) notice = "No changes. Edit a setting, or Esc to close.";
          else { review = true; reviewTop = 0; scopeIndex = 0; notice = ""; }
        }
        tui.requestRender();
      },
      dispose() { finished = true; },
    };
  });
}

export function registerSettingsMenu(pi: ExtensionAPI, afterApply: (previous: Preferences, next: Preferences, ctx: ExtensionContext) => void): void {
  pi.registerCommand("compact-settings", {
    description: "Configure compaction and recovery; apply to session or save project/global defaults",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("Usage: /compact-settings", "error"); return; }
      if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("/compact-settings requires the interactive terminal UI.", "error"); return; }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("Wait until the agent is idle and queued messages have been handled before changing settings.", "warning"); return; }
      const sessionId = ctx.sessionManager.getSessionId(), leaf = ctx.sessionManager.getLeafId();
      const entries = ctx.sessionManager.getBranch(), all = ctx.sessionManager.getEntries();
      const locked = recoveryLocked(all), state = preferenceState(pi.getSettings(), entries);
      if (locked) {
        // Edit the configured default, not the immutable choice of this session.
        // Otherwise a current subagent session could not save an explicit false
        // over an inherited true (or a direct session save true over false).
        state.values.mainAgentLookup = state.defaults.mainAgentLookup;
      }
      const choice = await pickSettings(ctx, state, locked, readSettingSourceLayers(ctx));
      if (!choice) return;
      if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leaf || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Session changed; settings update cancelled.", "warning"); return;
      }
      const { changes, scope } = choice;
      if (!["session", "project", "global"].includes(scope) || Object.keys(changes).some((key) => !PREFERENCE_KEYS.includes(key as PreferenceKey) ||
          (changes[key as PreferenceKey] !== null && !validPreference(key as PreferenceKey, changes[key as PreferenceKey])))) {
        ctx.ui.notify("Invalid settings; nothing was changed.", "error"); return;
      }
      if (locked && "mainAgentLookup" in changes && scope === "session") {
        ctx.ui.notify("Recovery mode is locked in this session. Save project/global defaults for new sessions instead.", "warning"); return;
      }
      try {
        // Save first: a filesystem failure must not partially apply the session changes.
        const saved = scope === "session" ? undefined : await savePreferences(ctx.cwd, scope, changes);
        if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leaf || !ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify(saved ? `Defaults saved to ${saved}; session changed, so they were not applied to this session.` : "Session changed; settings update cancelled.", "warning"); return;
        }
        const patch = { ...changes };
        if (locked) delete patch.mainAgentLookup;
        for (const key of PREFERENCE_KEYS) {
          if (patch[key] === null && !(key in state.overrides)) delete patch[key];
          else if (same(patch[key], state.overrides[key])) delete patch[key];
        }
        if (Object.keys(patch).length) pi.appendEntry(SETTINGS_ENTRY, patch);
        const next = preferenceState(pi.getSettings(), ctx.sessionManager.getBranch()).values;
        afterApply(state.values, next, ctx);
        ctx.ui.notify(saved ? `Compaction settings applied and saved to ${saved}.${locked && "mainAgentLookup" in changes ? " Recovery default applies to new sessions only." : ""}`
          : "Compaction settings applied to this session.", "info");
        // Reload rebinds recovery tools and refreshes Pi's cached file settings.
        if (saved || (!locked && "mainAgentLookup" in patch && next.mainAgentLookup !== state.values.mainAgentLookup)) { await ctx.reload(); return; }
      } catch (error) {
        ctx.ui.notify(`Could not save compaction settings: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

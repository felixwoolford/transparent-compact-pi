"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { stripVTControlCharacters: plain } = require("node:util");

module.exports = async function settingsMenuTests(h) {
  const { jiti, piRoot, root, factory, load, SessionManager, makeContext, user, preferences, updateSettings } = h;
  const config = await jiti.import(path.resolve(__dirname, "../extensions/lib/config.ts"));
  const { pickSettings, savePreferences, settingText, settingBadge, settingSourceLayers, readSettingSourceLayers, lookupModelItems } = await jiti.import(path.resolve(__dirname, "../extensions/lib/settings-menu.ts"));
  const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
  const { SettingsManager, CONFIG_DIR_NAME } = await jiti.import("@earendil-works/pi-coding-agent");
  const themeDir = path.join(piRoot, "dist/modes/interactive/theme");
  const { loadThemeFromPath } = await jiti.import(path.join(themeDir, "theme.js"));
  const dark = loadThemeFromPath(path.join(themeDir, "dark.json"), "truecolor");
  const light = loadThemeFromPath(path.join(themeDir, "light.json"), "truecolor");
  let active = dark;
  const theme = { fg: (...args) => active.fg(...args), bg: (...args) => active.bg(...args), bold: (s) => active.bold(s) };
  const keys = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b",
    home: "\x1b[H", end: "\x1b[F", pageUp: "\x1b[5~", pageDown: "\x1b[6~" };
  const kb = { matches: (data, action) => data === keys[action.split(".").at(-1).replace("confirm", "enter").replace("cancel", "esc")] };
  const interact = (actions, inspect) => async (build) => {
    let result, finished = false;
    const tui = { terminal: { rows: 26 }, requestRender() {} };
    const component = build(tui, theme, kb, (value) => { result = value; finished = true; });
    const render = (width = 110) => {
      const lines = component.render(width);
      assert(lines.length <= tui.terminal.rows);
      for (const line of lines) {
        assert(visibleWidth(line) <= width, `line exceeds ${width}: ${plain(line)}`);
        if (width >= 8) assert.equal(visibleWidth(line), width, "frame edges stay aligned");
      }
      return lines.map(plain).join("\n");
    };
    if (inspect) inspect({ component, render, tui });
    for (const action of actions) {
      render();
      if (typeof action === "function") action(render(), component);
      else if (action && typeof action === "object") {
        component.handleInput("\x01"); component.handleInput("\x0b"); component.handleInput(action.value);
      } else component.handleInput(keys[action] ?? action);
    }
    assert(finished, "interaction must finish"); component.dispose(); return result;
  };
  console.log("== Settings menu: framed draft/review UI, field validation, cancellation, reset, scopes and resize ==");
  const state = config.preferenceState({}, [], {}), original = JSON.stringify(state);
  assert.equal(settingText("lookupMaxCalls", 0), "0");
  assert.equal(settingText("lookupModel", ""), "session model");
  const pickerContext = { model: { provider: "session", id: "current" },
    scopedModels: [{ model: { provider: "provider", id: "model", name: "Lookup test model" } }],
    modelRegistry: { getAvailable: () => assert.fail("scoped lookup selection must not enumerate unscoped models") } };
  const actions = [" ", "down", " ", "down", " ", { value: "12.5%" }, "enter", "down", " ",
    { value: "provider/model" }, "enter", "down", " ", { value: "0" }, "enter",
    (screen) => assert(screen.includes("Invalid value")), { value: "5" }, "enter", "down", " ", { value: "0" }, "enter",
    "down", " ", "enter", (screen) => assert(screen.includes("2/2 Review") && screen.includes("Apply to this session")), "down", "enter"];
  const chosen = await pickSettings({ ...pickerContext, ui: { custom: interact(actions, ({ component, render, tui }) => {
    const before = component.render(110);
    assert.equal(before.filter((line) => line.includes(dark.getBgAnsi("selectedBg"))).length, 1);
    for (const rows of [8, 10, 18, 32]) for (const width of [1, 8, 24, 42, 80, 120]) { tui.terminal.rows = rows; render(width); }
    tui.terminal.rows = 26;
    assert(render().includes("[default]"));
    active = light; component.invalidate();
    const after = component.render(110);
    assert.deepEqual(after.map(plain), before.map(plain)); assert.notDeepEqual(after, before);
    active = dark; component.invalidate();
  }) } }, state, false);
  assert.equal(chosen.scope, "project");
  assert.deepEqual(chosen.changes, { compactionMethod: "summary", capMode: "on", capBudget: { unit: "percent", value: 12.5 },
    lookupModel: "provider/model", lookupTurns: 5, lookupMaxCalls: 0, mainAgentLookup: true });
  assert.equal(JSON.stringify(state), original, "draft never mutates the initial state");
  assert.equal(await pickSettings({ ui: { custom: interact([" ", "enter", "esc", "esc"]) } }, state, false), undefined);
  assert.equal(await pickSettings({ ui: { custom: interact(["down", "down", " ", { value: "bad" }, "esc", "esc"]) } }, state, false), undefined);
  const reset = await pickSettings({ ui: { custom: interact(["d", "enter", "enter"]) } }, state, false);
  assert.deepEqual(reset, { changes: { compactionMethod: "verbatim" }, scope: "session" });
  const configured = config.preferenceState({ transparentCompact: { compactionMethod: "summary", capMode: "off", maxSummaryChars: 6000,
    lookupModel: "file/model", lookupTurns: 7, lookupMaxCalls: 8, mainAgentLookup: true } },
    [{ type: "custom", customType: config.SETTINGS_ENTRY, data: { lookupMaxCalls: 9 } }],
    { MECH_COMPACT_MAX_SUMMARY_CHARS: "9000", MECH_COMPACT_LOOKUP_TURNS: "12", MECH_COMPACT_LOOKUP_MAX_CALLS: "11",
      MECH_COMPACT_LOOKUP_MODEL: "env/model", MECH_COMPACT_MAIN_AGENT_LOOKUP: "1" });
  const defaultResets = {};
  for (const [index, key] of config.PREFERENCE_KEYS.entries()) {
    const choice = await pickSettings({ ui: { custom: interact([...Array(index).fill("down"), "d", (screen) => {
      if (key === "lookupMaxCalls") assert(screen.includes("Consecutive lookups: 3  [default]"));
    }, "enter", "enter"]) } }, configured, false);
    assert.deepEqual(choice, { changes: { [key]: config.DEFAULT_PREFERENCES[key] }, scope: "session" }, `${key} resets to the built-in value, never a configured value`);
    defaultResets[key] = choice.changes;
  }
  await pickSettings({ ui: { custom: interact(["down", "down", " ", { value: "25%" }, "enter",
    (screen) => assert(screen.includes("Cap budget: 25%  [default]")), "enter", "enter"]) } }, configured, false);
  const locked = structuredClone(state); locked.values.mainAgentLookup = true;
  const later = await pickSettings({ ui: { custom: interact(["end", " ", "enter", "enter", (screen) => assert(screen.includes("locked")), "down", "enter"]) } }, locked, true);
  assert.deepEqual(later, { changes: { mainAgentLookup: false }, scope: "project" });

  console.log("== Lookup model picker: scoped models, fuzzy search, current selection, follow-session and cancellation ==");
  const alpha = { provider: "alpha", id: "one", name: "Alpha Friendly" }, beta = { provider: "beta", id: "two", name: "Beta Friendly" };
  const modelCtx = { ...pickerContext, scopedModels: [{ model: beta }, { model: alpha }, { model: alpha }] };
  assert.deepEqual(lookupModelItems(modelCtx).map((item) => item.value), ["", "alpha/one", "beta/two"]);
  const modelPosition = Array(config.PREFERENCE_KEYS.indexOf("lookupModel")).fill("down");
  let pickerControls;
  const scopedChoice = await pickSettings({ ...modelCtx, ui: { custom: interact([...modelPosition, " ", (_screen, component) => {
    const { render, tui } = pickerControls;
    for (const rows of [10, 18, 32]) for (const width of [1, 8, 24, 42, 110]) { tui.terminal.rows = rows; render(width); }
    tui.terminal.rows = 26;
    const before = component.render(110);
    active = light; component.invalidate();
    assert.deepEqual(component.render(110).map(plain), before.map(plain));
    assert.notDeepEqual(component.render(110), before);
    active = dark; component.invalidate();
  }, "down", "enter", (screen) => assert(screen.includes("Lookup model: alpha/one") && screen.includes("[session setting]*")), "enter", "enter"],
    (controls) => { pickerControls = controls; }) } }, state, false);
  assert.deepEqual(scopedChoice.changes, { lookupModel: "alpha/one" });
  const searched = await pickSettings({ ...modelCtx, ui: { custom: interact([...modelPosition, " ", { value: "Beta Friendly" },
    "enter", "enter", "enter"]) } }, state, false);
  assert.deepEqual(searched.changes, { lookupModel: "beta/two" }, "search matches model display names, not just provider/model IDs");
  const pinned = structuredClone(state); pinned.values.lookupModel = "beta/two";
  const sameModel = await pickSettings({ ...modelCtx, ui: { custom: interact([...modelPosition, " ", "enter",
    (screen) => assert(!screen.includes("Lookup model: beta/two  [session setting]*")), "esc"]) } }, pinned, false);
  assert.equal(sameModel, undefined, "the current configured model is selected on opening; reselecting it makes no change");
  const followSession = await pickSettings({ ...modelCtx, ui: { custom: interact([...modelPosition, " ", { value: "Use session model" },
    "enter", (screen) => assert(screen.includes("Lookup model: session model  [default]*")), "enter", "enter"]) } }, pinned, false);
  assert.deepEqual(followSession.changes, { lookupModel: "" });
  assert.equal(await pickSettings({ ...modelCtx, ui: { custom: interact([...modelPosition, " ", { value: "not-an-existing-model" }, "enter",
    (screen) => assert(screen.includes("No matching models")), "esc", "esc"]) } }, state, false), undefined, "unmatched text cannot become a configured model");
  const cancelledPicker = await pickSettings({ ...modelCtx, ui: { custom: interact([" ", ...modelPosition, " ", { value: "Beta Friendly" }, "esc", "enter", "enter"]) } }, state, false);
  assert.deepEqual(cancelledPicker.changes, { compactionMethod: "summary" }, "cancelling the picker preserves other draft edits");
  let availableCalls = 0;
  const unscopedCtx = { ...modelCtx, scopedModels: [], modelRegistry: { getAvailable: () => { availableCalls++; return [beta]; } } };
  assert.deepEqual(lookupModelItems(unscopedCtx).map((item) => item.value), ["", "beta/two"]);
  const unscopedChoice = await pickSettings({ ...unscopedCtx, ui: { custom: interact([...modelPosition, " ", "down", "enter", "enter", "enter"]) } }, state, false);
  assert.deepEqual(unscopedChoice.changes, { lookupModel: "beta/two" });
  assert.equal(availableCalls, 2, "each picker uses one local catalogue snapshot without refreshing providers");
  const emptyChoice = await pickSettings({ ...modelCtx, scopedModels: [], modelRegistry: { getAvailable: () => [] },
    ui: { custom: interact([...modelPosition, " ", "enter", "enter", "enter"]) } }, pinned, false);
  assert.deepEqual(emptyChoice.changes, { lookupModel: "" }, "following the session remains selectable with an empty catalogue");

  console.log("== Settings badges: lowest matching default/global/project/environment/session value, including drafts ==");
  const sourceGlobal = { transparentCompact: { lookupMaxCalls: 5, maxSummaryChars: 80000 } };
  const sourceProject = { transparentCompact: { lookupMaxCalls: 7, maxSummaryChars: null, maxSummaryPercent: 30 } };
  const sourceEnv = { MECH_COMPACT_LOOKUP_MAX_CALLS: "9", MECH_COMPACT_MAX_SUMMARY_CHARS: "12000" };
  const layers = settingSourceLayers(sourceGlobal, sourceProject, sourceEnv);
  for (const [value, label] of [[3, "default"], [5, "global setting"], [7, "project setting"], [9, "environment setting"], [4, "session setting"]])
    assert.equal(settingBadge("lookupMaxCalls", value, layers), label);
  const equalLayers = settingSourceLayers(sourceGlobal, { transparentCompact: { lookupMaxCalls: 5 } }, { MECH_COMPACT_LOOKUP_MAX_CALLS: "5" });
  assert.equal(settingBadge("lookupMaxCalls", 5, equalLayers), "global setting", "duplicate matches prefer the lowest scope");
  assert.equal(settingBadge("capBudget", { value: 25, unit: "percent" }, layers), "default");
  assert.equal(settingBadge("capBudget", { value: 20000, unit: "tokens" }, layers), "global setting", "token budgets match their saved character equivalents");
  assert.equal(settingBadge("capBudget", { value: 30, unit: "percent" }, layers), "project setting", "project cap units use Pi's merged settings");
  assert.equal(settingBadge("capBudget", { value: 12000, unit: "chars" }, layers), "environment setting");
  const badgeCwd = path.join(root, "badge-project"), badgeAgentDir = path.join(root, "badge-agent");
  fs.mkdirSync(path.join(badgeCwd, CONFIG_DIR_NAME), { recursive: true }); fs.mkdirSync(badgeAgentDir);
  fs.writeFileSync(path.join(badgeAgentDir, "settings.json"), JSON.stringify(sourceGlobal));
  fs.writeFileSync(path.join(badgeCwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify(sourceProject));
  const sourceCtx = { cwd: badgeCwd, isProjectTrusted: () => true };
  assert.equal(settingBadge("lookupMaxCalls", 7, readSettingSourceLayers(sourceCtx, badgeAgentDir, sourceEnv)), "project setting");
  assert.equal(settingBadge("lookupMaxCalls", 7, readSettingSourceLayers({ ...sourceCtx, isProjectTrusted: () => false }, badgeAgentDir, sourceEnv)), "session setting",
    "untrusted project files cannot supply badge matches");
  const missingCwd = path.join(root, "missing-badge-project"), missingAgent = path.join(root, "missing-badge-agent");
  readSettingSourceLayers({ cwd: missingCwd, isProjectTrusted: () => true }, missingAgent, {});
  assert(!fs.existsSync(missingCwd) && !fs.existsSync(missingAgent), "reading badge layers never creates files or directories");
  const badgeManager = SessionManager.inMemory(badgeCwd);
  const badgeRef = { current: badgeManager, settings: { transparentCompact: { lookupMaxCalls: 7 } } };
  const badgeExt = load(factory, badgeRef);
  const badgeCtx = { ...makeContext(badgeManager, badgeCwd), ...modelCtx, mode: "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false, reload: async () => {} };
  const position = Array(config.PREFERENCE_KEYS.indexOf("lookupMaxCalls")).fill("down");
  const savedBadgeEnv = { agent: process.env.PI_CODING_AGENT_DIR, calls: process.env.MECH_COMPACT_LOOKUP_MAX_CALLS };
  process.env.PI_CODING_AGENT_DIR = badgeAgentDir; process.env.MECH_COMPACT_LOOKUP_MAX_CALLS = "9";
  const openBadgeMenu = (actions) => badgeExt.commands["compact-settings"].handler("", { ...badgeCtx,
    ui: { ...badgeCtx.ui, custom: interact(actions) } });
  try {
    await updateSettings(badgeExt, badgeCtx, { lookupMaxCalls: 5 }, "global");
    await openBadgeMenu([...position, (screen) => {
      assert(screen.includes("Consecutive lookups: 5  [global setting]"));
      assert(!screen.includes("Consecutive lookups: 5  [global setting]*"), "saved values have no pending marker");
    }, "esc"]);
    assert.equal(preferences(badgeCtx, badgeRef.settings).lookupMaxCalls, 5, "global saves still apply to the active session");
    for (const [value, label] of [[3, "default"], [7, "project setting"], [9, "environment setting"], [4, "session setting"]]) {
      await updateSettings(badgeExt, badgeCtx, { lookupMaxCalls: value });
      await openBadgeMenu([...position, (screen) => assert(screen.includes(`Consecutive lookups: ${value}  [${label}]`)), "esc"]);
    }
    await openBadgeMenu([...position, " ", { value: "5" }, "enter",
      (screen) => assert(screen.includes("Consecutive lookups: 5  [global setting]*")),
      " ", { value: "4" }, "enter", (screen) => {
        assert(screen.includes("Consecutive lookups: 4  [session setting]"));
        assert(!screen.includes("Consecutive lookups: 4  [session setting]*"), "reverting an edit clears its marker");
      }, "d", (screen) => assert(screen.includes("Consecutive lookups: 3  [default]*")), "esc"]);
    assert.equal(preferences(badgeCtx, badgeRef.settings).lookupMaxCalls, 4, "cancelling a marked draft does not apply it");
    await updateSettings(badgeExt, badgeCtx, { lookupMaxCalls: 7 }, "project");
    await openBadgeMenu([...position, (screen) => assert(screen.includes("Consecutive lookups: 7  [project setting]")), "esc"]);
    await openBadgeMenu([...modelPosition, " ", { value: "Beta Friendly" }, "enter", "enter", "down", "enter"]);
    assert.equal(preferences(badgeCtx, badgeRef.settings).lookupModel, "beta/two", "the real command applies the picked lookup model");
    assert.equal(JSON.parse(fs.readFileSync(path.join(badgeCwd, CONFIG_DIR_NAME, "settings.json"))).transparentCompact.lookupModel, "beta/two");
    assert.equal(badgeCtx.model.id, "current", "lookup-model selection does not change the session model");
    await updateSettings(badgeExt, badgeCtx, { lookupMaxCalls: 3 }, "global");
    assert(!("lookupMaxCalls" in JSON.parse(fs.readFileSync(path.join(badgeAgentDir, "settings.json"))).transparentCompact),
      "saving the built-in default removes its global override");
    assert.equal(preferences(badgeCtx, badgeRef.settings).lookupMaxCalls, 3, "the session still uses the explicit default above project and environment overrides");
    await openBadgeMenu([...position, (screen) => assert(screen.includes("Consecutive lookups: 3  [default]")), "esc"]);
  } finally {
    if (savedBadgeEnv.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedBadgeEnv.agent;
    if (savedBadgeEnv.calls === undefined) delete process.env.MECH_COMPACT_LOOKUP_MAX_CALLS; else process.env.MECH_COMPACT_LOOKUP_MAX_CALLS = savedBadgeEnv.calls;
  }

  console.log("== Settings state: existing session entries, per-field precedence, resets, branches and reload ==");
  const cwd = path.join(root, "settings-menu-project"), agentDir = path.join(root, "settings-menu-agent");
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  const manager = SessionManager.inMemory(cwd), first = manager.appendMessage(user("Task"));
  const ref = { current: manager, settings: { transparentCompact: { lookupTurns: 8 } } }, ext = load(factory, ref);
  const notices = [];
  let reloads = 0;
  const ctx = { ...makeContext(manager, cwd), isIdle: () => true, hasPendingMessages: () => false,
    reload: async () => { reloads++; }, ui: { notify: (message, level) => notices.push({ message, level }) } };
  manager.appendCustomEntry(config.METHOD_ENTRY, { method: "summary" });
  manager.appendCustomEntry(config.CAP_ENTRY, { mode: "off", budget: { unit: "tokens", value: 20000 } });
  // DEPRECATED autoFilter compatibility fixture. TODO(1.x.x): remove this
  // legacy entry and the autoFilter assertions below.
  manager.appendCustomEntry("transparent-compact:auto-filter", { enabled: false });
  assert.equal(preferences(ctx).compactionMethod, "summary"); assert.equal(preferences(ctx).capMode, "off");
  assert(!config.PREFERENCE_KEYS.includes("autoFilter"), "aside pruning is no longer an optional preference");
  assert(!("autoFilter" in preferences(ctx)));
  await updateSettings(ext, ctx, { compactionMethod: "verbatim", capMode: "on", lookupTurns: 4 });
  const changed = manager.getLeafId();
  assert.equal(preferences(ctx).compactionMethod, "verbatim"); assert.equal(preferences(ctx).capBudget.unit, "tokens");
  assert.equal(preferences(ctx).lookupTurns, 4);
  assert.equal(JSON.stringify(manager.buildSessionContext()).includes("lookupTurns"), false, "settings stay outside model context");
  await updateSettings(ext, ctx, { lookupTurns: 4 }); assert.equal(manager.getLeafId(), changed, "same override is not duplicated");
  await updateSettings(ext, ctx, { lookupTurns: null });
  assert.equal(preferences(ctx, ref.settings).lookupTurns, Number(process.env.MECH_COMPACT_LOOKUP_TURNS ?? 8), "null entries still clear older session overrides");
  manager.branch(first); assert.equal(preferences(ctx).capMode, "warn");
  manager.branch(changed); assert.equal(preferences(ctx).capMode, "on");
  manager.appendMessage(user("Continue the selected branch"));
  const file = path.join(root, "settings-menu-session.jsonl"); h.saveSession(manager, file);
  const reopened = SessionManager.open(file);
  assert.equal(config.sessionPreferences({}, reopened.getBranch()).lookupTurns, 4);
  manager.appendCustomEntry(config.CAP_ENTRY, { mode: "off", budget: { unit: "chars", value: 1000 } });
  assert.equal(preferences(ctx).capMode, "off", "cap-confirmation entries override earlier menu changes");

  console.log("== Menu session overrides drive lookup model selection and both budgets ==");
  const lookupManager = SessionManager.inMemory(cwd);
  lookupManager.appendMessage(user("Recover the SEARCH_TARGET evidence"));
  const lookupRef = { current: lookupManager, settings: { transparentCompact: { lookupMaxCalls: 8 } } };
  const lookupExt = load(factory, lookupRef);
  const lookupCtx = { ...ctx, sessionManager: lookupManager };
  await updateSettings(lookupExt, lookupCtx, { lookupTurns: 4, lookupMaxCalls: 1, lookupModel: "selected/model" });
  let calls = 0;
  const selectedModel = { provider: "selected", id: "model" };
  const registry = { find: (provider, id) => provider === "selected" && id === "model" ? selectedModel : undefined,
    complete: async (model) => {
      assert.equal(model, selectedModel);
      return ++calls <= 4 ? h.assistant([h.toolCall("grep", { pattern: "SEARCH_TARGET", before: 0, after: 0 }, `query-${calls}`)], "toolUse")
        : h.assistant([h.text("Partial evidence")]);
    } };
  const findings = await lookupExt.tools.context_lookup.execute("settings-lookup", { question: "Recover earlier evidence" }, undefined, undefined,
    { ...lookupCtx, modelRegistry: registry });
  assert.equal(calls, 5); assert(h.toolText(findings).includes("4-turn limit"));
  lookupManager.appendMessage({ role: "toolResult", toolName: "context_lookup", toolCallId: "settings-lookup", content: findings.content, isError: false, timestamp: 0 });
  const limited = await lookupExt.tools.context_lookup.execute("blocked-lookup", { question: "Again" }, undefined, undefined,
    { ...lookupCtx, modelRegistry: registry });
  assert(h.toolText(limited).includes("consecutive-call limit reached (1)")); assert.equal(calls, 5);
  const savedMaxCalls = process.env.MECH_COMPACT_LOOKUP_MAX_CALLS;
  process.env.MECH_COMPACT_LOOKUP_MAX_CALLS = "11";
  try {
    await updateSettings(lookupExt, lookupCtx, defaultResets.lookupMaxCalls);
    assert.equal(preferences(lookupCtx, lookupRef.settings).lookupMaxCalls, 3, "reset persists 3 above file, environment, and previous session overrides");
    await pickSettings({ ui: { custom: interact([...Array(config.PREFERENCE_KEYS.indexOf("lookupMaxCalls")).fill("down"),
      (screen) => assert(screen.includes("Consecutive lookups: 3  [default]")), "esc"]) } },
      config.preferenceState(lookupRef.settings, lookupManager.getBranch()), false);
  } finally {
    if (savedMaxCalls === undefined) delete process.env.MECH_COMPACT_LOOKUP_MAX_CALLS; else process.env.MECH_COMPACT_LOOKUP_MAX_CALLS = savedMaxCalls;
  }

  console.log("== Settings files: merge only edited keys, inheritance across cap units, tokens and failure safety ==");
  const globalFile = path.join(agentDir, "settings.json"), projectFile = path.join(cwd, CONFIG_DIR_NAME, "settings.json");
  fs.writeFileSync(globalFile, JSON.stringify({ unrelated: true, transparentCompact: { maxSummaryChars: 80000, lookupTurns: 9, custom: "keep" } }));
  await savePreferences(cwd, "project", { capBudget: { unit: "percent", value: 30 }, lookupMaxCalls: 2 }, agentDir);
  let effective = SettingsManager.create(cwd, agentDir, { projectTrusted: true }).getSettings();
  assert.deepEqual(config.resolveConfig(effective, {}).defaultCapBudget, { unit: "percent", value: 30 }, "project percentage masks global chars");
  assert.equal(effective.transparentCompact.lookupTurns, 9); assert.equal(effective.transparentCompact.custom, "keep");
  await savePreferences(cwd, "project", { capBudget: { unit: "tokens", value: 20000 } }, agentDir);
  assert.equal(JSON.parse(fs.readFileSync(projectFile)).transparentCompact.maxSummaryChars, 80000);
  await savePreferences(cwd, "project", { capBudget: null }, agentDir);
  assert.equal(JSON.parse(fs.readFileSync(projectFile)).transparentCompact.lookupMaxCalls, 2);
  assert(!("maxSummaryChars" in JSON.parse(fs.readFileSync(projectFile)).transparentCompact));
  await savePreferences(cwd, "project", defaultResets.lookupMaxCalls, agentDir);
  assert.equal(JSON.parse(fs.readFileSync(projectFile)).transparentCompact.lookupMaxCalls, 3, "saving a reset stores the built-in default, not deletion/inheritance");
  await savePreferences(cwd, "global", { lookupMaxCalls: 0, lookupModel: "" }, agentDir);
  assert.equal(JSON.parse(fs.readFileSync(globalFile)).unrelated, true);
  assert.equal(JSON.parse(fs.readFileSync(globalFile)).transparentCompact.custom, "keep");
  assert(!("lookupModel" in JSON.parse(fs.readFileSync(globalFile)).transparentCompact), "the default session-model choice is omitted globally");
  await savePreferences(cwd, "global", { ...config.DEFAULT_PREFERENCES }, agentDir);
  assert.deepEqual(JSON.parse(fs.readFileSync(globalFile)), { unrelated: true, transparentCompact: { custom: "keep" } },
    "all built-in defaults, including both cap keys, are removed without touching unrelated settings");
  const emptyAgentDir = path.join(root, "empty-default-agent");
  fs.mkdirSync(emptyAgentDir);
  fs.writeFileSync(path.join(emptyAgentDir, "settings.json"), JSON.stringify({ unrelated: true, transparentCompact: { lookupMaxCalls: 5 } }));
  await savePreferences(cwd, "global", { lookupMaxCalls: 3 }, emptyAgentDir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(emptyAgentDir, "settings.json"))), { unrelated: true }, "empty global namespace is removed too");
  fs.writeFileSync(projectFile, "BROKEN JSON");
  await assert.rejects(savePreferences(cwd, "project", { lookupTurns: 3 }, agentDir));
  assert.equal(fs.readFileSync(projectFile, "utf8"), "BROKEN JSON");
  for (const invalid of ["[]", '{"transparentCompact":false}']) {
    fs.writeFileSync(projectFile, invalid);
    await assert.rejects(savePreferences(cwd, "project", { lookupTurns: 3 }, agentDir));
    assert.equal(fs.readFileSync(projectFile, "utf8"), invalid);
  }
  const beforeFailure = manager.getLeafId();
  await updateSettings(ext, ctx, { lookupTurns: 3 }, "project");
  assert.equal(manager.getLeafId(), beforeFailure, "failed save does not partially apply session settings");
  assert.equal(notices.at(-1).level, "error");
  fs.writeFileSync(projectFile, JSON.stringify({ transparentCompact: { lookupTurns: 6, untouched: "keep" } }));
  await updateSettings(ext, ctx, { lookupMaxCalls: 0 }, "project");
  assert.equal(preferences(ctx).lookupMaxCalls, 0); assert.equal(reloads, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(projectFile)).transparentCompact, { lookupTurns: 6, untouched: "keep", lookupMaxCalls: 0 });
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try { await updateSettings(ext, ctx, { lookupMaxCalls: 2 }, "global"); }
  finally { if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir; }
  assert.equal(JSON.parse(fs.readFileSync(globalFile)).transparentCompact.lookupMaxCalls, 2);

  console.log("== Settings command: input guards, stale drafts, main-agent lock and reload request ==");
  const command = ext.commands["compact-settings"], guardLeaf = manager.getLeafId();
  for (const mode of ["json", "rpc", "print"]) await command.handler("", { ...ctx, mode, hasUI: true });
  await command.handler("", { ...ctx, mode: "tui", hasUI: true, isIdle: () => false });
  await command.handler("", { ...ctx, mode: "tui", hasUI: true, hasPendingMessages: () => true });
  await command.handler("oops", ctx);
  assert.equal(manager.getLeafId(), guardLeaf, "guards do not persist changes");
  const staleLeaf = manager.getLeafId();
  await command.handler("", { ...ctx, mode: "tui", hasUI: true, ui: { ...ctx.ui, custom: async () => {
    manager.appendMessage(user("Arrived while settings were open")); return { changes: { capMode: "off" }, scope: "session" };
  } } });
  assert.notEqual(manager.getLeafId(), staleLeaf);
  assert.equal(manager.getBranch().at(-1).type, "message", "stale drafts never append settings");
  const fresh = SessionManager.inMemory(cwd), freshExt = load(factory, { current: fresh });
  let freshReloads = 0;
  const freshCtx = { ...ctx, sessionManager: fresh, reload: async () => { freshReloads++; } };
  await updateSettings(freshExt, freshCtx, { mainAgentLookup: true });
  assert.equal(freshReloads, 1); assert.equal(preferences(freshCtx).mainAgentLookup, true);
  fresh.appendCustomEntry(config.MAIN_MODE_ENTRY, {});
  const lockedLeaf = fresh.getLeafId();
  await freshExt.commands["compact-settings"].handler("", { ...freshCtx, mode: "tui", hasUI: true, ui: { ...freshCtx.ui,
    custom: interact(["end", (screen) => assert(screen.includes("Recovery default (next session): subagent")), "esc"]),
  } });
  await updateSettings(freshExt, freshCtx, { mainAgentLookup: false }); assert.equal(fresh.getLeafId(), lockedLeaf);
  await updateSettings(freshExt, freshCtx, { mainAgentLookup: false, lookupTurns: 3 }, "project");
  assert.equal(preferences(freshCtx).lookupTurns, 3);
  assert.equal(preferences(freshCtx).mainAgentLookup, true, "locked recovery choice is not overwritten");
  assert.equal(JSON.parse(fs.readFileSync(projectFile)).transparentCompact.mainAgentLookup, false);
  assert(notices.some((n) => n.message.includes("new sessions only")));
};

import { stripVTControlCharacters } from "node:util";
import { matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { FILTER_MARKER } from "./checkpoint-cap.js";
import type { SpanContent, ToolLines } from "./checkpoint-cap.js";
export { FILTER_MARKER } from "./checkpoint-cap.js";
export { turnOwners } from "./turn-context.js";
import { MODE_LABELS, MODE_SYMBOLS } from "./turn-context.js";
import type { Fidelity, TurnFidelities, TurnMode, TurnSelection } from "./turn-context.js";

export const PREFLAG_ENTRY = "transparent-compact:aside-turn";
export const AUTO_FILTER_ENTRY = "transparent-compact:auto-filter";
export const FILTER_REVISION_ENTRY = "transparent-compact:filter-revision";

export function autoFilterEnabled(entries: SessionEntry[]): boolean {
  const entry = entries.findLast((entry) => entry.type === "custom" && entry.customType === AUTO_FILTER_ENTRY);
  return entry?.type === "custom" && (entry.data as { enabled?: boolean })?.enabled === true;
}

/** Written immediately before the aside's user message is persisted. Consume
 * once at that raw boundary; the timestamp guards against an interrupted append.
 */
export function preflaggedTurns(entries: SessionEntry[]): Set<string> {
  const flagged = new Set<string>();
  let pending: number | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === PREFLAG_ENTRY)
      pending = (entry.data as { timestamp?: number })?.timestamp;
    else if (entry.type === "message" && entry.message.role === "user") {
      if (pending !== undefined && entry.message.timestamp === pending) flagged.add(entry.id);
      pending = undefined;
    }
  }
  return flagged;
}
export const FILTER_EXPLANATION = "`[Turn manually filtered]` marks a user turn and its following agent/tool activity that the user chose to exclude as low-value context. Its contents remain retrievable from the full history. Do not recover filtered turns unless needed for the current task.";
export interface TurnSpan extends SpanContent { turnIds?: (string | null)[] }

/** Drop canonical lines before capping, retaining tool-record indices exactly.
 * A turn can cross compaction spans; emit only one marker at its first position.
 */
export function filterSpans<T extends TurnSpan>(spans: T[], excluded: Set<string>): T[] {
  if (excluded.size === 0) return spans;
  const marked = new Set<string>();
  return spans.map((span) => {
    const lines: string[] = [], turnIds: (string | null)[] = [];
    const indices = new Map<number, number>();
    span.lines.forEach((line, index) => {
      const owner = span.turnIds?.[index] ?? null;
      if (owner && excluded.has(owner)) {
        if (!marked.has(owner)) {
          marked.add(owner);
          lines.push(FILTER_MARKER);
          turnIds.push(owner);
        }
      } else {
        indices.set(index, lines.length);
        lines.push(line);
        turnIds.push(owner);
      }
    });
    const tools: ToolLines | undefined = span.tools && { ...span.tools, lines: span.tools.lines
      .filter((record) => indices.has(record.index))
      .map((record) => ({ ...record, index: indices.get(record.index)! })) };
    return { ...span, lines, turnIds, tools };
  });
}

export interface FilterTurn {
  id: string;
  label: string;
  lines: string[];
  selected?: boolean;
  filtered?: boolean;
  fidelity?: Fidelity;
  fidelityInfo?: (mode: Fidelity) => { tokens: number; lines: string[] };
  deferred?: boolean;
  unavailable?: string;
}

const displayText = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** Tree-like whole-turn selection followed by a scrollable, complete preview.
 * Subentries are inspection-only: space always toggles their owning user turn.
 */
export async function pickFilteredTurns(ctx: ExtensionContext, turns: FilterTurn[], signal: AbortSignal): Promise<TurnSelection | undefined> {
  return ctx.ui.custom<TurnSelection | undefined>((tui, theme, kb, done) => {
    const selected = new Set(turns.filter((turn) => turn.selected).map((turn) => turn.id));
    const fidelity: TurnFidelities = Object.fromEntries(turns.filter((turn) => turn.fidelity && !selected.has(turn.id)).map((turn) => [turn.id, turn.fidelity!]));
    const originalMode = (turn: FilterTurn): TurnMode => turn.filtered ? "pruned" : turn.fidelity ?? "prose";
    const modeOf = (turn: FilterTurn): TurnMode => selected.has(turn.id) ? "pruned" : fidelity[turn.id] ?? "prose";
    const setMode = (turn: FilterTurn, mode: TurnMode) => {
      if (mode === "pruned") selected.add(turn.id); else selected.delete(turn.id);
      if (mode === "tools" || mode === "full") fidelity[turn.id] = mode; else delete fidelity[turn.id];
    };
    const selection = (): TurnSelection => ({ pruned: [...selected], fidelity: { ...fidelity } });
    let notice: string | undefined;
    const cost = (turn: FilterTurn, mode: TurnMode) => {
      try { return mode === "pruned" ? 6 : mode === "prose" ? Math.ceil(turn.lines.join("\n").length / 4) : turn.fidelityInfo?.(mode).tokens ?? 0; }
      catch { return 0; } // An invalid old pin must still be removable.
    };
    const tokenDelta = () => turns.filter((turn) => !turn.unavailable && !turn.deferred)
      .reduce((sum, turn) => sum + cost(turn, modeOf(turn)) - cost(turn, originalMode(turn)), 0);
    const expanded = new Set<string>();
    type PreviewLine = { text: string; kind: "heading" | "content" | "note" };
    let cursor = 0, top = 0, review: PreviewLine[] | undefined, scroll = 0;
    let wrappedReview: { width: number; source: PreviewLine[]; lines: PreviewLine[] } | undefined;
    const rows = () => turns.flatMap((turn, index) => {
      let details: string[] = [];
      if (expanded.has(turn.id)) {
        details = turn.lines.slice(1);
        const mode = modeOf(turn);
        if (mode === "tools" || mode === "full") {
          try { details = turn.fidelityInfo?.(mode).lines ?? details; }
          catch (error) { details = [String(error), ...details]; }
        }
      }
      return [{ turn, number: index + 1, child: false, text: turn.label },
        ...details.map((text) => ({ turn, number: index + 1, child: true, text }))];
    });
    const pageSize = () => Math.max(1, tui.terminal.rows - (tui.terminal.rows >= 16 ? 10 : 9));
    const stateOf = (turn: FilterTurn): { label: string; color: "dim" | "warning" | "success" | "text" | "accent"; hint: string } => {
      const checked = selected.has(turn.id);
      if (turn.unavailable) return { label: "Locked", color: "dim", hint: `Locked — ${turn.unavailable}` };
      if (turn.deferred) return checked
        ? { label: "Pending", color: "warning", hint: "Pending pruning — recent tail unchanged; f only toggles the flag" }
        : { label: "PROSE", color: "success", hint: "Keep — pending exclusion cancelled" };
      const mode = modeOf(turn);
      if (mode === "tools" || mode === "full") return { label: MODE_LABELS[mode], color: "accent",
        hint: mode === "tools" ? "PROSE+TOOLS — complete tools; thinking markers only" : "FULL — all recorded content, including thinking" };
      if (checked) return { label: "PRUNED", color: "warning", hint: turn.filtered
        ? "Already pruned — Space restores PROSE; f cycles modes" : "Prune — replace this whole turn with a marker" };
      return { label: "PROSE", color: turn.filtered || turn.selected ? "success" : "text", hint: turn.filtered
        ? "Restore — compacted prose returns to the checkpoint" : turn.selected ? "Keep — pre-flag cancelled" : "PROSE — our standard mechanical compaction" };
    };
    const changeSummary = () => {
      let exclude = 0, restore = 0, pending = 0, keep = 0, tools = 0, full = 0;
      for (const turn of turns) {
        if (turn.unavailable) continue;
        const checked = selected.has(turn.id), mode = modeOf(turn);
        if (mode === "tools") { if (mode !== originalMode(turn)) tools++; continue; }
        if (mode === "full") { if (mode !== originalMode(turn)) full++; continue; }
        if (checked && turn.deferred) pending++;
        else if (checked && !turn.filtered) exclude++;
        else if (!checked && turn.filtered) restore++;
        else if (!checked && turn.selected) keep++;
      }
      return `${exclude} pruned · ${restore} restored · ${keep} keep · ${pending} pending · ${tools} tools · ${full} full`;
    };
    const finish = (value: TurnSelection | undefined) => { signal.removeEventListener("abort", abort); done(value); };
    const abort = () => finish(undefined);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) queueMicrotask(abort);
    return {
      render(width: number): string[] {
        const height = pageSize(), roomy = tui.terminal.rows >= 16, framed = width >= 8;
        const innerWidth = Math.max(1, width - (framed ? 4 : 0));
        const pad = (text: string) => {
          const clipped = truncateToWidth(text, innerWidth);
          return clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
        };
        const line = (text: string, focused = false) => {
          const content = focused ? theme.bg("selectedBg", pad(text)) : pad(text);
          return framed ? theme.fg("borderMuted", "│ ") + content + theme.fg("borderMuted", " │") : content;
        };
        const rule = (label: string, position: "top" | "middle" | "bottom" = "middle") => {
          if (!framed) return truncateToWidth(label, width);
          const [left, right] = position === "top" ? ["╭", "╮"] : position === "bottom" ? ["╰", "╯"] : ["├", "┤"];
          const caption = truncateToWidth(label ? `─ ${label} ` : "", width - 2);
          return theme.fg("borderMuted", left) + caption +
            theme.fg("borderMuted", "─".repeat(Math.max(0, width - 2 - visibleWidth(caption))) + right);
        };
        const key = (name: string, action: string) => theme.fg("accent", theme.bold(name)) + theme.fg("muted", ` ${action}`);
        const title = review ? "Turn context · 2/2 Review" : "Turn context · 1/2 Select";
        const out = [rule(theme.fg("accent", theme.bold(title)), "top")];
        out.push(line(theme.fg("muted", review
          ? "PROSE is size-capped. PROSE+TOOLS/FULL are never silently shortened."
          : "Choose each whole turn's context mode. Nothing changes until you confirm.")));
        if (roomy) out.push(line(review ? theme.fg("accent", changeSummary())
          : theme.fg("warning", "[X] Pruned") + theme.fg("muted", "  [ ] Prose  ") + theme.fg("accent", "[○] Prose+tools  [■] Full") +
            theme.fg("dim", "  [-] Locked")));
        let footer: string;
        if (review) {
          if (wrappedReview?.width !== innerWidth || wrappedReview.source !== review)
            wrappedReview = { width: innerWidth, source: review, lines: review.flatMap((item) =>
              wrapTextWithAnsi(displayText(item.text), innerWidth).map((text) => ({ ...item, text }))) };
          const wrapped = wrappedReview.lines;
          scroll = Math.max(0, Math.min(scroll, wrapped.length - height));
          out.push(rule(theme.fg("muted", `Change preview · ${scroll + 1}–${Math.min(scroll + height, wrapped.length)} / ${wrapped.length} lines · ~${tokenDelta() >= 0 ? "+" : ""}${tokenDelta().toLocaleString()} tokens`)));
          for (const item of wrapped.slice(scroll, scroll + height))
            out.push(line(theme.fg(item.kind === "heading" ? "accent" : item.kind === "note" ? "muted" : "text",
              item.kind === "heading" ? theme.bold(item.text) : item.text)));
          footer = "Original session history remains unchanged";
        } else {
          const visible = rows();
          cursor = Math.max(0, Math.min(cursor, visible.length - 1));
          top = Math.max(0, Math.min(top, cursor, visible.length - height));
          if (cursor >= top + height) top = cursor - height + 1;
          out.push(rule(theme.fg("muted", `User turns · ${visible.length ? top + 1 : 0}–${Math.min(top + height, visible.length)} / ${visible.length} rows · ${selected.size} pruned`)));
          for (let i = top; i < Math.min(top + height, visible.length); i++) {
            const { turn, number, child, text } = visible[i], state = stateOf(turn), focused = i === cursor;
            const pointer = theme.fg("accent", focused ? "› " : "  ");
            const content = displayText(text).replace(/\s+/g, " ").replace(child ? /^\[([^\]]+)\]:\s*/ : /^\[User\]:\s*/, child ? "$1  " : "");
            let row: string;
            if (child) row = pointer + theme.fg("dim", "    └ ") + theme.fg(focused ? "text" : "muted", content);
            else {
              const checkbox = `[${turn.unavailable ? "-" : MODE_SYMBOLS[modeOf(turn)]}]`;
              row = pointer + theme.fg("dim", `${expanded.has(turn.id) ? "▾" : "▸"} `) + theme.fg(state.color, checkbox) + " " +
                (innerWidth >= 24 ? theme.fg("dim", `${String(number).padStart(String(turns.length).length)}  `) : "") +
                (innerWidth >= 60 ? theme.fg(state.color, state.label.toUpperCase().padEnd(13)) : "") +
                theme.fg(turn.unavailable ? "dim" : "text", content);
            }
            out.push(line(row, focused));
          }
          if (!visible.length) out.push(line(theme.fg("dim", "No user turns to display.")));
          const current = visible[cursor];
          footer = notice ?? (current ? current.child ? "Agent detail — Space/f changes its whole user turn" : stateOf(current.turn).hint : "Original history stays recoverable");
        }
        out.push(rule(theme.fg("muted", "Controls")));
        out.push(line(review
          ? `${key("↑/↓", "Scroll")}  ${theme.fg("accent", theme.bold("PgUp/PgDn"))}  ${theme.fg("accent", theme.bold("Home/End"))}`
          : `${key("↑/↓", "Move")} ${key("Space", "Prune")} ${key("f", "Mode")} ${key("←/→", "Fold")}`));
        out.push(line(review
          ? `${key("Enter", "Confirm & save")}   ${key("Esc", "Back")}`
          : `${key("Enter", "Review changes")}   ${key("Esc", "Cancel")}`));
        out.push(rule(theme.fg("dim", footer), "bottom"));
        return out.map((text) => truncateToWidth(text, width));
      },
      handleInput(data: string) {
        const page = pageSize();
        if (kb.matches(data, "tui.select.cancel")) {
          if (review) { review = undefined; scroll = 0; } else { finish(undefined); return; }
        } else if (review) {
          if (kb.matches(data, "tui.select.confirm")) { finish(selection()); return; }
          if (kb.matches(data, "tui.select.up")) scroll--;
          else if (kb.matches(data, "tui.select.down")) scroll++;
          else if (matchesKey(data, Key.pageUp)) scroll -= page;
          else if (matchesKey(data, Key.pageDown)) scroll += page;
          else if (matchesKey(data, Key.home)) scroll = 0;
          else if (matchesKey(data, Key.end)) scroll = Number.MAX_SAFE_INTEGER;
        } else {
          const visible = rows(), current = visible[cursor];
          notice = undefined;
          if (kb.matches(data, "tui.select.up")) cursor = Math.max(0, cursor - 1);
          else if (kb.matches(data, "tui.select.down")) cursor = Math.min(visible.length - 1, cursor + 1);
          else if (matchesKey(data, Key.pageUp)) cursor = Math.max(0, cursor - page);
          else if (matchesKey(data, Key.pageDown)) cursor = Math.min(visible.length - 1, cursor + page);
          else if (matchesKey(data, Key.home)) cursor = 0;
          else if (matchesKey(data, Key.end)) cursor = visible.length - 1;
          else if (current && matchesKey(data, Key.right)) expanded.add(current.turn.id);
          else if (current && matchesKey(data, Key.left)) {
            expanded.delete(current.turn.id);
            cursor = rows().findIndex((row) => row.turn.id === current.turn.id);
          } else if (current && matchesKey(data, Key.space) && !current.turn.unavailable) {
            setMode(current.turn, selected.has(current.turn.id) ? "prose" : "pruned");
            cursor = visible.findIndex((row) => row.turn.id === current.turn.id);
          } else if (current && matchesKey(data, "f") && !current.turn.unavailable) {
            const cycle: TurnMode[] = current.turn.deferred ? ["pruned", "prose"] : ["pruned", "prose", "tools", "full"];
            const next = cycle[(cycle.indexOf(modeOf(current.turn)) + 1) % cycle.length];
            try {
              if (next === "tools" || next === "full") current.turn.fidelityInfo?.(next);
              setMode(current.turn, next);
              cursor = visible.findIndex((row) => row.turn.id === current.turn.id);
            } catch (error) { notice = error instanceof Error ? error.message : String(error); }
          } else if (kb.matches(data, "tui.select.confirm")) {
            const changes = turns.filter((turn) => !turn.unavailable &&
              (modeOf(turn) !== originalMode(turn) || (!!turn.selected && !selected.has(turn.id))));
            review = [
              ...changes.flatMap((turn): PreviewLine[] => {
                const checked = selected.has(turn.id), mode = modeOf(turn);
                const action = turn.deferred && checked ? "Pending exclusion (recent tail unchanged)"
                  : checked ? "Prune" : turn.filtered ? "Restore" : turn.selected && mode === "prose" ? "Cancel pre-flag (keep turn)" : "Change mode";
                const before = originalMode(turn);
                const asContent = (lines: string[]): PreviewLine[] => lines.flatMap((line) => line.split("\n")).map((text) => ({ text, kind: "content" }));
                let content: PreviewLine[];
                if ((before === "tools" || before === "full") && (mode === "pruned" || mode === "prose")) {
                  let previous: string[];
                  try { previous = turn.fidelityInfo?.(before).lines ?? turn.lines; }
                  catch (error) { previous = [`Original native group unavailable: ${String(error)}`]; }
                  content = [{ text: "Current native content being removed:", kind: "note" }, ...asContent(previous)];
                  if (mode === "prose") content.push({ text: "Retained as PROSE (subject to the cap):", kind: "note" }, ...asContent(turn.lines));
                } else content = asContent(turn.deferred ? [turn.label] : mode === "tools" || mode === "full" ? turn.fidelityInfo?.(mode).lines ?? turn.lines : turn.lines);
                return [{ text: `${action}: turn ${turn.id} (${MODE_LABELS[before]} → ${MODE_LABELS[mode]})`, kind: "heading" },
                  ...content, { text: "", kind: "content" }];
              }),
              ...(changes.length ? [] : [{ kind: "note" as const, text: selected.size ? "No changes; previously filtered turns remain excluded."
                : "No filtering changes. Keep the current checkpoint." }])];
            scroll = 0;
          }
        }
        tui.requestRender();
      },
      invalidate() { wrappedReview = undefined; },
      dispose() { signal.removeEventListener("abort", abort); },
    };
  });
}

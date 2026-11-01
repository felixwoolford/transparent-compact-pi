import { stripVTControlCharacters } from "node:util";
import { matchesKey, Key, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { FILTER_MARKER } from "./checkpoint-cap.js";
import type { SpanContent, ToolLines } from "./checkpoint-cap.js";
export { FILTER_MARKER } from "./checkpoint-cap.js";

export const FILTER_REQUEST = "transparent-compact:filter-turns";
export const FILTER_EXPLANATION = "`[Turn manually filtered]` marks a user turn and its following agent/tool activity that the user chose to exclude as low-value context. Its contents remain retrievable from the full history. Do not recover filtered turns unless needed for the current task.";
export interface TurnSpan extends SpanContent { turnIds?: (string | null)[] }

/** Raw user boundaries, not projected message roles, define a whole turn. */
export function turnOwners(entries: SessionEntry[]): Map<string, string | null> {
  let owner: string | null = null;
  return new Map(entries.map((entry) => {
    if (entry.type === "message" && entry.message.role === "user") owner = entry.id;
    return [entry.id, owner];
  }));
}

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
  unavailable?: string;
}

const displayText = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** Tree-like whole-turn selection followed by a scrollable, complete preview.
 * Subentries are inspection-only: space always toggles their owning user turn.
 */
export async function pickFilteredTurns(ctx: ExtensionContext, turns: FilterTurn[], signal: AbortSignal): Promise<string[] | undefined> {
  return ctx.ui.custom<string[] | undefined>((tui, theme, kb, done) => {
    const selected = new Set<string>(), expanded = new Set<string>();
    let cursor = 0, top = 0, review: string[] | undefined, scroll = 0;
    let wrappedReview: { width: number; source: string[]; lines: string[] } | undefined;
    const rows = () => turns.flatMap((turn) => [
      { turn, child: false, text: turn.label },
      ...(expanded.has(turn.id) ? turn.lines.slice(1).map((text) => ({ turn, child: true, text })) : []),
    ]);
    const finish = (value: string[] | undefined) => { signal.removeEventListener("abort", abort); done(value); };
    const abort = () => finish(undefined);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) queueMicrotask(abort);
    return {
      render(width: number): string[] {
        const height = Math.max(1, tui.terminal.rows - 7);
        const out = [theme.fg("accent", review
          ? `Confirm filtering ${selected.size} turn(s) — checkpoint content to exclude:`
          : `Filter checkpoint turns — ${selected.size} selected for deletion`)];
        if (review) {
          if (wrappedReview?.width !== width || wrappedReview.source !== review)
            wrappedReview = { width, source: review, lines: review.flatMap((line) => wrapTextWithAnsi(displayText(line), Math.max(1, width))) };
          const wrapped = wrappedReview.lines;
          scroll = Math.max(0, Math.min(scroll, wrapped.length - height));
          out.push(...wrapped.slice(scroll, scroll + height));
          out.push(theme.fg("dim", `${scroll + 1}–${Math.min(scroll + height, wrapped.length)} / ${wrapped.length} lines`));
          out.push(theme.fg("warning", "Enter: confirm and compact · Esc: back · ↑/↓/PgUp/PgDn/Home/End: scroll"));
        } else {
          const visible = rows();
          cursor = Math.max(0, Math.min(cursor, visible.length - 1));
          top = Math.max(0, Math.min(top, cursor));
          if (cursor >= top + height) top = cursor - height + 1;
          for (let i = top; i < Math.min(top + height, visible.length); i++) {
            const { turn, child, text } = visible[i];
            const prefix = child ? "      └ " : `${expanded.has(turn.id) ? "▾" : "▸"} [${turn.unavailable ? "-" : selected.has(turn.id) ? "x" : " "}] `;
            const reason = !child && turn.unavailable ? `(${turn.unavailable}) ` : "";
            const line = `${i === cursor ? "> " : "  "}${prefix}${reason}${displayText(text).replace(/\s+/g, " ")}`;
            out.push(theme.fg(turn.unavailable ? "dim" : selected.has(turn.id) ? "warning" : "text", truncateToWidth(line, width)));
          }
          out.push(theme.fg("dim", "↑/↓: move · Space: toggle whole turn · ←/→: collapse/expand · Enter: review · Esc: cancel"));
          out.push(theme.fg("dim", "Unchecked turns stay. Original history is unchanged. Recent-tail turns cannot be filtered."));
        }
        return out.map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        const page = Math.max(1, tui.terminal.rows - 7);
        if (kb.matches(data, "tui.select.cancel")) {
          if (review) { review = undefined; scroll = 0; } else { finish(undefined); return; }
        } else if (review) {
          if (kb.matches(data, "tui.select.confirm")) { finish([...selected]); return; }
          if (kb.matches(data, "tui.select.up")) scroll--;
          else if (kb.matches(data, "tui.select.down")) scroll++;
          else if (matchesKey(data, Key.pageUp)) scroll -= page;
          else if (matchesKey(data, Key.pageDown)) scroll += page;
          else if (matchesKey(data, Key.home)) scroll = 0;
          else if (matchesKey(data, Key.end)) scroll = Number.MAX_SAFE_INTEGER;
        } else {
          const visible = rows(), current = visible[cursor];
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
            if (!selected.delete(current.turn.id)) selected.add(current.turn.id);
          } else if (kb.matches(data, "tui.select.confirm")) {
            review = ["Each selected group will be replaced by [Turn manually filtered]. Full history remains retrievable.", "",
              ...(selected.size ? turns.filter((turn) => selected.has(turn.id)).flatMap((turn) => [
                `--- Turn ${turn.id} ---`, ...turn.lines.flatMap((line) => line.split("\n")), "",
              ]) : ["No turns selected. Proceed with ordinary verbatim compaction."])];
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

/** Pure checkpoint presentation and progressive size guard. No Pi, filesystem,
 * model calls, or session mutation. Canonical span lines/records are never edited.
 */
export const TOOL_PREFIX = "[Tools]: ";
export const FILTER_MARKER = "[Turn manually filtered]";
import { NORMAL_PREVIEW_CHARS, headPrefix, commandPreview } from "./tool-stubs/display.mjs";
export { NORMAL_PREVIEW_CHARS, commandPreview };
export const TIGHTENED_ATTR = ' tools-tightened="true"';

// Encoded display fragments, NOT full commands or executable arguments.
// Retain the original prefix for every smaller head-only preview.
export interface CommandPreview { head: string; truncated?: boolean }
export interface ToolStub {
  prefix: string;
  command?: CommandPreview;
  suffix: string;
  /** Authoritative dictionary references, never inferred by scanning prose. */
  locations?: string[];
}
export interface ToolLine {
  index: number;
  calls: ToolStub[];
  /** Both adjacent messages must be tool-only before prefixes may be folded. */
  mergeable: boolean;
  prefix?: string;
}
export interface ToolLines { version: 2; lines: ToolLine[] }
export interface SpanContent { lines: string[]; tools?: ToolLines; protectedLines?: number[] }
export interface CappedSpans { lines: string[][]; tightened: boolean[]; trimmed: boolean[]; locationIds: string[] }
export function renderCommand(preview: CommandPreview, max = NORMAL_PREVIEW_CHARS): string {
  return headPrefix(preview.head, max) + (preview.truncated || preview.head.length > max ? "…" : "");
}
export function renderToolStub(stub: ToolStub, max = NORMAL_PREVIEW_CHARS): string {
  return stub.prefix + (stub.command ? renderCommand(stub.command, max) : "") + stub.suffix;
}
export function renderToolLine(calls: ToolStub[], max = NORMAL_PREVIEW_CHARS, prefix = TOOL_PREFIX): string {
  return prefix + calls.map((call) => renderToolStub(call, max)).join("; ");
}

// Stored records are optional/versioned. Require exact canonical round-tripping
// before using one; missing or invalid records leave text opaque.
function toolRecords(span: SpanContent): Map<number, ToolLine> {
  const records = new Map<number, ToolLine>();
  try {
    const tools = span.tools;
    if (!tools || tools.version !== 2 || !Array.isArray(tools.lines)) return records;
    const seen = new Set<number>();
    for (const record of tools.lines) {
      if (!record || !Number.isSafeInteger(record.index) || record.index < 0 || record.index >= span.lines.length) continue;
      if (seen.has(record.index)) { records.delete(record.index); continue; }
      seen.add(record.index);
      if (typeof record.mergeable !== "boolean" || !Array.isArray(record.calls) || !record.calls.length ||
          (record.prefix !== undefined && record.prefix !== TOOL_PREFIX && record.prefix !== "[BashExecution]: ")) continue;
      const valid = record.calls.every((call) => {
        if (!call || typeof call.prefix !== "string" || typeof call.suffix !== "string") return false;
        if (call.locations !== undefined && (!Array.isArray(call.locations) || !call.locations.every((id) => typeof id === "string" && /^@\d+$/.test(id)))) return false;
        const p = call.command;
        if (p === undefined) return true;
        if (!p || typeof p.head !== "string") return false;
        return p.head.length <= NORMAL_PREVIEW_CHARS &&
          (p.truncated === undefined || typeof p.truncated === "boolean") &&
          (p.truncated !== true || p.head.length >= NORMAL_PREVIEW_CHARS - 1);
      });
      if (valid && renderToolLine(record.calls, NORMAL_PREVIEW_CHARS, record.prefix) === span.lines[record.index]) records.set(record.index, record);
    }
  } catch { return new Map(); }
  return records;
}

interface Row {
  index: number;
  protected: boolean;
  text: string;
  calls?: ToolStub[];
  mergeable: boolean;
  preview: number;
  prefix: string;
  foldPrefix: boolean;
  tightened: boolean;
}

/** Stop as soon as the budget fits: 120-char previews, then 80, adjacent
 * tool-only prefixes, and finally the historical destructive cap.
 * Every rung walks oldest first, across all spans (not just the new one).
 */
export function capSpans(spans: SpanContent[], budget = Infinity, extraChars: (ids: string[]) => number = () => 0,
  guidance: (text: string) => string = (text) => text): CappedSpans {
  const tightened = spans.map(() => false), trimmed = spans.map(() => false);
  const records = spans.map(toolRecords);
  const references = (calls: ToolStub[]) => [...new Set(calls.flatMap((call) => call.locations ?? []))];
  const initialIds = references(records.flatMap((map) => [...map.values()].flatMap((record) => record.calls)));
  let size = spans.reduce((n, span) => n + span.lines.reduce((s, line) => s + line.length + 1, 0), 0) + extraChars(initialIds);
  if (size <= budget) return { lines: spans.map((s) => s.lines.slice()), tightened, trimmed, locationIds: initialIds };
  const states = spans.map((span, spanIndex) => {
    const ownRecords = records[spanIndex];
    return span.lines.map((text, index): Row => {
      const record = ownRecords.get(index);
      return { index, protected: span.protectedLines?.includes(index) ?? false, text, calls: record?.calls.slice(), mergeable: record?.mergeable ?? false,
        preview: NORMAL_PREVIEW_CHARS, prefix: record?.prefix ?? TOOL_PREFIX, foldPrefix: false, tightened: false };
    });
  });
  const joined = (rows: Row[], i: number) => i > 0 && rows[i].foldPrefix && rows[i].calls && rows[i - 1].calls &&
    rows[i].mergeable && rows[i - 1].mergeable && rows[i].prefix === TOOL_PREFIX && rows[i - 1].prefix === TOOL_PREFIX && rows[i].index === rows[i - 1].index + 1;
  const currentIds = () => references(states.flatMap((rows) => rows.flatMap((row) => row.calls ?? [])));
  const measure = () => states.reduce((n, rows) => n + rows.reduce((s, row, i) =>
    s + row.text.length + 1 - (joined(rows, i) ? TOOL_PREFIX.length - 1 : 0), 0), 0) + extraChars(currentIds());
  const finish = (): CappedSpans => ({
    lines: states.map((rows, span) => {
      const lines: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (joined(rows, i)) lines[lines.length - 1] += `; ${row.text.slice(TOOL_PREFIX.length)}`;
        else lines.push(row.text);
        if (row.tightened || joined(rows, i)) tightened[span] = true;
      }
      return lines;
    }), tightened, trimmed, locationIds: currentIds(),
  });
  const render = (row: Row) => renderToolLine(row.calls!, row.preview, row.prefix);
  const update = (row: Row) => {
    const text = render(row);
    if (text.length < row.text.length) {
      size += text.length - row.text.length;
      row.text = text;
      row.tightened = true;
    }
  };
  for (const max of [120, 80]) {
    for (const rows of states) for (const row of rows) {
      if (!row.calls?.some((call) => call.command)) continue;
      row.preview = max;
      update(row);
      if (size <= budget) return finish();
    }
  }
  for (const rows of states) for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    row.foldPrefix = true;
    if (joined(rows, i)) size -= TOOL_PREFIX.length - 1;
    if (size <= budget) return finish();
  }

  // No presentation-only rung fits. Keep calls independently removable even
  // when their prefixes are folded; never cap a giant concatenated tool line.
  for (let span = 0; span < states.length && size > budget; span++) {
    const rows = states[span];
    for (let i = 0; i < rows.length && size > budget;) {
      const row = rows[i];
      if (row.protected || row.text.startsWith("[User]:") || row.text === FILTER_MARKER) { i++; continue; }
      if (row.calls && row.calls.length > 1) {
        row.calls.shift();
        row.text = render(row);
      } else rows.splice(i, 1);
      trimmed[span] = true;
      size = measure();
    }
  }
  // Stub each oversized user line once. Canonical lines remain untouched, so
  // later checkpoints never shorten an already shortened presentation again.
  for (let span = 0; span < states.length && size > budget; span++) {
    for (const row of states[span]) {
      if (size <= budget) break;
      const line = row.text;
      if (row.protected || !line.startsWith("[User]:") || line.length <= 120) continue;
      let end = 120;
      if (/[\uD800-\uDBFF]/.test(line[end - 1])) end--;
      const stub = `${line.slice(0, end)}${guidance(`…[truncated +${line.length - end} chars — use context_lookup]`)}`;
      if (stub.length >= line.length) continue;
      row.text = stub;
      trimmed[span] = true;
      size = measure();
    }
  }
  for (let span = 0; span < states.length && size > budget; span++) {
    while (size > budget) {
      const index = states[span].findIndex((row) => !row.protected && row.text !== FILTER_MARKER);
      if (index < 0) break;
      states[span].splice(index, 1);
      trimmed[span] = true;
      size = measure();
    }
  }
  return finish();
}

/** Pure checkpoint presentation and progressive size guard. No Pi, filesystem,
 * model calls, or session mutation. Canonical span lines/records are never edited.
 */
export const TOOL_PREFIX = "[Tools]: ";
export const NORMAL_PREVIEW_CHARS = 160;
export const TIGHTENED_ATTR = ' tools-tightened="true"';

// Encoded display fragments, NOT full commands or executable arguments. Retaining
// the original two ends lets every smaller preview derive from the same source.
export interface CommandPreview { head: string; tail?: string }
export interface ToolStub {
  prefix: string;
  command?: CommandPreview;
  suffix: string;
  ref?: string;
  /** Unknown evidence and history-bearing calls default to protected refs. */
  retainRef: boolean;
}
export interface ToolLine {
  index: number;
  calls: ToolStub[];
  /** Both adjacent messages must be tool-only before prefixes may be folded. */
  mergeable: boolean;
}
export interface ToolLines { version: 1; lines: ToolLine[] }
export interface SpanContent { lines: string[]; tools?: ToolLines }
export interface CappedSpans { lines: string[][]; tightened: boolean[]; trimmed: boolean[] }

function ends(head: string, tail: string, max: number): CommandPreview {
  let h = Math.floor((max - 1) * 0.62), t = tail.length - (max - h - 1);
  if (/[\uD800-\uDBFF]/.test(head[h - 1])) h--;
  if (/[\uDC00-\uDFFF]/.test(tail[t])) t++;
  return { head: head.slice(0, h), tail: tail.slice(t) };
}
export function commandPreview(encoded: string): CommandPreview {
  return encoded.length <= NORMAL_PREVIEW_CHARS ? { head: encoded } : ends(encoded, encoded, NORMAL_PREVIEW_CHARS);
}
export function renderCommand(preview: CommandPreview, max = NORMAL_PREVIEW_CHARS): string {
  const full = preview.head + (preview.tail === undefined ? "" : `…${preview.tail}`);
  if (full.length <= max) return full;
  const shorter = ends(preview.head, preview.tail ?? preview.head, max);
  return `${shorter.head}…${shorter.tail}`;
}
export function renderToolStub(stub: ToolStub, max = NORMAL_PREVIEW_CHARS, thinRefs = false): string {
  return stub.prefix + (stub.command ? renderCommand(stub.command, max) : "") + stub.suffix +
    (stub.ref && (!thinRefs || stub.retainRef) ? ` ref=${stub.ref}` : "");
}
export function renderToolLine(calls: ToolStub[], max = NORMAL_PREVIEW_CHARS, thinRefs = false): string {
  return TOOL_PREFIX + calls.map((call) => renderToolStub(call, max, thinRefs)).join("; ");
}

// Stored records are optional/versioned. Require exact canonical round-tripping
// before using one; legacy or malformed strings are opaque, never regex-rewritten.
function toolRecords(span: SpanContent): Map<number, ToolLine> {
  const records = new Map<number, ToolLine>();
  try {
    if (span.tools?.version !== 1 || !Array.isArray(span.tools.lines)) return records;
    const seen = new Set<number>();
    for (const record of span.tools.lines) {
      if (!record || !Number.isSafeInteger(record.index) || record.index < 0 || record.index >= span.lines.length) continue;
      if (seen.has(record.index)) { records.delete(record.index); continue; }
      seen.add(record.index);
      if (typeof record.mergeable !== "boolean" || !Array.isArray(record.calls) || !record.calls.length) continue;
      const valid = record.calls.every((call) => {
        if (!call || typeof call.prefix !== "string" || typeof call.suffix !== "string" || typeof call.retainRef !== "boolean" ||
          (call.ref !== undefined && (typeof call.ref !== "string" || !call.ref))) return false;
        const p = call.command;
        if (p === undefined) return true;
        if (!p || typeof p.head !== "string") return false;
        if (p.tail === undefined) return p.head.length <= NORMAL_PREVIEW_CHARS;
        // Smaller rungs must have enough of both original ends available.
        return typeof p.tail === "string" && p.head.length >= 97 && p.tail.length >= 60 &&
          p.head.length + p.tail.length + 1 <= NORMAL_PREVIEW_CHARS;
      });
      if (valid && renderToolLine(record.calls) === span.lines[record.index]) records.set(record.index, record);
    }
  } catch { return new Map(); }
  return records;
}

interface Row {
  index: number;
  text: string;
  calls?: ToolStub[];
  mergeable: boolean;
  preview: number;
  thinRefs: boolean;
  foldPrefix: boolean;
  tightened: boolean;
}

/** Stop as soon as the budget fits: 120-char previews, then 80, low-priority
 * refs, adjacent tool-only prefixes, and finally the historical destructive cap.
 * Every rung walks oldest first, across all spans (not just the new one).
 */
export function capSpans(spans: SpanContent[], budget = Infinity): CappedSpans {
  const tightened = spans.map(() => false), trimmed = spans.map(() => false);
  let size = spans.reduce((n, span) => n + span.lines.reduce((s, line) => s + line.length + 1, 0), 0);
  if (size <= budget) return { lines: spans.map((s) => s.lines.slice()), tightened, trimmed };
  const states = spans.map((span) => {
    const records = toolRecords(span);
    return span.lines.map((text, index): Row => {
      const record = records.get(index);
      return { index, text, calls: record?.calls.slice(), mergeable: record?.mergeable ?? false,
        preview: NORMAL_PREVIEW_CHARS, thinRefs: false, foldPrefix: false, tightened: false };
    });
  });
  const joined = (rows: Row[], i: number) => i > 0 && rows[i].foldPrefix && rows[i].calls && rows[i - 1].calls &&
    rows[i].mergeable && rows[i - 1].mergeable && rows[i].index === rows[i - 1].index + 1;
  const measure = () => states.reduce((n, rows) => n + rows.reduce((s, row, i) =>
    s + row.text.length + 1 - (joined(rows, i) ? TOOL_PREFIX.length - 1 : 0), 0), 0);
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
    }), tightened, trimmed,
  });
  const render = (row: Row) => renderToolLine(row.calls!, row.preview, row.thinRefs);
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
  for (const rows of states) for (const row of rows) {
    if (!row.calls?.some((call) => call.ref && !call.retainRef)) continue;
    row.thinRefs = true;
    update(row);
    if (size <= budget) return finish();
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
      if (row.text.startsWith("[User]:")) { i++; continue; }
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
      if (!line.startsWith("[User]:") || line.length <= 120) continue;
      let end = 120;
      if (/[\uD800-\uDBFF]/.test(line[end - 1])) end--;
      const stub = `${line.slice(0, end)}…[truncated +${line.length - end} chars — use context_lookup]`;
      if (stub.length >= line.length) continue;
      row.text = stub;
      trimmed[span] = true;
      size = measure();
    }
  }
  for (let span = 0; span < states.length && size > budget; span++) {
    while (states[span].length && size > budget) {
      states[span].shift();
      trimmed[span] = true;
      size = measure();
    }
  }
  return finish();
}

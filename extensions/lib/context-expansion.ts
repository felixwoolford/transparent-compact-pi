/** Quote-to-expand backend. No tool registration, prompts, model calls, or writes.
 * Targets come from renderer provenance, never from parsing checkpoint text.
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type ExpansionSource = (
  | { kind: "tool"; entryId: string; blockIndex: number; callId: string; name: string }
  | { kind: "prose" | "bash"; entryId: string }
) & { digest: string };
export interface ExpansionAnchor { index: number; source: ExpansionSource; callIndex?: number }
export interface ExpansionTarget { text: string; source: ExpansionSource }
export interface ExpansionQuery { text: string; selector?: string; cursor?: string }
export interface ExpansionCandidate {
  selector: string;
  kind: ExpansionSource["kind"];
  preview: string;
  before?: string;
  after?: string;
}
export type ExpansionResult =
  | { status: "not-found" }
  | { status: "invalid"; reason: "query" | "selector" | "cursor" }
  | { status: "unavailable" }
  | { status: "ambiguous"; total: number; candidates: ExpansionCandidate[]; nextCursor?: string }
  | { status: "expanded"; kind: ExpansionSource["kind"]; entryIds: string[]; content: string; nextCursor?: string };

export function remapExpansionAnchors(anchors: ExpansionAnchor[] | undefined, indices: Map<number, number>): ExpansionAnchor[] | undefined {
  return anchors?.filter((anchor) => indices.has(anchor.index)).map((anchor) => ({ ...anchor, index: indices.get(anchor.index)! }));
}

// Pair by call ID AND tool name. Concurrent duplicate IDs stay ambiguous;
// sequential reuse is allowed only after consuming a result.
export function pairedToolResults(messages: AgentMessage[]): Map<object, Record<string, any>> {
  const results = new Map<object, Record<string, any>>();
  const pending = new Map<string, { block: object; name: string } | null>();
  for (const message of messages) {
    const m = message as unknown as Record<string, any>;
    if (m.role === "assistant") {
      for (const block of m.content ?? []) {
        if (block.type !== "toolCall" || typeof block.id !== "string" || !block.id) continue;
        pending.set(block.id, pending.has(block.id) ? null : { block, name: block.name });
      }
    } else if (m.role === "toolResult") {
      const call = pending.get(m.toolCallId);
      if (!call || call.name !== m.toolName) continue;
      results.set(call.block, m);
      pending.delete(m.toolCallId);
    }
  }
  return results;
}

function textContent(content: unknown, separator = ""): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join(separator) : "";
}
const imageCount = (content: unknown) => Array.isArray(content) ? content.filter((block) => block?.type === "image").length : 0;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
export const expansionDigest = hash;
function head(text: string, length: number): string {
  let end = Math.min(length, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}
// A quoted count, location or range must not join digits from a larger number.
function containsQuote(text: string, quote: string): boolean {
  const numericStart = /^\d/.test(quote), numericEnd = /\d$/.test(quote);
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    if ((numericStart && /\d/.test(text[at - 1] ?? "")) ||
      (numericEnd && /\d/.test(text[at + quote.length] ?? ""))) continue;
    return true;
  }
  return false;
}
function preview(entry: SessionEntry): string {
  if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return "";
  const value = textContent(entry.message.content, "\n").trim();
  return value ? head(value, 160) : "";
}
function neighbours(entries: readonly SessionEntry[], at: number): { before?: string; after?: string } {
  const result: { before?: string; after?: string } = {};
  if (at < 0) return result;
  for (const [key, step] of [["before", -1], ["after", 1]] as const) {
    for (let i = at + step; i >= 0 && i < entries.length; i += step) {
      const text = preview(entries[i]);
      if (text) { result[key] = text; break; }
    }
  }
  return result;
}
function cursor(key: string, offset: number): string {
  return Buffer.from(JSON.stringify({ key, offset })).toString("base64url");
}
function offsetOf(value: string | undefined, key: string): number | undefined {
  if (value === undefined) return 0;
  if (typeof value !== "string" || value.length > 256 || !/^[\w-]+$/.test(value)) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return decoded.key === key && Number.isSafeInteger(decoded.offset) && decoded.offset >= 0 ? decoded.offset : undefined;
  } catch { return undefined; }
}

/** Literal, case-sensitive matching of a displayed fragment, not history search.
 * Selectors exist only in results; cursors bind the query and exact backing data.
 * The tool adapter formats these results without changing the recovered content.
 */
export function expandTargets(entries: readonly SessionEntry[], targets: readonly ExpansionTarget[], query: ExpansionQuery,
  limits: { maxChars?: number; maxCandidates?: number } = {}): ExpansionResult {
  if (!query || typeof query.text !== "string" || !query.text.trim() || query.text.length > 4000)
    return { status: "invalid", reason: "query" };
  const maxChars = limits.maxChars ?? 12000, maxCandidates = limits.maxCandidates ?? 8;
  if (!Number.isSafeInteger(maxChars) || maxChars < 2 || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1)
    throw new Error("Invalid expansion limits.");
  const quote = query.text.trim().replace(/^\[Tools\]:\s*/, "");
  if (!quote) return { status: "invalid", reason: "query" };
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  const matches: { target: ExpansionTarget; candidate: ExpansionCandidate }[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (!containsQuote(target.text, quote)) continue;
    const adjacent = neighbours(entries, positions.get(target.source.entryId) ?? -1);
    const selector = hash([quote, target.source]);
    if (seen.has(selector)) continue;
    seen.add(selector);
    matches.push({ target, candidate: { selector, kind: target.source.kind, preview: head(target.text, 200), ...adjacent } });
  }
  if (!matches.length) return query.selector === undefined ? { status: "not-found" } : { status: "invalid", reason: "selector" };
  const selected = query.selector === undefined ? (matches.length === 1 ? matches[0] : undefined)
    : matches.find((match) => match.candidate.selector === query.selector);
  if (query.selector !== undefined && !selected) return { status: "invalid", reason: "selector" };
  if (!selected) {
    const key = hash(["matches", matches.map((match) => match.candidate)]), offset = offsetOf(query.cursor, key);
    if (offset === undefined || offset >= matches.length) return { status: "invalid", reason: "cursor" };
    const candidates = matches.slice(offset, offset + maxCandidates).map((match) => match.candidate);
    const end = offset + candidates.length;
    return { status: "ambiguous", total: matches.length, candidates, ...(end < matches.length ? { nextCursor: cursor(key, end) } : {}) };
  }
  const source = selected.target.source, entry = entries[positions.get(source.entryId) ?? -1];
  if (!entry || entry.type !== "message") return { status: "unavailable" };
  const m = entry.message as unknown as Record<string, any>;
  const entryIds = [entry.id];
  let content: string;
  if (source.kind === "tool") {
    const call = m.role === "assistant" && m.content?.[source.blockIndex];
    if (!call || call.type !== "toolCall" || call.id !== source.callId || call.name !== source.name ||
      hash([call.name, call.id, call.arguments ?? {}]) !== source.digest) return { status: "unavailable" };
    const messages = entries.filter((e) => e.type === "message").map((e) => e.message);
    const result = pairedToolResults(messages).get(call);
    const resultEntry = result && entries.find((e) => e.type === "message" && e.message === result);
    if (resultEntry) entryIds.push(resultEntry.id);
    content = JSON.stringify({ call: { name: call.name, arguments: call.arguments ?? {} }, result: result ? {
      toolName: result.toolName, isError: result.isError, text: textContent(result.content),
      imagesOmitted: imageCount(result.content), ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    } : null }, null, 2);
  } else if (source.kind === "bash") {
    if (m.role !== "bashExecution" || hash([m.command ?? "", m.output ?? ""]) !== source.digest) return { status: "unavailable" };
    content = JSON.stringify({ command: m.command, output: m.output, exitCode: m.exitCode, cancelled: m.cancelled, truncated: m.truncated }, null, 2);
  } else {
    if (m.role !== "user" && m.role !== "assistant") return { status: "unavailable" };
    content = textContent(m.content, m.role === "assistant" ? "\n" : "");
    if (hash(m.role === "assistant" ? content.trim() : m.content) !== source.digest) return { status: "unavailable" };
  }
  const key = hash(["content", selected.candidate.selector, entryIds, content]), offset = offsetOf(query.cursor, key);
  if (offset === undefined || (offset >= content.length && !(offset === 0 && content.length === 0)) ||
    (offset > 0 && /[\uD800-\uDBFF]/.test(content[offset - 1]) && /[\uDC00-\uDFFF]/.test(content[offset])))
    return { status: "invalid", reason: "cursor" };
  const page = head(content.slice(offset), maxChars), end = offset + page.length;
  return { status: "expanded", kind: source.kind, entryIds, content: page, ...(end < content.length ? { nextCursor: cursor(key, end) } : {}) };
}

/** Procedural guidance appears only in tool results, when it is needed. */
export function formatExpansionResult(result: ExpansionResult): string {
  let text: string;
  switch (result.status) {
    case "expanded":
      text = `Historical expansion (ENTRY ${result.entryIds.join(", ")}):\n${result.content}`;
      break;
    case "ambiguous":
      text = `${result.total} matches. To expand one, repeat the same text with its selector, omitting cursor.\n\n` +
        result.candidates.map((candidate) => [
          `selector: ${candidate.selector}`,
          `preview: ${JSON.stringify(candidate.preview)}`,
          ...(candidate.before ? [`before: ${JSON.stringify(candidate.before)}`] : []),
          ...(candidate.after ? [`after: ${JSON.stringify(candidate.after)}`] : []),
        ].join("\n")).join("\n\n");
      break;
    case "not-found":
      return "No matching fragment in the current checkpoint. Use context_lookup if recovery is still needed.";
    case "unavailable":
      return "The original source is unavailable. Use context_lookup if recovery is still needed.";
    case "invalid":
      return result.reason === "query" ? "context_expand failed: invalid text." :
        "Invalid selector or cursor. Repeat the original text without selector or cursor.";
  }
  if (result.nextCursor) text += `\n\nMore content is available. Continue only if needed using the returned cursor; keep text and selector unchanged.\ncursor: ${result.nextCursor}`;
  return text;
}

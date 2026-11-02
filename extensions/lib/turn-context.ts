import { uuidv7 } from "@earendil-works/pi-ai";
import { buildSessionProjection, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnSpan } from "./turn-filter.js";

export type Fidelity = "tools" | "full";
export type TurnMode = "pruned" | "prose" | Fidelity;
export type TurnFidelities = Record<string, Fidelity>;
export interface TurnSelection { pruned: string[]; fidelity: TurnFidelities }
export interface TurnSlot { turnId: string; mode: Fidelity; offset: number; marker: string }
export const MODE_LABELS: Record<TurnMode, string> = { pruned: "PRUNED", prose: "PROSE", tools: "PROSE+TOOLS", full: "FULL" };
export const MODE_SYMBOLS: Record<TurnMode, string> = { pruned: "X", prose: " ", tools: "○", full: "■" };
export const FIDELITY_EXPLANATION = "Selected PROSE+TOOLS/FULL turns are inserted as original context messages at their labelled positions, replacing their compacted copies. PROSE+TOOLS replaces recorded thinking blocks with [Thinking omitted]; FULL retains all recorded thinking. They are not shortened by the prose cap. Provider/model compatibility transformations still apply. Historical content and thinking are not verification of current facts.";
/** Raw user boundaries define whole turns, independent of context edits. */
export function turnOwners(entries: SessionEntry[]): Map<string, string | null> {
  let owner: string | null = null;
  return new Map(entries.map((entry) => {
    if (entry.type === "message" && entry.message.role === "user") owner = entry.id;
    return [entry.id, owner];
  }));
}
const managed = (m: AgentMessage) => m.role === "custom" && m.customType === "transparent-compact:reorient";

/** Disable only compaction in Pi's projection, preserving the branch topology,
 * custom-message conversion and explicit context edits. No raw body is copied
 * into checkpoint metadata, and omitted/replaced content is never resurrected.
 */
export function originalProjection(entries: SessionEntry[]) {
  const uncompacted = entries.map((entry): SessionEntry => entry.type === "compaction"
    ? { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, type: "custom", customType: "transparent-compact:projection-boundary", data: null }
    : entry);
  return buildSessionProjection(uncompacted).entries;
}

function validateTools(messages: AgentMessage[], id: string): void {
  const pending = new Map<string, string>(), seen = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (pending.size) throw new Error(`Turn ${id} has incomplete tool-call/result groups; choose PROSE instead.`);
      for (const block of msg.content) if (block.type === "toolCall") {
        if (seen.has(block.id)) throw new Error(`Turn ${id} has ambiguous tool-call ids; choose PROSE instead.`);
        seen.add(block.id); pending.set(block.id, block.name);
      }
    } else if (msg.role === "toolResult") {
      if (pending.get(msg.toolCallId) !== msg.toolName)
        throw new Error(`Turn ${id} has an orphaned tool result (possibly from a context edit); choose PROSE instead.`);
      pending.delete(msg.toolCallId);
    }
  }
  if (pending.size) throw new Error(`Turn ${id} has incomplete tool-call/result groups; choose PROSE instead.`);
}

export function fidelityMessages(entries: SessionEntry[], fidelity: TurnFidelities, boundary: string): Map<string, AgentMessage[]> {
  const owners = turnOwners(entries), cut = entries.findIndex((e) => e.id === boundary);
  if (cut < 0) throw new Error("Cannot locate the retained context boundary.");
  const groups = new Map(Object.keys(fidelity).map((id) => [id, [] as AgentMessage[]]));
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  for (const { sourceEntry, messages } of originalProjection(entries)) {
    const id = owners.get(sourceEntry.id);
    if (!id || !groups.has(id)) continue;
    const content = messages.filter((m) => m.role !== "system" && !managed(m) && !(m.role === "bashExecution" && m.excludeFromContext));
    if (!content.length) continue;
    if (positions.get(sourceEntry.id)! >= cut) throw new Error(`Turn ${id} still overlaps the retained recent tail.`);
    groups.get(id)!.push(...content);
  }
  for (const [id, messages] of groups) {
    if (fidelity[id] !== "tools" && fidelity[id] !== "full") throw new Error(`Unknown fidelity mode for turn ${id}.`);
    if (!messages.length || messages[0].role !== "user") throw new Error(`Original user turn ${id} is unavailable or explicitly omitted.`);
    validateTools(messages, id);
    if (fidelity[id] === "tools") groups.set(id, messages.map((msg) => msg.role !== "assistant" ? msg : { ...msg,
      content: msg.content.map((block) => block.type === "thinking" ? { type: "text" as const, text: "[Thinking omitted]" } : block) }));
  }
  return groups;
}

/** Replace every compacted copy, across span boundaries, with one protected
 * slot. The random marker is generated, not interpreted from historical text.
 */
export function fidelitySpans<T extends TurnSpan>(spans: T[], fidelity: TurnFidelities) {
  const markers = new Map<string, string>();
  const result = spans.map((span) => {
    const lines: string[] = [], turnIds: (string | null)[] = [], protectedLines: number[] = [], indices = new Map<number, number>();
    span.lines.forEach((line, index) => {
      const owner = span.turnIds?.[index] ?? null;
      if (owner && fidelity[owner]) {
        if (!markers.has(owner)) {
          const marker = `[Full-fidelity turn ${owner}: ${MODE_LABELS[fidelity[owner]]}; slot ${uuidv7()}]`;
          markers.set(owner, marker); protectedLines.push(lines.length); lines.push(marker); turnIds.push(owner);
        }
      } else { indices.set(index, lines.length); lines.push(line); turnIds.push(owner); }
    });
    const tools = span.tools && { ...span.tools, lines: span.tools.lines.filter((r) => indices.has(r.index))
      .map((r) => ({ ...r, index: indices.get(r.index)! })) };
    return { ...span, lines, turnIds, tools, protectedLines };
  });
  for (const id of Object.keys(fidelity)) if (!markers.has(id)) throw new Error(`Turn ${id} has no editable checkpoint position.`);
  return { spans: result, markers };
}

export function locateSlots(summary: string, markers: Map<string, string>, fidelity: TurnFidelities): TurnSlot[] {
  return [...markers].map(([turnId, marker]) => {
    const offset = summary.indexOf(marker);
    if (offset < 0 || offset !== summary.lastIndexOf(marker)) throw new Error(`Full-fidelity placement for ${turnId} was lost or duplicated.`);
    return { turnId, mode: fidelity[turnId], offset, marker };
  }).sort((a, b) => a.offset - b.offset);
}

const expanded = new WeakMap<AgentMessage, string>();
export function isExpandedCheckpoint(message: AgentMessage, summary: string): boolean {
  const previous = expanded.get(message);
  if (previous !== undefined && previous !== summary) throw new Error("Stale full-fidelity projection; rebuild context from the session before continuing.");
  return previous === summary;
}

export function expandCheckpoint(message: Extract<AgentMessage, { role: "compactionSummary" }>, summary: string,
  slots: TurnSlot[], fidelity: TurnFidelities, entries: SessionEntry[], boundary: string): AgentMessage[] {
  if (!Object.keys(fidelity).length) return [{ ...message, summary }];
  const groups = fidelityMessages(entries, fidelity, boundary), output: AgentMessage[] = [], seen = new Set<string>();
  let from = 0, ending = "";
  for (const slot of slots) {
    if (!Number.isSafeInteger(slot.offset) || typeof slot.marker !== "string" || !slot.marker || slot.offset < from || summary.slice(slot.offset, slot.offset + slot.marker.length) !== slot.marker ||
        slot.mode !== fidelity[slot.turnId] || seen.has(slot.turnId) || !groups.has(slot.turnId))
      throw new Error("Full-fidelity checkpoint placements are inconsistent; revise turn modes before continuing.");
    output.push({ ...message, summary: ending + summary.slice(from, slot.offset) + `\n[Full-fidelity turn ${slot.turnId}: ${MODE_LABELS[slot.mode]}]\n` });
    // Request-local copies: later transforms must not mutate saved records.
    output.push(...groups.get(slot.turnId)!.map((item) => structuredClone(item)));
    ending = `\n[End full-fidelity turn ${slot.turnId}]\n`;
    seen.add(slot.turnId); from = slot.offset + slot.marker.length;
  }
  if (seen.size !== groups.size) throw new Error("Full-fidelity checkpoint has missing placements; revise turn modes before continuing.");
  output.push({ ...message, summary: ending + summary.slice(from) });
  for (const item of output) if (item.role === "compactionSummary") expanded.set(item, summary);
  return output;
}

export interface NoticeTokens { pruning: number; revision: number; fidelity: number }
export interface ContextEstimate {
  tokens: number;
  contextWindow?: number;
  reserve: number;
  headroom?: number;
  delta?: number;
  tailTokens?: number;
  noticeTokens?: NoticeTokens;
  noticeDelta?: NoticeTokens;
  shortening?: "automatic" | "confirmation";
}
export type ContextEstimator = (selection: TurnSelection) => Promise<ContextEstimate>;
export const contextReserve = (ctx: ExtensionContext) => Math.min(ctx.model?.maxTokens || 16384, 16384) + 4096;
export function estimateContext(messages: AgentMessage[], ctx: ExtensionContext): ContextEstimate {
  const tokens = messageTokens(messages), contextWindow = ctx.model?.contextWindow, reserve = contextReserve(ctx);
  return { tokens, contextWindow, reserve, headroom: contextWindow ? contextWindow - tokens - reserve : undefined };
}

export const messageTokens = (messages: AgentMessage[]) => messages.reduce((sum, m) => sum + (m.role === "bashExecution" && m.excludeFromContext ? 0 : estimateTokens(m) + 8), 0);

/** Estimates, not a provider tokenizer. Keep output/framing headroom and check
 * again on each actual request, including its restored system/tool messages.
 */
export function checkContextBudget(messages: AgentMessage[], ctx: ExtensionContext, includeSystem = false): number {
  const window = ctx.model?.contextWindow;
  if (!window) throw new Error("Cannot budget full-fidelity turns without the model's context window.");
  const tokens = messageTokens(messages) + (includeSystem ? Math.ceil((ctx.getSystemPrompt?.() ?? "").length / 4) : 0);
  const reserve = contextReserve(ctx);
  if (tokens + reserve > window) throw new Error(`Full-fidelity context needs ~${tokens.toLocaleString()} input tokens plus ${reserve.toLocaleString()} reserved tokens (window ${window.toLocaleString()}). Change PROSE+TOOLS/FULL turns to PROSE or PRUNED with /filter-turns. Nothing was silently shortened.`);
  return tokens;
}

export function retainedTailMessages(entries: SessionEntry[], boundary: string): AgentMessage[] {
  const cut = entries.findIndex((e) => e.id === boundary);
  if (cut < 0) throw new Error("Cannot locate the retained context boundary.");
  const tailIds = new Set(entries.slice(cut).map((entry) => entry.id));
  return originalProjection(entries).filter(({ sourceEntry }) => tailIds.has(sourceEntry.id))
    .flatMap(({ messages }) => messages).filter((m) => m.role !== "system" && !managed(m));
}

export function checkpointContextMessages(summary: string, slots: TurnSlot[], fidelity: TurnFidelities,
  entries: SessionEntry[], boundary: string): AgentMessage[] {
  const summaryMessage = { role: "compactionSummary" as const, summary, tokensBefore: 0, timestamp: 0 };
  const tail = retainedTailMessages(entries, boundary);
  return [...expandCheckpoint(summaryMessage, summary, slots, fidelity, entries, boundary), ...tail];
}

export function checkCheckpointBudget(summary: string, slots: TurnSlot[], fidelity: TurnFidelities,
  entries: SessionEntry[], boundary: string, ctx: ExtensionContext): void {
  if (Object.keys(fidelity).length) checkContextBudget(checkpointContextMessages(summary, slots, fidelity, entries, boundary), ctx, true);
}

/** UI-only, complete text/arguments/output preview; image bytes are identified,
 * not drawn or dumped as base64. Native image blocks are retained in context.
 */
export function previewMessages(messages: AgentMessage[]): string[] {
  const lines: string[] = [];
  for (const msg of messages) {
    lines.push(msg.role === "toolResult" ? `[Tool result ${msg.toolName} (${msg.toolCallId})${msg.isError ? "; error" : ""}]:` : `[${msg.role}]:`);
    if ("content" in msg) {
      if (typeof msg.content === "string") lines.push(...msg.content.split("\n"));
      else for (const block of msg.content) {
        if (block.type === "text") lines.push(...block.text.split("\n"));
        else if (block.type === "thinking") lines.push("[Thinking]", ...block.thinking.split("\n"), ...(block.redacted ? ["[Opaque/redacted thinking retained]"] : []));
        else if (block.type === "toolCall") lines.push(`[Tool call ${block.name} (${block.id})]: ${JSON.stringify(block.arguments)}`);
        else if (block.type === "image") lines.push(`[Image attachment: ${block.mimeType}]`);
      }
    } else if (msg.role === "bashExecution") lines.push(msg.command, ...msg.output.split("\n"));
    else if (msg.role === "branchSummary") lines.push(msg.summary);
  }
  return lines;
}

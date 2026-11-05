/**
 * transparent-compact — transparent compaction with session-backed recovery.
 *
 * Builds a deterministic checkpoint from retained session history. context_lookup renders the current raw
 * session branch in memory at call time, including earlier compactions,
 * thinking, full tool outputs, and tool-call arguments. Pi normally persists
 * this history under ~/.pi/agent/sessions/; custom session locations and
 * ephemeral sessions work too. Only the active branch is searched.
 *
 * Optional env settings:
 *   MECH_COMPACT_MAX_SUMMARY_CHARS    initial character budget override (takes precedence over percent)
 *   MECH_COMPACT_MAX_SUMMARY_PERCENT  initial percentage of model context (default 25; >0, <=100)
 *   MECH_COMPACT_LOOKUP_MODEL         "provider/modelId" for the lookup subagent
 *   MECH_COMPACT_LOOKUP_TURNS         max substantive search turns (default 25).
 *                                    Valid continuation-only turns are exempt;
 *                                    total search-phase calls capped at 3x this,
 *                                    plus one final write-up on exhaustion
 *   MECH_COMPACT_LOOKUP_MAX_CALLS     consecutive lookup limit (default 3;
 *                                    0 = unlimited). Non-recovery tool results,
 *                                    bash executions, or user messages reset it.
 *                                    Fallback tools neither count nor reset it.
 *   MECH_COMPACT_LOOKUP_SESSION_FILE  absolute session JSONL path to search
 *                                    instead of the current branch (study override)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import { contentText, normalizeContext, uuidv7 } from "@earendil-works/pi-ai";
import type { Message as AiMessage, Model, Tool as AiTool } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionProjection, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { capSpans, renderToolLine, renderToolStub, NORMAL_PREVIEW_CHARS, TIGHTENED_ATTR } from "./lib/checkpoint-cap.js";
import { ToolRenderer, TOOL_DISPLAY_EXPLANATION } from "./lib/tool-stubs/renderer.mjs";
import { checkpointPath } from "./lib/tool-stubs/display.mjs";
import { Locations } from "./lib/tool-stubs/locations.mjs";
import type { ToolLines, ToolStub } from "./lib/checkpoint-cap.js";
import { FILTER_EXPLANATION, PREFLAG_ENTRY, AUTO_FILTER_ENTRY, FILTER_REVISION_ENTRY, autoFilterEnabled, preflaggedTurns,
  filterSpans, pickFilteredTurns, turnOwners } from "./lib/turn-filter.js";
import type { FilterTurn, TurnSpan, ReadPosition } from "./lib/turn-filter.js";
import { readPath as fileEvidenceKey, readCatalog, readRetentionState, selectedReads, renderRetainedReads, retainedReadOutputs, retainReadSpans, READ_RETENTION_ENTRY } from "./lib/read-retention.js";
import type { ReadOutput, ReadRetention } from "./lib/read-retention.js";
import { pickRetainedReads } from "./lib/read-retention-ui.js";
import { FIDELITY_EXPLANATION, fidelityMessages, fidelitySpans, locateSlots, expandCheckpoint,
  messageTokens, previewMessages, checkCheckpointBudget, checkContextBudget, isExpandedCheckpoint, checkpointContextMessages, retainedTailMessages, estimateContext } from "./lib/turn-context.js";
import type { ContextEstimate, NoticeTokens, TurnFidelities, TurnSelection, TurnSlot } from "./lib/turn-context.js";

// ============================================================================
// Configuration
// ============================================================================

const MECH_KIND = "mech-compact";
const METHOD_ENTRY = "transparent-compact:compaction-method";
type CompactionMethod = "verbatim" | "summary";

const SUMMARY_COMPACTION_WARNING = "Applying summary compaction weakens the verbatim guarantee. You may switch back to verbatim compaction before summary compaction runs to leave the guarantee unchanged. If summary compaction runs (manually or automatically), it replaces older active context with a model-generated summary, which may omit or reinterpret details. Switching back afterward does not undo this: only subsequent verbatim spans retain the guarantee. Original history remains recoverable through context_lookup, but is no longer a direct expansion of the active context.";
const MIXED_CONTEXT_WARNING = "**Mixed context: earlier material is model-summarized, not verbatim.** The verbatim guarantee applies only to the labelled verbatim spans and uncompacted tail. The model-summary base may omit or reinterpret details; use `context_lookup` to recover original history.";

// Read from the active branch rather than cached state: reload, resume, fork,
// and tree navigation all inherit only the choices on their own path.
function compactionMethod(entries: SessionEntry[]): CompactionMethod {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== METHOD_ENTRY) continue;
    const method = (entry.data as { method?: unknown } | undefined)?.method;
    if (method === "verbatim" || method === "summary") return method;
  }
  return "verbatim";
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function percentFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
}

function lookupMaxCallsFromEnv(): number {
  const raw = process.env.MECH_COMPACT_LOOKUP_MAX_CALLS?.trim();
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : 3;
}

const cfg = {
  defaultCapBudget: (process.env.MECH_COMPACT_MAX_SUMMARY_CHARS
    ? { unit: "chars", value: intFromEnv("MECH_COMPACT_MAX_SUMMARY_CHARS", 80_000) }
    : { unit: "percent", value: percentFromEnv("MECH_COMPACT_MAX_SUMMARY_PERCENT", 25) }) as CapBudget,
  lookupTurns: intFromEnv("MECH_COMPACT_LOOKUP_TURNS", 25),
  lookupMaxCalls: lookupMaxCallsFromEnv(),
  lookupModel: process.env.MECH_COMPACT_LOOKUP_MODEL?.trim() || undefined,
  argSnippetChars: NORMAL_PREVIEW_CHARS,
  listMaxChars: 12_000,
  grepMaxChars: 12_000,
  showEntryMaxChars: 24_000,
  lookupAnswerMaxChars: 12_000,
};

// Cap policy is session/branch state, separate from the compaction method.
const CAP_ENTRY = "transparent-compact:cap-compaction";
type CapMode = "on" | "off" | "warn";
interface CapBudget { unit: "chars" | "tokens" | "percent"; value: number }
interface CapSettings { mode: CapMode; budget: CapBudget }

function validCapBudget(value: unknown): value is CapBudget {
  if (!value || typeof value !== "object") return false;
  const { unit, value: n } = value as CapBudget;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return false;
  if (unit === "percent") return n <= 100;
  return Number.isSafeInteger(n) && (unit === "chars" || (unit === "tokens" && n <= Number.MAX_SAFE_INTEGER / 4));
}

function parseCapBudget(text: string): CapBudget | undefined {
  const match = /^(\d+(?:\.\d+)?)(c|t|%)$/.exec(text);
  if (!match) return;
  const budget: CapBudget = { value: Number(match[1]), unit: match[2] === "c" ? "chars" : match[2] === "t" ? "tokens" : "percent" };
  return validCapBudget(budget) ? budget : undefined;
}

function capSettings(entries: SessionEntry[]): CapSettings {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== CAP_ENTRY) continue;
    const state = entry.data as CapSettings | undefined;
    if (state && ["on", "off", "warn"].includes(state.mode) && validCapBudget(state.budget)) return state;
  }
  return { mode: "warn", budget: { ...cfg.defaultCapBudget } };
}

function capBudgetText(budget: CapBudget): string {
  return `${budget.value}${budget.unit === "chars" ? "c" : budget.unit === "tokens" ? "t" : "%"}`;
}

function capBudgetChars(budget: CapBudget, contextWindow?: number): number | undefined {
  if (budget.unit === "chars") return budget.value;
  if (budget.unit === "tokens") return budget.value * 4;
  if (!contextWindow || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return;
  const tokens = Math.max(1, Math.floor(contextWindow * budget.value / 100));
  return tokens <= Number.MAX_SAFE_INTEGER / 4 ? tokens * 4 : undefined;
}

function capDescription(state: CapSettings, contextWindow?: number): string {
  const chars = capBudgetChars(state.budget, contextWindow);
  const resolved = chars === undefined ? "model context window unavailable" : state.budget.unit === "chars"
    ? `${chars.toLocaleString()} chars`
    : `${(chars / 4).toLocaleString()} estimated tokens at 4 chars/token; ${chars.toLocaleString()} chars`;
  return `Verbatim compaction cap: ${state.mode}; budget ${capBudgetText(state.budget)} (${resolved}).`;
}

function persistCap(pi: ExtensionAPI, previous: CapSettings, next: CapSettings): void {
  if (previous.mode !== next.mode || previous.budget.unit !== next.budget.unit || previous.budget.value !== next.budget.value)
    pi.appendEntry(CAP_ENTRY, next);
}

// undefined means uncapped; null means cancel (never fall through to summary).
async function chooseCapBudget(pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal | undefined,
  reason: string, size: { overhead: number; lineChars: number }, operation = "compaction"): Promise<number | undefined | null> {
  try {
    let state = capSettings(ctx.sessionManager.getBranch());
    for (;;) {
      if (signal?.aborted) return null;
      if (state.mode === "off") return undefined;
      const limit = capBudgetChars(state.budget, ctx.model?.contextWindow);
      if (limit === undefined) {
        ctx.ui.notify("transparent-compact: cannot resolve percentage cap without the model's context window; choose a c/t budget or turn the cap off.", "error");
        return null;
      }
      // Exactly the existing cap's test, including its minimum 500-char line budget.
      const needsTrim = size.lineChars > Math.max(500, limit - size.overhead);
      if (state.mode !== "warn" || !needsTrim) return limit;
      const warning = `Verbatim ${operation} would trim content: ~${(size.overhead + size.lineChars).toLocaleString()} conversation/retained-read chars; budget ${capBudgetText(state.budget)} (${limit.toLocaleString()} chars).`;
      if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
        ctx.ui.notify(`${warning} Applying the cap because no interactive UI is available.`, "warning");
        return limit;
      }
      const risk = reason === "overflow"
        ? "Overflow recovery: disabling the cap may leave too much context for the retry."
        : "Disabling the cap may leave too much context for the model.";
      const choice = await ctx.ui.select(`${warning}\n${risk}`, [
        "Apply trimming", "Disable cap for this session", "Change budget", `Cancel ${operation}`,
      ], { signal });
      if (signal?.aborted) return null;
      if (choice === "Apply trimming") return limit;
      if (choice === "Disable cap for this session") {
        const next: CapSettings = { ...state, mode: "off" };
        persistCap(pi, state, next);
        ctx.ui.notify(capDescription(next, ctx.model?.contextWindow), "info");
        return undefined;
      }
      if (choice !== "Change budget") return null;
      for (;;) {
        if (typeof ctx.ui.input !== "function") return null;
        const input = await ctx.ui.input("Compaction budget: <chars>c, <estimated tokens>t, or <context window>%", capBudgetText(state.budget), { signal });
        if (signal?.aborted || input === undefined) return null;
        const budget = parseCapBudget(input.trim());
        if (!budget) {
          ctx.ui.notify("Invalid budget: use a positive integer with c/t, or a percentage greater than 0 and at most 100% (e.g. 80000c, 20000t, 25%).", "error");
          continue;
        }
        const next = { ...state, budget };
        persistCap(pi, state, next);
        state = next;
        ctx.ui.notify(capDescription(state, ctx.model?.contextWindow), "info");
        break; // Recheck: a smaller/new budget may still require trimming.
      }
    }
  } catch (err) {
    if (!signal?.aborted) ctx.ui?.notify?.(`transparent-compact: unable to resolve cap decision (${errMsg(err)}); ${operation} cancelled`, "error");
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// Content helpers
// ============================================================================

interface TextOut {
  text: string;
  images: number;
}

function textOf(content: unknown): TextOut {
  if (typeof content === "string") return { text: content, images: 0 };
  if (Array.isArray(content)) {
    let text = "";
    let images = 0;
    for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string") text += block.text;
      else if (block && block.type === "image") images++;
    }
    if (images > 0) text += `\n[${images} image(s) attached — binary, not inlined in transcript]`;
    return { text, images };
  }
  return { text: "", images: 0 };
}

function truncateHead(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `${text.slice(0, max)}\n…[+${dropped} chars truncated]`;
}

// ============================================================================
// Transcript: full-fidelity branch serialization (untruncated, entry-anchored)
// ============================================================================

const HR = "=".repeat(78);

/**
 * Serialize one message into PHYSICAL lines (no element may contain \n, so
 * array positions map 1:1 to file lines) plus, for assistant messages, the
 * relative position of each section marker line.
 */
function serializeAgentMessage(msg: AgentMessage): { lines: string[]; sections?: { kind: string; rel: number }[] } {
  const m = msg as unknown as Record<string, any>;
  const lines: string[] = [];
  const sections: { kind: string; rel: number }[] = [];
  switch (msg.role) {
    case "user":
    case "toolResult": {
      const { text } = textOf(m.content);
      lines.push(...text.split("\n"));
      break;
    }
    case "assistant": {
      for (const block of m.content ?? []) {
        if (block.type === "thinking") {
          sections.push({ kind: "thinking", rel: lines.length });
          lines.push("[thinking]", ...String(block.thinking ?? "").split("\n"));
        } else if (block.type === "text") {
          sections.push({ kind: "text", rel: lines.length });
          lines.push("[text]", ...String(block.text ?? "").split("\n"));
        } else if (block.type === "toolCall") {
          sections.push({ kind: "toolCall", rel: lines.length });
          lines.push(`[toolCall] ${block.name}`, ...JSON.stringify(block.arguments ?? {}, null, 2).split("\n"));
        }
      }
      break;
    }
    case "bashExecution": {
      lines.push(...`$ ${String(m.command ?? "")}`.split("\n"), "[output]", ...String(m.output ?? "").split("\n"));
      break;
    }
    case "custom": {
      lines.push(...textOf(m.content).text.split("\n"));
      break;
    }
    default:
      lines.push(...JSON.stringify(msg, null, 2).split("\n"));
  }
  return sections.length > 0 ? { lines, sections } : { lines };
}

interface TranscriptIndexSection {
  kind: string;
  /** 1-based line number of the section marker line */
  startLine: number;
}

// Pair only selected messages, by call id AND tool name. Ambiguous concurrent
// ids stay unknown; sequential reuse is allowed after consuming a result.
function pairedToolResults(messages: AgentMessage[]): Map<object, Record<string, any>> {
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

interface TranscriptIndexEntry {
  id: string;
  type: string;
  role?: string;
  /** 1-based line number of the ENTRY header line */
  startLine: number;
  /** 1-based line number of the last line of the block (inclusive) */
  endLine: number;
  sections?: TranscriptIndexSection[];
  /** Raw, unambiguously matched call/result entries; never parsed from text. */
  relatedIds?: string[];
}

function branchToTranscript(entries: SessionEntry[]): { lines: string[]; index: TranscriptIndexEntry[] } {
  const lines: string[] = [
    "# pi session transcript — full raw branch",
    "# Each block starts with an ENTRY header; entry ids match the session JSONL.",
    "# Thinking blocks and tool outputs are complete (not truncated).",
    "",
  ];
  interface BlockRec {
    id: string;
    type: string;
    role?: string;
    hrIdx: number;
    sections?: { kind: string; rel: number }[];
  }
  const blocks: BlockRec[] = [];
  for (const entry of entries) {
    const t = (entry as { timestamp?: string }).timestamp ?? "";
    const hrIdx = lines.length;
    lines.push(HR);
    let role: string | undefined;
    let sections: { kind: string; rel: number }[] | undefined;
    switch (entry.type) {
      case "session": {
        const e = entry as SessionEntry & { version?: number; id?: string; cwd?: string; parentSession?: string };
        lines.push(`ENTRY <header>  session v${e.version ?? 1}  id=${e.id ?? "?"}`);
        lines.push(`  cwd=${e.cwd ?? "?"}${e.parentSession ? `  parentSession=${e.parentSession}` : ""}`);
        break;
      }
      case "message": {
        const m = entry.message as unknown as Record<string, any>;
        if (m.role === "system") {
          const sectionNames = m.sections ? Object.keys(m.sections).join(", ") : "(content only)";
          lines.push(`ENTRY ${entry.id}  system  ${t}`);
          lines.push(`  (system prompt checkpoint — sections: ${sectionNames}; full text in session JSONL)`);
          role = m.role;
        } else {
          const extra =
            m.role === "toolResult"
              ? ` (${m.toolName ?? "?"}, isError=${m.isError ? "true" : "false"})`
              : m.role === "assistant"
                ? ` (model=${m.provider ?? "?"}/${m.model ?? "?"}, stop=${m.stopReason ?? "?"})`
                : "";
          lines.push(`ENTRY ${entry.id}  ${m.role}${extra}  ${t}`);
          const ser = serializeAgentMessage(entry.message);
          lines.push(...ser.lines);
          role = m.role;
          sections = ser.sections;
        }
        break;
      }
      case "compaction": {
        const e = entry as SessionEntry & { tokensBefore?: number; firstKeptEntryId?: string; summary?: string };
        lines.push(`ENTRY ${entry.id}  compaction  ${t}  tokensBefore=${e.tokensBefore ?? "?"}  firstKeptEntryId=${e.firstKeptEntryId ?? "?"}`);
        lines.push("[summary]");
        lines.push(...String(e.summary ?? "").split("\n"));
        break;
      }
      case "branch_summary": {
        const e = entry as SessionEntry & { fromId?: string; summary?: string };
        lines.push(`ENTRY ${entry.id}  branch_summary  ${t}  fromId=${e.fromId ?? "?"}`);
        lines.push(...String(e.summary ?? "").split("\n"));
        break;
      }
      case "custom_message": {
        const e = entry as SessionEntry & { customType?: string; content?: unknown };
        lines.push(`ENTRY ${entry.id}  custom_message (${e.customType ?? "?"})  ${t}`);
        lines.push(...textOf(e.content).text.split("\n"));
        break;
      }
      case "model_change":
        lines.push(`ENTRY ${entry.id}  model_change  ${t}  -> ${(entry as any).provider}/${(entry as any).modelId}`);
        break;
      case "thinking_level_change":
        lines.push(`ENTRY ${entry.id}  thinking_level_change  ${t}  -> ${(entry as any).thinkingLevel}`);
        break;
      case "usage":
        lines.push(`ENTRY ${entry.id}  usage (${(entry as any).kind ?? "?"})  ${t}  (not in LLM context)`);
        break;
      case "custom":
        lines.push(`ENTRY ${entry.id}  custom (${(entry as any).customType ?? "?"})  ${t}  (not in LLM context)`);
        break;
      case "label":
        lines.push(`ENTRY ${entry.id}  label  ${t}  target=${(entry as any).targetId}  label=${(entry as any).label ?? "(cleared)"}`);
        break;
      case "context_edit":
        lines.push(
          `ENTRY ${entry.id}  context_edit  ${t}  target=${(entry as any).targetId}  replacement=${(entry as any).replacement === null ? "omitted" : "replaced"}`,
        );
        break;
      case "session_info":
        lines.push(`ENTRY ${entry.id}  session_info  ${t}  name=${(entry as any).name ?? ""}`);
        break;
      default:
        lines.push(`ENTRY ${entry.id}  ${(entry as { type: string }).type}  ${t}  (unhandled entry type)`);
    }
    lines.push("");
    blocks.push({ id: entry.id, type: entry.type, role, hrIdx, sections });
  }
  const index: TranscriptIndexEntry[] = blocks.map((b, i) => {
    const e: TranscriptIndexEntry = {
      id: b.id,
      type: b.type,
      startLine: b.hrIdx + 2, // header line (1-based)
      endLine: i + 1 < blocks.length ? blocks[i + 1].hrIdx : lines.length, // last line of block, inclusive
    };
    if (b.role) e.role = b.role;
    if (b.sections && b.sections.length > 0) e.sections = b.sections.map((s) => ({ kind: s.kind, startLine: b.hrIdx + s.rel + 3 }));
    return e;
  });
  const byMessage = new Map<object, string>();
  const byCall = new Map<object, string>();
  const messages: AgentMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    messages.push(entry.message);
    byMessage.set(entry.message, entry.id);
    if (entry.message.role === "assistant")
      for (const block of entry.message.content ?? [])
        if (block.type === "toolCall") byCall.set(block, entry.id);
  }
  const byId = new Map(index.map((entry) => [entry.id, entry]));
  for (const [call, result] of pairedToolResults(messages)) {
    const callId = byCall.get(call), resultId = byMessage.get(result);
    if (!callId || !resultId) continue;
    const callEntry = byId.get(callId)!, resultEntry = byId.get(resultId)!;
    (callEntry.relatedIds ??= []).push(resultId);
    resultEntry.relatedIds = [callId];
  }
  return { lines, index };
}

// ============================================================================
// Mechanical summary (what replaces the model summary in the session)
// ============================================================================

// Conservative lexical categories for selected output observations. These do
// not parse shell syntax or establish whether a command succeeded.
function commandHints(command: string): { tests: boolean; network: boolean; historical: boolean } {
  const core = command.replace(/^\s*cd\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)\s*&&\s*/, "").trimStart();
  const tests = /^(?:(?:uv run |(?:\S*\/)?python[\d.]* -m )?pytest\b|(?:\S*\/)?pytest\b|(?:npm|pnpm|yarn) (?:run )?(?:test|build)\b|node --test\b|(?:\.\/)?gradlew\b|cargo (?:test|build)\b|go (?:test|build)\b|dotnet (?:test|build)\b|mvn (?:test|verify|package)\b)/.test(core);
  const network = /^(?:curl|wget)\b/.test(core);
  const readOnly = /^(?:cat|sed|awk|rg|grep|head|tail|find|ls|man|git)\b/.test(core);
  const historical = !readOnly && (network || /^(?:timeout\s+\S+\s+)?tmux\b/.test(core) ||
    /^(?:\S*\/)?(?:python[\d.]*|node|ruby|perl)\b[^\n]*(?:\s-[ce]\b|\s-\s*<<)/.test(core) ||
    /^(?:uv run )?(?:\S*\/)?(?:python[\d.]*|node)\b/.test(core) ||
    /^(?:time|hyperfine)\b|\b(?:bench(?:mark)?|timeit)\b/.test(core));
  return { tests, network, historical };
}

function observationQuote(text: string): string {
  if (JSON.stringify(text).length <= cfg.argSnippetChars) return JSON.stringify(text);
  // Unlike a generic argument prefix, keep output quotations closed and escaped
  // even when the source contains control characters or ends at a surrogate.
  let end = Math.min(text.length, cfg.argSnippetChars);
  while (JSON.stringify(text.slice(0, end) + "…").length > cfg.argSnippetChars) end--;
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return JSON.stringify(text.slice(0, end) + "…");
}

function bashOutputLabel(command: string, result: Record<string, any>): string {
  const content = result.content;
  // Do not treat an image, structured-only result, or truncation notice as a
  // tiny complete text observation. Summaries below quote selected text only.
  const textOnly = typeof content === "string" || (Array.isArray(content) && content.length > 0 && content.every((b) => b?.type === "text" && typeof b.text === "string"));
  if (!textOnly) return "";
  const raw = textOf(content).text;
  const structuredExit = result.structuredContent?.exit_code;
  const hasStructuredExit = Number.isSafeInteger(structuredExit);
  const suffix = /(?:^|\n)Command exited with code (-?\d+)\s*$/.exec(raw);
  // Successful reads can print a fixture containing the wrapper's exact text.
  // Prefer explicit metadata; trust a legacy nonzero footer only on tool error.
  const exit = suffix && (hasStructuredExit ? Number(suffix[1]) === structuredExit : result.isError === true) ? suffix : undefined;
  const bodyText = exit ? raw.slice(0, exit.index) : raw;
  const body = bodyText.trim();
  const partial = result.details?.truncation?.truncated === true || /\[(?:Output truncated|Showing last |Showing lines )/i.test(body);
  const labels: string[] = [];
  const reportedExit = hasStructuredExit ? structuredExit : exit ? Number(exit[1]) : undefined;
  const exitCode = Number.isSafeInteger(reportedExit) ? reportedExit : undefined;
  if (exitCode !== undefined && exitCode !== 0) labels.push(`exit ${exitCode}`); // Reported shell status, NOT pipeline/test status.
  if (!partial && (bodyText === "" || body === "(no output)")) return [...labels, "no output"].join("; ");
  const hints = commandHints(command);
  const lines = body.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  let observed: string[] = [];
  if (hints.tests) {
    observed = lines.filter((line) =>
      /^=+ .*\b\d+ (?:passed|failed|errors?|skipped|xfailed)\b.*=+$/.test(line.trim()) ||
      /^(?:\d+ (?:passed|failed|errors?|skipped|xfailed|deselected|warnings?)(?:, )?)+ in [\d.]+s$/.test(line.trim()) ||
      /^(?:ℹ|#) (?:pass|fail) \d+$/.test(line.trim()) ||
      /^BUILD (?:SUCCESSFUL|FAILED)\b/.test(line.trim()) ||
      /^(?:PASS|FAIL): \d+\/\d+$/.test(line.trim())).slice(-3);
  }
  if (hints.network) {
    const codes = [...body.matchAll(/(?:^|\n)(?:HTTP\/[\d.]+\s+([1-5]\d\d)\b|http(?:_code)?[=: ]\s*([1-5]\d\d)\b)/gi)].map((m) => m[1] ?? m[2]);
    if (codes.length) labels.push(`output: http ${codes.slice(0, 4).join(",")}${codes.length > 4 ? ",…" : ""}`);
  }
  // Only recognized execution commands get error-text scanning. In particular,
  // never extract test/error labels from file reads, searches, or git views.
  if (!observed.length && (hints.tests || hints.historical)) {
    const errors = lines.filter((line) => line.trim()).slice(-6).filter((line) =>
      /^(?:\s*\w*(?:Error|Exception):|Traceback \(most recent call last\):|error(?:\[\w+\])?:|fatal:)|command not found/.test(line));
    observed = errors.slice(-1);
  }
  if (observed.length) labels.push(`output: ${observed.map((line) => observationQuote(line.trim())).join(" / ")}`);
  else if (!labels.some((label) => label.startsWith("output:")) && hints.historical && !partial &&
    bodyText.length <= 100 && JSON.stringify(bodyText).length <= cfg.argSnippetChars)
    labels.push(`output: ${JSON.stringify(bodyText)}`);
  // A commit hash is useful provenance, but only extract the git-generated
  // bracketed form, not arbitrary lines that merely start with hex digits.
  if (/^(?:git\b|.*&&\s*git\b)/.test(command) && /\bgit commit\b/.test(command)) {
    const hash = /^\[[^\]\n]+ ([0-9a-f]{7,40})\]/m.exec(body)?.[1];
    if (hash) labels.push(`commit ${hash}`);
  }
  return labels.join("; ");
}

interface MessageSource { entryId: string; owner: string | null }
async function summarizeMessages(messages: AgentMessage[], renderer: ToolRenderer, sources?: (MessageSource | null)[]): Promise<TurnSpan> {
  const results = pairedToolResults(messages);
  const lines: string[] = [], turnIds: (string | null)[] = [], readPositions: ReadPosition[] = [];
  const tools: ToolLines = { version: 2, lines: [] };
  for (const [messageIndex, msg] of messages.entries()) {
    const start = lines.length;
    const m = msg as unknown as Record<string, any>;
    switch (msg.role) {
      case "user": {
        const { text, images } = textOf(m.content);
        if (text.trim() || images > 0) lines.push(`[User]: ${text}`);
        break;
      }
      case "assistant": {
        let prose = "";
        const calls: ToolStub[] = [];
        for (const block of m.content ?? []) {
          if (block.type === "text") prose += (prose ? "\n" : "") + String(block.text ?? "");
          else if (block.type === "toolCall") {
            const name = String(block.name), args = block.arguments ?? {};
            const result = results.get(block);
            const status = typeof result?.isError !== "boolean" ? " [unknown]" : result.isError ? " [tool error]" : "";
            const command = name === "bash" && typeof args.command === "string" ? args.command : undefined;
            const label = result && command !== undefined ? bashOutputLabel(command, result) : "";
            calls.push(await renderer.render(name, args, status + (label ? ` → ${label}` : "")));
          }
          // thinking blocks: removed by design (kept in the session)
        }
        if (prose.trim()) lines.push(`[Assistant]: ${prose.trim()}`);
        if (calls.length > 0) {
          tools.lines.push({ index: lines.length, calls, mergeable: !prose.trim() });
          lines.push(renderToolLine(calls));
        }
        break;
      }
      case "toolResult": {
        // Keep a structural insertion point even when retention is OFF. Outputs
        // are fetched from the session only when rendering a selected read.
        const source = sources?.[messageIndex];
        if (m.toolName === "read" && source) readPositions.push({ entryId: source.entryId, index: lines.length });
        break;
      }
      case "bashExecution": {
        const calls = [await renderer.render("bash", { command: String(m.command ?? "") }, " [output removed]")];
        const prefix = "[BashExecution]: ";
        tools.lines.push({ index: lines.length, calls, mergeable: false, prefix });
        lines.push(renderToolLine(calls, NORMAL_PREVIEW_CHARS, prefix));
        break;
      }
      case "custom":
        // Our instruction envelope is regenerated, not conversation prose.
        // Keep originals in raw history, but never carry old checklists into spans.
        if (m.customType !== REORIENT_MESSAGE)
          lines.push(`[Custom message]: ${renderToolStub(await renderer.render("custom", { type: m.customType }))} [content removed — use context_lookup]`);
        break;
      case "branchSummary":
      case "compactionSummary":
        lines.push(`[${msg.role === "branchSummary" ? "Branch summary" : "Compaction summary"}]: ${String(m.summary ?? "")}`);
        break;
      default:
        break;
    }
    for (let i = start; i < lines.length; i++) turnIds.push(sources?.[messageIndex]?.owner ?? null);
  }
  return { lines, ...(sources ? { turnIds } : {}), ...(readPositions.length ? { readPositions } : {}), ...(tools.lines.length ? { tools } : {}) };
}

const SECTION_HEADER = "### Compacted conversation (oldest first)";
const SPAN_CLOSE = "</compacted-span>";
const SPAN_TRIMMED_NOTE = "(trimmed for size — use context_lookup)";
const SPAN_TRIMMED_ATTR = ' trimmed="true"';
const BASE_CLOSE = "</compacted-base>";

function spanOpen(n: number, compactedAt: string, reason: string, covers?: string): string {
  // covers = [first summarised message, last summarised message]; the span
  // ends at pi's cut point, which is earlier than the compaction time.
  // Spans written before from/to existed render without covers.
  return `<compacted-span n="${n}"${covers ? ` covers="${covers}"` : ""} compacted-at="${compactedAt}" trigger="${reason}">`;
}

/**
 * The base = the most recent compaction entry on the branch that is NOT a
 * mech-compact entry with details.span — i.e. a model-generated summary or a
 * legacy (nested-format) mech checkpoint. Everything before it is covered by
 * its opaque summary text. Spans = mech entries with details.span after the
 * base, oldest first. Spans before the base are deliberately NOT re-rendered
 * (the base is opaque; the session holds the raw history).
 */
interface LocationEntry { id: string; key: string; kind: string; value: string; display: string }
type StoredSpan = TurnSpan & { at: string; reason: string; from?: string; to?: string };

function collectBaseAndSpans(branchEntries: SessionEntry[]): {
  base: { kind: "model-summary" | "legacy-checkpoint"; at: string; summary: string } | null;
  spans: StoredSpan[];
} {
  const spanDetails = (e: SessionEntry) => {
    if (e.type !== "compaction") return undefined;
    const d = (e as { details?: Record<string, any> }).details;
    if (!d || d.kind !== MECH_KIND || !Array.isArray(d.span?.lines)) return undefined;
    return d.span as TurnSpan & { at?: unknown; reason?: unknown; from?: unknown; to?: unknown };
  };
  let baseIdx = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type !== "compaction") continue;
    if (!spanDetails(branchEntries[i])) {
      baseIdx = i;
      break;
    }
  }
  const baseEntry = baseIdx >= 0 ? branchEntries[baseIdx] : null;
  const base = baseEntry
    ? {
        kind: (((baseEntry as { details?: { kind?: string } }).details?.kind === MECH_KIND) as boolean ? "legacy-checkpoint" : "model-summary") as
          | "model-summary"
          | "legacy-checkpoint",
        at: (baseEntry as { timestamp?: string }).timestamp ?? "",
        summary: (baseEntry as { summary?: string }).summary ?? "",
      }
    : null;
  const spans: StoredSpan[] = [];
  for (let i = Math.max(baseIdx + 1, 0); i < branchEntries.length; i++) {
    const sd = spanDetails(branchEntries[i]);
    if (sd)
      spans.push({
        at: String(sd.at ?? (branchEntries[i] as { timestamp?: string }).timestamp ?? ""),
        reason: String(sd.reason ?? "unknown"),
        // from/to are absent on spans written before they existed — render
        // without covers rather than guessing.
        from: typeof sd.from === "string" && sd.from !== "" ? sd.from : undefined,
        to: typeof sd.to === "string" && sd.to !== "" ? sd.to : undefined,
        lines: sd.lines,
        tools: sd.tools,
        turnIds: sd.turnIds,
        readPositions: sd.readPositions,
      });
  }
  return { base, spans };
}

interface FilterRevision {
  compactionId: string;
  summary: string;
  filteredTurnIds: string[];
  keptAsideTurnIds: string[];
  fidelity?: TurnFidelities;
  slots?: TurnSlot[];
  readRetention: ReadRetention;
}

function checkpointLocations(entries: SessionEntry[]): LocationEntry[] {
  return (latestVerbatimCompaction(entries)?.details as { locations?: LocationEntry[] } | undefined)?.locations ?? [];
}

function latestFilterRevision(entries: SessionEntry[]) {
  const compaction = latestVerbatimCompaction(entries);
  if (!compaction) return;
  const entry = entries.slice(entries.indexOf(compaction) + 1).findLast((entry) =>
    entry.type === "custom" && entry.customType === FILTER_REVISION_ENTRY &&
    (entry.data as FilterRevision)?.compactionId === compaction.id);
  return entry?.type === "custom" ? entry as typeof entry & { data: FilterRevision } : undefined;
}

function filteredTurns(entries: SessionEntry[]): string[] {
  return latestFilterRevision(entries)?.data.filteredTurnIds ??
    (latestVerbatimCompaction(entries)?.details as { filteredTurnIds?: string[] } | undefined)?.filteredTurnIds ?? [];
}

function keptAsideTurns(entries: SessionEntry[]): string[] {
  return latestFilterRevision(entries)?.data.keptAsideTurnIds ??
    (latestVerbatimCompaction(entries)?.details as { keptAsideTurnIds?: string[] } | undefined)?.keptAsideTurnIds ?? [];
}

function turnFidelities(entries: SessionEntry[]): TurnFidelities {
  const revision = latestFilterRevision(entries);
  return revision ? revision.data.fidelity ?? {} :
    (latestVerbatimCompaction(entries)?.details as { fidelity?: TurnFidelities } | undefined)?.fidelity ?? {};
}

function projectCheckpoint(messages: AgentMessage[], entries: SessionEntry[]): AgentMessage[] {
  const compaction = latestVerbatimCompaction(entries), revision = latestFilterRevision(entries);
  const fidelity = turnFidelities(entries);
  if (!compaction || (!revision && !Object.keys(fidelity).length)) return messages;
  const saved = revision?.data ?? compaction.details as { slots?: TurnSlot[] };
  if (messages.some((message) => isExpandedCheckpoint(message, revision?.data.summary ?? compaction.summary))) return messages;
  // Expand only the active checkpoint using generated offsets, not historical
  // text patterns. Original records and the retained tail remain untouched.
  return messages.flatMap((message) => message.role === "compactionSummary"
    ? expandCheckpoint(message, revision?.data.summary ?? message.summary, saved.slots ?? [], fidelity, entries, compaction.firstKeptEntryId)
    : [message]);
}

// Match Pi's prepared messages to their source entries, including explicit
// context replacements and generated custom messages. No raw bodies are stored.
function preparedMessageSources(entries: SessionEntry[], messages: AgentMessage[]): (MessageSource | null)[] {
  const owners = turnOwners(entries);
  const queues = new Map<string, MessageSource[]>();
  for (const projected of buildSessionProjection(entries).entries) {
    if (projected.sourceEntry.type === "compaction") continue;
    for (const message of projected.messages) {
      const key = JSON.stringify(message);
      const queue = queues.get(key) ?? [];
      queue.push({ entryId: projected.sourceEntry.id, owner: owners.get(projected.sourceEntry.id) ?? null });
      queues.set(key, queue);
    }
  }
  return messages.map((message) => queues.get(JSON.stringify(message))?.shift() ?? null);
}

function filterChoices(entries: SessionEntry[], spans: TurnSpan[], excluded: Set<string>, firstKeptEntryId: string,
  retained: ReadOutput[], selected = excluded, fidelity: TurnFidelities = turnFidelities(entries)): FilterTurn[] {
  const owners = turnOwners(entries), flagged = preflaggedTurns(entries);
  const cut = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  const tailOwners = new Set(entries.slice(cut).filter((entry) => entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary")
    .map((entry) => owners.get(entry.id)));
  const lines = new Map<string, string[]>();
  const inline = retainReadSpans(spans, retained.filter((read) =>
    entries.findIndex((entry) => entry.id === read.entryId) < cut && !fidelity[read.owner ?? ""]), excluded);
  for (const span of inline.spans) span.lines.forEach((line, index) => {
    const owner = span.turnIds?.[index];
    if (owner) { const group = lines.get(owner) ?? []; group.push(line); lines.set(owner, group); }
  });
  return entries.filter((entry) => entry.type === "message" && entry.message.role === "user").map((entry) => {
    const content = lines.get(entry.id) ?? [];
    const deferred = tailOwners.has(entry.id);
    const unavailable = deferred ? (flagged.has(entry.id) ? undefined : "in retained recent tail")
      : content.length === 0 ? "not individually represented in checkpoint" : undefined;
    const cache = new Map<string, { tokens: number; lines: string[] }>();
    return { id: entry.id, fidelity: fidelity[entry.id], fidelityInfo: (mode) => {
      if (!cache.has(mode)) {
        const messages = fidelityMessages(entries, { [entry.id]: mode }, firstKeptEntryId).get(entry.id)!;
        cache.set(mode, { tokens: messageTokens(messages), lines: previewMessages(messages) });
      }
      return cache.get(mode)!;
    }, label: content[0] ?? `[User]: ${entry.type === "message" ? textOf((entry.message as any).content).text : ""}`,
      lines: content, selected: excluded.has(entry.id) || (!unavailable && selected.has(entry.id)),
      filtered: excluded.has(entry.id), deferred, unavailable };
  });
}

function applyTurnSelection(choices: FilterTurn[], result: TurnSelection, preflags: Set<string>,
  excluded: Set<string>, keptAsides: Set<string>, fidelity: TurnFidelities): void {
  const selected = new Set(result.pruned);
  for (const turn of choices) {
    if (turn.unavailable) continue;
    if (!turn.deferred) {
      if (selected.has(turn.id)) excluded.add(turn.id); else excluded.delete(turn.id);
      if (!selected.has(turn.id) && result.fidelity[turn.id]) fidelity[turn.id] = result.fidelity[turn.id];
      else delete fidelity[turn.id];
    }
    if (preflags.has(turn.id)) {
      if (selected.has(turn.id)) keptAsides.delete(turn.id); else keptAsides.add(turn.id);
    }
  }
}

// Remove file-list traces belonging only to excluded turns. A path also used
// by a kept turn stays listed; filtering is not a claim that mutations were undone.
function excludedFilePaths(entries: SessionEntry[], excluded: Set<string>, firstKeptEntryId: string, cwd: string): Set<string> {
  const owners = turnOwners(entries), removed = new Set<string>(), kept = new Set<string>();
  const cut = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  for (const entry of entries.slice(0, cut)) {
    if (entry.type !== "message") continue;
    const m = entry.message as any;
    const calls = m.role === "assistant" ? (m.content ?? []).filter((b: any) => b.type === "toolCall")
      : m.role === "toolResult" ? m.nestedCalls?.calls ?? [] : [];
    for (const call of calls) {
      if (!["read", "write", "edit"].includes(call.name) || typeof call.arguments?.path !== "string") continue;
      (excluded.has(owners.get(entry.id) ?? "") ? removed : kept).add(fileEvidenceKey(call.arguments.path, cwd));
    }
  }
  return new Set([...removed].filter((file) => !kept.has(file)));
}

function checkpointEvidence(entries: SessionEntry[], firstKeptEntryId: string, cwd: string,
  readRetention: ReadRetention, readFiles: string[], modifiedFiles: string[], excluded: Set<string>) {
  if (!excluded.size) return { readRetention, readFiles, modifiedFiles };
  const removedPaths = excludedFilePaths(entries, excluded, firstKeptEntryId, cwd);
  return {
    readRetention,
    readFiles: readFiles.filter((file) => !removedPaths.has(fileEvidenceKey(file, cwd))),
    modifiedFiles: modifiedFiles.filter((file) => !removedPaths.has(fileEvidenceKey(file, cwd))),
  };
}

const RECOVERY_HISTORY_NOTE = "Compaction hides earlier details from your current view. The original conversation history, including recorded tool outputs and your reasoning, is preserved in the session and can be retrieved.";
const RECOVERY_SOURCE_GUIDANCE = "Re-read project files for their current contents. Prefer lookup for what was observed earlier or to avoid repeating slow external research or expensive computations; cheap local rereads and recomputations remain reasonable.";
const RECOVERY_SCOPE_RULE = "Use the recovery tools for history established by this conversation or its checkpoint, not project discovery, requirements never supplied, other sessions, or abandoned branches.";
const RECOVERY_FILESYSTEM_RULE = "For recovery of details hidden by compaction, do not read or grep raw session JSONL files through filesystem tools; use the recovery tools instead.";

const REORIENT_BLOCK = `**Post-compaction re-orientation.** ${RECOVERY_HISTORY_NOTE} Selected retained reads and the uncompacted tail remain available as evidence. Recover only hidden information needed for the current task.
1. **Restore only information needed to continue.** Re-read project files when you need their current contents; cheap local rereads and recomputations are reasonable. If you need an earlier observation, the source of a finding, or the reason for a conclusion that compaction hid, use \`context_lookup\`. This can avoid repeating slow or unreliable research. Restore inputs, not completed actions: do not redo writes, edits, or other state-changing actions merely because their results are hidden. **Before using \`write\` to replace an existing file, re-read it unless its current contents are already visible in context. Do not reconstruct unchanged sections from memory.**
2. If this is a Git repository, run \`git status\` and review uncommitted work. Re-verify build/test state if you are about to rely on it.
3. **Distinguish earlier claims from supporting evidence.** Retained assistant prose records what was said, not independent verification. If a task-relevant claim has uncertain provenance or conflicts with new evidence, check its supporting output (using \`context_lookup\` if hidden) or the current source before treating it as established; label unresolved claims unverified. Retrieved reasoning remains a historical hypothesis, and historical outputs do not establish current file or build/test state.`;

const REVISION_NOTE_PREFIX = "- Checkpoint context revised: ";
const CHECKPOINT_EXPLANATION = `**Compacted conversation follows.** The earlier part of this conversation has been compacted into the checkpoint below. This is not the full transcript. ${RECOVERY_HISTORY_NOTE}`;

const RECOVERY_INSTRUCTIONS = `**Recovering hidden details.** Use \`context_lookup\` with a specific historical question: a subagent searches this conversation's full session history and returns relevant findings. Use the recovery tools for history established by this conversation or its checkpoint, not for project discovery or exploration of other sessions. If its findings are incomplete, use the bounded fallback tools \`context_list_entries\`, \`context_grep\`, and \`context_show_entry\`.`;

const EVIDENCE_BOUNDARY_RULE = "**Evidence boundary:** Tool stubs omit supporting details. Most output and detailed payloads are omitted. Inline observations are historical, not verification of unshown details or current state. Use `context_lookup` for omitted observations or provenance; inspect sources for current state.";

const REORIENT_MESSAGE = "transparent-compact:reorient";
const RECOVERY_RECAP = `**Recovery recap.** ${RECOVERY_SCOPE_RULE} For unfamiliar project details or missing requirements, inspect project files or ask the user instead. If lookup findings are incomplete, use \`context_list_entries\`, \`context_grep\`, or \`context_show_entry\`, following pagination instructions. ${RECOVERY_FILESYSTEM_RULE} Keep these evidence/recovery rules in force as work continues.`;

function latestVerbatimCompaction(entries: SessionEntry[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "compaction")
      return (entry.details as { kind?: string } | undefined)?.kind === MECH_KIND ? entry : undefined;
  }
}

function reorientationMessage(compactionId: string, filtered = false, revisionId = compactionId, fidelity = false) {
  return { customType: REORIENT_MESSAGE, content: `${REORIENT_BLOCK}${filtered ? `\n\n${FILTER_EXPLANATION}` : ""}${fidelity ? `\n\n${FIDELITY_EXPLANATION}` : ""}\n\n${RECOVERY_RECAP}`,
    display: false, details: { compactionId, ...(revisionId !== compactionId ? { revisionId } : {}) } };
}

function isReorientation(msg: AgentMessage): boolean {
  return msg.role === "custom" && msg.customType === REORIENT_MESSAGE;
}

function reorientationFor(msg: AgentMessage, compactionId: string, revisionId: string): boolean {
  const details = msg.role === "custom" ? msg.details as { compactionId?: string; revisionId?: string } | undefined : undefined;
  return isReorientation(msg) && details?.compactionId === compactionId &&
    (details.revisionId ?? details.compactionId) === revisionId;
}

/** Keep one current, persisted checklist. Obsolete managed messages can still be
 * in Pi's retained tail, but are never presented as conversation or summarized.
 * On the first request, move the checklist after pending input/other transforms.
 * Later requests keep it in history before the work that followed it. */
function projectReorientation(messages: AgentMessage[], entries: SessionEntry[]): AgentMessage[] {
  const compaction = latestVerbatimCompaction(entries);
  const anchor = latestFilterRevision(entries) ?? compaction;
  let selected = -1;
  for (let i = 0; i < messages.length; i++)
    if (compaction && reorientationFor(messages[i], compaction.id, anchor!.id)) selected = i;
  const result = messages.filter((m, i) => !isReorientation(m) || i === selected);
  if (selected < 0 || !compaction) return result;
  const answered = entries.slice(entries.indexOf(anchor!) + 1).some((e) =>
    e.type === "message" && e.message.role === "assistant" &&
    e.message.stopReason !== "aborted" && e.message.stopReason !== "error");
  if (!answered) {
    const checklist = messages[selected];
    return [...result.filter((m) => m !== checklist), checklist];
  }
  return result;
}

/** Attribute generated notice costs without touching quoted historical text.
 * Notices occur only in the generated prefix, before SECTION_HEADER. Using the
 * real estimator on counterfactual messages keeps counts tied to current text.
 */
function contextNoticeTokens(messages: AgentMessage[], reminder: AgentMessage): NoticeTokens {
  const first = messages.find((message) => message.role === "compactionSummary");
  if (!first || first.role !== "compactionSummary" || reminder.role !== "custom" || typeof reminder.content !== "string")
    throw new Error("Cannot identify generated context notices.");
  const end = first.summary.indexOf(SECTION_HEADER);
  if (end < 0) throw new Error("Cannot identify the checkpoint introduction.");
  let header = first.summary.slice(0, end), content = reminder.content;
  const body = first.summary.slice(end);
  const revision = header.split("\n").find((line) => line.startsWith(REVISION_NOTE_PREFIX)) ?? "";
  const notes: NoticeTokens = { pruning: 0, revision: 0, fidelity: 0 };
  const parts: [keyof NoticeTokens, string][] = [["pruning", FILTER_EXPLANATION], ["revision", revision], ["fidelity", FIDELITY_EXPLANATION]];
  for (const [kind, text] of parts) {
    if (!text) continue;
    const before = messageTokens([{ ...first, summary: header + body }, { ...reminder, content }]);
    header = header.replace(`${text}\n`, "");
    if (kind !== "revision") content = content.replace(`\n\n${text}`, "");
    notes[kind] = before - messageTokens([{ ...first, summary: header + body }, { ...reminder, content }]);
  }
  return notes;
}

async function buildMechanicalSummary(opts: {
  reason: string; // pi's raw reason: "manual" | "threshold" | "overflow"
  tokensBefore: number;
  branchEntries: SessionEntry[];
  now: string;
  spanLines: string[]; // this compaction's own span, un-capped
  revisedAt?: string; // rebuild existing spans only; no new compaction or boundary
  spanTools?: ToolLines; // display records; no raw command/program payloads
  locations?: LocationEntry[];
  spanTurnIds?: (string | null)[];
  spanReadPositions?: ReadPosition[];
  filteredTurnIds?: string[];
  fidelity?: TurnFidelities;
  slots?: TurnSlot[]; // generated output placements; no raw payloads
  presentation?: { shortened: boolean }; // optional presentation-accounting output
  spanFrom?: string; // ISO timestamp of the first summarised message
  spanTo?: string; // ISO timestamp of the last summarised message
  firstKeptEntryId?: string; // start of the verbatim (uncompacted) tail
  readRetention: ReadRetention;
  cwd: string;
  notify: (msg: string) => void;
  chooseCap: (size: { overhead: number; lineChars: number }) => Promise<number | undefined | null>;
}): Promise<string | undefined> {
  const { base, spans } = collectBaseAndSpans(opts.branchEntries);
  const fidelity = opts.fidelity ?? {};
  const native = Object.keys(fidelity).length ? fidelityMessages(opts.branchEntries, fidelity, opts.firstKeptEntryId!) : new Map<string, AgentMessage[]>();
  const nativeMessages = [...native.values()].flat();
  const nativeChars = messageTokens(nativeMessages) * 4;
  const excluded = new Set(opts.filteredTurnIds);
  const retained = retainedReadOutputs(readCatalog(opts.branchEntries, opts.cwd), opts.readRetention,
    opts.branchEntries, opts.firstKeptEntryId, fidelity);
  const inserted = retainReadSpans(opts.revisedAt ? spans : [...spans, {
    at: opts.now, reason: opts.reason, from: opts.spanFrom, to: opts.spanTo,
    lines: opts.spanLines, tools: opts.spanTools, turnIds: opts.spanTurnIds, readPositions: opts.spanReadPositions,
  }], retained, excluded);
  if (inserted.unplaced.length) throw new Error(`Cannot retain read ${inserted.unplaced[0].entryId} (${inserted.unplaced[0].path}): its original position is not in a verbatim span. Choose another read or set it to OFF.`);
  const rendered = fidelitySpans(filterSpans(inserted.spans, excluded), fidelity);
  const allSpans = rendered.spans;
  const locations = new Locations(opts.cwd, opts.locations ?? checkpointLocations(opts.branchEntries));
  const dictionary = (ids: string[]) => locations.render(new Set(ids));
  const dictionaryCost = (ids: string[]) => { const text = dictionary(ids); return text ? text.length + 2 : 0; };
  const allLocationIds = allSpans.flatMap((span) => span.tools?.lines.flatMap((line) => line.calls.flatMap((call) => call.locations ?? [])) ?? []);
  const coversOf = (s: { from?: string; to?: string }): string | undefined => (s.from && s.to ? `${s.from} → ${s.to}` : undefined);

  // Inline reads count in span size exactly once and are structurally protected
  // from capping. The opaque base and native messages remain fixed overhead.
  const baseOpen = base ? `<compacted-base kind="${base.kind}" compacted-at="${base.at}">` : "";
  const retainedChars = allSpans.reduce((total, span) => total + (span.protectedLines ?? [])
    .filter((index) => !rendered.markers.has(span.turnIds?.[index] ?? ""))
    .reduce((n, index) => n + span.lines[index].length + 1, 0), 0);
  let overhead = nativeChars + SECTION_HEADER.length + 2;
  if (base) overhead += baseOpen.length + 1 + BASE_CLOSE.length + 2 + base.summary.length;
  overhead += allSpans.reduce(
    (a, s, i) => a + spanOpen(i + 1, s.at, s.reason, coversOf(s)).length + SPAN_TRIMMED_ATTR.length + TIGHTENED_ATTR.length + 2 + SPAN_TRIMMED_NOTE.length + 1 + SPAN_CLOSE.length + 2,
    0,
  );
  // Closing line: where the verbatim (uncompacted) tail begins. Spans end at
  // pi's cut point, which is earlier than the compaction time — the tail is
  // named by the first kept entry's timestamp (no time if it cannot be found).
  const keptEntry = opts.firstKeptEntryId ? opts.branchEntries.find((e) => e.id === opts.firstKeptEntryId) : undefined;
  const keptTime = (keptEntry as { timestamp?: unknown } | undefined)?.timestamp;
  const closingLine =
    typeof keptTime === "string" && keptTime !== ""
      ? `Conversation from ${keptTime} onward continues verbatim below — it was not compacted.`
      : `Conversation continues verbatim below — it was not compacted.`;
  overhead += closingLine.length + 2;
  const lines = allSpans.map((s) => s.lines);
  const lineChars = lines.reduce((total, span) => total + span.reduce((n, line) => n + line.length + 1, 0), 0);
  const maxChars = await opts.chooseCap({ overhead: overhead + dictionaryCost(allLocationIds), lineChars });
  if (maxChars === null) return undefined;
  if (maxChars !== undefined && base && base.summary.length > maxChars)
    opts.notify(`transparent-compact: the base block alone is ${base.summary.length.toLocaleString()} chars (budget ${maxChars.toLocaleString()}); it is kept un-capped`);
  if (maxChars !== undefined && retainedChars > maxChars)
    opts.notify(`transparent-compact: retained reads alone are ${retainedChars.toLocaleString()} chars (budget ${maxChars.toLocaleString()}); they are kept un-capped`);
  if (maxChars !== undefined && nativeChars > maxChars)
    opts.notify(`transparent-compact: full-fidelity turns alone are ~${nativeChars.toLocaleString()} estimated chars (budget ${maxChars.toLocaleString()}); they are kept un-capped. Only PROSE can be trimmed.`);
  const capped = capSpans(allSpans, maxChars === undefined ? undefined : Math.max(500, maxChars - overhead), dictionaryCost);
  if (opts.presentation) opts.presentation.shortened = capped.trimmed.some(Boolean) || capped.tightened.some(Boolean);

  const blocks: string[] = [];
  if (base) blocks.push(`${baseOpen}\n${base.summary.replace(/\n+$/, "")}\n${BASE_CLOSE}`);
  capped.lines.forEach((lines, i) => {
    const s = allSpans[i];
    const trimmed = capped.trimmed[i];
    const open = spanOpen(i + 1, s.at, s.reason, coversOf(s));
    const attributes = (capped.tightened[i] ? TIGHTENED_ATTR : "") + (trimmed ? SPAN_TRIMMED_ATTR : "");
    blocks.push([
      attributes ? `${open.slice(0, -1)}${attributes}>` : open,
      ...(trimmed ? [SPAN_TRIMMED_NOTE] : []),
      ...lines,
      SPAN_CLOSE,
    ].join("\n"));
  });

  const compactionCount = opts.branchEntries.filter((e) => e.type === "compaction").length + (opts.revisedAt ? 0 : 1);
  const parts: string[] = [];
  parts.push(`## Verbatim compaction checkpoint (compaction ${compactionCount} on this branch)`);
  parts.push(CHECKPOINT_EXPLANATION);
  if (opts.filteredTurnIds?.length) parts.push(FILTER_EXPLANATION);
  if (native.size) parts.push(FIDELITY_EXPLANATION);
  if (base?.kind === "model-summary") {
    parts.push(MIXED_CONTEXT_WARNING);
    opts.notify(MIXED_CONTEXT_WARNING);
  }
  parts.push(`- Latest: ${opts.now} (trigger: ${opts.reason}, ~${opts.tokensBefore.toLocaleString()} tokens before compaction)`);
  if (opts.revisedAt) parts.push(`${REVISION_NOTE_PREFIX}${opts.revisedAt}. No additional history was compacted; the verbatim boundary is unchanged.`);
  parts.push(TOOL_DISPLAY_EXPLANATION);
  parts.push("- [tool error] means the result was flagged as an error; [unknown] means no safely matched result/status. Unlabelled does NOT establish exit 0 or passing tests. → exit N is a reported shell status; output: quotes/extracts selected output, not an inferred verdict. Everything shown is historical. Legacy [ok] only means not flagged as a tool error; legacy calls without status are unknown.");
  parts.push("- Newly compacted custom messages are kept only as type stubs (long types abbreviated); their content is removed and remains recoverable in the session through context_lookup. Stored canonical spans are unchanged; their presentation may tighten under the cap.");
  parts.push(
    "- pi keeps the most recent part of the conversation verbatim (its `keepRecentTokens` setting). The spans below cover only what came *before* that. The retained verbatim conversation begins after the explicit boundary marker at the end of this checkpoint.",
  );
  parts.push("- The full transcript before this point is kept in the session; use `context_lookup` to recover details (including thinking and tool outputs).");
  parts.push("");
  parts.push(RECOVERY_INSTRUCTIONS);
  parts.push("");
  parts.push(SECTION_HEADER);
  parts.push("");
  parts.push(blocks.length > 0 ? blocks.join("\n\n") : "(no user or assistant prose in these spans — use context_lookup)");
  // The location dictionary stays above the LAST checkpoint line; everything
  // after that line is Pi's verbatim tail.
  const locationTable = dictionary(capped.locationIds);
  if (locationTable) parts.push("", locationTable);
  parts.push("");
  parts.push(EVIDENCE_BOUNDARY_RULE);
  parts.push("");
  parts.push(closingLine);

  const summary = parts.join("\n");
  if (native.size && !opts.slots) throw new Error("Missing full-fidelity placement output.");
  opts.slots?.push(...locateSlots(summary, rendered.markers, fidelity));
  return summary;
}

// ============================================================================
// context_lookup subagent: searches the transcript in its own context
// ============================================================================

interface Transcript {
  /** Logical transcript name for subagent citations; never a filesystem path. */
  name: string;
  file: string;
  /** Rendered raw branch, with physical lines and an authoritative entry index. */
  lines: string[];
  index: TranscriptIndexEntry[];
}

/** Entry/section owning a physical line. Only the renderer index is trusted:
 * ENTRY-like text and rules inside tool output cannot spoof attribution. */
function entryAt(lines: string[], idx: number, index: TranscriptIndexEntry[]): { id: string; header: string; section?: string } | undefined {
  const lineNo = idx + 1;
  let lo = 0;
  let hi = index.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid].startLine <= lineNo) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return undefined;
  const e = index[found];
  if (lineNo > e.endLine) return undefined;
  let section: string | undefined;
  for (const s of e.sections ?? []) if (s.startLine <= lineNo) section = s.kind;
  return { id: e.id, header: lines[e.startLine - 1] ?? "", section };
}

// Keep page boundaries between Unicode characters, never inside a surrogate pair.
function characterBoundary(text: string, start: number, end: number): number {
  const prev = text.charCodeAt(end - 1), next = text.charCodeAt(end);
  return end > start && prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
}

// An entry-id boundary pins a paginated listing/search while new tool calls
// and results append to the branch. It is not a snapshot or a filesystem path.
function transcriptWindow(transcripts: Transcript[], file?: string, throughEntry?: string): Transcript[] {
  const targets = file ? transcripts.filter((d) => d.name === file) : transcripts;
  if (!throughEntry) return targets;
  const bounded: Transcript[] = [];
  for (const d of targets) {
    const at = d.index.findIndex((e) => e.id === throughEntry);
    if (at >= 0) bounded.push({ ...d, lines: d.lines.slice(0, d.index[at].endLine), index: d.index.slice(0, at + 1) });
  }
  if (!bounded.length) throw new Error(`Pagination boundary ENTRY "${throughEntry}" is not on this transcript branch. Restart at offset=0 (and charOffset=0 for grep) without throughEntry.`);
  return bounded;
}

// Offsets count JavaScript string characters (UTF-16 code units), not tokens.
// Pagination never discards a suffix: even a single enormous physical line is
// accessible. Only response payloads are capped; small status/cursor notes are extra.
interface PageCursor { offset: number; charOffset?: number; throughEntry?: string }
type OnContinuation = (cursor: PageCursor) => void;

function pageText(text: string, opts: { offset?: number; maxChars: number; maxLines?: number; attribution: string; continuation?: string; onContinuation?: OnContinuation }): string {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  if (offset >= text.length) return `No more content at offset=${offset} (${text.length} total characters).`;
  let end = Math.min(text.length, offset + opts.maxChars);
  if (opts.maxLines !== undefined) {
    let lines = 0;
    for (let i = offset; i < end; i++) {
      if (text[i] === "\n" && ++lines >= opts.maxLines) { end = i + 1; break; }
    }
  }
  end = characterBoundary(text, offset, end);
  const prefix = offset > 0 ? `[Continuation: ${truncateHead(opts.attribution, 1_000)}; offset=${offset}]\n` : "";
  const body = text.slice(offset, end);
  const notice = end < text.length
    ? `\n[Page limited: characters ${offset}–${end - 1} of ${text.length}; ${text.length - end} characters remain. Continue with the same parameters and offset=${end}${opts.continuation ?? ""}.]`
    : "";
  if (end < text.length && end > offset) opts.onContinuation?.({ offset: end });
  return prefix + body + notice;
}

function listEntries(transcripts: Transcript[], opts: { file?: string; offset?: number; throughEntry?: string } = {}, onContinuation?: OnContinuation): string {
  const targets = transcriptWindow(transcripts, opts.file, opts.throughEntry);
  const throughEntry = targets.length === 1 ? targets[0].index.at(-1)?.id : undefined;
  const parts: string[] = [];
  for (const d of targets) {
    const rows = d.index.map((e) => {
      const header = d.lines[e.startLine - 1] ?? "";
      const next = d.lines[e.startLine] ?? "";
      const preview = next.trim() !== "" && !next.startsWith(HR) ? `  ${next.trim().slice(0, 90)}` : "";
      return `${header}${preview}`;
    });
    parts.push(`### ${d.name} (${rows.length} entries)\n${rows.join("\n")}`);
  }
  return parts.length ? pageText(parts.join("\n\n"), {
    offset: opts.offset, maxChars: cfg.listMaxChars, attribution: `entry listing for ${targets.map((t) => t.name).join(", ")}`,
    continuation: throughEntry ? `, throughEntry=${JSON.stringify(throughEntry)}` : "",
    onContinuation: (cursor) => onContinuation?.({ ...cursor, throughEntry }),
  }) : "(no transcript entries)";
}

interface GrepOptions { pattern: string; file?: string; before?: number; after?: number; maxMatches?: number; offset?: number; charOffset?: number; throughEntry?: string }
function grepTranscript(transcripts: Transcript[], opts: GrepOptions, onContinuation?: OnContinuation): string {
  const targets = transcriptWindow(transcripts, opts.file, opts.throughEntry);
  const throughEntry = targets.length === 1 ? targets[0].index.at(-1)?.id : undefined;
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern, "i");
  } catch {
    re = new RegExp(opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const before = Math.max(0, Math.floor(opts.before ?? 2));
  const after = Math.max(0, Math.floor(opts.after ?? 6));
  const maxMatches = Math.max(1, Math.floor(opts.maxMatches ?? 15));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const startCharOffset = Math.max(0, Math.floor(opts.charOffset ?? 0));
  let charOffset = startCharOffset;
  const hits: { transcript: Transcript; line: number }[] = [];
  for (const d of targets) {
    for (let i = 0; i < d.lines.length; i++) if (re.test(d.lines[i])) hits.push({ transcript: d, line: i });
  }
  if (hits.length === 0) return `No matches for /${opts.pattern}/ in ${targets.map((t) => t.name).join(", ") || "(no transcripts)"}.`;
  if (offset >= hits.length) return `No more matches at offset=${offset} (${hits.length} total matches).`;

  const out: string[] = [];
  let size = 0;
  let next = offset;
  for (; next < hits.length && next < offset + maxMatches; next++) {
    const { transcript: d, line: i } = hits[next];
    const entry = entryAt(d.lines, i, d.index);
    const header = truncateHead(`--- ${d.name} line ${i + 1}${entry ? `  << ${entry.header}${entry.section ? `  [${entry.section}]` : ""}` : ""}`, 1_000);
    const from = Math.max(0, i - before);
    const to = Math.min(d.lines.length - 1, i + after);
    const body = d.lines.slice(from, to + 1).map((l, n) => (n + from === i ? `>> ${l}` : `   ${l}`)).join("\n");
    if (charOffset >= body.length) return `Invalid charOffset=${charOffset} for match offset=${next}: the current rendered context has only ${body.length} characters. charOffset is valid only with the same pattern, file, before/after, and throughEntry as the page that issued it. Restart this match at offset=${next} with charOffset=0, keeping your intended search/context parameters.`;
    const prefix = `${header}${charOffset ? `  [match offset=${next}, charOffset=${charOffset}]` : ""}\n`;
    const available = cfg.grepMaxChars - size - prefix.length - (out.length ? 2 : 0);
    if (available <= 0) break;
    const end = characterBoundary(body, charOffset, Math.min(body.length, charOffset + available));
    if (end === charOffset) break;
    const chunk = prefix + body.slice(charOffset, end);
    out.push(chunk);
    size += chunk.length + (out.length > 1 ? 2 : 0);
    if (end < body.length) { charOffset = end; break; }
    charOffset = 0;
  }
  const notice = next < hits.length
    ? `\n[Page limited: ${hits.length} total matches; ${hits.length - next} matches remain${charOffset ? " (including the partially shown match)" : ""}. Continue with the same parameters and offset=${next}, charOffset=${charOffset}${throughEntry ? `, throughEntry=${JSON.stringify(throughEntry)}` : ""}.]`
    : "";
  if (next < hits.length && (next > offset || charOffset > startCharOffset)) {
    onContinuation?.({ offset: next, charOffset, throughEntry });
  }
  return out.join("\n\n") + notice;
}

function showEntry(transcripts: Transcript[], opts: { id: string; includeRelated?: boolean; file?: string; maxLines?: number; offset?: number }, onContinuation?: OnContinuation): string {
  const targets = opts.file ? transcripts.filter((d) => d.name === opts.file) : transcripts;
  const out: string[] = [];
  const headers: string[] = [];
  for (const d of targets) {
    const e = d.index.find((x) => x.id === opts.id);
    if (!e) continue;
    const ids = new Set([e.id, ...(opts.includeRelated === true ? e.relatedIds ?? [] : [])]);
    // Chronological, one-hop expansion: a result includes its originating
    // assistant, not all sibling outputs. An assistant includes its results.
    for (const entry of d.index) {
      if (!ids.has(entry.id)) continue;
      const block = d.lines.slice(entry.startLine - 2, entry.endLine);
      out.push(`### ${d.name}\n${block.join("\n")}`);
      headers.push(`${d.name}: ${d.lines[entry.startLine - 1]}`);
    }
  }
  return out.length ? pageText(out.join("\n\n"), {
    offset: opts.offset, maxChars: cfg.showEntryMaxChars,
    maxLines: Math.max(1, Math.floor(opts.maxLines ?? 400)), attribution: headers.join("; "), onContinuation,
  }) : `No entry with id "${opts.id}" found.`;
}

// Identical paging parameters in the subagent and direct tools; only the
// subagent accepts a logical transcript name (not a filesystem path).
const OFFSET_FIELD = Type.Optional(Type.Integer({ minimum: 0, description: "Character offset (UTF-16 units, default 0). Use the next offset reported by the previous page." }));
const FILE_FIELD = Type.Optional(Type.String({ description: "Logical transcript name. Omit for all." }));
const THROUGH_ENTRY_FIELD = Type.Optional(Type.String({ description: "Last ENTRY id included in this paginated listing/search. Keep the reported throughEntry on subsequent pages to exclude newly appended calls/results; omit to start a fresh search." }));
const LIST_FIELDS = { offset: OFFSET_FIELD, throughEntry: THROUGH_ENTRY_FIELD };
const GREP_FIELDS = {
  pattern: Type.String({ description: "JS regex, case-insensitive" }),
  before: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines before (default 2)" })),
  after: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines after (default 6)" })),
  maxMatches: Type.Optional(Type.Integer({ minimum: 1, description: "Max matches per page (default 15); character limit also applies" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Match offset (0-based, default 0). Use the next offset reported by the previous page." })),
  charOffset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset within that match's context (default 0). Keep pattern, file, before/after and throughEntry unchanged when continuing; otherwise restart the match with charOffset=0." })),
  throughEntry: THROUGH_ENTRY_FIELD,
};
const SHOW_FIELDS = {
  id: Type.String({ description: "ENTRY id" }),
  includeRelated: Type.Optional(Type.Boolean({ description: "Include unambiguously matched tool call/result entries (default false). Keep unchanged when paging." })),
  maxLines: Type.Optional(Type.Integer({ minimum: 1, description: "Max lines per page (default 400); character limit also applies" })),
  offset: OFFSET_FIELD,
};

const LOOKUP_FALLBACK_NOTE =
  "If more detail is needed for this query, use context_list_entries, context_grep, or context_show_entry rather than immediately repeating context_lookup.";

// Append outside the truncated findings so the next-step guidance survives
// even a long write-up. Normal successful answers remain unchanged.
function lookupPartialFindings(text: string, marker: string): string {
  const status = truncateHead(marker, 1_000); // Provider error messages can be large too.
  const budget = cfg.lookupAnswerMaxChars - status.length - LOOKUP_FALLBACK_NOTE.length - 2;
  return `${truncateHead(text, budget)}\n${status}\n${LOOKUP_FALLBACK_NOTE}`;
}

const LOOKUP_WRITEUP_PROMPT =
  "Search is finished; no further tool calls are allowed. Report what you found so far: the facts you confirmed (with ENTRY ids), " +
  "what you could not locate in the material searched, and where you'd look next. " +
  "Budget exhaustion or an incomplete search does not establish absence from the transcript.";

const LOOKUP_SYSTEM_PROMPT = `You are a context-lookup subagent for a coding agent whose main context was compacted by verbatim compaction. The full pre-compaction transcript — including assistant thinking blocks and complete tool outputs that were REMOVED from the main context — is in the transcript files named in the request.

You have three tools:
- list_entries: paginated overview of entries (id, role, timestamp, preview)
- grep: paginated transcript search; matches come with surrounding lines and authoritative ENTRY attribution
- show_entry: retrieve an entry by id in bounded pages; includeRelated=true also shows its matched tool call/result

Search tools bound each response, not the underlying history. A partial page is not the entire evidence, but you do NOT need to exhaust every page. Follow continuation parameters only when omitted content is needed to answer the question, keeping all other search/context parameters unchanged. Narrow an overly broad search rather than paging through irrelevant matches. Stop paging once you have sufficient relevant evidence.

Work efficiently: start with list_entries if you don't know where to look, then grep for concrete terms, then show_entry for exact content. When you are confident you have what is needed, stop calling tools and output your final answer as plain text.

Final answer rules (your final message is the ONLY text the main agent sees):
- Return only the important findings. Do not narrate your search process.
- Quote exact error messages, paths, values, and code verbatim where they matter.
- Cite the ENTRY id (and file) for each finding so the main agent can verify.
- A failed or incomplete search does not establish absence from the transcript. Distinguish "not found in the material searched" from "absent from the transcript". If the search was incomplete or budget-limited, state what you did not reach or confirm; do not claim the answer was never recorded or that the session ended before it occurred.

Provenance rules — label each finding with its source type:
- "user instruction" — what the user asked, pasted, or confirmed
- "observed tool output" — what a tool actually returned at the time (ground truth)
- "reasoning at the time (thinking)" — what the agent believed or hypothesized then; NOT verified fact
Grep attributions include a section tag like [thinking] / [text] / [toolCall]. When a finding rests on old thinking, say explicitly that it was reasoning-at-the-time, so the main agent does not treat it as established fact.`;

// Canonical effective parameters identify a specific issued page, not merely
// a positive offset. Defaults may be made explicit without changing a query.
function lookupPageKey(name: string, args: Record<string, any>): string | undefined {
  const number = (key: string, fallback: number, min = 0): number | undefined => {
    const value = args[key] ?? fallback;
    return Number.isSafeInteger(value) && value >= min ? value : undefined;
  };
  const string = (key: string): string | null | undefined => {
    const value = args[key];
    return value == null ? null : typeof value === "string" ? value : undefined;
  };
  let fields: unknown[];
  switch (name) {
    case "list_entries":
      fields = [string("file"), number("offset", 0), string("throughEntry")];
      break;
    case "grep":
      fields = [typeof args.pattern === "string" ? args.pattern : undefined, string("file"),
        number("before", 2), number("after", 6), number("maxMatches", 15, 1),
        number("offset", 0), number("charOffset", 0), string("throughEntry")];
      break;
    case "show_entry":
      fields = [typeof args.id === "string" ? args.id : undefined, string("file"),
        typeof (args.includeRelated ?? false) === "boolean" ? (args.includeRelated ?? false) : undefined,
        number("maxLines", 400, 1), number("offset", 0)];
      break;
    default:
      return undefined;
  }
  return fields.includes(undefined) ? undefined : JSON.stringify([name, ...fields]);
}

async function runLookupSubagent(opts: {
  question: string;
  transcripts: Transcript[];
  model: Model;
  registry: ModelRegistry;
  signal: AbortSignal | undefined;
}): Promise<string> {
  const toc = truncateHead(listEntries(opts.transcripts).split("\n").slice(0, 60).join("\n"), 4_000);

  const tools: AiTool[] = [
    {
      name: "list_entries",
      description: "List ENTRY headers and previews in pages of up to 12000 payload characters, plus cursor notes. If additional previews are needed, follow all reported continuation parameters (offset and throughEntry). Optional file restricts to a logical transcript name.",
      parameters: Type.Object({ ...LIST_FIELDS, file: FILE_FIELD }),
    },
    {
      name: "grep",
      description: "Regex-search transcript lines with surrounding context and authoritative entry attribution. Up to 12000 payload characters per page, plus cursor notes. Follow all reported continuation parameters (offset, charOffset, throughEntry) only if omitted matches/context are needed. pattern is a JS regex (case-insensitive).",
      parameters: Type.Object({ ...GREP_FIELDS, file: FILE_FIELD }),
    },
    {
      name: "show_entry",
      description: "Retrieve an indexed entry by ENTRY id, optionally with matched tool call/result entries (includeRelated=true), in pages of up to 24000 payload characters and maxLines lines, plus attribution/cursor notes. Follow the reported offset only if omitted content is needed; keep includeRelated unchanged when paging.",
      parameters: Type.Object({ ...SHOW_FIELDS, file: FILE_FIELD }),
    },
  ];

  const messages: AiMessage[] = [
    {
      role: "user",
      content:
        `Question: ${opts.question}\n\n` +
        `Transcript files (full raw session branch; ENTRY blocks are anchored by entry id):\n` +
        opts.transcripts.map((d) => `- ${d.file}`).join("\n") +
        `\n\nTranscript overview (first entries; list_entries can retrieve additional previews if needed):\n${toc}`,
      timestamp: Date.now(),
    },
  ];

  // Ephemeral admission state only: no telemetry, saved trace, or cursor
  // parsing from untrusted transcript text. Each issued cursor is single-use.
  const continuations = new Set<string>();
  const dispatch = (name: string, args: Record<string, any>): string => {
    const issued: OnContinuation = (cursor) => {
      const key = lookupPageKey(name, { ...args, ...cursor });
      if (key) continuations.add(key);
    };
    try {
      switch (name) {
        case "list_entries":
          return listEntries(opts.transcripts, args, issued);
        case "grep":
          return grepTranscript(opts.transcripts, args, issued);
        case "show_entry":
          return showEntry(opts.transcripts, args, issued);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Tool error: ${errMsg(err)}`;
    }
  };

  const sessionId = uuidv7();
  // Continuations do not spend the substantive-search budget, but still cost
  // inference. Bound ALL search-phase model calls, plus one final write-up.
  const maxModelCalls = Math.min(Number.MAX_SAFE_INTEGER, cfg.lookupTurns * 3);
  const searchLimit = `${cfg.lookupTurns}-turn limit`;
  let limit = `${maxModelCalls}-call total limit`;
  let searchTurns = 0;
  let pagingOnlyNotified = false;
  let lastText = "";
  for (let turn = 0; turn < maxModelCalls; turn++) {
    if (searchTurns >= cfg.lookupTurns) {
      if (continuations.size === 0) { limit = searchLimit; break; }
      if (!pagingOnlyNotified) {
        messages.push({ role: "user", content: "The substantive search-turn budget is exhausted. Only follow previously issued continuation pages if needed, or answer now. Do not start new searches.", timestamp: Date.now() });
        pagingOnlyNotified = true;
      }
    }
    const resp = await opts.registry.complete(
      opts.model,
      normalizeContext({ systemPrompt: LOOKUP_SYSTEM_PROMPT, messages, tools }),
      { signal: opts.signal, sessionId, maxTokens: 4096 },
    );
    if (resp.stopReason === "aborted") return "(lookup subagent aborted)";
    if (resp.stopReason === "error") return `(lookup subagent error: ${resp.errorMessage ?? "unknown"})`;

    const toolCalls = resp.content.filter((b) => b.type === "toolCall");
    const text = contentText(resp.content);
    if (text) lastText = text;

    if (toolCalls.length === 0) {
      const answer = text || "(subagent returned no answer)";
      return pagingOnlyNotified
        ? lookupPartialFindings(answer, `[subagent reached the ${searchLimit}; findings may be incomplete]`)
        : truncateHead(answer, cfg.lookupAnswerMaxChars);
    }

    // Check the whole batch against cursors issued BEFORE this response.
    // New queries, changed parameters, invented/replayed cursors and duplicate
    // continuations consume a search turn, even alongside a valid continuation.
    const available = new Set(continuations);
    const keys = toolCalls.map((call) => lookupPageKey(String(call.name), (call.arguments ?? {}) as Record<string, any>));
    const continuationOnly = keys.every((key) => key !== undefined && available.delete(key));
    if (!continuationOnly) {
      if (searchTurns >= cfg.lookupTurns) { limit = searchLimit; break; }
      searchTurns++;
    }
    // Consume before dispatch, so a sibling cannot consume a newly issued page.
    for (const key of keys) if (key) continuations.delete(key);
    messages.push(resp);
    for (const call of toolCalls) {
      const args = (call.arguments ?? {}) as Record<string, any>;
      const result = dispatch(String(call.name), args);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: String(call.name),
        content: [{ type: "text", text: result }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }

  // Either budget is exhausted: one extra tool-free write-up still returns
  // usable partial findings without extending searching or paging indefinitely.
  messages.push({ role: "user", content: LOOKUP_WRITEUP_PROMPT, timestamp: Date.now() });
  const marker = `[subagent reached the ${limit}; this is its write-up of partial findings]`;
  let writeupError = "";
  try {
    const resp = await opts.registry.complete(
      opts.model,
      normalizeContext({ systemPrompt: LOOKUP_SYSTEM_PROMPT, messages }),
      { signal: opts.signal, sessionId, maxTokens: 4096 },
    );
    const text = resp.stopReason === "aborted" || resp.stopReason === "error" ? "" : contentText(resp.content);
    if (text) return lookupPartialFindings(text, marker);
  } catch (err) {
    writeupError = errMsg(err);
  }
  const why = writeupError ? `; write-up failed: ${writeupError}` : "";
  return lookupPartialFindings(lastText, `[subagent reached the ${limit}; findings may be incomplete${why}]`);
}

// ============================================================================
// Session-backed transcript (rendered only when a recovery tool is called)
// ============================================================================

function sessionTranscript(ctx: { sessionManager: { getBranch: () => SessionEntry[] } }): Transcript {
  const override = process.env.MECH_COMPACT_LOOKUP_SESSION_FILE?.trim();
  let entries: SessionEntry[];
  if (override) {
    // Fail closed: never silently search the pruned fork when an override is
    // misconfigured. Guard open() because pi initializes empty/missing files.
    if (!path.isAbsolute(override)) throw new Error("MECH_COMPACT_LOOKUP_SESSION_FILE must be an absolute path.");
    const stat = fs.statSync(override);
    if (!stat.isFile() || stat.size === 0) throw new Error("MECH_COMPACT_LOOKUP_SESSION_FILE must name a non-empty session JSONL file.");
    entries = SessionManager.open(override).getBranch();
  } else {
    // getBranch() is raw history, unlike buildSessionContext(): compaction
    // and context edits never remove earlier thinking or tool results here.
    entries = ctx.sessionManager.getBranch();
  }
  const { lines, index } = branchToTranscript(entries);
  return { name: "session", file: "session", lines, index };
}

// ============================================================================
// Main-agent fallback: the same transcript search functions as the subagent
// ============================================================================

const FALLBACK_TOOL_NAMES = new Set(["context_list_entries", "context_grep", "context_show_entry"]);

/** Count prior lookup attempts since the last user/ordinary-work/bash boundary.
 * Fallback results, text, and thinking neither increase nor reset the count. Deduplicate call/result ids, and include
 * earlier siblings in the current assistant message even before results exist:
 * two parallel lookups cannot both claim the first slot. Later siblings are
 * excluded. Raw branch state follows reload, resume, compaction, and forks. */
function consecutiveLookups(ctx: { sessionManager: { getBranch: () => SessionEntry[] } }, toolCallId: string): number {
  const entries = ctx.sessionManager.getBranch();
  const calls = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role === "user" || m.role === "bashExecution") break;
    if (m.role === "toolResult") {
      if (FALLBACK_TOOL_NAMES.has(m.toolName)) continue;
      if (m.toolName !== "context_lookup") break;
      calls.add(m.toolCallId);
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type !== "toolCall") continue;
        if (b.id === toolCallId) break;
        if (b.name === "context_lookup") calls.add(b.id);
      }
    }
  }
  return calls.size;
}

function registerDirectTools(pi: ExtensionAPI): void {
  const pre = "Fallback after context_lookup, when its findings are incomplete; same scope as context_lookup. ";
  const run = (ctx: { sessionManager: { getBranch: () => SessionEntry[] } }, f: (t: Transcript[]) => string) => {
    try {
      const transcript = sessionTranscript(ctx);
      if (transcript.index.length === 0) return { content: [{ type: "text" as const, text: "No entries found on the session branch." }], details: undefined };
      return { content: [{ type: "text" as const, text: f([transcript]) }], details: undefined };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Tool error: ${errMsg(err)}` }], details: undefined };
    }
  };
  pi.registerTool({
    name: "context_list_entries",
    label: "Context: list entries",
    description: pre + "List raw session ENTRY headers and previews, including compacted entries, in pages of up to 12000 payload characters, plus cursor notes. Follow all reported continuation parameters (offset and throughEntry).",
    promptSnippet: "Fallback: list this conversation's entries for post-compaction recovery",
    parameters: Type.Object(LIST_FIELDS),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (t) => listEntries(t, params));
    },
  });
  pi.registerTool({
    name: "context_grep",
    label: "Context: grep",
    description: pre + "Regex-search the full raw session branch, including compacted thinking and tool outputs, with surrounding lines and entry attribution. pattern is a JS regex (case-insensitive). Up to 12000 payload characters per page, plus cursor notes. Follow all reported continuation parameters (offset, charOffset, throughEntry) for remaining matches or oversized lines. Historical thinking is not verified fact.",
    promptSnippet: "Fallback: search this conversation's evidence hidden by compaction",
    parameters: Type.Object(GREP_FIELDS),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (t) => grepTranscript(t, params));
    },
  });
  pi.registerTool({
    name: "context_show_entry",
    label: "Context: show entry",
    description: "Read a known raw session entry to recover a specific detail hidden by compaction. Use an ENTRY id returned by context_lookup, context_grep, or context_list_entries. Prefer context_lookup when search or interpretation is needed; same scope as context_lookup. Start with a small maxLines. Optional includeRelated=true includes matched tool call/result entries; use it only if the counterpart is needed. Returns up to 24000 payload characters and maxLines lines per page, plus attribution/cursor notes; a page may not contain the entire entry. Continue with the reported offset only if the requested detail is missing, incomplete, or needs more context to resolve ambiguity, keeping includeRelated unchanged. Stop once the question is answered; do not expand surrounding history by default.",
    promptSnippet: "Recover a specific detail hidden by compaction at a known ENTRY id in this conversation.",
    parameters: Type.Object(SHOW_FIELDS),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (t) => showEntry(t, params));
    },
  });
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Only bridge a specific /filter-later (or /fl) submission to its actual persisted user
  // message. The next input clears a failed/handled submission, so it cannot
  // accidentally flag a later ordinary prompt. Durable state uses raw entries.
  let requestedAside: { sessionId: string; text: string } | undefined;
  let asideInputSession: string | undefined;
  const clearAsideSubmission = () => { requestedAside = undefined; asideInputSession = undefined; };
  pi.on("input", (event, ctx) => {
    asideInputSession = event.source === "extension" && requestedAside?.sessionId === ctx.sessionManager.getSessionId() &&
      requestedAside.text === event.text ? requestedAside.sessionId : undefined;
    requestedAside = undefined;
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "user" || asideInputSession !== ctx.sessionManager.getSessionId()) return;
    asideInputSession = undefined;
    // Pi persists this user message immediately after message_end handlers.
    pi.appendEntry(PREFLAG_ENTRY, { timestamp: event.message.timestamp });
  });
  pi.on("session_shutdown", clearAsideSubmission);
  pi.on("session_tree", clearAsideSubmission);

  // Starting/resuming a run persists the checklist AFTER the starting user
  // message. Existing branch history, not an in-memory flag, prevents repeats.
  pi.on("before_agent_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    const compaction = latestVerbatimCompaction(entries);
    if (!compaction) return;
    const revisionId = latestFilterRevision(entries)?.id ?? compaction.id;
    const found = entries.some((e) => {
      if (e.type !== "custom_message" || e.customType !== REORIENT_MESSAGE) return false;
      const details = e.details as { compactionId?: string; revisionId?: string } | undefined;
      return details?.compactionId === compaction.id && (details.revisionId ?? details.compactionId) === revisionId;
    });
    if (!found) return { message: reorientationMessage(compaction.id, filteredTurns(entries).length > 0, revisionId, Object.keys(turnFidelities(entries)).length > 0) };
  });

  // Between-turn compaction and overflow continuation do not necessarily pass
  // through before_agent_start. Steering is consumed by Pi before that next
  // request and persists the same custom message. Idle/post-run compactions wait
  // for the next starting message instead; the checklist must not start a run.
  pi.on("session_compact", (event, ctx) => {
    if ((event.compactionEntry.details as { kind?: string } | undefined)?.kind !== MECH_KIND) return;
    if (event.willRetry || ctx.signal)
      pi.sendMessage(reorientationMessage(event.compactionEntry.id,
        ((event.compactionEntry.details as { filteredTurnIds?: string[] }).filteredTurnIds?.length ?? 0) > 0, event.compactionEntry.id,
        Object.keys((event.compactionEntry.details as { fidelity?: TurnFidelities }).fidelity ?? {}).length > 0), { deliverAs: "steer" });
  });

  // Run after ordinary transforms and system/tool restoration. Preserve all
  // non-managed messages, remove old checklists even if they survive in the tail,
  // and keep the current one active on subsequent requests (not just the first).
  pi.on("context_with_system", (event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    try {
      const messages = projectReorientation(projectCheckpoint(event.messages, entries), entries);
      if (Object.keys(turnFidelities(entries)).length) checkContextBudget(messages, ctx);
      if (messages.length !== event.messages.length || messages.some((m, i) => m !== event.messages[i])) return { messages };
    } catch (error) {
      ctx.ui.notify(`Full-fidelity context blocked: ${errMsg(error)}`, "error");
      ctx.abort(); // Hook errors alone do not cancel Pi requests. Abort explicitly.
      throw error;
    }
  });

  // Method selection never changes Pi's auto-compaction enabled setting.
  pi.registerCommand("compaction-method", {
    description: "Show or set the session compaction method: verbatim|summary (manual and automatic)",
    getArgumentCompletions: (prefix) => ["verbatim", "summary"]
      .filter((method) => method.startsWith(prefix))
      .map((method) => ({ value: method, label: method })),
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested && requested !== "verbatim" && requested !== "summary") {
        ctx.ui.notify("Usage: /compaction-method [verbatim|summary]", "error");
        return;
      }
      const entries = ctx.sessionManager.getBranch();
      const previous = compactionMethod(entries);
      const method = requested || previous;
      const changed = method !== previous;
      if (changed) pi.appendEntry(METHOD_ENTRY, { method });
      ctx.ui.notify(`Compaction method: ${method} (manual, automatic, and overflow recovery).`, "info");
      if (changed && method === "summary") ctx.ui.notify(SUMMARY_COMPACTION_WARNING, "warning");
      else if (changed && collectBaseAndSpans(entries).base?.kind === "model-summary") ctx.ui.notify(MIXED_CONTEXT_WARNING, "warning");
    },
  });

  pi.registerCommand("cap-compaction", {
    description: "Show or set verbatim compaction cap: on|off|warn [80000c|20000t|25%]",
    getArgumentCompletions: (prefix) => {
      const mode = /^(on|off|warn)\s/.exec(prefix)?.[1];
      const values = mode ? ["80000c", "20000t", "25%"].map((budget) => `${mode} ${budget}`)
        : ["on", "off", "warn", "80000c", "20000t", "25%"];
      return values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const previous = capSettings(ctx.sessionManager.getBranch());
      const words = args.trim().split(/\s+/).filter(Boolean);
      const mode = ["on", "off", "warn"].includes(words[0]) ? words.shift() as CapMode : previous.mode;
      const budget = words.length === 0 ? previous.budget : words.length === 1 ? parseCapBudget(words[0]) : undefined;
      if (!budget) {
        ctx.ui.notify("Usage: /cap-compaction [on|off|warn] [<chars>c|<estimated tokens>t|<percent>%]; percentages must be >0 and <=100.", "error");
        return;
      }
      const next = { mode, budget };
      persistCap(pi, previous, next);
      ctx.ui.notify(`${capDescription(next, ctx.model?.contextWindow)} Applies only to verbatim compaction.`, "info");
    },
  });

  for (const name of ["filter-later", "fl"]) pi.registerCommand(name, {
    description: "Submit a normal user turn pre-flagged for future checkpoint filtering",
    handler: async (args, ctx) => {
      if (!args.trim()) { ctx.ui.notify(`Usage: /${name} <message>`, "error"); return; }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait until the agent is idle and queued messages have been handled before submitting an aside.", "warning"); return;
      }
      if (compactionMethod(ctx.sessionManager.getBranch()) !== "verbatim") {
        ctx.ui.notify(`/${name} requires verbatim compaction. Use /compaction-method verbatim first.`, "error"); return;
      }
      clearAsideSubmission();
      requestedAside = { sessionId: ctx.sessionManager.getSessionId(), text: args };
      try {
        pi.sendUserMessage(args);
      } catch (error) {
        clearAsideSubmission();
        throw error;
      }
    },
  });

  pi.registerCommand("filter-auto", {
    description: "Show or set automatic application of pre-flagged asides: on|off (default off)",
    getArgumentCompletions: (prefix) => ["on", "off"].filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value && value !== "on" && value !== "off") { ctx.ui.notify("Usage: /filter-auto [on|off]", "error"); return; }
      const previous = autoFilterEnabled(ctx.sessionManager.getBranch());
      const enabled = value ? value === "on" : previous;
      if (enabled !== previous) pi.appendEntry(AUTO_FILTER_ENTRY, { enabled });
      ctx.ui.notify(`Automatic aside filtering: ${enabled ? "on" : "off"}. Applies user pre-flags during verbatim threshold/overflow compaction; no picker or automatic relevance judgments.`, "info");
    },
  });

  const filterTurns = {
    description: "Choose checkpoint turn modes: pruned, prose, prose+tools or full; no compaction",
    handler: async (args: string, ctx: ExtensionContext, reads = false) => {
      const command = reads ? "/retain-reads" : "/filter-turns";
      if (args.trim()) { ctx.ui.notify(`Usage: ${command}`, "error"); return; }
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify(`${command} requires the interactive terminal UI.`, "error"); return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait until the agent is idle and queued messages have been handled before filtering turns.", "warning"); return;
      }
      const entries = ctx.sessionManager.getBranch();
      const compaction = latestVerbatimCompaction(entries);
      if (compactionMethod(entries) !== "verbatim") {
        ctx.ui.notify(`${command} requires verbatim compaction.`, "error"); return;
      }
      const catalog = readCatalog(entries, ctx.cwd);
      let retention = readRetentionState(entries, ctx, catalog);
      if (!compaction) {
        if (!reads) { ctx.ui.notify("/filter-turns requires an existing verbatim checkpoint. Use /compact-filtered to create one.", "error"); return; }
        const sessionId = ctx.sessionManager.getSessionId(), leafId = ctx.sessionManager.getLeafId();
        const result = await pickRetainedReads(ctx, catalog, retention, new Set(), new AbortController().signal);
        if (!result) return;
        if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId || !ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify("Session changed; retention update cancelled.", "warning"); return;
        }
        if (JSON.stringify(result) === JSON.stringify(retention)) {
          ctx.ui.notify("No read-retention changes.", "info"); return;
        }
        pi.appendEntry(READ_RETENTION_ENTRY, result);
        ctx.ui.notify("Read retention saved for future verbatim compactions.", "info"); return;
      }
      const canonical = compaction.details as { span: StoredSpan; readRetention: ReadRetention; readFiles: string[]; modifiedFiles: string[] };
      if (!canonical.span) {
        ctx.ui.notify("This checkpoint has no editable canonical spans. Use /compact-filtered first.", "error"); return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const revisionId = latestFilterRevision(entries)?.id;
      const signal = new AbortController().signal;
      try {
        const previousExcluded = filteredTurns(entries), previousKept = keptAsideTurns(entries);
        const excluded = new Set(previousExcluded), keptAsides = new Set(previousKept);
        const previousFidelity = turnFidelities(entries), fidelity = { ...previousFidelity }, slots: TurnSlot[] = [];
        const preflags = preflaggedTurns(entries);
        const anchor = latestFilterRevision(entries) ?? compaction;
        const savedRetention = anchor.type === "custom" ? anchor.data.readRetention : canonical.readRetention;
        const savedEntries = entries.slice(0, entries.indexOf(anchor) + 1);
        const previousRetained = renderRetainedReads(readCatalog(savedEntries, ctx.cwd), savedRetention,
          savedEntries, compaction.firstKeptEntryId, excluded, fidelity);
        // LATEST can move (or an output can be context-edited) without a mode
        // toggle. Compare generated read copies against their original branch
        // inputs, never by parsing quoted text out of the saved checkpoint.
        const sameRetention = () => JSON.stringify(retention) === JSON.stringify(savedRetention) &&
          renderRetainedReads(catalog, retention, entries, compaction.firstKeptEntryId,
            new Set(previousExcluded), previousFidelity) === previousRetained;
        const proposed = new Set([...excluded, ...[...preflags].filter((id) => !keptAsides.has(id))]);
        const choices = filterChoices(entries, collectBaseAndSpans(entries).spans, excluded,
          compaction.firstKeptEntryId, selectedReads(catalog, retention), proposed);
        const unchanged = (pruned: Set<string>, kept: Set<string>, modes: TurnFidelities) =>
          pruned.size === previousExcluded.length && previousExcluded.every((id) => pruned.has(id)) &&
          kept.size === previousKept.length && previousKept.every((id) => kept.has(id)) &&
          JSON.stringify(Object.entries(modes).sort()) === JSON.stringify(Object.entries(previousFidelity).sort());
        const cap = capSettings(entries);
        const renderCheckpoint = (pruned: Set<string>, modes: TurnFidelities, placements: TurnSlot[], preview: boolean, presentation?: { shortened: boolean }) => buildMechanicalSummary({
          reason: canonical.span.reason, tokensBefore: compaction.tokensBefore, branchEntries: entries,
          now: canonical.span.at, revisedAt: new Date().toISOString(), spanLines: [], filteredTurnIds: [...pruned], fidelity: modes, slots: placements, presentation,
          firstKeptEntryId: compaction.firstKeptEntryId,
          ...checkpointEvidence(entries, compaction.firstKeptEntryId, ctx.cwd,
            retention, canonical.readFiles, canonical.modifiedFiles, pruned),
          cwd: ctx.cwd, notify: preview ? () => {} : (message) => ctx.ui.notify(message, "warning"),
          chooseCap: preview ? async () => {
            if (cap.mode === "off") return undefined;
            const limit = capBudgetChars(cap.budget, ctx.model?.contextWindow);
            if (limit === undefined) throw new Error("Cannot preview a percentage cap without the model's context window.");
            return limit; // Warn-mode previews assume applying the current cap; never open a dialog or persist policy here.
          } : (size) => chooseCapBudget(pi, ctx, signal, "manual", size, "checkpoint update"),
        });
        const activeTools = new Set(pi.getActiveTools());
        const system: AgentMessage = { role: "system", content: ctx.getSystemPrompt(), timestamp: 0,
          toolsAdded: pi.getAllTools().filter((tool) => activeTools.has(tool.name))
            .map(({ name, description, parameters }) => ({ name, description, parameters })) };
        const tailTokens = messageTokens(retainedTailMessages(entries, compaction.firstKeptEntryId));
        const measure = (summary: string, placements: TurnSlot[], modes: TurnFidelities, pruned: Set<string>, shortening?: ContextEstimate["shortening"]): ContextEstimate => {
          const reminder: AgentMessage = { ...reorientationMessage(compaction.id, pruned.size > 0,
            revisionId ?? compaction.id, Object.keys(modes).length > 0), role: "custom", timestamp: 0 };
          const messages = checkpointContextMessages(summary, placements, modes, entries, compaction.firstKeptEntryId);
          return { ...estimateContext([system, ...messages, reminder], ctx), tailTokens,
            noticeTokens: contextNoticeTokens(messages, reminder), shortening };
        };
        const saved = latestFilterRevision(entries)?.data ?? { summary: compaction.summary,
          slots: (compaction.details as { slots?: TurnSlot[] }).slots };
        let baseline: Promise<ContextEstimate | undefined> | undefined;
        const estimateSelection = async (selection: TurnSelection): Promise<ContextEstimate> => {
          baseline ??= Promise.resolve().then(() => measure(saved.summary, saved.slots ?? [], previousFidelity, new Set(previousExcluded))).catch(() => undefined);
          const pruned = new Set(previousExcluded), kept = new Set(previousKept), modes = { ...previousFidelity }, placements: TurnSlot[] = [];
          applyTurnSelection(choices, selection, preflags, pruned, kept, modes);
          const original = await baseline;
          if (unchanged(pruned, kept, modes) && sameRetention()) return { ...(original ?? measure(saved.summary, saved.slots ?? [], previousFidelity, pruned)), delta: original ? 0 : undefined };
          const presentation = { shortened: false };
          const summary = await renderCheckpoint(pruned, modes, placements, true, presentation);
          if (summary === undefined) throw new Error("Checkpoint preview cancelled.");
          const estimated = measure(summary, placements, modes, pruned,
            presentation.shortened ? cap.mode === "warn" ? "confirmation" : "automatic" : undefined);
          return { ...estimated, delta: original ? estimated.tokens - original.tokens : undefined,
            noticeDelta: original?.noticeTokens && estimated.noticeTokens ? {
              pruning: (previousExcluded.length > 0) === (pruned.size > 0) ? 0 : estimated.noticeTokens.pruning - original.noticeTokens.pruning,
              revision: revisionId ? 0 : estimated.noticeTokens.revision - original.noticeTokens.revision,
              fidelity: Boolean(Object.keys(previousFidelity).length) === Boolean(Object.keys(modes).length) ? 0 : estimated.noticeTokens.fidelity - original.noticeTokens.fidelity,
            } : undefined };
        };
        if (reads) {
          const result = await pickRetainedReads(ctx, catalog, retention, excluded, signal);
          if (!result) return;
          retention = result;
        } else {
          const result = await pickFilteredTurns(ctx, choices, signal, estimateSelection);
          if (result === undefined) return;
          applyTurnSelection(choices, result, preflags, excluded, keptAsides, fidelity);
        }
        if (unchanged(excluded, keptAsides, fidelity) && sameRetention()) {
          ctx.ui.notify("No checkpoint context changes.", "info"); return;
        }
        const summary = await renderCheckpoint(excluded, fidelity, slots, false);
        if (summary === undefined) return;
        checkCheckpointBudget(summary, slots, fidelity, entries, compaction.firstKeptEntryId, ctx);
        const current = ctx.sessionManager.getBranch();
        if (ctx.sessionManager.getSessionId() !== sessionId || latestVerbatimCompaction(current)?.id !== compaction.id ||
            latestFilterRevision(current)?.id !== revisionId || ctx.sessionManager.getLeafId() !== entries.at(-1)?.id || !ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify("Session/checkpoint changed; filtering update cancelled.", "warning"); return;
        }
        pi.appendEntry(FILTER_REVISION_ENTRY, { compactionId: compaction.id, summary, readRetention: retention,
          filteredTurnIds: [...excluded], keptAsideTurnIds: [...keptAsides],
          ...(Object.keys(fidelity).length ? { fidelity, slots } : {}) } satisfies FilterRevision);
        ctx.ui.notify("Checkpoint context updated. No additional history compacted; recent messages and boundary unchanged.", "info");
      } catch (error) {
        ctx.ui.notify(`Checkpoint context update cancelled: ${errMsg(error)}`, "error");
      }
    },
  };

  pi.registerCommand("compact-filtered", {
    description: "Run ordinary compaction, then open checkpoint turn controls",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("Usage: /compact-filtered", "error"); return; }
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("/compact-filtered requires the interactive terminal UI.", "error"); return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait until the agent is idle and queued messages have been handled before filtering turns.", "warning"); return;
      }
      if (compactionMethod(ctx.sessionManager.getBranch()) !== "verbatim") {
        ctx.ui.notify("/compact-filtered requires verbatim compaction. Use /compaction-method verbatim first.", "error"); return;
      }
      const sessionId = ctx.sessionManager.getSessionId(), leafId = ctx.sessionManager.getLeafId();
      try {
        // compact() is callback-based. Wait for completion, not merely dispatch,
        // so the editor sees the saved checkpoint and the host is idle again.
        const result = await new Promise<{ summary: string; firstKeptEntryId: string }>((resolve, reject) => {
          ctx.compact({ onComplete: resolve, onError: reject });
        });
        const entries = ctx.sessionManager.getBranch(), current = latestVerbatimCompaction(entries);
        if (ctx.sessionManager.getSessionId() !== sessionId || !current || current.summary !== result.summary ||
            current.firstKeptEntryId !== result.firstKeptEntryId || (leafId && !entries.some((entry) => entry.id === leafId))) {
          ctx.ui.notify("Session/checkpoint changed; turn controls not opened.", "warning"); return;
        }
      } catch (error) {
        // These are Pi's current no-op outcomes, not general compaction failures.
        // Only an unchanged session with an existing checkpoint can be edited.
        const noOp = error instanceof Error && (error.message === "Already compacted" || error.message === "Nothing to compact (session too small)");
        if (!noOp || ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId ||
            !latestVerbatimCompaction(ctx.sessionManager.getBranch())) {
          ctx.ui.notify(`Compaction before turn editing failed: ${errMsg(error)}`, "error"); return;
        }
      }
      // The common editor rechecks idle/UI/method state. Escape here leaves the
      // already completed compaction intact; only the proposed revision is lost.
      await filterTurns.handler("", ctx);
    },
  });
  pi.registerCommand("filter-turns", filterTurns);
  pi.registerCommand("retain-reads", {
    description: "Choose retained file reads: off, first or latest; preview full outputs",
    handler: (args, ctx) => filterTurns.handler(args, ctx, true),
  });
  pi.registerCommand("export-checkpoint", {
    description: "Export the saved checkpoint text, including manual revisions: [path]",
    handler: async (args, ctx) => {
      const argument = args.trim();
      const match = argument.match(/^(?:"([^"]+)"|'([^']+)'|([^\s"']+))$/);
      if (argument && !match) {
        ctx.ui.notify("Usage: /export-checkpoint [path] (quote paths containing spaces)", "error"); return;
      }
      const entries = ctx.sessionManager.getBranch();
      const compaction = entries.findLast((entry) => entry.type === "compaction");
      if (!compaction) {
        ctx.ui.notify("No checkpoint in this branch. Use /compact first.", "info"); return;
      }
      const filename = match?.[1] ?? match?.[2] ?? match?.[3] ?? `pi-checkpoint-${ctx.sessionManager.getSessionId()}.txt`;
      const outputPath = path.resolve(ctx.cwd, filename.replace(/^~(?=$|[/\\])/, () => homedir()));
      // Export the frozen text, not a reconstruction from newer reads or spans.
      // Native turn expansions are separate context messages, not summary text.
      const summary = latestFilterRevision(entries)?.data.summary ?? compaction.summary;
      try {
        fs.writeFileSync(outputPath, summary, { encoding: "utf8", mode: 0o600 });
        ctx.ui.notify(`Checkpoint exported to: ${outputPath}`, "info");
      } catch (error) {
        ctx.ui.notify(`Failed to export checkpoint: ${errMsg(error)}`, "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    clearAsideSubmission();
    const entries = ctx.sessionManager.getBranch();
    if (compactionMethod(entries) === "verbatim" && collectBaseAndSpans(entries).base?.kind === "model-summary") {
      ctx.ui.notify(MIXED_CONTEXT_WARNING, "warning");
    }

    // Amend the built-in command's autocomplete description, not its handler.
    // Older Pi versions without this API keep their original description.
    if (ctx.mode !== "tui" || typeof ctx.ui.addAutocompleteProvider !== "function") return;
    ctx.ui.addAutocompleteProvider((current) => ({
      get triggerCharacters() { return current.triggerCharacters; },
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        if (!suggestions || !/^\/\S*$/.test(suggestions.prefix)) return suggestions;
        const method = compactionMethod(ctx.sessionManager.getBranch());
        return {
          ...suggestions,
          items: suggestions.items.map((item) => item.value === "compact"
            ? { ...item, description: method === "verbatim"
              ? "Manually compact with transparent-compact"
              : "Manually compact with summary compaction" }
            : item),
        };
      },
      applyCompletion: (...args) => current.applyCompletion(...args),
      shouldTriggerFileCompletion: (...args) => current.shouldTriggerFileCompletion?.(...args) ?? true,
    }));
  });

  // --------------------------------------------------------------------------
  // Mechanical compaction
  // --------------------------------------------------------------------------
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, reason, signal } = event;
    const automaticFiltering = reason !== "manual" && autoFilterEnabled(branchEntries);
    if (!preparation) return;
    if (signal?.aborted) return;
    if (preparation.messagesToSummarize.length === 0 && preparation.turnPrefixMessages.length === 0) return;
    if (compactionMethod(ctx.sessionManager.getBranch()) === "summary") {
      const revision = latestFilterRevision(branchEntries);
      if (revision || Object.keys(turnFidelities(branchEntries)).length) {
        // Pi prepares from the saved compaction, not our request projection.
        // Summary mode must consume the revised checkpoint too, rather than
        // resurrecting filtered text or dropping standalone restorations.
        const active = latestVerbatimCompaction(branchEntries)!;
        preparation.previousSummary = projectCheckpoint([{ role: "compactionSummary", summary: active.summary, tokensBefore: active.tokensBefore, timestamp: 0 }], branchEntries)
          .map((message) => message.role === "compactionSummary" ? message.summary : previewMessages([message]).join("\n")).join("\n\n");
        const canonical = latestVerbatimCompaction(branchEntries)!.details as {
          readRetention: ReadRetention; readFiles: string[]; modifiedFiles: string[];
        };
        const visible = checkpointEvidence(branchEntries, preparation.firstKeptEntryId, ctx.cwd,
          readRetentionState(branchEntries, ctx), canonical.readFiles, canonical.modifiedFiles, new Set(filteredTurns(branchEntries)));
        const ops = preparation.fileOps;
        ops.read = new Set(visible.readFiles);
        ops.edited = new Set(visible.modifiedFiles);
        ops.written = new Set();
        for (const message of [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]) {
          const calls = message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall")
            : message.role === "toolResult" ? message.nestedCalls?.calls ?? [] : [];
          for (const call of calls) {
            const file = (call.arguments as { path?: unknown } | undefined)?.path;
            if (typeof file !== "string" || !file) continue;
            if (call.name === "read") ops.read.add(file);
            else if (call.name === "write") ops.written.add(file);
            else if (call.name === "edit") ops.edited.add(file);
          }
        }
      }
      return; // No override: Pi runs its normal model-generated compaction.
    }

    // No disk snapshot: pi retains the full raw branch in its session.

    // 1) Cumulative file lists: pi only carries lists from pi-generated
    //    compactions (fromHook=false), so we carry our own forward.
    let retainingReads = false;
    try {
      const fileOps = preparation.fileOps as { read: Set<string>; written: Set<string>; edited: Set<string> } | undefined;
      if (fileOps) {
        for (let i = branchEntries.length - 1; i >= 0; i--) {
          const e = branchEntries[i];
          if (e.type === "compaction") {
            const d = (e as { details?: { kind?: string; readFiles?: string[]; modifiedFiles?: string[] } }).details;
            if (d?.kind === MECH_KIND) {
              for (const f of d.readFiles ?? []) fileOps.read.add(f);
              for (const f of d.modifiedFiles ?? []) fileOps.edited.add(f);
              break;
            }
          }
        }
      }

      const modified = new Set([...(fileOps?.edited ?? []), ...(fileOps?.written ?? [])]);
      const canonicalModifiedFiles = [...modified].sort();
      const canonicalReadFiles = [...(fileOps?.read ?? [])].filter((f) => !modified.has(f)).sort();

      // 2) The new span. Pi's preparation span is [previous cut, current cut)
      //    — it includes the previous compaction's retained tail (verified
      //    against prepareCompaction: the projection places the retained tail
      //    right after the previous compaction entry and boundaryStart sits at
      //    it), so consecutive spans tile: nothing is summarized twice or
      //    missed. No entry-id bookkeeping is needed; the next preparation is
      //    authoritative.
      const nowIso = new Date().toISOString();
      const allMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
      // Span coverage range: first/last summarised message timestamps (pi
      // message timestamps are epoch ms; ISO strings are accepted too).
      const toIso = (ts: unknown): string | undefined => {
        const t = typeof ts === "number" ? ts : typeof ts === "string" && ts !== "" ? Date.parse(ts) : NaN;
        return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
      };
      const msgTs = (m: AgentMessage): unknown => (m as unknown as { timestamp?: unknown }).timestamp;
      const spanFrom = toIso(msgTs(allMessages[0]));
      const spanTo = toIso(msgTs(allMessages[allMessages.length - 1]));
      const renderer = new ToolRenderer(ctx.cwd, { entries: checkpointLocations(branchEntries) });
      const span = await summarizeMessages(allMessages, renderer, preparedMessageSources(branchEntries, allMessages));
      const spanLines = span.lines;

      // 3) Explicit read choices apply independently after whole-turn filtering.
      const catalog = readCatalog(branchEntries, ctx.cwd);
      const canonicalRetained = readRetentionState(branchEntries, ctx, catalog);
      retainingReads = selectedReads(catalog, canonicalRetained).length > 0;
      const excluded = new Set(filteredTurns(branchEntries));
      const keptAsides = new Set(keptAsideTurns(branchEntries));
      const fidelity = { ...turnFidelities(branchEntries) }, slots: TurnSlot[] = [];
      if (automaticFiltering) {
        const preflags = preflaggedTurns(branchEntries);
        const proposed = new Set([...excluded, ...[...preflags].filter((id) => !keptAsides.has(id))]);
        const choices = filterChoices(branchEntries, [...collectBaseAndSpans(branchEntries).spans, span],
          excluded, preparation.firstKeptEntryId, selectedReads(catalog, canonicalRetained), proposed);
        for (const turn of choices)
          if (!turn.unavailable && !turn.deferred && proposed.has(turn.id)) excluded.add(turn.id);
      }
      const filteredTurnIds = [...excluded];
      const evidence = checkpointEvidence(branchEntries, preparation.firstKeptEntryId, ctx.cwd,
        canonicalRetained, canonicalReadFiles, canonicalModifiedFiles, excluded);
      const summary = await buildMechanicalSummary({
        reason, // pi's raw reason, passed through unchanged
        tokensBefore: preparation.tokensBefore,
        branchEntries,
        now: nowIso,
        spanLines,
        spanTools: span.tools,
        locations: renderer.locations.entries,
        spanTurnIds: span.turnIds,
        spanReadPositions: span.readPositions,
        filteredTurnIds, fidelity, slots,
        spanFrom,
        spanTo,
        firstKeptEntryId: preparation.firstKeptEntryId,
        ...evidence,
        cwd: ctx.cwd,
        notify: (m) => ctx.ui?.notify?.(m, "warning"),
        chooseCap: (size) => chooseCapBudget(pi, ctx, signal, reason, size),
      });
      if (summary === undefined || signal?.aborted) return { cancel: true };
      checkCheckpointBudget(summary, slots, fidelity, branchEntries, preparation.firstKeptEntryId, ctx);

      ctx.ui?.notify?.(
        `transparent-compact: ~${preparation.tokensBefore.toLocaleString()} tokens -> verbatim checkpoint; full transcript kept in the session`,
        "info",
      );

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            kind: MECH_KIND,
            // Canonical metadata stays reversible; only the rendered checkpoint
            // masks file paths owned by excluded turns. Retained reads are independent.
            readFiles: canonicalReadFiles,
            modifiedFiles: canonicalModifiedFiles,
            readRetention: canonicalRetained,
            locations: renderer.locations.entries,
            ...(filteredTurnIds.length ? { filteredTurnIds } : {}),
            ...(keptAsides.size ? { keptAsideTurnIds: [...keptAsides] } : {}),
            ...(Object.keys(fidelity).length ? { fidelity, slots } : {}),
            // Only this compaction's own span (un-capped lines). Earlier spans
            // are re-rendered from the earlier entries' details — no nesting.
            span: { at: nowIso, from: spanFrom, to: spanTo, reason, tokensBefore: preparation.tokensBefore,
              lines: spanLines, turnIds: span.turnIds, ...(span.readPositions ? { readPositions: span.readPositions } : {}),
              ...(span.tools ? { tools: span.tools } : {}) },
          },
        },
      };
    } catch (err) {
      // Fail closed rather than discard explicit filtering/fidelity/retention.
      const preserveFiltering = automaticFiltering || retainingReads || filteredTurns(branchEntries).length > 0 || Object.keys(turnFidelities(branchEntries)).length > 0;
      ctx.ui?.notify?.(`transparent-compact: failed to build checkpoint (${errMsg(err)}); ${preserveFiltering ? "compaction cancelled" : "falling back to Pi's summary compaction"}`, "error");
      return preserveFiltering ? { cancel: true } : undefined;
    }
  });

  // --------------------------------------------------------------------------
  // context_lookup tool: subagent research over the raw session branch
  // --------------------------------------------------------------------------
  registerDirectTools(pi);
  pi.registerTool({
    name: "context_lookup",
    label: "Context lookup",
    executionMode: "sequential",
    description:
      `Retrieve earlier outputs, findings, decisions, and reasoning hidden by compaction. Ask \`context_lookup\` where an earlier finding came from, what a command actually printed, or why you reached a conclusion, especially when earlier notes conflict with new evidence. A subagent searches this conversation's full raw active branch in its own context and returns relevant findings. ${RECOVERY_SOURCE_GUIDANCE} ${RECOVERY_SCOPE_RULE} If findings are incomplete, use context_list_entries, context_grep, or context_show_entry, following pagination instructions. ${RECOVERY_FILESYSTEM_RULE}`,
    promptSnippet: "Retrieve earlier outputs, findings, decisions, and reasoning hidden by compaction, including the provenance of earlier conclusions",
    parameters: Type.Object({
      question: Type.String({ description: "A specific question about earlier in this conversation: an output, source of a finding, reason for a decision, or evidence behind notes that conflict with new observations." }),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (cfg.lookupMaxCalls > 0 && consecutiveLookups(ctx, toolCallId) >= cfg.lookupMaxCalls) {
        return {
          content: [{ type: "text", text: `context_lookup consecutive-call limit reached (${cfg.lookupMaxCalls}). ${LOOKUP_FALLBACK_NOTE}` }],
          details: undefined,
        };
      }
      let model: Model | undefined;
      if (cfg.lookupModel) {
        const slash = cfg.lookupModel.indexOf("/");
        if (slash > 0) model = ctx.modelRegistry.find(cfg.lookupModel.slice(0, slash), cfg.lookupModel.slice(slash + 1));
      }
      model = model ?? ctx.model;
      if (!model) {
        return { content: [{ type: "text", text: "context_lookup needs a model (session model or MECH_COMPACT_LOOKUP_MODEL)." }], details: undefined };
      }

      try {
        if (signal?.aborted) return { content: [{ type: "text", text: "(lookup subagent aborted)" }], details: undefined };
        const transcript = sessionTranscript(ctx);
        if (transcript.index.length === 0)
          return { content: [{ type: "text", text: "No entries found on the session branch." }], details: undefined };
        const answer = await runLookupSubagent({ question: params.question, transcripts: [transcript], model, registry: ctx.modelRegistry, signal });
        return { content: [{ type: "text", text: answer }], details: undefined };
      } catch (err) {
        return { content: [{ type: "text", text: `context_lookup failed: ${errMsg(err)}` }], details: undefined };
      }
    },
  });
}

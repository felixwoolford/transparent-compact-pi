import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { originalProjection, turnOwners } from "./turn-context.js";

export type ReadMode = "off" | "first" | "latest";
export interface ReadRetention {
  defaults: Record<string, ReadMode>;
  overrides: Record<string, ReadMode>;
}
export const READ_RETENTION_ENTRY = "transparent-compact:read-retention";
export interface ReadOutput {
  entryId: string;
  path: string;
  owner: string | null;
  order: number;
  offset: number;
  limit?: number;
  text: string[];
  end?: number;
  total?: number;
  eof: boolean;
}
export interface ReadEpisode { path: string; reads: ReadOutput[] }
export interface ReadFile { path: string; episodes: ReadEpisode[] }

/** Lexical tool-path normalization, never stat/realpath or a symlink claim. */
export function readPath(file: string, cwd: string): string {
  let normalized = file.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) normalized = path.join(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) {
    try { normalized = fileURLToPath(normalized); } catch { /* Keep unknown syntax literal. */ }
  }
  return path.resolve(cwd, normalized);
}

/** Coverage describes delivered text, not the requested limit. Recognize Pi's
 * terminal pagination notices; unrecognized truncation stays unknown. */
function coverage(text: string[], offset: number, limit: number | undefined, details: any): Pick<ReadOutput, "end" | "total" | "eof"> {
  const body = text.join("\n");
  const showing = body.match(/\n\n\[Showing lines (\d+)[-–](\d+) of (\d+)(?: \([^\n]*\))?\. Use offset=\d+ to continue\.\]$/);
  if (showing && Number(showing[1]) === offset) return { end: Number(showing[2]), total: Number(showing[3]), eof: false };
  const more = body.match(/\n\n\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/);
  if (more) return { end: Number(more[2]) - 1, total: Number(more[2]) - 1 + Number(more[1]), eof: false };
  if (details?.truncation?.truncated || /\[(?:Output truncated|Line \d+ is .*exceeds|Showing lines|\d+ more lines in file)/.test(body)) return { eof: false };
  // Ordinary text-only read results without a pagination notice reach EOF.
  // A bounded read returning exactly its limit is conservative: EOF unconfirmed.
  const count = body === "" ? 0 : body.split("\n").length;
  const end = offset + count - 1, eof = limit === undefined || count < limit;
  return { end, eof, ...(eof ? { total: end } : {}) };
}

/** Read candidates come from the context-edited original projection, not from
 * summaries. Tool source order defines adjacency even for parallel batches. */
export function readCatalog(entries: SessionEntry[], cwd: string): ReadFile[] {
  const owners = turnOwners(entries);
  const projected = originalProjection(entries).flatMap(({ sourceEntry, messages }) => messages.map((message) => ({ entry: sourceEntry, message })));
  // An omitted/replaced tool operation may still have mutated the filesystem.
  // It remains an episode boundary even though its content is not resurrected.
  const visibleEntries = new Set(projected.map((p) => p.entry.id));
  const visibleCalls = new Map<string, Set<string>>();
  for (const { entry, message } of projected) if (message.role === "assistant")
    visibleCalls.set(entry.id, new Set(message.content.filter((b) => b.type === "toolCall").map((b) => b.id)));
  const hiddenBefore = new Map<string, number>(), changedBatches = new Set<string>();
  let hidden = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const missing = entry.message.content.filter((b) => b.type === "toolCall" && !visibleCalls.get(entry.id)?.has(b.id)).length;
      hidden += missing;
      if (missing) changedBatches.add(entry.id);
    }
    else if (entry.type === "message" && entry.message.role === "bashExecution" && !visibleEntries.has(entry.id)) hidden++;
    hiddenBefore.set(entry.id, hidden);
  }
  const counts = new Map<string, number>();
  for (const { message } of projected) if (message.role === "assistant")
    for (const block of message.content) if (block.type === "toolCall") counts.set(block.id, (counts.get(block.id) ?? 0) + 1);
  type Call = { args: any; name: string; order: number; owner: string | null };
  const pending = new Map<string, Call>();
  const reads: ReadOutput[] = [];
  let order = 0, seenHidden = 0;
  for (const { entry, message } of projected) {
    const hidden = hiddenBefore.get(entry.id)!;
    if (hidden !== seenHidden) { order += hidden - seenHidden; pending.clear(); seenHidden = hidden; }
    if (message.role === "user") { order++; pending.clear(); }
    else if (message.role === "bashExecution") order++;
    else if (message.role === "assistant") {
      pending.clear();
      for (const block of message.content) if (block.type === "toolCall") {
        if (changedBatches.has(entry.id)) order++; // Never join across an operation removed inside a batch.
        const call = { args: block.arguments, name: block.name, order: order++, owner: owners.get(entry.id) ?? null };
        if (counts.get(block.id) === 1) pending.set(block.id, call);
      }
    } else if (message.role === "toolResult") {
      const call = pending.get(message.toolCallId);
      pending.delete(message.toolCallId);
      if (!call || call.name !== "read" || message.toolName !== call.name || message.isError !== false ||
          typeof call.args?.path !== "string" || !message.content.length || message.content.some((b) => b.type !== "text" || typeof b.text !== "string")) continue;
      const offset = call.args.offset ?? 1, limit = call.args.limit ?? undefined;
      if (!Number.isSafeInteger(offset) || offset < 1 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) continue;
      const text = message.content.map((b) => (b as { text: string }).text);
      reads.push({ entryId: entry.id, path: readPath(call.args.path, cwd), owner: call.owner, order: call.order, offset,
        ...(limit === undefined ? {} : { limit }), text, ...coverage(text, offset, limit, message.details) });
    }
  }
  const files = new Map<string, ReadFile>();
  let previous: ReadOutput | undefined, episode: ReadEpisode | undefined;
  for (const read of reads.sort((a, b) => a.order - b.order)) {
    const file = files.get(read.path) ?? { path: read.path, episodes: [] };
    files.set(read.path, file);
    if (!previous || previous.path !== read.path || previous.owner !== read.owner || previous.order + 1 !== read.order ||
        previous.eof || previous.end === undefined || read.offset <= previous.offset || read.offset > previous.end + 1 ||
        (previous.total !== undefined && read.total !== undefined && previous.total !== read.total)) {
      episode = { path: read.path, reads: [] };
      file.episodes.push(episode);
    }
    episode!.reads.push(read);
    previous = read;
  }
  return [...files.values()];
}

const instructionFile = (file: string) => /^(AGENTS(?:\.override)?|CLAUDE)\.md$/i.test(path.basename(file));
export function retentionOverrides(entries: SessionEntry[]): Record<string, ReadMode> {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const state = entry.type === "compaction" ? (entry.details as { readRetention?: ReadRetention })?.readRetention
      : entry.type === "custom" && entry.customType === "transparent-compact:filter-revision" ? (entry.data as { readRetention?: ReadRetention })?.readRetention
      : entry.type === "custom" && entry.customType === READ_RETENTION_ENTRY ? entry.data as ReadRetention : undefined;
    if (state) return { ...state.overrides };
  }
  return {};
}

export function readRetentionState(entries: SessionEntry[], ctx: ExtensionContext, catalog = readCatalog(entries, ctx.cwd)): ReadRetention {
  const sources = new Map<string, string[]>();
  for (const file of catalog) if (instructionFile(file.path)) {
    const episode = file.episodes.at(-1)!;
    // Parse each output independently; never fabricate declarations across gaps.
    sources.set(file.path, episode.reads.map((r) => r.text.join("\n")));
  }
  const contextFiles = ctx.getSystemPromptOptions?.().contextFiles ?? [];
  for (const file of contextFiles) if (instructionFile(file.path)) sources.set(readPath(file.path, ctx.cwd), [file.content]);
  if (!contextFiles.length) for (const match of (ctx.getSystemPrompt?.() ?? "").matchAll(/<project_instructions path="([^"]+)">\n?([\s\S]*?)<\/project_instructions>/g))
    if (instructionFile(match[1])) sources.set(readPath(match[1], ctx.cwd), [match[2]]);
  const defaults: Record<string, ReadMode> = {};
  for (const [source, contents] of sources) for (const content of contents) for (const block of content.matchAll(/<retain-reads>\s*\n([\s\S]*?)<\/retain-reads>/g)) {
    for (const line of block[1].split("\n")) {
      let file = line.trim();
      if (!file) continue;
      const mode: ReadMode = file.startsWith("latest:") ? "latest" : "first";
      if (mode === "latest") file = file.slice(7).trim();
      if (file) defaults[readPath(file, path.dirname(source))] = mode;
    }
  }
  return { defaults, overrides: retentionOverrides(entries) };
}

export const readMode = (state: ReadRetention, file: string): ReadMode => state.overrides[file] ?? state.defaults[file] ?? "off";
export function selectedEpisode(file: ReadFile, mode: ReadMode): ReadEpisode | undefined {
  return mode === "off" ? undefined : mode === "first" ? file.episodes[0] : file.episodes.at(-1);
}
export function selectedReads(catalog: ReadFile[], state: ReadRetention): ReadOutput[] {
  return catalog.flatMap((file) => selectedEpisode(file, readMode(state, file.path))?.reads ?? []);
}
export function episodeCoverage(episode: ReadEpisode): string {
  const first = episode.reads[0], last = episode.reads.at(-1)!;
  const end = episode.reads.reduce<number | undefined>((end, r) => r.end === undefined || end === undefined ? undefined : Math.max(end, r.end), first.end);
  const totals = new Set(episode.reads.flatMap((r) => r.total === undefined ? [] : [r.total]));
  if (first.offset === 1 && last.eof && end !== undefined && totals.size <= 1) return "full";
  return `partial: ${first.offset}–${end ?? "?"}${last.eof ? " (EOF)" : ""}`;
}

/** Only extra copies are rendered: OFF never touches normal tool/tail content.
 * Turn pruning does not suppress explicit read retention. Native turns already
 * contain their read output, so they and the recent tail need no duplicate. */
export function renderRetainedReads(catalog: ReadFile[], state: ReadRetention, entries: SessionEntry[], boundary: string | undefined,
  excluded: Set<string>, fidelity: Record<string, unknown>): string {
  const cut = entries.findIndex((e) => e.id === boundary);
  const visible = new Set(cut < 0 ? [] : entries.slice(cut).map((e) => e.id));
  const reads = selectedReads(catalog, state).filter((r) => !visible.has(r.entryId) && !fidelity[r.owner ?? ""]);
  if (!reads.length) return "";
  return ["### Retained reads", "Selected original read outputs, preserved verbatim, independently of turn filtering. These are historical snapshots, not new filesystem reads; ranges and truncation notices may be partial.",
    ...reads.map((r) => `<retained-read entry=${JSON.stringify(r.entryId)} path=${JSON.stringify(r.path)} offset=${r.offset}${r.limit === undefined ? "" : ` limit=${r.limit}`}${excluded.has(r.owner ?? "") ? ' filtered-turn="true"' : ""}>\n${r.text.join("\n")}\n</retained-read>`)].join("\n\n");
}

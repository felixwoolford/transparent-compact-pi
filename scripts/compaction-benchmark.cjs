"use strict";

// Optional read-only benchmark on explicitly supplied sessions. No SessionManager
// opens/migrations, model calls, tool execution, or checkpoint-content artifacts.
// Usage: node scripts/compaction-benchmark.cjs [--headroom] [--runs 7] [--out DIR] <session.jsonl> [...]
// Rebuild recorded cuts to give earlier spans structured records, then benchmark
// one more compaction on the complete active branch. Repeat on a valid 2x branch.
// The baseline defaults to HEAD; override with TC_BASELINE_REF.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const snapshotExtension = require("./git-extension-snapshot.cjs");
const { piRoot, jitiAliases } = require("./pi-runtime.cjs");
const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
const repo = path.resolve(__dirname, "..");
const hash = (s) => createHash("sha256").update(s).digest("hex");
const stamp = () => performance.now();
const spanChars = (spans) => spans.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.length + 1, 0), 0);
function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: values };
}
async function measure(fn, runs) {
  for (let i = 0; i < 2; i++) await fn();
  const wall = [], cpu = [];
  let last;
  for (let i = 0; i < runs; i++) {
    const startCpu = process.cpuUsage(), start = stamp();
    last = await fn();
    wall.push(stamp() - start);
    const used = process.cpuUsage(startCpu);
    cpu.push((used.user + used.system) / 1000);
  }
  return { timing: { ...stats(wall), cpu: stats(cpu) }, last };
}
function activeBranch(rows) {
  const byId = new Map(rows.filter((e) => e.id && e.type !== "session").map((e) => [e.id, e]));
  let entry = rows.findLast((e) => e.id && e.type !== "session");
  const branch = [], seen = new Set();
  while (entry) {
    assert(!seen.has(entry.id), "active branch must be acyclic");
    seen.add(entry.id);
    branch.push(entry);
    if (!entry.parentId) break;
    entry = byId.get(entry.parentId);
    assert(entry, "every parent must exist");
  }
  return branch.reverse();
}
function doubledBranch(branch) {
  const entryIds = new Map(branch.map((e) => [e.id, `copy2-${e.id}`]));
  const remapMessage = (m) => {
    if (!m) return;
    if (m.role === "toolResult" && m.toolCallId) m.toolCallId = `copy2-${m.toolCallId}`;
    if (Array.isArray(m.content)) for (const b of m.content)
      if (b.type === "toolCall" && b.id) b.id = `copy2-${b.id}`;
  };
  const second = structuredClone(branch);
  for (let i = 0; i < second.length; i++) {
    const e = second[i];
    e.id = entryIds.get(e.id);
    e.parentId = i ? second[i - 1].id : branch.at(-1).id;
    if (e.type === "compaction") {
      assert(entryIds.has(e.firstKeptEntryId));
      e.firstKeptEntryId = entryIds.get(e.firstKeptEntryId);
    }
    if (e.type === "context_edit") {
      assert(entryIds.has(e.targetId), "context-edit target must remain in its copy");
      e.targetId = entryIds.get(e.targetId);
      remapMessage(e.replacement);
    }
    remapMessage(e.message);
  }
  const result = [...branch, ...second];
  assert.equal(new Set(result.map((e) => e.id)).size, result.length, "copies must have distinct entry ids");
  for (let i = 1; i < result.length; i++) assert.equal(result[i].parentId, result[i - 1].id);
  return result;
}
function load(factory) {
  let handler;
  factory({ on: (name, fn) => { if (name === "session_before_compact") handler = fn; },
    registerTool: () => {}, registerCommand: () => {} });
  assert(handler);
  return handler;
}
function messagesBetween(branch, fromId, toId, project) {
  const positions = new Map(branch.map((e, i) => [e.id, i]));
  const from = fromId === undefined ? 0 : positions.get(fromId), to = positions.get(toId);
  assert(from !== undefined && to !== undefined && from <= to, "cut boundaries must tile forward");
  return project(branch).entries.filter((e) => e.sourceEntry.type !== "compaction" &&
    positions.get(e.sourceEntry.id) >= from && positions.get(e.sourceEntry.id) < to)
    .flatMap((e) => e.messages).filter((m) => m.role !== "system");
}
function context(branch, cwd, budget) {
  // Override historical cap settings for a reproducible benchmark. The synthetic
  // control belongs only to the context, never to conversation/span inputs.
  const control = { type: "custom", id: "benchmark-cap", parentId: branch.at(-1)?.id ?? null,
    customType: "transparent-compact:cap-compaction", data: { mode: budget === undefined ? "off" : "on",
      budget: { unit: "chars", value: budget ?? 131072 } } };
  const view = [...branch, control];
  return { cwd, sessionManager: { getBranch: () => view }, model: { contextWindow: 131072 },
    hasUI: false, mode: "json", ui: { notify: (_message, level) => { if (level === "error") throw new Error(_message); } } };
}
function event(branch, messages, firstKeptEntryId, fileLists, tokensBefore = 0) {
  return { branchEntries: branch, reason: "manual", signal: new AbortController().signal,
    preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId, tokensBefore,
      fileOps: { read: new Set(fileLists?.readFiles ?? []), written: new Set(), edited: new Set(fileLists?.modifiedFiles ?? []) } } };
}
async function invoke(handler, input, ctx) {
  const response = await handler(input, ctx);
  assert(response?.compaction, "deterministic compaction must succeed without falling back to a model");
  return response.compaction;
}
async function rebuild(handler, source, cwd, project, headroom) {
  const start = stamp(), branch = [], hookTimes = [], preparationTimes = [], headroomCheckpoints = [];
  let headroomAuditMs = 0;
  let previousCut;
  for (const original of source) {
    if (original.type !== "compaction") { branch.push(original); continue; }
    const prepareStart = stamp();
    const messages = messagesBetween(branch, previousCut, original.firstKeptEntryId, project);
    const input = event(branch, messages, original.firstKeptEntryId, original.details, original.tokensBefore);
    const ctx = context(branch, cwd);
    preparationTimes.push(stamp() - prepareStart);
    const hookStart = stamp();
    const c = await invoke(handler, input, ctx);
    hookTimes.push(stamp() - hookStart);
    if (headroom) {
      const auditStart = stamp();
      const capped = await invoke(handler,
        event(branch, messages, original.firstKeptEntryId, original.details, original.tokensBefore), context(branch, cwd, 131072));
      const canonicalHash = (span) => hash(JSON.stringify([span.lines, span.tools]));
      assert.equal(canonicalHash(capped.details.span), canonicalHash(c.details.span), "capping must not change canonical own-span data");
      headroomCheckpoints.push({ checkpoint: hookTimes.length, entryId: original.id,
        uncappedCheckpointChars: c.summary.length, ...outputStats(capped) });
      headroomAuditMs += stamp() - auditStart;
    }
    branch.push({ ...original, summary: c.summary, details: c.details });
    previousCut = original.firstKeptEntryId;
  }
  // Leave one synthetic user message un-compacted so the final hook is a normal
  // append, not an attempt to summarize the existing compactions a second time.
  const tail = { type: "message", id: "benchmark-tail", parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Benchmark retained tail" }], timestamp: Date.now() } };
  branch.push(tail);
  const prepareStart = stamp();
  const messages = messagesBetween(branch, previousCut, tail.id, project);
  assert(messages.length, "final tail must contain messages to compact");
  const previousFiles = branch.findLast((e) => e.type === "compaction")?.details;
  const readFiles = new Set(previousFiles?.readFiles ?? []), modifiedFiles = new Set(previousFiles?.modifiedFiles ?? []);
  for (const message of messages) if (message.role === "assistant" && Array.isArray(message.content))
    for (const block of message.content) if (block.type === "toolCall" && typeof block.arguments?.path === "string") {
      if (block.name === "read") readFiles.add(block.arguments.path);
      if (block.name === "write" || block.name === "edit") modifiedFiles.add(block.arguments.path);
    }
  return { branch, messages, tail: tail.id, headroomCheckpoints,
    fileLists: { readFiles: [...readFiles], modifiedFiles: [...modifiedFiles] },
    setup: { totalReplayMs: stamp() - start, headroomAuditMs, recordedCheckpoints: hookTimes.length,
      hooksTotalMs: hookTimes.reduce((n, x) => n + x, 0), hooks: stats(hookTimes),
      preparationTotalMs: preparationTimes.reduce((n, x) => n + x, 0), finalPreparationMs: stamp() - prepareStart } };
}
function outputStats(c) {
  return { checkpointChars: c.summary.length, tightenedSpans: (c.summary.match(/tools-tightened="true"/g) ?? []).length,
    trimmedSpans: (c.summary.match(/trimmed="true"/g) ?? []).length };
}
async function benchmark(handler, source, cwd, project, runs, capSpans, headroom) {
  const state = await rebuild(handler, source, cwd, project, headroom);
  const oldDetails = hash(JSON.stringify(state.branch.filter((e) => e.type === "compaction").map((e) => e.details)));
  const cases = [], budgets = [["cap off", undefined], ["25% of 131k context", 131072], ["severe cap", 8000]];
  let uncapped;
  for (const [label, budget] of budgets) {
    const ctx = context(state.branch, cwd, budget);
    const measured = await measure(() => invoke(handler, event(state.branch, state.messages, state.tail, state.fileLists), ctx), runs);
    if (budget === undefined) uncapped = measured.last;
    cases.push({ label, budgetChars: budget ?? null, ...measured.timing, ...outputStats(measured.last) });
    console.log(`    ${label}: ${measured.timing.medianMs.toFixed(2)} ms (range ${measured.timing.minMs.toFixed(2)}–${measured.timing.maxMs.toFixed(2)}); ${measured.last.summary.length} chars; ${outputStats(measured.last).trimmedSpans} trimmed spans`);
  }
  assert.equal(hash(JSON.stringify(state.branch.filter((e) => e.type === "compaction").map((e) => e.details))), oldDetails, "prior canonical metadata is immutable");
  const spans = [...state.branch.filter((e) => e.type === "compaction").map((e) => e.details.span), uncapped.details.span];
  const pureCap = [];
  if (capSpans) {
    const canonicalHash = hash(JSON.stringify(spans));
    const canonicalChars = spanChars(spans);
    for (const [label, budget] of [["cap off", undefined], ["5% reduction", Math.floor(canonicalChars * 0.95)],
      ["131072 line chars", 131072], ["8000 line chars", 8000]]) {
      const measured = await measure(() => capSpans(spans, budget), runs);
      pureCap.push({ label, lineBudgetChars: budget ?? null, ...measured.timing,
        outputLineChars: spanChars(measured.last.lines.map((lines) => ({ lines }))),
        tightenedSpans: measured.last.tightened.filter(Boolean).length, trimmedSpans: measured.last.trimmed.filter(Boolean).length });
      console.log(`      pure cap ${label}: ${measured.timing.medianMs.toFixed(2)} ms`);
    }
    assert.equal(hash(JSON.stringify(spans)), canonicalHash);
  }
  const headroomResult = headroom ? { budgetChars: 131072,
    firstTightenedCheckpoint: state.headroomCheckpoints.find((c) => c.tightenedSpans > 0)?.checkpoint ?? null,
    firstDestructiveCheckpoint: state.headroomCheckpoints.find((c) => c.trimmedSpans > 0)?.checkpoint ?? null,
    checkpoints: state.headroomCheckpoints } : undefined;
  return { setup: state.setup, headroom: headroomResult, canonicalSpans: spans.length, canonicalLineChars: spanChars(spans),
    canonicalLinesHash: hash(JSON.stringify(spans.map((s) => s.lines))),
    canonicalToolCalls: spans.reduce((n, s) => n + (s.tools?.lines.reduce((m, l) => m + l.calls.length, 0) ?? 0), 0),
    latestSpanMessages: state.messages.length, fullHook: cases, pureCap };
}
async function main() {
  const args = process.argv.slice(2);
  const headroomIndex = args.indexOf("--headroom"), headroom = headroomIndex >= 0;
  if (headroom) args.splice(headroomIndex, 1);
  const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args.splice(at, 2)[1]; };
  const runs = Number(option("--runs", "7"));
  assert(Number.isInteger(runs) && runs >= 3 && runs <= 100, "--runs must be 3–100");
  const out = option("--out", undefined) ?? fs.mkdtempSync(path.join(os.tmpdir(), "tc-compaction-bench-"));
  assert(args.length, "Supply session JSONL paths");
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-compaction-baseline-"));
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("MECH_COMPACT_")) delete process.env[key];
    const startup = stamp();
    const baseline = snapshotExtension(repo, process.env.TC_BASELINE_REF || "HEAD", temp);
    const jiti = createJiti(__filename, { alias: jitiAliases });
    const { buildSessionProjection } = await jiti.import("@earendil-works/pi-coding-agent");
    const current = load((await jiti.import(path.join(repo, "extensions/index.ts"))).default);
    const old = load((await jiti.import(baseline.entryPath)).default);
    const { capSpans } = await jiti.import(path.join(repo, "extensions/lib/checkpoint-cap.ts"));
    const report = { environment: { node: process.version, platform: process.platform, arch: process.arch,
      cpu: os.cpus()[0]?.model, availableParallelism: os.availableParallelism(), runtimeLoadMs: stamp() - startup },
      baselineCommit: baseline.commit,
      worktreeSourceHashes: Object.fromEntries(["extensions/index.ts", "extensions/lib/checkpoint-cap.ts", "scripts/compaction-benchmark.cjs"]
        .map((file) => [file, hash(fs.readFileSync(path.join(repo, file)))])),
      runs, warmups: 2, headroomEnabled: headroom, methodology: [
        "Read-only active-branch replay; original files never opened through SessionManager.",
        "Rebuild recorded cuts cap-off, independently for each renderer, to give all earlier current spans structured metadata.",
        "2x links two active-branch copies, remapping entry IDs, context-edit/cut targets, and tool call/result IDs. No duplicate session header.",
        "Full hook timings exclude JSON parsing, history replay, input projection, runtime import, and disk I/O; replay/preparation timings are reported separately.",
        "With --headroom, also evaluate the fixed 131072-character cap at every recorded cut; total setup includes this separately timed audit.",
        "Headroom means extra recorded cut intervals before the first destructive cap, not a prediction of changed live compaction trigger times.",
        "Pure-cap timings include validation, canonical-line scanning, all required rungs, destructive fallback, and final rendering; exclude surrounding compaction work.",
        "Full-hook cap budget includes span overhead; pure-cap budgets apply to lines only, so these are not identical cut points.",
        "No model calls, recorded command execution, or output-content artifacts. Times are local wall-clock measurements, not live-model quality tests.",
        "Process peak RSS includes runtime imports, both renderers, raw inputs and duplicated branches; it is not incremental cap memory.",
      ], sessions: [] };
    console.log(`Baseline ${baseline.commit.slice(0, 8)}; ${runs} measured runs + 2 warmups per case; no model/tool execution`);
    for (const file of args) {
      const parseStart = stamp(), input = fs.readFileSync(file), originalHash = hash(input);
      const rows = input.toString("utf8").trim().split("\n").map(JSON.parse);
      const source = activeBranch(rows), cwd = rows.find((e) => e.type === "session")?.cwd;
      assert(cwd);
      const parseAndBranchMs = stamp() - parseStart;
      const session = { file: path.resolve(file), inputBytes: input.length, rawRows: rows.length, activeBranchEntries: source.length, parseAndBranchMs, sizes: [] };
      for (const copies of [1, 2]) {
        const cloneStart = stamp(), entries = copies === 1 ? source : doubledBranch(source);
        const duplicationMs = stamp() - cloneStart;
        console.log(`\n${path.basename(path.dirname(file))} ${copies}x: ${entries.length} entries (~${(copies * input.length / 1e6).toFixed(1)} MB source data)`);
        const result = { copies, entries: entries.length, duplicationMs };
        for (const [label, handler, cap] of [["baseline", old, undefined], ["progressive", current, capSpans]]) {
          console.log(`  ${label}`);
          result[label] = await benchmark(handler, entries, cwd, buildSessionProjection, runs, cap, headroom);
          console.log(`    setup: ${result[label].setup.recordedCheckpoints} historical checkpoints rebuilt in ${result[label].setup.totalReplayMs.toFixed(1)} ms`);
        }
        assert.equal(result.progressive.canonicalLinesHash, result.baseline.canonicalLinesHash, "both renderers receive and preserve identical uncapped history");
        if (copies === 2) assert.equal(result.progressive.canonicalToolCalls, 2 * session.sizes[0].progressive.canonicalToolCalls,
          "doubled history must actually compact twice the tool calls");
        if (headroom) {
          const before = result.baseline.headroom.firstDestructiveCheckpoint, after = result.progressive.headroom.firstDestructiveCheckpoint;
          result.headroomComparison = { budgetChars: 131072, baselineFirstDestructiveCheckpoint: before,
            progressiveFirstDestructiveCheckpoint: after,
            extraRecordedRoundsBeforeDestruction: before !== null && after !== null ? after - before : null };
          console.log(`  Destructive onset: baseline #${before ?? "not reached"}, progressive #${after ?? "not reached"}; extra recorded rounds: ${result.headroomComparison.extraRecordedRoundsBeforeDestruction ?? "not yet bounded"}`);
        }
        session.sizes.push(result);
      }
      assert.equal(hash(fs.readFileSync(file)), originalHash, "source file must remain byte-identical");
      report.sessions.push(session);
    }
    report.processPeakRssMiB = process.resourceUsage().maxRSS / 1024;
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`\nInput hashes and canonical metadata checked. Metadata/timings only; no checkpoint contents.\nReport: ${path.join(out, "report.json")}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

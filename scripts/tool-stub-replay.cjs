"use strict";

// Read-only, explicitly requested session audit. Never executes recorded tools,
// opens inputs through SessionManager, migrates sessions, or calls a model.
// Usage: node scripts/tool-stub-replay.cjs [--out DIR] <session.jsonl> [...]
// TC_BASELINE_REF defaults to HEAD; select a pre-change commit for comparisons.
// Both renderers rebuild all spans at recorded cuts with capping disabled, so
// savings measure rendering, not different evidence retention or tokenization.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const snapshotExtension = require("./git-extension-snapshot.cjs");
const { piRoot, jitiAliases } = require("./pi-runtime.cjs");
const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
const repo = path.resolve(__dirname, "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function activeBranch(byId, tip) {
  const branch = [], seen = new Set();
  while (tip) {
    assert(!seen.has(tip), "session ancestry must not contain a cycle");
    seen.add(tip);
    const entry = byId.get(tip);
    assert(entry, `missing ancestor ${tip}`);
    branch.push(entry);
    tip = entry.parentId;
  }
  return branch.reverse();
}

function loadExtension(factory) {
  const handlers = {}, tools = {};
  factory({ on: (name, handler) => { handlers[name] = handler; },
    registerTool: (tool) => { tools[tool.name] = tool; }, registerCommand: () => {} });
  return { handlers, tools };
}

async function replay(ext, rows, buildSessionProjection) {
  const cwd = rows.find((e) => e.type === "session")?.cwd;
  assert(cwd, "session header must specify cwd");
  const byId = new Map(), callCounts = new Map(), checkpoints = [];
  for (const [i, original] of rows.entries()) {
    if (!original.id || original.type === "session") continue;
    if (original.type !== "compaction") { byId.set(original.id, original); continue; }
    const branch = activeBranch(byId, original.parentId);
    const positions = new Map(branch.map((e, n) => [e.id, n]));
    const cut = positions.get(original.firstKeptEntryId);
    assert(cut !== undefined, `kept boundary at line ${i + 1} must be on branch`);
    const previous = branch.findLast((e) => e.type === "compaction");
    const from = previous ? positions.get(previous.firstKeptEntryId) : 0;
    assert(from !== undefined && from <= cut, "recorded spans must tile forward");
    const messages = buildSessionProjection(branch).entries.filter((e) =>
      e.sourceEntry.type !== "compaction" && positions.get(e.sourceEntry.id) >= from && positions.get(e.sourceEntry.id) < cut)
      .flatMap((e) => e.messages).filter((m) => m.role !== "system");
    const capOff = { type: "custom", id: "audit-cap-off", parentId: branch.at(-1)?.id ?? null,
      customType: "transparent-compact:cap-compaction", data: { mode: "off", budget: { unit: "chars", value: 80000 } } };
    const ctx = { cwd, sessionManager: { getBranch: () => [...branch, capOff] }, model: { contextWindow: 131072 },
      hasUI: false, mode: "json", ui: { notify: () => {} } };
    const response = await ext.handlers.session_before_compact({ branchEntries: branch,
      reason: original.details?.span?.reason ?? "threshold", signal: new AbortController().signal,
      preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: original.firstKeptEntryId,
        tokensBefore: original.tokensBefore, fileOps: { read: new Set(original.details?.readFiles ?? []), written: new Set(),
          edited: new Set(original.details?.modifiedFiles ?? []) } } }, ctx);
    assert(response?.compaction, `compaction at line ${i + 1} must be renderable`);
    const c = response.compaction;
    const ownCalls = messages.reduce((n, m) => n + (m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").length : 0), 0);
    const coveredCalls = branch.filter((e) => e.type === "compaction").reduce((n, e) => n + (callCounts.get(e.id) ?? 0), ownCalls);
    callCounts.set(original.id, ownCalls);
    byId.set(original.id, { ...original, summary: c.summary, details: c.details });
    const spans = [...branch.filter((e) => e.type === "compaction" && e.details?.span).map((e) => e.details.span), c.details.span];
    checkpoints.push({ line: i + 1, original, ...c, coveredCalls, spanLines: spans.flatMap((s) => s.lines), rawBranch: branch });
  }
  return checkpoints;
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--out");
  const output = outputIndex < 0 ? fs.mkdtempSync(path.join(os.tmpdir(), "tc-tool-stub-audit-")) : path.resolve(args.splice(outputIndex, 2)[1]);
  assert(args.length, "Supply session JSONL paths");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-stub-baseline-"));
  try {
    const baselineRef = process.env.TC_BASELINE_REF || "HEAD";
    const { commit: baselineCommit, entryPath: baselineFile } = snapshotExtension(repo, baselineRef, temp);
    for (const key of Object.keys(process.env)) if (key.startsWith("MECH_COMPACT_")) delete process.env[key];
    const jiti = createJiti(__filename, { alias: jitiAliases });
    const { buildSessionProjection } = await jiti.import("@earendil-works/pi-coding-agent");
    const before = loadExtension((await jiti.import(baselineFile)).default);
    const after = loadExtension((await jiti.import(path.join(repo, "extensions/index.ts"))).default);
    const report = { baselineCommit, cap: "off", units: "UTF-16 code units (not tokens)", sessions: [] };
    console.log(`Baseline ${baselineCommit.slice(0, 8)}; identical recorded cuts; cap off; no model calls or recorded-command execution`);
    for (const file of args) {
      const input = fs.readFileSync(file), originalHash = hash(input);
      const rows = input.toString("utf8").trim().split("\n").map(JSON.parse);
      const old = await replay(before, rows, buildSessionProjection);
      const current = await replay(after, rows, buildSessionProjection);
      assert.equal(current.length, old.length);
      const name = path.basename(path.dirname(file));
      console.log(`\n${name}: ${current.length} checkpoints`);
      const metrics = [];
      for (let i = 0; i < current.length; i++) {
        const a = old[i], b = current[i];
        const prose = (lines) => lines.filter((l) => /^\[(?:User|Assistant)\]:/.test(l));
        assert.deepEqual(prose(b.spanLines), prose(a.spanLines), "all retained conversation prose must stay verbatim");
        assert.equal(b.spanLines.length, a.spanLines.length, "no merging, folding, or dropped tool lines");
        const stubChars = (lines) => lines.filter((l) => /^\[(?:Tools|Assistant tool calls)\]:/.test(l)).reduce((n, l) => n + l.length + 1, 0);
        const refs = [...b.spanLines.join("\n").matchAll(/ ref=([^\s;]+)/g)].map((m) => m[1]);
        const rawIds = new Set(b.rawBranch.map((e) => e.id));
        assert(refs.every((id) => rawIds.has(id)), "every emitted ref must exist on the original active branch");
        const m = { checkpoint: i + 1, line: b.line, capturedChars: b.original.summary.length,
          capturedTrimmedSpans: (b.original.summary.match(/trimmed="true"/g) ?? []).length,
          beforeChars: a.summary.length, afterChars: b.summary.length, deltaPercent: (b.summary.length / a.summary.length - 1) * 100,
          beforeStubChars: stubChars(a.spanLines), afterStubChars: stubChars(b.spanLines), refs: refs.length, coveredCalls: b.coveredCalls,
          referenceChars: [...b.spanLines.join("\n").matchAll(/ ref=[^\s;]+/g)].reduce((n, match) => n + match[0].length, 0) };
        metrics.push(m);
        console.log(`  #${i + 1} L${m.line}: captured ${m.capturedChars}; rebuilt ${m.beforeChars} -> ${m.afterChars} (${m.deltaPercent.toFixed(1)}%); stubs ${m.beforeStubChars} -> ${m.afterStubChars}; refs ${m.refs}/${m.coveredCalls}`);
        for (const [version, checkpoint] of [["before", a], ["after", b]])
          fs.writeFileSync(path.join(output, `${name}.${i + 1}.${version}.md`), checkpoint.summary, { mode: 0o600 });
      }
      const final = current.at(-1), baseline = old.at(-1), examples = [];
      for (const [label, pattern] of [["test pipeline", /pytest -q.*tail -25/], ["network probe", /CodeAbbey API/],
        ["empty manual lookup", /man tmux/], ["terminal selection", /tmux.*copy-mode/], ["launch command", /tmux kill-session/], ["terminal observation", /tmux.*show-buffer/]]) {
        let count = 0;
        for (let i = 0; i < final.spanLines.length && count < 2; i++) {
          if (!final.spanLines[i].startsWith("[Tools]:") || !pattern.test(final.spanLines[i])) continue;
          examples.push({ label, before: baseline.spanLines[i], after: final.spanLines[i] });
          count++;
        }
      }
      // Smoke-test exact expansion, prioritizing the two historical gaps that
      // motivated this audit: the hidden launch command and the failed API probe.
      const prioritized = [...examples.filter((e) => e.label === "launch command" || e.label === "network probe"), ...examples];
      const refIds = [...new Set(prioritized.flatMap((e) => [...e.after.matchAll(/ ref=([^\s;]+)/g)].map((m) => m[1])))].slice(0, 6);
      const recoveryChecks = [];
      for (const id of refIds) {
        let text = "", offset = 0, pages = 0;
        for (;;) {
          assert(pages++ < 100, `ref ${id} must finish within 100 pages`);
          const result = await after.tools.context_show_entry.execute("audit", { id, includeRelated: true, maxLines: 1000, offset }, undefined, undefined,
            { sessionManager: { getBranch: () => final.rawBranch } });
          const page = result.content.map((b) => b.text ?? "").join("");
          text += page.replace(/^\[Continuation: [^\n]*\]\n/, "").split("\n[Page limited:")[0];
          const next = /Continue with the same parameters and offset=(\d+)\.\]$/.exec(page);
          if (!next) break;
          assert(Number(next[1]) > offset, "direct expansion cursor must advance");
          offset = Number(next[1]);
        }
        assert(text.includes("[toolCall] bash") && text.includes("toolResult"), `ref ${id} recovers both call and result`);
        const resultAt = final.rawBranch.findIndex((e) => e.id === id);
        const source = final.rawBranch[resultAt];
        const origin = final.rawBranch.slice(0, resultAt).findLast((e) => e.type === "message" && e.message.role === "assistant" &&
          e.message.content?.some((b) => b.type === "toolCall" && b.id === source.message?.toolCallId && b.name === source.message?.toolName));
        const call = origin?.message.content.find((b) => b.type === "toolCall" && b.id === source.message.toolCallId);
        assert(call && text.includes(JSON.stringify(call.arguments, null, 2)), "recovery includes exact full arguments, not the truncated preview");
        recoveryChecks.push({ ref: id, pages, expandedChars: text.length, fullArgumentsRecovered: true, recoveredLaunchModelArgument: text.includes("PI_CODING_AGENT_DIR") && text.includes("--model"),
          recovered404: /http=404/.test(text) });
      }
      report.sessions.push({ name, checkpoints: metrics, examples, directRefChecks: recoveryChecks });
      assert.equal(hash(fs.readFileSync(file)), originalHash, "input session must remain byte-identical");
    }
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`\nProse preservation, line preservation, ref validity, direct expansion, and input hashes checked.\nArtifacts: ${output}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

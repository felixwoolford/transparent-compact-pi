"use strict";

// Optional, local-only measurement against user-supplied session audits.
// Does not open sessions through SessionManager or modify the supplied JSONL.
// Usage: node scripts/file-evidence-replay.cjs <session.jsonl> [...]
// Rebuilds both versions at the recorded cut points, so every span uses the
// respective renderer rather than inheriting 0.8.6's saved tool signatures.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const snapshotExtension = require("./git-extension-snapshot.cjs");
const { piRoot, jitiAliases } = require("./pi-runtime.cjs");
const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
const repo = path.resolve(__dirname, "..");

function fileSection(summary) {
  const starts = [summary.indexOf("File lists record earlier operations."), summary.indexOf("<read-files"), summary.indexOf("<modified-files")]
    .filter((n) => n >= 0);
  if (!starts.length) return "";
  const ends = ["</read-files>", "</modified-files>"].map((tag) => {
    const n = summary.lastIndexOf(tag);
    return n < 0 ? 0 : n + tag.length;
  });
  return summary.slice(Math.min(...starts), Math.max(...ends));
}

async function replay(factory, rows, buildSessionProjection) {
  const header = rows.find((row) => row.type === "session");
  const branch = [];
  const checkpoints = [];
  let compact;
  factory({ on: (name, handler) => { if (name === "session_before_compact") compact = handler; },
    registerTool: () => {}, registerCommand: () => {} });
  let previousCut;
  for (const [index, original] of rows.entries()) {
    if (original.type === "session") continue;
    if (original.type !== "compaction") { branch.push(original); continue; }
    const positions = new Map(branch.map((entry, i) => [entry.id, i]));
    const cut = positions.get(original.firstKeptEntryId) ?? branch.length;
    const from = previousCut === undefined ? 0 : positions.get(previousCut) ?? 0;
    const messages = buildSessionProjection(branch).entries
      .filter((entry) => entry.sourceEntry.type !== "compaction" && positions.get(entry.sourceEntry.id) >= from && positions.get(entry.sourceEntry.id) < cut)
      .flatMap((entry) => entry.messages);
    const response = await compact({ branchEntries: branch, reason: original.details?.span?.reason ?? "threshold",
      signal: new AbortController().signal,
      preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: original.firstKeptEntryId,
        tokensBefore: original.tokensBefore,
        fileOps: { read: new Set(original.details?.readFiles ?? []), written: new Set(), edited: new Set(original.details?.modifiedFiles ?? []) } },
    }, { cwd: header.cwd, sessionManager: { getBranch: () => branch }, model: { contextWindow: 131072 },
      hasUI: false, mode: "json", ui: { notify: () => {} } });
    assert(response?.compaction, `recorded compaction at line ${index + 1} must be renderable`);
    const c = response.compaction;
    branch.push({ ...original, summary: c.summary, details: c.details });
    checkpoints.push({ line: index + 1, summary: c.summary, files: fileSection(c.summary) });
    previousCut = original.firstKeptEntryId;
  }
  return checkpoints;
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("Supply one or more session JSONL paths");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-file-evidence-replay-"));
  try {
    const baselineRef = process.env.TC_BASELINE_REF || "d74d334";
    const { entryPath: baseline } = snapshotExtension(repo, baselineRef, temp);
    delete process.env.MECH_COMPACT_MAX_SUMMARY_CHARS;
    process.env.MECH_COMPACT_MAX_SUMMARY_PERCENT = "25";
    const jiti = createJiti(__filename, { alias: jitiAliases });
    const { buildSessionProjection } = await jiti.import("@earendil-works/pi-coding-agent");
    const { default: before } = await jiti.import(baseline);
    const { default: after } = await jiti.import(path.join(repo, "extensions/index.ts"));
    console.log(`Baseline ${baselineRef}; 131072-token window; recorded cut points; no live model calls`);
    for (const file of files) {
      const bytes = fs.readFileSync(file, "utf8");
      const rows = bytes.trim().split("\n").map(JSON.parse);
      const old = await replay(before, rows, buildSessionProjection);
      const current = await replay(after, rows, buildSessionProjection);
      assert.equal(current.length, old.length);
      console.log(`\n${path.basename(file)}: ${current.length} checkpoints`);
      for (let i = 0; i < current.length; i++) {
        const c = current[i];
        console.log(`  #${i + 1} line ${c.line}: file section ${old[i].files.length} -> ${c.files.length} chars (${c.files.length - old[i].files.length >= 0 ? "+" : ""}${c.files.length - old[i].files.length}); total checkpoint delta ${c.summary.length - old[i].summary.length}`);
        if (c.line === 1033 || c.line === 1366)
          console.log(c.files.split("\n").filter((s) => s.includes("build/fetch-holidays.mjs")).map((s) => "    " + s).join("\n"));
      }
      assert.equal(fs.readFileSync(file, "utf8"), bytes, "source session remains untouched");
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exit(1); });

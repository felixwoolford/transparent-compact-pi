"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { locationId, locationLine } = require('./location-test-helpers.cjs');

module.exports = async function ({ ext, SessionManager, root, compact, makeContext, assistant, toolCall, text, user }) {
  console.log("== Compact signatures: relative paths, payload sizes, and 160-character head-only previews ==");
  const cwd = path.join(root, "format project+[a](b)");
  const build = async (messages, { budget, fileOps } = {}) => {
    const manager = SessionManager.inMemory(cwd);
    manager.appendCustomEntry("transparent-compact:cap-compaction", {
      mode: budget === undefined ? "off" : "on", budget: { unit: "chars", value: budget ?? 80000 },
    });
    const ids = messages.map((m) => manager.appendMessage(m));
    const kept = manager.appendMessage(user("Retained format tail"));
    const ctx = makeContext(manager, cwd);
    const before = JSON.stringify(manager.getBranch());
    const result = await ext.handlers.session_before_compact({
      branchEntries: manager.getBranch(), reason: "threshold", signal: new AbortController().signal,
      preparation: { messagesToSummarize: ids.map((id) => manager.getEntry(id).message),
        turnPrefixMessages: [], firstKeptEntryId: kept, tokensBefore: 10000, fileOps },
    }, ctx);
    assert(result?.compaction);
    assert.equal(JSON.stringify(manager.getBranch()), before, "formatting does not mutate raw history");
    return { c: result.compaction, manager, ctx, kept };
  };
  const content = "WRITE_PAYLOAD_SECRET\n".repeat(100);
  const oldText = "OLD_PAYLOAD_SECRET\n".repeat(100);
  const newText = "NEW_PAYLOAD_SECRET\n".repeat(100);
  const longPath = "src/" + "long-component/".repeat(15) + "identifying-file.ts";
  const commands = [
    [`cd "${cwd}" && cat '${cwd}/src/example.ts'`, 'cd "." && cat \'./src/example.ts\''],
    [`cat ${cwd}-sibling/file.ts`, `cat ${cwd}-sibling/file.ts`],
    [`cat /prefix${cwd}/file.ts`, `cat /prefix${cwd}/file.ts`],
    [`curl https://host${cwd}/file.ts`, `curl https://host${cwd}/file.ts`],
    [`FILE='${cwd}/src/example.ts'`, "FILE='./src/example.ts'"],
    ["cd /tmp && node -e \"\nconst setup = '" + "x".repeat(70) + "';\nIDENTIFYING_TARGET();\"",
      "cd /tmp && node -e \"\nconst setup = '" + "x".repeat(70) + "';\nIDENTIFYING_TARGET();\""],
    ["x".repeat(158), "x".repeat(158)], // JSON-encoded length exactly 160.
    ["x".repeat(159), "x".repeat(159)], // Previously the omission-count marker grew this argument.
    ["x".repeat(500), "x".repeat(500)],
  ];
  const args = [
    ["read", { path: path.join(cwd, "src/example.ts"), offset: 12, limit: 30 }],
    ["read", { path: path.join(cwd, longPath) }],
    ["read", { path: cwd + "-sibling/file.ts" }],
    ["read", { path: "../relative-file.ts" }],
    ["read", { path: cwd }],
    ["write", { path: path.join(cwd, "src/out.ts"), content }],
    ["edit", { path: path.join(cwd, "src/out.ts"), edits: [{ oldText, newText }, { oldText, newText }] }],
    ["edit", { path: path.join(cwd, "src/out.ts"), oldText, newText }],
    ["edit", { path: "empty.ts", edits: [] }],
    ["edit", { path: "malformed.ts", edits: { unexpected: "kept generically" } }],
    ["third_party", { content: "Not a write payload", query: "q".repeat(500) }],
    ...commands.map(([command]) => ["bash", { command, timeout: 60 }]),
  ];
  const userProse = `Keep this instruction and path verbatim: ${cwd}/src/example.ts`;
  const assistantProse = `I inspected ${cwd}/src/example.ts.`;
  const { c, manager } = await build([
    user(userProse), assistant([text(assistantProse), ...args.map(([name, a], i) => toolCall(name, a, `format-${i}`))], "toolUse"),
  ], { fileOps: { read: new Set([path.join(cwd, "docs/spec.md")]),
    written: new Set([path.join(cwd, "src/out.ts")]), edited: new Set() } });
  const stubs = c.details.span.lines.filter((s) => s.startsWith("[Tools]:")).join("\n");
  const id = (file) => locationId(c, file, cwd);
  for (const signature of [
    `read ${id('src/example.ts')}:12-41`,
    `read ${id(longPath)}`,
    `read ${id(cwd + '-sibling/file.ts')}`,
    `read ${id('../relative-file.ts')}`, `read ${id('.')}`,
    `write ${id('src/out.ts')} (${content.length} chars)`,
    `edit ${id('src/out.ts')} ×2`,
    `edit ${id('src/out.ts')} oldText=<${oldText.length} chars> newText=<${newText.length} chars>`,
    `edit ${id('empty.ts')} ×0`,
    `edit ${id('malformed.ts')} [unknown]`,
  ]) assert(stubs.includes(signature), signature);
  assert(!stubs.includes('kept generically'), 'malformed known payloads do not expose arbitrary arguments');
  for (const [command, expected] of commands) {
    const encoded = JSON.stringify(expected);
    const snippet = encoded.length > 160 ? encoded.slice(0, 160) + "…" : encoded;
    if (encoded.length <= 160 || /^x{161,}$/.test(command))
      assert(stubs.includes(`bash ${snippet} [unknown]`), command);
    assert(snippet.length <= encoded.length, "abbreviating never increases argument size");
  }
  assert.equal(stubs.includes('IDENTIFYING_TARGET'), JSON.stringify(commands[5][1]).length <= 160,
    'only genuinely short interpreter commands preserve their complete literal body');
  assert(!stubs.includes("…[+"), "omit repetitive truncation counts");
  assert(!stubs.includes("; output removed"), "output removal is explained once, not per call");
  for (const secret of ["WRITE_PAYLOAD_SECRET", "OLD_PAYLOAD_SECRET", "NEW_PAYLOAD_SECRET"])
    assert(!c.summary.includes(secret), secret);
  assert(stubs.includes('third_party(content="Not a write payload", query="' + "q".repeat(159) + "…"));
  assert(c.summary.includes(userProse) && c.summary.includes(assistantProse), "never shorten conversation prose");
  assert(!c.summary.includes("docs/spec.md"), "metadata-only paths do not create dictionary entries");
  assert.equal(locationLine(c, "src/out.ts"), `${id('src/out.ts')} "src/out.ts"`);
  assert(!/<(?:read|modified)-files\b/.test(c.summary), "no separate file inventories");
  assert.deepEqual(c.details.readFiles, [path.join(cwd, "docs/spec.md")], "file metadata stays original");
  assert.deepEqual(c.details.modifiedFiles, [path.join(cwd, "src/out.ts")]);
  assert(manager.getBranch().some((e) => e.message?.content?.some?.((b) => b.arguments?.content === content)),
    "write bodies remain in raw history");

  const joined = (await build([assistant([
    toolCall("read", { path: "src/both.ts" }, "joined"),
    toolCall("read", { path: "lexical-only.ts" }, "lexical"),
  ], "toolUse")], { fileOps: { read: new Set(["src/both.ts", "read-only.md"]),
    written: new Set(), edited: new Set(["./src/both.ts"]) } })).c;
  for (const file of ["src/both.ts", "lexical-only.ts"])
    assert.equal(locationLine(joined, file), `${locationId(joined, file)} ${JSON.stringify(file)}`,
      "operation metadata does not annotate definitions");
  assert(!joined.summary.includes("read-only.md"));

  const oversizedFile = "src/" + "long-directory/".repeat(100) + "read.md";
  const fixed = (await build([assistant([toolCall("read", { path: oversizedFile }, "oversized")], "toolUse")],
    { budget: 700, fileOps: { read: new Set([oversizedFile]), written: new Set(), edited: new Set() } })).c;
  assert(!fixed.summary.includes(`[Tools]: read ${locationId(fixed, oversizedFile)}`), "cap removes the tool stub");
  assert(!fixed.summary.includes(oversizedFile), "capping the last reference removes its definition even if operation metadata contains it");

  const execution = await build([{ role: "bashExecution", command: `cd '${cwd}' && ` + "x".repeat(2000),
    output: "EXECUTION_OUTPUT_SECRET", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 }]);
  const executionStub = execution.c.details.span.lines[0];
  assert(executionStub.startsWith('[BashExecution]: bash "cd \'.\' && '));
  assert(executionStub.length < 230 && !executionStub.includes("\n"));
  assert(!execution.c.summary.includes("EXECUTION_OUTPUT_SECRET"));

  console.log("== Span trimming: partial drops, shortened user messages, empty spans, and repetition ==");
  const partial = await build([
    user("PRESERVED_USER"), assistant([text("OLDEST_PROSE " + "a".repeat(1100))]),
    assistant([text("MIDDLE_PROSE " + "b".repeat(1100))]), assistant([text("NEWEST_PROSE " + "c".repeat(1100))]),
  ], { budget: 2400 });
  const span = (summary, n = 1) => summary.match(new RegExp(`<compacted-span n="${n}"[^>]*>[\\s\\S]*?</compacted-span>`))[0];
  const trimmed = span(partial.c.summary);
  assert(trimmed.includes('trimmed="true"') && trimmed.includes("trimmed for size"));
  assert(trimmed.includes("PRESERVED_USER") && trimmed.includes("NEWEST_PROSE"));
  assert(!trimmed.includes("OLDEST_PROSE"));
  assert(partial.c.details.span.lines.some((line) => line.includes("OLDEST_PROSE")), "stored spans remain uncapped");
  assert(trimmed.includes("[Assistant]:"), "a nonempty partial span must still be marked");
  partial.manager.appendCompaction(partial.c.summary, partial.kept, partial.c.tokensBefore, partial.c.details, true);
  const next = partial.manager.appendMessage(user("Next retained tail"));
  const repeated = await compact(ext, partial.ctx, [partial.kept], next);
  assert(span(repeated.summary).includes('trimmed="true"'), "repeated compaction marks partial trimming again");
  assert(!span(repeated.summary, 2).includes('trimmed="true"'), "unchanged spans are not marked");

  const shortened = await build([user("LONG_USER " + "u".repeat(20000))], { budget: 700 });
  assert.equal(shortened.c.details.span.lines.length, 1);
  assert(span(shortened.c.summary).includes('trimmed="true"'), "same line count but shortened text is marked");
  assert(shortened.c.summary.includes("[truncated +"));

  const removed = await build([assistant([text("REMOVED_PROSE " + "r".repeat(2000))])], { budget: 700 });
  assert(span(removed.c.summary).includes('trimmed="true"'));
  assert(!span(removed.c.summary).includes("REMOVED_PROSE"));
  const empty = await build([assistant([{ type: "thinking", thinking: "EMPTY_SPAN_THINKING" }])], { budget: 700 });
  assert.deepEqual(empty.c.details.span.lines, []);
  assert(!span(empty.c.summary).includes('trimmed="true"'), "naturally empty spans were not size-trimmed");
  const uncapped = await build([assistant([text("UNTRIMMED_PROSE " + "a".repeat(2000))])]);
  assert(!span(uncapped.c.summary).includes('trimmed="true"'));
  assert(uncapped.c.summary.includes("UNTRIMMED_PROSE"));
};

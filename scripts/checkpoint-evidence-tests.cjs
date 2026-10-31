"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function ({ ext, SessionManager, root, compact, makeContext, assistant, toolCall, text, user }) {
  console.log("== Checkpoint evidence: per-call outcomes, removed document contents, and closing rule ==");
  const cwd = path.join(root, "checkpoint-evidence");
  fs.mkdirSync(cwd);
  const manager = SessionManager.inMemory(cwd);
  const ids = [];
  const append = (message) => ids.push(manager.appendMessage(message));
  const call = (name, args, id) => assistant([toolCall(name, args, id)], "toolUse");
  const result = (id, name, isError) => ({ role: "toolResult", toolCallId: id, toolName: name,
    isError, content: [text("REMOVED_EVIDENCE_SECRET: ERROR; tests failed; document says N=99")], timestamp: 0 });
  append(user("Inspect SPEC.md and run the checks."));
  append(assistant([
    text("All checks passed."),
    toolCall("bash", { command: "check" }, "ok"),
    toolCall("read", { path: "missing.md" }, "error"),
  ], "toolUse"));
  // Parallel results arrive in reverse order. Output text must not determine status.
  append(result("error", "read", true));
  append(result("ok", "bash", false));
  append(call("read", { path: "unfinished.md" }, "unfinished"));
  append(call("read", { path: "missing-status.md" }, "missing-status"));
  append(result("missing-status", "read", undefined));
  append(call("read", { path: "wrong-name.md" }, "wrong-name"));
  append(result("wrong-name", "write", false));
  append(result("too-early", "read", false));
  append(call("read", { path: "before-call.md" }, "too-early"));
  append(call("bash", { command: "first-reuse" }, "reuse"));
  append(result("reuse", "bash", false));
  append(call("bash", { command: "second-reuse" }, "reuse"));
  append(result("reuse", "bash", true));
  append(assistant([
    toolCall("read", { path: "duplicate-a.md" }, "duplicate"),
    toolCall("read", { path: "duplicate-b.md" }, "duplicate"),
  ], "toolUse"));
  append(result("duplicate", "read", false));
  append(result("duplicate", "read", true));
  append(call("read", { path: "outside-selection.md" }, "outside-selection"));
  // Exists on the raw branch but is not selected for this compaction.
  manager.appendMessage(result("outside-selection", "read", false));
  const kept = manager.appendMessage(user("Retained tail"));
  const ctx = makeContext(manager, cwd);
  const c = await compact(ext, ctx, ids, kept, "manual", {
    read: new Set(["SPEC.md", "docs/a guide.md"]), written: new Set(), edited: new Set(["changed.ts"]),
  });
  assert(c.summary.includes('bash "check"; read "missing.md" [tool error]'));
  assert(c.summary.includes('[Assistant]: All checks passed.'), "assistant prose stays verbatim, not endorsed");
  assert(c.summary.includes('bash "first-reuse"'));
  assert(c.summary.includes('bash "second-reuse" [tool error]'));
  for (const file of ["unfinished.md", "missing-status.md", "wrong-name.md", "before-call.md", "duplicate-a.md", "duplicate-b.md", "outside-selection.md"]) {
    assert(c.summary.includes(`read "${file}" [unknown]`), file);
  }
  assert(!c.summary.includes("REMOVED_EVIDENCE_SECRET"), "neither successful nor failed output bodies leak");
  assert(c.summary.includes("Unlabelled does NOT establish exit 0 or passing tests."));
  assert(c.summary.includes("SPEC.md\ndocs/a guide.md\n</read-files>"));
  assert(c.summary.includes("changed.ts (no read-tool output in tail)"));
  assert.deepEqual(c.details.readFiles, ["SPEC.md", "docs/a guide.md"], "metadata retains bare paths");
  assert.deepEqual(c.details.modifiedFiles, ["changed.ts"]);
  const rule = "**Evidence boundary:** Previews and file lists are incomplete; output labels are historical observations, prose is not verification. Open refs with `context_show_entry` (`includeRelated=true`), or use `context_lookup`. Inspect sources for current state.";
  assert(c.summary.includes(`</modified-files>\n\n${rule}\n\nConversation`), "rule sits after file lists, immediately before the tail boundary");
  const next = manager.appendMessage(user("Next retained tail"));
  const repeated = await compact(ext, ctx, [kept], next);
  assert(repeated.summary.includes('bash "check"'), "signatures persist in saved uncapped spans");
  assert(repeated.summary.includes("SPEC.md\ndocs/a guide.md\n</read-files>"), "cumulative read lists make no unsupported absence claim");
  assert.equal(repeated.summary.split(rule).length - 1, 1, "closing rule is not nested on repeated compaction");

  const split = SessionManager.inMemory(cwd);
  const a = split.appendMessage(call("read", { path: "split.md" }, "split"));
  const t = split.appendMessage(result("split", "read", true));
  const tail = split.appendMessage(assistant([text("Kept tail")]));
  const splitResult = await ext.handlers.session_before_compact({
    branchEntries: split.getBranch(), reason: "threshold", signal: new AbortController().signal,
    preparation: { messagesToSummarize: [split.getEntry(a).message], turnPrefixMessages: [split.getEntry(t).message],
      isSplitTurn: true, firstKeptEntryId: tail, tokensBefore: 1000 },
  }, makeContext(split, cwd));
  assert(splitResult.compaction.summary.includes('read "split.md" [tool error]'), "pairing spans both preparation arrays");
  assert(splitResult.compaction.summary.includes(rule), "rule is present without any file lists");

  const old = SessionManager.inMemory(cwd);
  const oldTail = old.appendMessage(user("Old retained tail"));
  const oldLine = '[Assistant tool calls] (outputs removed): read(path="OLD.md")';
  const oldCustom = '[Custom]: LEGACY_CUSTOM_BODY';
  old.appendCompaction("OLD_CHECKPOINT", oldTail, 1000, {
    kind: "mech-compact", readFiles: ["OLD.md"], modifiedFiles: [],
    span: { at: "2026-01-01T00:00:00Z", reason: "manual", lines: [oldLine, oldCustom] },
  }, true);
  const newTail = old.appendMessage(user("New retained tail"));
  const legacy = await compact(ext, makeContext(old, cwd), [oldTail], newTail);
  assert(legacy.summary.includes(oldLine), "old spans are not rewritten with guessed outcomes");
  assert(legacy.summary.includes(oldCustom), "previously saved custom-message bodies are not migrated");
  assert(legacy.summary.includes("legacy calls without status are unknown."));
  assert(legacy.summary.includes("OLD.md\n</read-files>"));
  console.log("== Custom messages: generic bounded stubs, raw recovery, and repeated compaction ==");
  const custom = SessionManager.inMemory(cwd);
  // The cap is off: removing bodies is compaction policy, not size trimming.
  custom.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  const cases = [
    { type: "third-party:background-result", content: "CUSTOM_OUTPUT_SECRET\n" + "output\n".repeat(500), display: true },
    { type: "unrelated:instructions", content: [text("CUSTOM_INSTRUCTIONS_SECRET"),
      { type: "image", data: "CUSTOM_IMAGE_SECRET", mimeType: "image/png" }], display: false },
    { type: "empty", content: "", display: true },
    { type: 'long\n"' + "x".repeat(1000), content: "CUSTOM_LONG_TYPE_SECRET", display: false },
  ];
  const customIds = cases.map((c) => custom.appendCustomMessageEntry(c.type, c.content, c.display,
    { arbitrary: "CUSTOM_DETAILS_SECRET" }));
  const originals = customIds.map((id) => structuredClone(custom.getEntry(id)));
  const customTail = custom.appendCustomMessageEntry("retained", "CUSTOM_TAIL_VERBATIM", true);
  const customCtx = makeContext(custom, cwd);
  const customResult = await compact(ext, customCtx, customIds, customTail);
  const stubs = customResult.details.span.lines;
  assert.equal(stubs.length, cases.length);
  for (const c of cases.slice(0, 3)) {
    assert(stubs.includes(`[Custom message]: custom(type=${JSON.stringify(c.type)}) [content removed — use context_lookup]`));
  }
  assert(stubs.every((line) => line.length < 300 && !line.includes("\n") && line.endsWith("[content removed — use context_lookup]")),
    "even multiline/oversized types produce bounded one-line stubs");
  assert(stubs.at(-1).includes("…"), "long custom types are abbreviated like tool arguments");
  for (const checkpoint of [customResult.summary, JSON.stringify(stubs)]) {
    for (const secret of ["CUSTOM_OUTPUT_SECRET", "CUSTOM_INSTRUCTIONS_SECRET", "CUSTOM_IMAGE_SECRET", "CUSTOM_DETAILS_SECRET", "CUSTOM_LONG_TYPE_SECRET"])
      assert(!checkpoint.includes(secret), secret);
  }
  assert.deepEqual(customIds.map((id) => custom.getEntry(id)), originals, "original session entries remain intact");
  const raw = await ext.tools.context_show_entry.execute("recover-custom", { id: customIds[0], maxLines: 1000 },
    new AbortController().signal, undefined, customCtx);
  const recovered = raw.content.map((b) => b.text ?? "").join("");
  assert(recovered.includes(cases[0].content), "the full custom body remains recoverable from raw history");
  assert(custom.buildSessionContext().messages.some((m) => m.role === "custom" && m.content === "CUSTOM_TAIL_VERBATIM"),
    "custom messages in Pi's retained tail remain verbatim");
  const customNextTail = custom.appendMessage(user("Next custom tail"));
  const customRepeated = await compact(ext, customCtx, [customTail], customNextTail);
  for (const stub of stubs) assert(customRepeated.summary.includes(stub), "saved stubs survive repeated compaction");
  assert(!customRepeated.summary.includes("CUSTOM_OUTPUT_SECRET"));
  assert(!customRepeated.summary.includes("CUSTOM_TAIL_VERBATIM"), "the former tail body is removed when newly compacted");
  assert.deepEqual(fs.readdirSync(cwd), [], "evidence metadata requires no disk snapshots");
};

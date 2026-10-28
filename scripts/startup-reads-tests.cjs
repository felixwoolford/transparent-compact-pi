"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function ({ factory, load, SessionManager, root, makeContext, assistant, toolCall, text, user, saveSession }) {
  console.log("== Startup reads: lexical selection, original chunks, frozen carry-forward and tail deduplication ==");
  const cwd = path.join(root, "startup-reads");
  fs.mkdirSync(cwd);
  const sources = [{ path: path.join(cwd, "AGENTS.md"), content:
    "Read `docs/SPEC.md`, GUIDE.md. Also [rules](docs/RULES.md#details), `a guide.md`, nested/NESTED.md. " +
    "Mentioned: PRE.md, LATE.md, FAILED.md, UNKNOWN.md, IMAGE.md, OMIT.md, REPLACED.md, " +
    "DUP.md, WRONG.md, UNFINISHED.md, CROSS.md, CALL-OMITTED.md. " +
    "Not matches: NOT-NEAR.md, SUFFIX.md.bak, elsewhere/PATH.md." },
    { path: path.join(cwd, "OTHER.md"), content: "NOT-AGENTS.md" }];

  function rig(manager = SessionManager.inMemory(cwd), contextFiles = sources) {
    const notices = [];
    const ctx = { ...makeContext(manager, cwd), getSystemPromptOptions: () => ({ contextFiles }),
      getSystemPrompt: () => "Arbitrary prompt text mentions NOT-AGENTS.md", ui: { notify: (message) => notices.push(message) } };
    const ext = load(factory, { current: manager });
    const append = (m) => manager.appendMessage(m);
    const call = (file, id = file, args = {}, name = "read") => append(assistant([toolCall(name, { path: file, ...args }, id)], "toolUse"));
    const result = (id, value, isError = false, name = "read") => append({ role: "toolResult", toolCallId: id, toolName: name,
      isError, content: typeof value === "string" ? [text(value)] : value, timestamp: 0 });
    const read = (file, value, args = {}, id = file) => { call(file, id, args); return result(id, value); };
    const compact = async (kept) => {
      const entries = manager.getBranch();
      const previous = entries.findLast((e) => e.type === "compaction");
      const start = previous ? entries.findIndex((e) => e.id === previous.firstKeptEntryId) : 0;
      const end = entries.findIndex((e) => e.id === kept);
      const messages = entries.slice(start, end).filter((e) => e.type === "message").map((e) => e.message);
      const response = await ext.handlers.session_before_compact({ branchEntries: entries, reason: "manual",
        preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: kept, tokensBefore: 90000,
          fileOps: { read: new Set(["docs/SPEC.md", "UNRELATED.md"]), written: new Set(), edited: new Set() } },
      }, ctx);
      assert(response?.compaction, "retention never needs a model or a file read");
      const c = response.compaction;
      const id = manager.appendCompaction(c.summary, kept, c.tokensBefore, c.details, true);
      return { ...c, id };
    };
    return { manager, ctx, notices, ext, append, call, result, read, compact };
  }

  const r = rig();
  r.read("PRE.md", "BEFORE_FIRST_PROMPT");
  r.append(user("First real user prompt"));
  r.manager.appendCustomMessageEntry("not-a-user-prompt", "Injected content", false);
  const page1 = "SPEC_PAGE_ONE\n  preserve whitespace  \n\n[2 more lines in file. Use offset=3 to continue.]";
  const page2 = "SPEC_PAGE_TWO\nend\n";
  const p1 = r.read("docs/SPEC.md", page1, { offset: 1, limit: 2 }, "spec-1");
  const p2 = r.read("docs/SPEC.md", page2, { offset: 3 }, "spec-2");
  r.read(path.join(cwd, "GUIDE.md"), "GUIDE_CONTENT");
  r.read("./docs/RULES.md", "RULES_CONTENT");
  r.read("a guide.md", "SPACED_PATH_CONTENT");
  r.read("nested/CLAUDE.md", "Read EXTRA.md.");
  r.read("nested/EXTRA.md", "NESTED_INSTRUCTIONS_CONTENT");
  for (const file of ["UNRELATED.md", "NEAR.md", "SUFFIX.md", "PATH.md", "NOT-AGENTS.md"])
    r.read(file, `EXCLUDED_${file}`);
  r.call("FAILED.md"); r.result("FAILED.md", "FAILED_CONTENT", true);
  r.call("UNKNOWN.md");
  r.append({ role: "toolResult", toolCallId: "UNKNOWN.md", toolName: "read", content: [text("UNKNOWN_CONTENT")], timestamp: 0 });
  r.read("IMAGE.md", [text("IMAGE_CONTENT"), { type: "image", data: "IMAGE_BYTES", mimeType: "image/png" }]);
  r.call("DUP.md", "dup"); r.call("DUP.md", "dup"); r.result("dup", "AMBIGUOUS_CONTENT");
  r.call("WRONG.md", "wrong"); r.result("wrong", "WRONG_TOOL_CONTENT", false, "bash");
  r.result("unmatched", "UNMATCHED_CONTENT");
  r.call("UNFINISHED.md");
  const omitted = r.read("OMIT.md", "OMITTED_CONTENT");
  r.manager.appendContextEdit(omitted, null);
  const replaced = r.read("REPLACED.md", "OLD_REPLACED_CONTENT");
  r.manager.appendContextEdit(replaced, { content: "REPLACEMENT_CONTENT" });
  const omittedCall = r.call("CALL-OMITTED.md");
  r.result("CALL-OMITTED.md", "OMITTED_CALL_CONTENT");
  r.manager.appendContextEdit(omittedCall, null);
  r.call("CROSS.md");
  const second = r.append(user("Second real user prompt"));
  r.result("CROSS.md", "AFTER_SECOND_RESULT");
  r.read("LATE.md", "AFTER_SECOND_PROMPT");
  const first = await r.compact(second);
  const state = first.details.startupReads;
  assert.equal(state.closed, true);
  assert.equal(state.reads.length, 7);
  assert.deepEqual(state.reads.filter((x) => x.path === "docs/SPEC.md"), [
    { entryId: p1, path: "docs/SPEC.md", offset: 1, limit: 2, text: [page1] },
    { entryId: p2, path: "docs/SPEC.md", offset: 3, text: [page2] },
  ]);
  for (const value of [page1, page2, "GUIDE_CONTENT", "RULES_CONTENT", "SPACED_PATH_CONTENT", "NESTED_INSTRUCTIONS_CONTENT", "REPLACEMENT_CONTENT"])
    assert(first.summary.includes(value), value);
  for (const value of ["BEFORE_FIRST_PROMPT", "EXCLUDED_", "FAILED_CONTENT", "UNKNOWN_CONTENT", "IMAGE_CONTENT", "IMAGE_BYTES", "AMBIGUOUS_CONTENT", "WRONG_TOOL_CONTENT", "UNMATCHED_CONTENT", "OMITTED_CONTENT", "OLD_REPLACED_CONTENT", "OMITTED_CALL_CONTENT", "AFTER_SECOND_RESULT", "AFTER_SECOND_PROMPT"])
    assert(!first.summary.includes(value), value);
  assert(!first.details.span.lines.join("\n").includes(page1), "read bodies are not part of trimmable spans");
  assert(first.summary.includes("docs/SPEC.md (startup read output retained in checkpoint or tail; may be partial)"));
  assert.match(first.summary, /^UNRELATED\.md$/m, "no absence claim for unannotated read paths");
  assert(first.summary.indexOf("### Retained startup reads") > first.summary.lastIndexOf("</compacted-span>"));
  assert(first.summary.indexOf("### Retained startup reads") < first.summary.indexOf("**Evidence boundary:**"));

  const file = path.join(root, "startup-reads-resume.jsonl");
  saveSession(r.manager, file);
  const reopened = rig(SessionManager.open(file));
  reopened.ctx.getSystemPromptOptions = () => { throw new Error("Closed selection must not re-read instructions"); };
  reopened.ctx.getSystemPrompt = reopened.ctx.getSystemPromptOptions;
  reopened.read("docs/SPEC.md", "LATER_VERSION_MUST_NOT_REPLACE_STARTUP");
  const next = reopened.append(user("Third prompt"));
  const repeated = await reopened.compact(next);
  assert.deepEqual(repeated.details.startupReads, state, "resume + another compaction copy frozen bytes, not checkpoint prose");
  assert.equal(repeated.summary.split(page1).length - 1, 1);
  assert(!repeated.summary.includes("LATER_VERSION_MUST_NOT_REPLACE_STARTUP"));
  assert(!repeated.details.span.lines.join("\n").includes(page1));

  // Branching before the first compaction must not inherit the abandoned branch's selection.
  r.manager.branch(p1);
  const alternativeSecond = r.append(user("Different second prompt"));
  const alternative = await r.compact(alternativeSecond);
  assert.deepEqual(alternative.details.startupReads.reads.map((x) => x.entryId), [p1]);
  assert(!alternative.summary.includes(page2));

  // An early cut must not duplicate a read already in the retained tail, and
  // must still collect later startup pages until the second real user message.
  const early = rig();
  early.append(user("One long first task"));
  const keptCall = early.call("docs/SPEC.md", "early", { limit: 2 });
  const earlyRead = early.result("early", page1);
  const earlyCompaction = await early.compact(keptCall);
  assert.equal(earlyCompaction.details.startupReads.closed, false);
  assert.deepEqual(earlyCompaction.details.startupReads.reads.map((x) => x.entryId), [earlyRead]);
  assert(!earlyCompaction.summary.includes(page1), "read remains in the tail, not duplicated in checkpoint");
  assert.equal(JSON.stringify(early.manager.buildSessionContext()).split("SPEC_PAGE_ONE").length - 1, 1);
  early.manager.appendCustomMessageEntry("steering", "Not a second user prompt", false);
  const earlyP2 = early.read("docs/SPEC.md", page2, { offset: 3 }, "early-page2");
  const secondEarly = early.append(user("Now the second prompt"));
  const closed = await early.compact(secondEarly);
  assert.equal(closed.details.startupReads.closed, true);
  assert.deepEqual(closed.details.startupReads.reads.map((x) => x.entryId), [earlyRead, earlyP2]);
  assert(closed.summary.includes(page1));
  assert(closed.summary.includes(page2));
  assert.equal(JSON.stringify(early.manager.buildSessionContext()).split("SPEC_PAGE_ONE").length - 1, 1);

  // Prompt-only fallback still requires a named AGENTS/CLAUDE block.
  const fallback = rig(undefined, []);
  delete fallback.ctx.getSystemPromptOptions;
  fallback.ctx.getSystemPrompt = () => `<project_instructions path="${path.join(cwd, "AGENTS.override.md")}">\nRead GUIDE.md.\n</project_instructions>`;
  fallback.append(user("First"));
  fallback.read("GUIDE.md", "FALLBACK_CONTENT");
  const fallbackTail = fallback.append(user("Second"));
  assert((await fallback.compact(fallbackTail)).summary.includes("FALLBACK_CONTENT"));

  // Fixed retained-read overhead consumes budget but never gets silently clipped.
  const capped = rig();
  capped.manager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "on", budget: { unit: "chars", value: 500 } });
  capped.append(user("First"));
  const large = "LARGE_START\n" + "reference contents\n".repeat(200) + "LARGE_END";
  capped.read("docs/SPEC.md", large);
  capped.append(assistant([text("Trimmable prose. ".repeat(500))]));
  const cappedTail = capped.append(user("Second"));
  const cap = await capped.compact(cappedTail);
  assert(cap.summary.includes(large));
  assert(!cap.summary.includes("Trimmable prose."));
  assert(capped.notices.some((x) => x.includes("retained startup reads alone") && x.includes("kept un-capped")));
  assert.deepEqual(fs.readdirSync(cwd), [], "selection uses prompt and transcript, never reads or writes source files");
};

"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

module.exports = async function ({ factory, load, SessionManager, root, makeContext, user, assistant, text, toolCall, saveSession }) {
  console.log("== Checkpoint export: frozen text, revisions, branch scope, paths and no context changes ==");
  const cwd = path.join(root, "checkpoint-export"); fs.mkdirSync(cwd);
  const manager = SessionManager.inMemory(cwd), notices = [], ext = load(factory, { current: manager });
  const ctx = { ...makeContext(manager, cwd),
    getSystemPromptOptions: () => ({ contextFiles: [{ path: path.join(cwd, "AGENTS.md"), content: "<retain-reads>\nlatest: SPEC.md\n</retain-reads>" }] }),
    ui: { notify: (message, level) => notices.push({ message, level }) } };
  const command = ext.commands["export-checkpoint"];
  const exportTo = async (argument, context = ctx, extension = ext) => {
    const before = JSON.stringify(context.sessionManager.getEntries()), leaf = context.sessionManager.getLeafId();
    await extension.commands["export-checkpoint"].handler(argument, context);
    assert.equal(JSON.stringify(context.sessionManager.getEntries()), before, "export does not write session entries");
    assert.equal(context.sessionManager.getLeafId(), leaf, "export does not move the branch leaf");
  };
  assert(command);
  await exportTo("");
  assert.match(notices.at(-1).message, /No checkpoint/);
  assert.deepEqual(fs.readdirSync(cwd), [], "no checkpoint means no export file");

  manager.appendMessage(user("EXPORT_COMPACTED_USER"));
  manager.appendMessage(assistant([toolCall("read", { path: "SPEC.md", limit: null }, "export-read")], "toolUse"));
  const snapshot = "EXPORT_FROZEN_SNAPSHOT\n  spaces  \n漢字 👋\n";
  manager.appendMessage({ role: "toolResult", toolCallId: "export-read", toolName: "read", isError: false, content: [text(snapshot)], timestamp: 0 });
  const tail = manager.appendMessage(user("EXPORT_RECENT_TAIL"));
  const entries = manager.getBranch();
  const result = await ext.handlers.session_before_compact({ branchEntries: entries, reason: "manual", signal: new AbortController().signal,
    preparation: { messagesToSummarize: entries.filter((e) => e.type === "message" && e.id !== tail).map((e) => e.message),
      turnPrefixMessages: [], firstKeptEntryId: tail, tokensBefore: 50000,
      fileOps: { read: new Set(["SPEC.md"]), written: new Set(), edited: new Set() } } }, ctx);
  assert(result?.compaction);
  const checkpoint = result.compaction;
  const checkpointId = manager.appendCompaction(checkpoint.summary, tail, checkpoint.tokensBefore, checkpoint.details, true);
  assert(checkpoint.summary.includes(snapshot));
  manager.appendMessage(assistant([toolCall("read", { path: "SPEC.md", limit: null }, "export-new-read")], "toolUse"));
  manager.appendMessage({ role: "toolResult", toolCallId: "export-new-read", toolName: "read", isError: false,
    content: [text("EXPORT_NEWER_NOT_COMPACTED")], timestamp: 0 });
  // Changing live inputs must not rebuild or advance the frozen LATEST snapshot.
  ctx.getSystemPromptOptions = () => { throw new Error("export must not consult live instruction files"); };
  await exportTo("");
  const defaultPath = path.join(cwd, `pi-checkpoint-${manager.getSessionId()}.txt`);
  assert.equal(fs.readFileSync(defaultPath, "utf8"), checkpoint.summary);
  assert(!checkpoint.summary.includes("EXPORT_RECENT_TAIL") && !checkpoint.summary.includes("EXPORT_NEWER_NOT_COMPACTED"));
  assert(notices.at(-1).message.includes(defaultPath));
  if (process.platform !== "win32") assert.equal(fs.statSync(defaultPath).mode & 0o777, 0o600);

  const revised = checkpoint.summary + "\nEXPORT_CONFIRMED_REVISION\n";
  const revisionId = manager.appendCustomEntry("transparent-compact:filter-revision", { compactionId: checkpointId,
    summary: revised, filteredTurnIds: [], keptAsideTurnIds: [], readRetention: checkpoint.details.readRetention });
  manager.appendCustomEntry("transparent-compact:filter-revision", { compactionId: "unrelated-checkpoint", summary: "EXPORT_WRONG_REVISION" });
  await exportTo('"revised checkpoint.txt"');
  assert.equal(fs.readFileSync(path.join(cwd, "revised checkpoint.txt"), "utf8"), revised);
  assert.equal(manager.getEntry(checkpointId).summary, checkpoint.summary, "the original checkpoint stays unchanged");

  const sessionFile = path.join(root, "checkpoint-export-session.jsonl"); saveSession(manager, sessionFile);
  const sessionBytes = fs.readFileSync(sessionFile);
  const reopened = SessionManager.open(sessionFile), resumed = load(factory, { current: reopened });
  await exportTo("resumed.txt", { ...ctx, sessionManager: reopened }, resumed);
  assert.equal(fs.readFileSync(path.join(cwd, "resumed.txt"), "utf8"), revised);
  assert.deepEqual(fs.readFileSync(sessionFile), sessionBytes, "export leaves the persisted session byte-identical");

  manager.branch(checkpointId);
  await exportTo("before-revision.txt");
  assert.equal(fs.readFileSync(path.join(cwd, "before-revision.txt"), "utf8"), checkpoint.summary);
  manager.branch(tail);
  await exportTo("no-checkpoint.txt");
  assert(!fs.existsSync(path.join(cwd, "no-checkpoint.txt")), "an abandoned branch's checkpoint is not exported");
  manager.branch(revisionId);
  const summaryId = manager.appendCompaction("EXPORT_MODEL_SUMMARY\n", tail, 50000, {}, false);
  await exportTo("summary.txt");
  assert.equal(fs.readFileSync(path.join(cwd, "summary.txt"), "utf8"), "EXPORT_MODEL_SUMMARY\n", "a newer summary supersedes old verbatim revisions");
  manager.branch(revisionId);
  manager.appendCustomEntry("transparent-compact:compaction-method", { method: "summary" });
  await exportTo("method-only.txt");
  assert.equal(fs.readFileSync(path.join(cwd, "method-only.txt"), "utf8"), revised, "method selection alone does not replace the checkpoint");

  for (const [argument, filename] of [["  relative.txt  ", "relative.txt"], ["'single quoted.txt'", "single quoted.txt"],
    [path.join(cwd, "absolute.txt"), "absolute.txt"], ["~/" + path.relative(os.homedir(), path.join(cwd, "tilde.txt")), "tilde.txt"]]) {
    await exportTo(argument);
    assert.equal(fs.readFileSync(path.join(cwd, filename), "utf8"), revised);
  }
  await exportTo("relative.txt"); // Explicit paths can be reused, like /export.
  assert.equal(fs.readFileSync(path.join(cwd, "relative.txt"), "utf8"), revised);
  for (const argument of ['"unterminated', '""', "one.txt two.txt", '"one.txt" ignored']) {
    const files = fs.readdirSync(cwd);
    await exportTo(argument);
    assert.equal(notices.at(-1).level, "error");
    assert.deepEqual(fs.readdirSync(cwd), files);
  }
  await exportTo(path.join(cwd, "missing", "failure.txt"));
  assert.equal(notices.at(-1).level, "error");
  await exportTo(cwd);
  assert.equal(notices.at(-1).level, "error");
  manager.branch(summaryId);
  manager.appendCompaction("", tail, 50000, {}, false);
  await exportTo("empty.txt");
  assert.equal(fs.readFileSync(path.join(cwd, "empty.txt"), "utf8"), "", "empty summaries remain valid snapshots");
};

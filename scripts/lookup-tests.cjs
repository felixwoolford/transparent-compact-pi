"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

module.exports = async function lookupTests(h) {
  const { ext, SessionManager, root, makeContext, searchTool, user } = h;
  assert.equal(ext.tools.context_lookup.executionMode, "sequential");

  // Compaction metadata is internal state, not a recovery source.
  const manager = SessionManager.inMemory(root);
  const tail = manager.appendMessage(user("Retained metadata-test tail"));
  const metadata = new Proxy({}, { get() { throw new Error("Transcript rendering must not inspect compaction metadata"); } });
  const id = manager.appendCompaction("HISTORICAL_SUMMARY", tail, 1000, metadata);
  const rendered = await searchTool(ext, makeContext(manager, root), "show_entry", { id });
  assert(rendered.includes("[summary]\nHISTORICAL_SUMMARY"), "compaction summary remains recoverable without reading metadata");
  assert(!rendered.includes("Transcript rendering must not inspect"));

  await module.exports.limitTests({ ...h, expected: 3 });
};

module.exports.limitTests = async function limitTests(h) {
  const { ext, SessionManager, root, makeContext, assistant, text, toolCall, toolText, saveSession, user, expected } = h;
  console.log(`== Consecutive lookup limit ${expected}: resets, branch state, and no model call when blocked ==`);
  const manager = SessionManager.inMemory(root);
  const request = manager.appendMessage(user("Long task with several recovery needs"));
  let modelCalls = 0;
  const ctx = { ...makeContext(manager, root), modelRegistry: { complete: async () => {
    modelCalls++;
    return assistant([text("Normal findings.")]);
  } } };
  const invoke = async (c = ctx) => {
    const id = `lookup-${modelCalls}-${c.sessionManager.getBranch().length}`;
    c.sessionManager.appendMessage(assistant([text("Not found yet, let me check again."), { type: "thinking", thinking: "A lookup would help" }, toolCall("context_lookup", { question: "Recover evidence" }, id)], "toolUse"));
    const result = await ext.tools.context_lookup.execute(id, { question: "Recover evidence" }, undefined, undefined, c);
    c.sessionManager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "context_lookup", content: result.content, isError: false, timestamp: Date.now() });
    return toolText(result);
  };
  const allowed = expected === 0 ? 4 : expected;
  for (let i = 0; i < allowed; i++) assert.equal(await invoke(), "Normal findings.");
  if (expected === 0) {
    assert.equal(modelCalls, 4, "zero means unlimited");
    return;
  }
  manager.appendCustomEntry("irrelevant-metadata", {});
  manager.appendMessage(assistant([{ type: "thinking", thinking: "Thinking is not a reset" }, text("Standalone narration is not a reset either.")]));
  manager.appendCompaction("A checkpoint does not reset the streak", request, 100, {}, true);
  const beforeBlocked = modelCalls;
  for (let i = 0; i < 3; i++) {
    const result = await invoke({ ...ctx, model: undefined, modelRegistry: {} });
    assert.equal(result, `context_lookup consecutive-call limit reached (${expected}).`);
  }
  assert.equal(modelCalls, beforeBlocked, "blocked attempts never launch another subagent");

  const file = path.join(root, "lookup-streak.jsonl");
  saveSession(manager, file);
  const resumed = SessionManager.open(file);
  assert((await invoke({ ...ctx, sessionManager: resumed })).includes("consecutive-call limit reached"), "resume inherits the active branch's streak");

  const breaks = [
    { role: "bashExecution", command: "true", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() },
    { role: "toolResult", toolName: "read", toolCallId: "read-reset", content: [text("Other evidence")], isError: false, timestamp: Date.now() },
    { role: "toolResult", toolName: "bash", toolCallId: "error-reset", content: [text("Failed but still other work")], isError: true, timestamp: Date.now() },
    user("A new user request"),
  ];
  for (const message of breaks) {
    manager.appendMessage(message);
    for (let i = 0; i < expected; i++) assert.equal(await invoke(), "Normal findings.");
    assert((await invoke()).includes("consecutive-call limit reached"));
  }
  const blockedLeaf = manager.getLeafId();
  manager.branch(request);
  assert.equal(await invoke(), "Normal findings.", "abandoned lookup results never count");
  manager.branch(blockedLeaf);
  assert((await invoke()).includes("consecutive-call limit reached"), "tree navigation restores the streak, not a cached count");

  // A transcript override is a search source, never the source for throttling.
  const override = SessionManager.inMemory(root);
  override.appendMessage(user("Full original session"));
  saveSession(override, file);
  try {
    process.env.MECH_COMPACT_LOOKUP_SESSION_FILE = file;
    assert((await invoke()).includes("consecutive-call limit reached"));
    manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "later-reset", content: [text("Ordinary work")], isError: false, timestamp: Date.now() });
    assert.equal(await invoke(), "Normal findings.");
  } finally {
    delete process.env.MECH_COMPACT_LOOKUP_SESSION_FILE;
  }

  // Results need not exist yet: earlier siblings occupy slots even if the
  // runtime invokes all tools concurrently (or in reverse scheduling order).
  for (const reverse of [false, true]) {
    const batchManager = SessionManager.inMemory(root);
    batchManager.appendMessage(user("Batch request"));
    const ids = Array.from({ length: expected + 2 }, (_, i) => `batch-${i}`);
    batchManager.appendMessage(assistant([
      text("Narration beside the lookup calls must not bypass the cap."),
      ...ids.map((id) => toolCall("context_lookup", { question: "Evidence" }, id)),
    ], "toolUse"));
    const order = reverse ? [...ids].reverse() : ids;
    const batchResults = await Promise.all(order.map(async (id) => [id, toolText(await ext.tools.context_lookup.execute(id, { question: "Evidence" }, undefined, undefined, { ...ctx, sessionManager: batchManager }))]));
    for (const [id, result] of batchResults) {
      assert.equal(result === "Normal findings.", ids.indexOf(id) < expected, "only the first configured number of siblings can run");
    }
  }
};

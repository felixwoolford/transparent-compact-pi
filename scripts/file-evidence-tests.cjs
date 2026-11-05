"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const scenario = require("./reorientation-fixture.cjs");
const { locationId, locationLine } = require('./location-test-helpers.cjs');

module.exports = async function (h) {
  const { ext, SessionManager, root, compact, makeContext, assistant, toolCall, text, user } = h;
  console.log("== File operations stay in conversation; locations are a plain lookup ==");
  const cwd = path.join(root, "file evidence");
  fs.mkdirSync(cwd);
  const manager = SessionManager.inMemory(cwd);
  const ids = [manager.appendMessage(user("Inspect and edit the source"))];
  for (const [name, args, output] of [
    ["read", { path: "source.ts" }, "COMPACTED_SOURCE_OUTPUT"],
    ["write", { path: "source.ts", content: "COMPACTED_WRITE_PAYLOAD" }, "written"],
    ["edit", { path: "source.ts", oldText: "a", newText: "b" }, "edited"],
  ]) {
    ids.push(manager.appendMessage(assistant([toolCall(name, args, name)], "toolUse")));
    ids.push(manager.appendMessage({ role: "toolResult", toolName: name, toolCallId: name,
      content: [text(output)], isError: false, timestamp: 0 }));
  }
  const kept = manager.appendMessage(user("Retained task"));
  const tailCall = manager.appendMessage(assistant([toolCall("read", { path: "source.ts" }, "tail")], "toolUse"));
  const tailResult = manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "tail",
    content: [text("RETAINED_SOURCE_OUTPUT")], isError: false, timestamp: 0 });
  const ctx = makeContext(manager, cwd);
  const c = await compact(ext, ctx, ids, kept, "manual", {
    read: new Set(["metadata-only.md"]), written: new Set(), edited: new Set(["source.ts"]),
  });
  const id = locationId(c, "source.ts");
  assert.equal(locationLine(c, "source.ts"), `${id} "source.ts"`);
  for (const operation of ["read", "write", "edit"])
    assert(c.details.span.lines.some(line => line.includes(`${operation} ${id}`)), "operation context stays in tool stubs");
  for (const content of ["COMPACTED_SOURCE_OUTPUT", "COMPACTED_WRITE_PAYLOAD", "RETAINED_SOURCE_OUTPUT"])
    assert(!c.summary.includes(content), "lookup definitions do not duplicate file contents");
  assert(manager.buildSessionContext().messages.some(message => JSON.stringify(message).includes("RETAINED_SOURCE_OUTPUT")));
  assert(!/<(?:read|modified)-files\b/.test(c.summary));
  assert(!c.summary.includes("metadata-only.md"));
  assert(!c.summary.includes("read in tail"));
  assert(!c.summary.includes("no read-tool output"));
  const next = manager.appendMessage(user("Move the read behind the cut"));
  const repeated = await compact(ext, ctx, [kept, tailCall, tailResult], next);
  assert.equal(locationId(repeated, "source.ts"), id);
  assert.equal(locationLine(repeated, "source.ts"), `${id} "source.ts"`);
  assert(!repeated.summary.includes("metadata-only.md"));

  const metadataOnly = SessionManager.inMemory(cwd);
  const old = metadataOnly.appendMessage(user("Earlier task"));
  const tail = metadataOnly.appendMessage(user("Next task"));
  const empty = await compact(ext, makeContext(metadataOnly, cwd), [old], tail, "manual", {
    read: new Set(["inventory-only.md"]), written: new Set(["inventory-only.ts"]), edited: new Set(),
  });
  assert(!empty.summary.includes("<locations "), "file-operation metadata alone does not create a dictionary");
  assert.deepEqual(empty.details.readFiles, ["inventory-only.md"], "summary-mode metadata is preserved");
  assert.deepEqual(empty.details.modifiedFiles, ["inventory-only.ts"]);
  await runtimeCases(h);
};

async function runtimeCases(h) {
  const { jiti, piRoot, root, SessionManager } = h;
  const { ModelRuntime } = await jiti.import("@earendil-works/pi-coding-agent");
  const { AssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
  const source = "CURRENT_SOURCE_MARKER\n" + "const preserveMe = true;\n".repeat(1300);
  const model = { id: "stub-model", provider: "stub", api: "test", name: "Test model", baseUrl: "http://127.0.0.1:1/never",
    reasoning: false, input: ["text"], contextWindow: 300000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  console.log("== Actual Pi requests: source survives vs only the rewrite plan survives ==");
  for (const sourceSurvives of [false, true]) {
    const cwd = path.join(root, `file-evidence-runtime-${sourceSurvives}`);
    fs.mkdirSync(cwd);
    const manager = SessionManager.inMemory(cwd);
    manager.appendMessage({ role: "user", content: "Modify the existing build script", timestamp: 0 });
    manager.appendMessage(scenario.assistant([scenario.call("write", { path: "build.ts", content: "PREVIOUS_VERSION" }, "initial-write")], "toolUse"));
    manager.appendMessage({ role: "toolResult", toolName: "write", toolCallId: "initial-write", content: [scenario.text("written")], isError: false, timestamp: 0 });
    manager.appendMessage({ role: "user", content: "Extend coverage, preserving existing logic", timestamp: 0 });
    const read = () => {
      manager.appendMessage(scenario.assistant([scenario.call("read", { path: "build.ts" }, "source")], "toolUse"));
      manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "source", content: [scenario.text(source)], isError: false, timestamp: 0 });
    };
    if (!sourceSurvives) read();
    manager.appendMessage(scenario.assistant([{ type: "thinking", thinking: "Rewrite plan; preserve existing sections from context. ".repeat(2200) }]));
    if (sourceSurvives) read();
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.hasConfiguredAuth = () => true;
    runtime.getAuth = async () => ({ auth: { apiKey: "test-only-no-network" } });
    runtime.complete = async () => { throw new Error("Compaction must not call a model"); };
    const requests = [];
    runtime.streamSimple = (_model, context) => {
      requests.push(structuredClone(context));
      const stream = new AssistantMessageEventStream();
      const message = scenario.assistant([scenario.text("Stopped for review.")]);
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    };
    const { session } = await scenario.createSession({ jiti, piRoot, cwd, manager, runtime, model });
    try {
      await session.compact();
      const c = manager.getBranch().findLast((e) => e.type === "compaction");
      assert.equal(locationLine(c, "build.ts"), `${locationId(c, "build.ts")} "build.ts"`);
      await session.prompt("Continue safely");
      assert.equal(requests.length, 1, "test observes delivery, not live-model compliance");
      const request = JSON.stringify(requests[0]);
      assert.equal(request.includes("CURRENT_SOURCE_MARKER"), sourceSurvives, "source retention is unchanged without annotations");
      assert(request.includes("Rewrite plan; preserve existing sections from context."), "the rewrite plan survives in either case");
      assert(request.includes("Before using `write` to replace an existing file, re-read it unless its current contents are already visible in context."));
      assert(request.includes("Do not reconstruct unchanged sections from memory."));
    } finally { session.dispose(); }
  }
}

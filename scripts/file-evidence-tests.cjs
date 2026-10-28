"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { homedir } = require("node:os");
const { pathToFileURL } = require("node:url");
const scenario = require("./reorientation-fixture.cjs");

module.exports = async function (h) {
  const { ext, SessionManager, root, compact, makeContext, assistant, toolCall, text, user, jiti } = h;
  console.log("== File evidence: retained reads/writes, mutations, omissions, and checkpoint-relative labels ==");
  const cwd = path.join(root, "file evidence");
  fs.mkdirSync(cwd);
  const rig = () => {
    const manager = SessionManager.inMemory(cwd);
    const old = manager.appendMessage(user("Earlier modifications"));
    const kept = manager.appendMessage(user("Retained task"));
    let serial = 0;
    const result = (name, id, content, extra = {}) => manager.appendMessage({ role: "toolResult", toolName: name,
      toolCallId: id, content: typeof content === "string" ? [text(content)] : content, isError: false, timestamp: 0, ...extra });
    const op = (name, file, args = {}, content = "tool output", extra = {}) => {
      const id = `evidence-${serial++}`;
      const call = manager.appendMessage(assistant([toolCall(name, { path: file, ...args }, id)], "toolUse"));
      return { call, result: result(name, id, content, extra) };
    };
    const build = async (files, options = {}) => {
      const ctx = { ...makeContext(manager, cwd), ...options.ctx };
      const branchBefore = JSON.stringify(manager.getBranch());
      const value = await ext.handlers.session_before_compact({ branchEntries: manager.getBranch(), reason: "manual",
        preparation: { messagesToSummarize: [manager.getEntry(old).message], turnPrefixMessages: options.prefix ?? [],
          firstKeptEntryId: kept, tokensBefore: 90000,
          fileOps: { read: new Set(options.read ?? []), written: new Set(), edited: new Set(files) } },
      }, ctx);
      assert(value?.compaction);
      assert.equal(JSON.stringify(manager.getBranch()), branchBefore, "annotation does not mutate raw history");
      assert(!value.compaction.summary.includes("current contents NOT in context"));
      assert(!value.compaction.summary.includes("(content removed)"));
      return value.compaction;
    };
    return { manager, old, kept, op, result, build };
  };
  const line = (summary, file) => summary.split("\n").find((s) => s === file || s.startsWith(file + " ("));
  const label = async (r, file, expected, options) => {
    const c = await r.build([file], options);
    assert.equal(line(c.summary, file), `${file} (${expected})`);
    return c;
  };

  // Actual built-in read results: explicit limits need not mean partial output.
  const { createReadTool } = await jiti.import("@earendil-works/pi-coding-agent");
  fs.writeFileSync(path.join(cwd, "small.ts"), "const original = 1;\nconst keep = 2;\n");
  fs.writeFileSync(path.join(cwd, "large.ts"), "very large line\n".repeat(4000));
  const reader = createReadTool(cwd);
  for (const [file, args, expected] of [
    ["small.ts", {}, "full read in tail"],
    ["small.ts", { offset: 1, limit: 9999 }, "full read in tail"],
    ["small.ts", { limit: 1 }, "partial read in tail"],
    ["small.ts", { offset: 2 }, "partial read in tail"],
    ["large.ts", {}, "partial read in tail"],
  ]) {
    const r = rig();
    const read = await reader.execute("actual-read", { path: file, ...args }, new AbortController().signal);
    r.op("read", file, args, read.content, { details: read.details });
    await label(r, file, expected);
  }
  const unknown = rig();
  const changedResult = unknown.op("read", "changed.ts", {}, "ORIGINAL_FULL_SOURCE");
  unknown.manager.appendContextEdit(changedResult.result, { content: "A replacement summary, not the full file." });
  const unknownC = await label(unknown, "changed.ts", "read output in tail");
  assert(!unknown.manager.buildSessionContext().messages.some((m) => JSON.stringify(m).includes("ORIGINAL_FULL_SOURCE")));
  assert(!unknownC.summary.includes("ORIGINAL_FULL_SOURCE"));

  const normal = rig();
  normal.op("read", path.join(cwd, "same.ts"), {}, "SOURCE_STAYS_ONLY_IN_TAIL");
  const normalC = await label(normal, "same.ts", "full read in tail");
  assert(!normalC.summary.includes("SOURCE_STAYS_ONLY_IN_TAIL"), "annotations never duplicate read bodies");
  assert(normalC.summary.includes("as of this checkpoint, not live filesystem state"));
  assert.equal(normalC.summary.split("File lists record earlier operations.").length - 1, 1);

  for (const operation of ["edit", "write"]) {
    const r = rig();
    r.op("read", "modified.ts", {}, "SOURCE");
    r.op(operation, "./modified.ts", operation === "edit" ? { oldText: "a", newText: "b" } : {});
    await label(r, "modified.ts", `read in tail, then ${operation === "edit" ? "edited" : "written"}`);
    r.op("read", "modified.ts", {}, "NEW_SOURCE");
    await label(r, "modified.ts", "full read in tail");
  }
  const written = rig();
  const write = written.op("write", "written.ts", { content: "VISIBLE_FULL_WRITE_PAYLOAD" });
  written.manager.appendContextEdit(write.result, null); // The payload, not the receipt, is the visible evidence.
  await label(written, "written.ts", "write content in tail");
  written.op("edit", "written.ts", { oldText: "VISIBLE", newText: "CHANGED" });
  await label(written, "written.ts", "write in tail, then edited");

  const completeThenPartial = rig();
  completeThenPartial.op("read", "pages.ts", {}, "COMPLETE_SOURCE");
  completeThenPartial.op("read", "pages.ts", { offset: 2 }, "LAST_PAGE");
  await label(completeThenPartial, "pages.ts", "full read in tail");

  for (const target of ["call", "result"]) {
    const r = rig();
    const read = r.op("read", "omitted.ts", {}, "OMITTED_SOURCE");
    r.manager.appendContextEdit(read[target], null);
    await label(r, "omitted.ts", "no read-tool output in tail");
  }
  const renamed = rig();
  const read = renamed.op("read", "original.ts", {}, "SOURCE_FOR_ORIGINAL");
  renamed.manager.appendContextEdit(read.call, { content: [toolCall("read", { path: "different.ts" }, "evidence-0")] });
  const renamedC = await renamed.build(["original.ts", "different.ts"]);
  for (const file of ["original.ts", "different.ts"])
    assert.equal(line(renamedC.summary, file), `${file} (no read-tool output in tail)`);

  const omittedMutation = rig();
  omittedMutation.op("read", "stale.ts", {}, "OLDER_SOURCE");
  const edit = omittedMutation.op("edit", "stale.ts", { oldText: "a", newText: "b" });
  omittedMutation.manager.appendContextEdit(edit.call, null);
  await label(omittedMutation, "stale.ts", "read in tail, then edited");

  const errors = rig();
  errors.op("read", "failed.ts", {}, "NOT_SOURCE", { isError: true });
  errors.op("read", "unknown.ts", {}, "NOT_CONFIRMED", { isError: undefined });
  const errorsC = await errors.build(["failed.ts", "unknown.ts"], { read: ["unrelated.md"] });
  for (const file of ["failed.ts", "unknown.ts"])
    assert.equal(line(errorsC.summary, file), `${file} (no read-tool output in tail)`);
  assert.equal(line(errorsC.summary, "unrelated.md"), "unrelated.md", "unmodified paths do not repeat the negative label per file");
  const readHeader = '<read-files note="reads in compacted history; unless annotated, no retained read-tool output identified">';
  assert.equal(errorsC.summary.split(readHeader).length - 1, 1, "read list states its negative default once");
  assert(errorsC.summary.includes("unannotated paths do not establish content visibility"));

  const duplicates = rig();
  duplicates.manager.appendMessage(assistant([
    toolCall("read", { path: "dup-a.ts" }, "duplicate"), toolCall("read", { path: "dup-b.ts" }, "duplicate"),
  ], "toolUse"));
  duplicates.result("read", "duplicate", "UNATTRIBUTABLE_SOURCE");
  const dupC = await duplicates.build(["dup-a.ts", "dup-b.ts"]);
  assert(!dupC.summary.includes("full read in tail"));

  for (const first of ["read", "write"]) for (const reverse of [false, true]) {
    const r = rig();
    r.manager.appendMessage(assistant([
      toolCall(first, { path: "concurrent.ts", ...(first === "write" ? { content: "WRITTEN_SOURCE" } : {}) }, "parallel-source"),
      toolCall("edit", { path: "concurrent.ts", oldText: "a", newText: "b" }, "parallel-edit"),
    ], "toolUse"));
    const results = [[first, "parallel-source"], ["edit", "parallel-edit"]];
    if (reverse) results.reverse();
    for (const [name, id] of results) r.result(name, id, "SOURCE_OR_RECEIPT");
    await label(r, "concurrent.ts", `${first} in tail; order uncertain`);
    r.op("read", "concurrent.ts", {}, "FRESH_SEQUENTIAL_SOURCE");
    await label(r, "concurrent.ts", "full read in tail");
  }

  const prefix = rig();
  const prefixMessages = [assistant([toolCall("read", { path: "prefix.ts" }, "prefix")], "toolUse"),
    { role: "toolResult", toolName: "read", toolCallId: "prefix", content: [text("COMPACTED_PREFIX_SOURCE")], isError: false, timestamp: 0 }];
  await label(prefix, "prefix.ts", "no read-tool output in tail", { prefix: prefixMessages });

  const nested = rig();
  nested.op("read", "nested.ts", {}, "OLDER_NESTED_SOURCE");
  nested.manager.appendMessage({ role: "toolResult", toolName: "orchestrator", toolCallId: "wrapper",
    content: [text("work done")], isError: false, timestamp: 0, nestedCalls: { complete: true, calls: [
      { id: "wrapper/0", name: "edit", status: "ok", durationMs: 1, arguments: { path: "nested.ts" } },
      { id: "wrapper/1", name: "read", status: "ok", durationMs: 1, arguments: { path: "hidden.ts" } },
    ] } });
  const nestedC = await nested.build(["nested.ts", "hidden.ts"]);
  assert.equal(line(nestedC.summary, "nested.ts"), "nested.ts (read in tail, then edited)");
  assert.equal(line(nestedC.summary, "hidden.ts"), "hidden.ts (no read-tool output in tail)");

  for (const alias of ["@./alias.ts", pathToFileURL(path.join(cwd, "alias.ts")).href]) {
    const r = rig();
    r.op("read", alias, {}, "ALIASED_SOURCE");
    await label(r, "alias.ts", "full read in tail");
  }
  const home = rig();
  home.op("read", "~/source.ts", {}, "HOME_SOURCE");
  const homeC = await home.build([path.join(homedir(), "source.ts")]);
  assert(homeC.summary.includes("(full read in tail)"));

  // Selected startup output survives separately, even though its read is compacted.
  const startupManager = SessionManager.inMemory(cwd);
  startupManager.appendMessage(user("Read the startup instructions"));
  startupManager.appendMessage(assistant([toolCall("read", { path: "START.md" }, "startup")], "toolUse"));
  startupManager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "startup", content: [text("STARTUP_SOURCE")], isError: false, timestamp: 0 });
  const startupKept = startupManager.appendMessage(user("Next task"));
  const startupCtx = { ...makeContext(startupManager, cwd), getSystemPromptOptions: () => ({
    contextFiles: [{ path: path.join(cwd, "AGENTS.md"), content: "Read START.md." }],
  }) };
  const startupC = await compact(ext, startupCtx, startupManager.getBranch().slice(0, -1).map((e) => e.id), startupKept,
    "manual", { read: new Set(), written: new Set(), edited: new Set(["START.md"]) });
  assert(startupC.summary.includes("START.md (startup read output retained in checkpoint or tail; may be partial)"));
  assert(!startupC.summary.includes("START.md (no read-tool output"));

  // A later checkpoint recomputes evidence rather than persisting an old annotation.
  normal.manager.appendCompaction(normalC.summary, normal.kept, normalC.tokensBefore, normalC.details, true);
  const next = normal.manager.appendMessage(user("Move the read behind the cut"));
  const again = await compact(ext, makeContext(normal.manager, cwd),
    normal.manager.getBranch().filter((e) => e.type === "message").slice(1, -1).map((e) => e.id), next);
  assert(again.summary.includes("same.ts (no read-tool output in tail)"));
  assert(!again.summary.includes("same.ts (full read in tail)"));
  assert(!JSON.stringify(again.details).includes("full read in tail"), "visibility labels are not cumulative metadata");

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
      const expected = sourceSurvives ? "full read in tail" : "no read-tool output in tail";
      assert(c.summary.includes(`build.ts (${expected})`));
      assert(!c.summary.includes("; output removed"), "use current compact signatures, not the 0.8.6 stubs");
      await session.prompt("Continue safely");
      assert.equal(requests.length, 1, "test observes delivery, not live-model compliance");
      const request = JSON.stringify(requests[0]);
      assert.equal(request.includes("CURRENT_SOURCE_MARKER"), sourceSurvives, "annotation agrees with actual provider input");
      assert(request.includes("Rewrite plan; preserve existing sections from context."), "the rewrite plan survives in either case");
      assert(request.includes("Before using `write` to replace an existing file, re-read it unless its current contents are already visible in context."));
      assert(request.includes("Do not reconstruct unchanged sections from memory."));
    } finally { session.dispose(); }
  }
}

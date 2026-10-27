"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const scenario = require("./reorientation-fixture.cjs");
const kind = "transparent-compact:reorient";
const heading = "Post-compaction re-orientation — REQUIRED BEFORE CONTINUING.";
const reminders = (messages) => messages.filter((m) => m.role === "custom" && m.customType === kind);
const count = (s, needle) => s.split(needle).length - 1;

function checkChecklist(content) {
  for (const phrase of [heading, "Compaction may have removed information needed to follow the project instructions.",
    "Before planning or performing the next task, you MUST complete this checklist",
    "1. **Re-read every required document IN ITS ENTIRETY.**",
    "For this step, a document is required reading **if and only if** your applicable system prompt, developer instructions, or project instructions",
    "including AGENTS.md / CLAUDE.md) explicitly instruct you to read it.",
    "Merely mentioning or linking a document does not qualify.",
    "Identify all such documents and re-read each from beginning to end", "even if you read them before compaction",
    "Grep matches, selected sections, summaries, and reading only files you intend to edit do NOT satisfy this requirement.",
    "If output is truncated, continue reading until you reach the end.",
    "Complete these reads before planning or changing anything; intending or promising to read does not count.",
    "If a required document is unavailable, report the blocker rather than silently skipping it.",
    "run `git status`", "Re-read any file you are about to modify", "note, not evidence", "do not redo writes",
    "If you cannot verify it", "**Recovery recap.**", "context_lookup", "context_list_entries", "context_grep",
    "context_show_entry", "Do not read raw session JSONL"])
    assert(content.includes(phrase), phrase);
}

function checkEnvelope(summary) {
  assert.equal(count(summary, "**Compacted conversation follows.**"), 1);
  assert(summary.includes("The earlier part of this conversation has been compacted into the checkpoint below."));
  assert(summary.includes("This is not the full transcript"));
  assert(summary.includes("but are preserved in the session and can be recovered"));
  assert(summary.indexOf("**Compacted conversation follows.**") < summary.indexOf("**Recovering dropped details.**"));
  assert(summary.includes("The retained verbatim conversation begins after the explicit boundary marker at the end of this checkpoint."));
  assert(!summary.includes("everything after the last span is uncompacted"));
  assert.equal(count(summary, "**Recovering dropped details.**"), 1);
  assert(summary.indexOf("**Recovering dropped details.**") < summary.indexOf("### Compacted conversation"));
  assert.equal(count(summary, "**Evidence boundary:**"), 1);
  assert(summary.indexOf("**Evidence boundary:**") > summary.lastIndexOf("</compacted-span>"));
  assert(summary.indexOf("**Evidence boundary:**") < summary.lastIndexOf("Conversation"));
  assert(!summary.includes(heading), "checklist is not inside the compacted conversation");
  assert(!summary.includes("**Recovery recap.**"));
}

module.exports = async function (h) {
  const { factory, load, SessionManager, root, compact, makeContext, assistant, text, user, saveSession } = h;
  console.log("== Persistent envelope: recovery header, boundary, post-tail checklist and deduplication ==");
  const cwd = path.join(root, "reorientation");
  fs.mkdirSync(cwd);
  const manager = SessionManager.inMemory(cwd);
  const ext = load(factory, { current: manager });
  const ctx = makeContext(manager, cwd);
  const project = (extension = ext, messages = manager.buildSessionContext().messages) =>
    extension.handlers.context_with_system({ type: "context_with_system", messages }, ctx)?.messages ?? messages;
  const start = (extension = ext) => {
    const result = extension.handlers.before_agent_start({ type: "before_agent_start", messageType: "user" }, ctx);
    if (!result?.message) return;
    const m = result.message;
    return manager.appendCustomMessageEntry(m.customType, m.content, m.display, m.details);
  };
  const old = manager.appendMessage(user("Read the required spec."));
  const kept = manager.appendMessage(assistant([text("Completed work in the retained tail.")]));
  assert.equal(start(), undefined, "no checklist without a verbatim compaction");
  assert.deepEqual(project(), manager.buildSessionContext().messages);
  await ext.handlers.session_before_compact({ preparation: { messagesToSummarize: [user("pending")], turnPrefixMessages: [],
    firstKeptEntryId: kept, tokensBefore: 1000 }, branchEntries: manager.getBranch(), reason: "manual" }, ctx);
  assert.equal(start(), undefined, "preparing/cancelling is not a completed compaction");

  const c1 = await compact(ext, ctx, [old], kept);
  checkEnvelope(c1.summary);
  ext.handlers.session_compact({ compactionEntry: manager.getEntry(c1.id), reason: "manual", willRetry: false }, ctx);
  assert(!manager.getBranch().some((e) => e.type === "custom_message"), "idle compaction waits for the next run, never starts one");
  const task = manager.appendMessage(user("Proceed with the next task."));
  const firstFooter = start();
  assert(firstFooter, "before_agent_start persists the checklist after starting input");
  assert.equal(start(), undefined, "only one message per compaction on the current branch");
  const input = manager.buildSessionContext().messages;
  const output = project();
  assert.deepEqual(output, input, "already correctly placed persisted message needs no rewrite");
  const reminder = reminders(output)[0];
  assert.equal(reminders(output).length, 1);
  assert.equal(output.at(-1), reminder);
  checkChecklist(reminder.content);
  const before = JSON.stringify(manager.getBranch());
  const delta = { role: "system", content: "Late system/tool update", timestamp: 0 };
  const withDelta = [...input, delta];
  const reordered = project(ext, withDelta);
  assert.deepEqual(reordered.slice(0, -1), [...input.slice(0, -1), delta]);
  assert.deepEqual(reordered.at(-1), reminder, "first request ends with checklist after all transforms");
  assert.deepEqual(project(ext, reordered), reordered, "projection is idempotent");
  assert.equal(JSON.stringify(manager.getBranch()), before, "request projection never changes stored history");

  for (const stopReason of ["error", "aborted"]) {
    manager.appendMessage({ ...assistant([], stopReason), errorMessage: "synthetic interruption" });
    assert.deepEqual(project().at(-1), reminder, `${stopReason} still leaves checklist at the resumption point`);
  }
  const pendingLeaf = manager.getLeafId();
  const answer = manager.appendMessage(assistant([text("I have restored the required inputs.")]));
  let active = project();
  assert.equal(reminders(active).length, 1, "checklist survives the first completed response");
  assert.deepEqual(reminders(active)[0], reminder);
  assert(active.indexOf(reminders(active)[0]) < active.findIndex((m) => m.role === "assistant" && m.content.some((b) => b.text === "I have restored the required inputs.")));
  manager.appendMessage(user("Another task."));
  assert.equal(start(), undefined, "later user turns do not add another copy");
  assert.equal(reminders(project()).length, 1);
  const reloaded = load(factory, { current: manager });
  assert.equal(start(reloaded), undefined);
  assert.deepEqual(project(reloaded), project(), "reload retains the persisted checklist");
  const file = path.join(root, "reorientation-resume.jsonl");
  saveSession(manager, file);
  const reopened = SessionManager.open(file);
  const resumedExt = load(factory, { current: reopened });
  const resumed = resumedExt.handlers.context_with_system({ type: "context_with_system", messages: reopened.buildSessionContext().messages }, makeContext(reopened, cwd));
  assert.equal(reminders(resumed?.messages ?? reopened.buildSessionContext().messages).length, 1);
  assert(fs.readFileSync(file, "utf8").includes(kind), "checklist is saved for resume/fork, not transient");

  // A second cut that leaves the OLD checklist in the retained tail.
  const c2 = await compact(ext, ctx, [kept], task, "threshold");
  checkEnvelope(c2.summary);
  assert(manager.buildSessionContext().messages.some((m) => m.role === "custom" && m.details.compactionId === c1.id));
  manager.appendMessage(user("Continue round two."));
  const secondFooter = start();
  active = project();
  assert.equal(reminders(active).length, 1, "old checklist is removed even when retained verbatim by Pi");
  assert.equal(reminders(active)[0].details.compactionId, c2.id);
  assert.equal(active.at(-1), reminders(active)[0]);
  manager.appendMessage(assistant([text("Round two complete.")]));
  assert.equal(reminders(project()).length, 1, "current recovery instructions remain on subsequent turns");

  // A third cut that SUMMARIZES both old managed messages. Ordinary custom
  // messages become stubs; user quotes must not be stripped by string matching.
  const ordinary = manager.appendCustomMessageEntry("ordinary", "CUSTOM_CONTENT_REMOVED", true);
  const quoted = manager.appendMessage(user("Quoted text: **Evidence boundary:** is the label we discussed."));
  const nextTail = manager.appendMessage(user("Third retained tail."));
  const c3 = await compact(ext, ctx, [task, firstFooter, answer, secondFooter, ordinary, quoted], nextTail, "overflow");
  assert.equal(count(c3.summary, "**Recovering dropped details.**"), 1);
  assert(!c3.summary.includes(heading));
  assert(!c3.summary.includes("**Recovery recap.**"));
  assert(c3.summary.includes('[Custom message]: custom(type="ordinary") [content removed — use context_lookup]'));
  assert(!c3.summary.includes("CUSTOM_CONTENT_REMOVED"));
  assert(!JSON.stringify(c3.details.span.lines).includes("CUSTOM_CONTENT_REMOVED"));
  assert(c3.summary.includes("Quoted text: **Evidence boundary:**"), "user prose is not mistaken for generated envelope text");
  assert(!JSON.stringify(c3.details.span.lines).includes(heading));
  assert(start());
  assert.equal(reminders(project()).length, 1);
  assert.equal(reminders(project())[0].details.compactionId, c3.id);
  assert(manager.getBranch().filter((e) => e.type === "custom_message" && e.customType === kind).length >= 3, "original managed messages remain in raw history");

  manager.branch(pendingLeaf);
  assert.equal(reminders(project())[0].details.compactionId, c1.id, "tree navigation follows the selected compaction");
  const verbatimLeaf = manager.getLeafId();
  manager.appendCompaction("Builtin model summary", task, 1000);
  assert.equal(start(), undefined);
  assert.equal(reminders(project()).length, 0, "summary mode does not replay an obsolete managed checklist");
  manager.branch(verbatimLeaf);
  manager.appendCustomEntry("transparent-compact:compaction-method", { method: "summary" });
  assert.equal(reminders(project()).length, 1, "changing only the method setting does not change existing context");

  await runtimeTests(h);
};

async function runtimeTests(h) {
  const { jiti, piRoot, root, SessionManager } = h;
  const { ModelRuntime, estimateTokens } = await jiti.import("@earendil-works/pi-coding-agent");
  const { AssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
  const { Type } = await jiti.import("typebox");
  const model = { id: "stub-model", provider: "stub", api: "test", name: "Test model", baseUrl: "http://127.0.0.1:1/never",
    reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  console.log("== Real Pi requests: ~20k tail, persistent checklist, repeated compaction, automatic and overflow continuation ==");
  for (const mode of ["manual", "pre-run", "threshold", "overflow", "post-run"]) {
    const cwd = path.join(root, `reorientation-runtime-${mode}`);
    const manager = SessionManager.inMemory(cwd);
    const fixture = scenario.seedScenario(manager, cwd);
    if (mode === "pre-run") {
      const last = manager.getLeafEntry().message;
      last.usage = { ...last.usage, input: 90000, totalTokens: 90000 };
    }
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "test-auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.hasConfiguredAuth = () => true;
    runtime.getAuth = async () => ({ auth: { apiKey: "test-only-no-network" } });
    runtime.complete = async () => { throw new Error("Compaction must not call a model"); };
    const tool = { name: "ordinary_work", label: "Work", description: "Test-only work", parameters: Type.Object({}),
      execute: async () => ({ content: [scenario.text("work done")], details: undefined }) };
    let turns = 0;
    const requests = [];
    runtime.streamSimple = (_model, context) => {
      requests.push(structuredClone(context));
      const first = turns++ === 0;
      let message;
      if (first && (mode === "threshold" || mode === "post-run")) {
        message = scenario.assistant(mode === "threshold" ? [scenario.call("ordinary_work", {}, "work")] : [scenario.text("Stage done.")], mode === "threshold" ? "toolUse" : "stop");
        message.usage = { ...message.usage, input: 90000, totalTokens: 90000 };
      } else if (first && mode === "overflow") {
        message = { ...scenario.assistant([], "error"), errorMessage: "maximum context length exceeded" };
      } else if ((first && (mode === "manual" || mode === "pre-run")) || (mode === "threshold" && turns === 2) || (mode === "overflow" && turns === 2)) {
        message = scenario.assistant([scenario.call("ordinary_work", {}, "reorient")], "toolUse");
      } else message = scenario.assistant([scenario.text("Done.")]);
      const stream = new AssistantMessageEventStream();
      if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
      return stream;
    };
    const { session, loaded } = await scenario.createSession({ jiti, piRoot, cwd, manager, runtime, model,
      customTools: [tool], instructions: fixture.instructions,
      settings: { enabled: mode !== "manual", keepRecentTokens: 20000 },
    });
    loaded.extensions[0].handlers.set("context", [({ messages }) => ({ messages: [...messages, {
      role: "custom", customType: "test:late-context", content: "LATE_CONTEXT_TRANSFORM", display: false, timestamp: 0,
    }] })]);
    try {
      if (mode === "manual") await session.compact();
      await session.prompt(scenario.prompt);
      if (mode === "post-run") {
        assert.equal(requests.length, 1, "post-run compaction/checklist must not start an unsolicited response");
        await session.prompt("Start the next stage.");
      }
      const compactions = manager.getBranch().filter((e) => e.type === "compaction");
      assert.equal(compactions.length, 1, mode);
      const c = compactions[0];
      checkEnvelope(c.summary);
      assert.equal(c.details.kind, "mech-compact");
      if (mode === "threshold" || mode === "overflow" || mode === "pre-run") assert.equal(c.details.span.reason, mode === "pre-run" ? "threshold" : mode);
      assert(!c.summary.includes(fixture.token));
      assert(!JSON.stringify(manager.buildSessionContext()).includes(fixture.token), "spec contents really were removed");
      const marked = requests.map((r) => JSON.stringify(r).includes(heading));
      const startsCompacted = mode === "manual" || mode === "pre-run";
      assert.deepEqual(marked, startsCompacted ? [true, true] : mode === "post-run" ? [false, true] : [false, true, true], mode);
      const branch = manager.getBranch();
      const keptIndex = branch.findIndex((e) => e.id === c.firstKeptEntryId);
      const compactIndex = branch.findIndex((e) => e.id === c.id);
      const keptTokens = branch.slice(keptIndex, compactIndex).filter((e) => e.type === "message" && e.message.role !== "system")
        .reduce((n, e) => n + estimateTokens(e.message), 0);
      assert(keptTokens >= 18000 && keptTokens <= 22000, `expected ~20k tokens retained, got ${keptTokens}`);
      const request = requests[startsCompacted ? 0 : 1];
      assert(JSON.stringify(request.messages).includes("state=ready signature=engine-20-41"));
      assert.equal(request.messages.at(-1).role, "user");
      checkChecklist(JSON.stringify(request.messages.at(-1)));
      assert(JSON.stringify(request.messages.at(-2)).includes("LATE_CONTEXT_TRANSFORM"));
      const footers = () => manager.getBranch().filter((e) => e.type === "custom_message" && e.customType === kind);
      assert.equal(footers().length, 1, "one saved checklist, not an ephemeral request-only nudge");
      const firstFooterId = footers()[0].id;
      await session.prompt("Another ordinary task.");
      assert.equal(footers().length, 1, "subsequent tasks retain, rather than re-insert, the checklist");
      assert.equal(count(JSON.stringify(requests.at(-1)), heading), 1);
      assert(!JSON.stringify(requests.at(-1).messages.at(-1)).includes(heading), "completed re-orientation stays in history, not as a new last instruction every turn");

      await session.compact();
      const c2 = manager.getBranch().filter((e) => e.type === "compaction").at(-1);
      checkEnvelope(c2.summary);
      assert(manager.buildSessionContext().messages.some((m) => m.role === "custom" && m.details?.compactionId === c.id), "old checklist deliberately survives in second retained tail");
      await session.prompt("Continue after the second compaction.");
      const secondRequest = requests.at(-1);
      assert.equal(count(JSON.stringify(secondRequest), heading), 1);
      assert.equal(count(JSON.stringify(secondRequest), "**Recovering dropped details.**"), 1);
      assert.equal(count(JSON.stringify(secondRequest), "**Evidence boundary:**"), 1);
      assert.equal(count(JSON.stringify(secondRequest), "**Recovery recap.**"), 1);
      checkChecklist(JSON.stringify(secondRequest.messages.at(-1)));
      assert.equal(footers().length, 2, "raw audit history keeps the old and current managed entries");
      assert(footers().some((e) => e.id === firstFooterId));
      assert.equal(footers().at(-1).details.compactionId, c2.id);
      console.log(`  ${mode}: ${keptTokens} estimated tokens retained; current checklist persists; second envelope has no duplicates`);
    } finally { session.dispose(); }
  }
}

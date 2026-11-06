"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

module.exports = async function ({ factory, load, SessionManager, root, makeContext, user, assistant, text, toolCall, jiti, piRoot, saveSession, searchTool }) {
  console.log("== Turn fidelity: native ordered replay, thinking modes, caps, edits, budgets, persistence and request projection ==");
  const { PREFLAG_ENTRY, AUTO_FILTER_ENTRY, FILTER_REVISION_ENTRY } = await jiti.import(path.resolve(__dirname, "../extensions/lib/turn-filter.ts"));
  const { sessionEntryToContextMessages } = await jiti.import("@earendil-works/pi-coding-agent");
  const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
  const key = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", end: "\x1b[F", home: "\x1b[H" };
  const kb = { matches: (data, action) => data === key[action.split(".").at(-1).replace("confirm", "enter").replace("cancel", "esc")] };
  const interact = (actions) => async (factory) => {
    let done = false, result;
    const component = factory({ terminal: { rows: 26 }, requestRender() {} }, { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s }, kb,
      (value) => { done = true; result = value; });
    const render = (width = 120) => {
      const lines = component.render(width);
      for (const line of lines) assert(visibleWidth(line) <= width);
      return lines.join("\n");
    };
    render();
    for (const action of actions) {
      if (typeof action === "function") action(render());
      else { component.handleInput(key[action] ?? action); for (const width of [1, 8, 42, 120]) render(width); }
    }
    assert(done, "interaction completes"); component.dispose(); return result;
  };
  const cwd = path.join(root, "fidelity"), manager = SessionManager.inMemory(cwd), ref = { current: manager };
  let ext = load(factory, ref);
  manager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  manager.appendCustomEntry(PREFLAG_ENTRY, { timestamp: 123 });
  const u1 = manager.appendMessage(user("USER_TOOLS", 123));
  const longArgs = "ARGUMENT_START" + "payload 漢字 ".repeat(250) + "ARGUMENT_END";
  const output = "OUTPUT_START\n" + "full output\n".repeat(300) + "OUTPUT_END";
  const a1 = manager.appendMessage(assistant([
    { type: "thinking", thinking: "TOOLS_THINKING_SECRET", thinkingSignature: "tools-signed-thinking" }, text("TOOLS_PROSE"),
    toolCall("read", { path: "STARTUP.md", payload: longArgs }, "native-read"),
  ], "toolUse"));
  const r1 = manager.appendMessage({ role: "toolResult", toolCallId: "native-read", toolName: "read", content: [text(output)], isError: false, timestamp: 124 });
  const managed = manager.appendCustomMessageEntry("transparent-compact:reorient", "STALE_MANAGED_CHECKLIST", false, { compactionId: "old" });
  const split = manager.appendMessage(assistant([text("TOOLS_FINAL")]));
  const u2 = manager.appendMessage(user("USER_PROSE"));
  const a2 = manager.appendMessage(assistant([text("PROSE_BETWEEN_NATIVE_TURNS")]));
  const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
  const u3 = manager.appendMessage(user([text("USER_FULL"), image]));
  const a3 = manager.appendMessage(assistant([
    { type: "thinking", thinking: "FULL_THINKING_PRESENT", thinkingSignature: "full-signed-thinking" },
    text("FULL_PROSE"), toolCall("edit", { path: "full.ts", oldText: "old", newText: longArgs }, "native-edit"),
  ], "toolUse"));
  const r3 = manager.appendMessage({ role: "toolResult", toolCallId: "native-edit", toolName: "edit", content: [text("FULL_RESULT"), image], isError: false, timestamp: 125 });
  const tail = manager.appendMessage(user("RECENT_UNCHANGED"));
  const notices = [];
  const model = { id: "stub-model", provider: "stub", api: "test", name: "Test", baseUrl: "http://127.0.0.1:1/never",
    reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let aborts = 0;
  const ctx = { ...makeContext(manager, cwd), model, mode: "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    abort: () => { aborts++; }, getSystemPrompt: () => "Test system prompt.",
    getSystemPromptOptions: () => ({ contextFiles: [{ path: "AGENTS.md", content: "<retain-reads>\nSTARTUP.md\n</retain-reads>" }] }),
    ui: { notify: (...args) => notices.push(args) } };
  const run = async (ids, boundary, reason = "manual") => ext.handlers.session_before_compact({
    reason, signal: new AbortController().signal,
    branchEntries: manager.getBranch(), preparation: { messagesToSummarize: ids.flatMap((id) => sessionEntryToContextMessages(manager.getEntry(id))),
      turnPrefixMessages: [], firstKeptEntryId: boundary, tokensBefore: 10000,
      fileOps: { read: new Set(["STARTUP.md"]), written: new Set(), edited: new Set(["full.ts"]) } },
  }, ctx);
  const persist = (c) => manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
  const project = (session = manager, extension = ext, context = ctx) => {
    const messages = session.buildSessionContext().messages;
    return extension.handlers.context_with_system({ messages }, { ...context, sessionManager: session })?.messages ?? messages;
  };
  const old = (await run([u1, a1, r1, managed], split)).compaction;
  const oldId = persist(old);
  assert(old.summary.includes(output), "startup read is initially retained separately");
  const ordinary = (await run([split, u2, a2, u3, a3, r3], tail)).compaction;
  persist(ordinary);
  const before = JSON.stringify(manager.getBranch());
  ctx.ui.custom = interact(["f", "f", "esc"]);
  await ext.commands["filter-turns"].handler("", ctx);
  assert.equal(JSON.stringify(manager.getBranch()), before, "cancelled mode changes are atomic");
  ctx.ui.custom = interact([
    "right", "down", "f", "f", // The pre-flag starts pruned; cycle to prose, then tools via a child.
    (screen) => assert(screen.includes("[○]") && screen.includes("PROSE+TOOLS") && screen.includes("[Thinking omitted]")), "left", "down", "down", "f", "f",
    (screen) => assert(screen.includes("[■]")), "f", "f", "f", "f", (screen) => assert(screen.includes("[■]")), "right", (screen) => assert(screen.includes("FULL_THINKING_PRESENT")), "left", "down", "f", " ",
    (screen) => assert(screen.includes("[-]") && screen.includes("Locked — in retained recent tail")),
    "enter", (screen) => { assert(screen.includes("PROSE → PROSE+TOOLS")); assert(screen.includes("tokens")); assert(screen.includes("[Thinking omitted]")); },
    "end", (screen) => assert(screen.includes("FULL_RESULT") && screen.includes("[Image attachment: image/png]")), "enter",
  ]);
  await ext.commands["filter-turns"].handler("", ctx);
  const selection = manager.getBranch().at(-1), c = selection.data;
  assert.equal(selection.customType, FILTER_REVISION_ENTRY, JSON.stringify(notices));
  assert.deepEqual(c.fidelity, { [u1]: "tools", [u3]: "full" });
  assert.deepEqual(c.keptAsideTurnIds, [u1], "explicit tools mode overrides automatic aside pruning");
  assert.equal(c.slots.length, 2, "one slot for a turn crossing two compaction spans");
  assert(c.slots[0].offset < c.slots[1].offset);
  assert(!c.summary.includes("TOOLS_PROSE") && !c.summary.includes("ARGUMENT_END") && !c.summary.includes("OUTPUT_END"), "raw content is not duplicated in the checkpoint");
  assert(!c.summary.includes("FULL_THINKING_PRESENT"));
  assert(!c.summary.includes("historical read output retained in a full-fidelity turn"), "native content is not catalogued in per-file annotations");
  assert.equal(JSON.stringify(manager.getBranch().slice(0, -1)), before, "only a revision is appended");
  const checkpointId = selection.id;
  const source = JSON.stringify(manager.getBranch());
  const messages = project(), json = JSON.stringify(messages);
  assert(json.includes("ARGUMENT_END") && json.includes("OUTPUT_END") && json.includes("FULL_RESULT"));
  assert(!json.includes("TOOLS_THINKING_SECRET") && json.includes("[Thinking omitted]"));
  assert(json.includes("FULL_THINKING_PRESENT") && json.includes("full-signed-thinking"));
  assert(!json.includes("STALE_MANAGED_CHECKLIST"));
  assert.equal(json.split("USER_TOOLS").length - 1, 1);
  assert.equal(json.split("OUTPUT_END").length - 1, 1, "no retained-startup-read duplicate");
  const position = (needle) => messages.findIndex((m) => JSON.stringify(m).includes(needle));
  assert(position("USER_TOOLS") < position("PROSE_BETWEEN_NATIVE_TURNS"));
  assert(position("PROSE_BETWEEN_NATIVE_TURNS") < position("USER_FULL"));
  assert(position("USER_FULL") < position("RECENT_UNCHANGED"));
  assert.deepEqual(messages.find((m) => m.role === "toolResult" && m.toolCallId === "native-edit"), manager.getEntry(r3).message);
  assert.deepEqual(messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.text === "USER_FULL")), manager.getEntry(u3).message);
  assert.deepEqual(ext.handlers.context_with_system({ messages }, ctx)?.messages ?? messages, messages, "projection is idempotent");
  assert.equal(JSON.stringify(manager.getBranch()), source);
  const requestLocal = project();
  requestLocal.find((m) => m.role === "toolResult" && m.toolCallId === "native-read").content[0].text = "REQUEST_LOCAL_ONLY";
  requestLocal.find((m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.id === "native-edit")).content.find((b) => b.type === "toolCall").arguments.newText = "REQUEST_LOCAL_ONLY";
  assert.equal(JSON.stringify(manager.getBranch()), source, "later request transforms cannot mutate original native records");
  assert(ext.handlers.before_agent_start({}, ctx).message.content.includes("PROSE+TOOLS/FULL"));

  ext = load(factory, ref);
  assert.deepEqual(project(), messages, "reload preserves the mode choices and message payloads");
  const file = path.join(root, "fidelity-session.jsonl"); saveSession(manager, file);
  const reopened = SessionManager.open(file), resumed = load(factory, { current: reopened });
  assert.deepEqual(project(reopened, resumed), messages, "resume preserves native replay");
  manager.branch(oldId);
  assert(!project().some((m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.id === "native-read")), "abandoned choices do not leak into the old branch");
  manager.branch(checkpointId);
  manager.appendCustomEntry(AUTO_FILTER_ENTRY, { enabled: true });
  const next = manager.appendMessage(user("NEXT_RECENT_TAIL"));
  const later = (await run([tail], next, "threshold")).compaction;
  assert.deepEqual(later.details.fidelity, c.fidelity);
  persist(later);
  assert(JSON.stringify(project()).includes("OUTPUT_END"));
  assert(!later.details.filteredTurnIds, "automatic aside pruning respects explicit fidelity choices");

  // A tiny prose cap cannot trim slots or their native payloads.
  manager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "on", budget: { unit: "chars", value: 500 } });
  const capTail = manager.appendMessage(user("CAP_RECENT_TAIL"));
  const capped = (await run([next], capTail)).compaction;
  assert(capped && capped.details.slots.length === 2);
  const cappedId = persist(capped);
  assert(JSON.stringify(project()).includes("ARGUMENT_END") && JSON.stringify(project()).includes("FULL_THINKING_PRESENT"));
  manager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  const pinHead = manager.getLeafId();

  manager.appendCustomEntry("transparent-compact:compaction-method", { method: "summary" });
  const summaryPrep = { previousSummary: "stale", messagesToSummarize: [manager.getEntry(capTail).message], turnPrefixMessages: [],
    firstKeptEntryId: capTail, fileOps: { read: new Set(), edited: new Set(), written: new Set() } };
  assert.equal(await ext.handlers.session_before_compact({ preparation: summaryPrep, branchEntries: manager.getBranch(), reason: "manual" }, ctx), undefined);
  assert(summaryPrep.previousSummary.includes("OUTPUT_END") && summaryPrep.previousSummary.includes("FULL_THINKING_PRESENT"));
  assert(summaryPrep.previousSummary.includes("[Thinking omitted]") && !summaryPrep.previousSummary.includes("TOOLS_THINKING_SECRET"));
  assert(!summaryPrep.previousSummary.includes("; slot "), "summary compaction consumes expanded text, not placeholders");
  manager.branch(pinHead);

  // Actual request guard must abort explicitly; throwing a hook error alone is not a gate.
  assert.throws(() => project(manager, ext, { ...ctx, model: { ...model, contextWindow: 1000 } }), /Nothing was silently shortened/);
  assert.equal(aborts, 1);
  assert.throws(() => project(manager, ext, { ...ctx, model: { ...model, contextWindow: undefined } }), /context window/);
  assert.equal(aborts, 2);

  // Context replacements/omissions are respected, never recovered behind the user's back.
  manager.appendContextEdit(r1, { content: [text("EXPLICIT_REPLACEMENT_OUTPUT")] });
  const replaced = JSON.stringify(project());
  assert(replaced.includes("EXPLICIT_REPLACEMENT_OUTPUT") && !replaced.includes("OUTPUT_END"));
  const replacementHead = manager.getLeafId();
  manager.appendContextEdit(r1, null);
  assert.throws(() => project(), /incomplete tool-call/);
  assert.equal(aborts, 3);
  // A broken pin remains removable through the UI (including its cost preview).
  ctx.ui.custom = interact([" ", "enter", "enter"]);
  await ext.commands["filter-turns"].handler("", ctx);
  assert(manager.getBranch().at(-1).data.filteredTurnIds.includes(u1));
  assert(!JSON.stringify(project()).includes("TOOLS_PROSE"));
  manager.branch(replacementHead);
  assert(JSON.stringify(project()).includes("EXPLICIT_REPLACEMENT_OUTPUT"));
  manager.branch(pinHead);

  // Corrupt placements cannot turn arbitrary historical text into managed context.
  manager.appendCustomEntry(FILTER_REVISION_ENTRY, { compactionId: cappedId, summary: capped.summary, filteredTurnIds: [], keptAsideTurnIds: [u1],
    fidelity: capped.details.fidelity, slots: capped.details.slots.map((slot, i) => i ? slot : { ...slot, offset: slot.offset + 1 }) });
  assert.throws(() => project(), /placements are inconsistent/);
  manager.branch(pinHead);

  // Standalone upgrades/downgrades leave the compaction count and cut unchanged.
  const count = manager.getBranch().filter((e) => e.type === "compaction").length;
  ctx.ui.custom = interact(["f", "enter", "enter"]); // Tools -> Full.
  await ext.commands["filter-turns"].handler("", ctx);
  assert.equal(manager.getBranch().at(-1).data.fidelity[u1], "full");
  assert(JSON.stringify(project()).includes("TOOLS_THINKING_SECRET"));
  ctx.ui.custom = interact([" ", " ", "down", "down", " ", " ", "enter", (screen) => assert(screen.includes("TOOLS_THINKING_SECRET")), "enter"]);
  await ext.commands["filter-turns"].handler("", ctx);
  assert(!manager.getBranch().at(-1).data.fidelity, "clearing every pin does not fall back to the old compaction's pins");
  assert(!project().some((m) => m.role === "toolResult" && ["native-read", "native-edit"].includes(m.toolCallId)));
  assert(!JSON.stringify(project()).includes("FULL_THINKING_PRESENT"));
  assert.equal(manager.getBranch().filter((e) => e.type === "compaction").length, count);
  assert.equal(manager.getEntry(cappedId).firstKeptEntryId, capTail);
  const beforeOversize = JSON.stringify(manager.getBranch());
  ctx.ui.custom = interact(["f", "enter", "enter"]);
  await ext.commands["filter-turns"].handler("", { ...ctx, model: { ...model, contextWindow: 1000 } });
  assert.equal(JSON.stringify(manager.getBranch()), beforeOversize, "oversized selection saves no checkpoint revision");
  assert(notices.some(([message]) => message.includes("Nothing was silently shortened")));
  // The original thinking and images remain recoverable after every downgrade.
  const recovered = await searchTool(ext, ctx, "show_entry", { id: a1 });
  assert(JSON.stringify(recovered).includes("TOOLS_THINKING_SECRET"));

  console.log("== Actual Pi requests: full-fidelity messages, thinking markers, images and persistent choices ==");
  const fs = require("node:fs"), scenario = require("./reorientation-fixture.cjs");
  const { ModelRuntime } = await jiti.import("@earendil-works/pi-coding-agent");
  const { AssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
  manager.branch(pinHead);
  const runtimeCwd = path.join(root, "fidelity-runtime"); fs.mkdirSync(runtimeCwd);
  const runtime = await ModelRuntime.create({ authPath: path.join(runtimeCwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({ auth: { apiKey: "test-only-no-network" } });
  runtime.complete = async () => { throw new Error("No model call during mode selection"); };
  const requests = [];
  runtime.streamSimple = (_model, context) => {
    requests.push(structuredClone(context));
    const stream = new AssistantMessageEventStream(), message = assistant([text("Done.")]);
    stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
  };
  const { session } = await scenario.createSession({ jiti, piRoot, cwd: runtimeCwd, manager, runtime, model });
  try {
    const ui = { notify() {}, custom: interact(["f", "enter", "enter"]) };
    await session.bindExtensions({ mode: "tui", uiContext: ui });
    await session.prompt("CONTINUE_FIDELITY");
    const request = JSON.stringify(requests.at(-1));
    assert(request.includes("OUTPUT_END") && request.includes("ARGUMENT_END") && request.includes("FULL_THINKING_PRESENT"));
    assert(!request.includes("TOOLS_THINKING_SECRET") && request.includes("[Thinking omitted]"));
    assert(request.includes(image.data));
    assert.equal(requests.at(-1).messages.filter((m) => m.role === "toolResult" && m.toolCallId === "native-read").length, 1);
    const beforeRequests = requests.length;
    await session.prompt("/filter-turns"); // First turn Tools -> Full, no model call.
    assert.equal(requests.length, beforeRequests);
    await session.prompt("CONTINUE_FULL_THINKING");
    assert(JSON.stringify(requests.at(-1)).includes("TOOLS_THINKING_SECRET"));
    // Ordinary compaction also carries the modes, rather than compacting replayed copies again.
    await session.prompt("ADVANCE_BOUNDARY\n" + "Recent useful context. ".repeat(5000));
    await session.compact();
    assert.equal(manager.getBranch().findLast((e) => e.type === "compaction").details.fidelity[u1], "full");
    await session.prompt("CONTINUE_AFTER_NEXT_COMPACTION");
    assert(JSON.stringify(requests.at(-1)).includes("TOOLS_THINKING_SECRET"));
    const errors = [];
    await session.bindExtensions({ mode: "tui", uiContext: ui, onError: (error) => errors.push(error) });
    session.setAutoCompactionEnabled(false);
    const stream = runtime.streamSimple;
    let abortedBeforeDispatch = false;
    runtime.streamSimple = (...args) => {
      if (args[2]?.signal?.aborted) { abortedBeforeDispatch = true; throw new Error("Aborted fixture; no provider dispatch"); }
      return stream(...args);
    };
    const beforeBlocked = requests.length;
    await session.prompt("OVERSIZED_LATER_INPUT " + "x".repeat(model.contextWindow * 4)).catch(() => {});
    assert(abortedBeforeDispatch, "actual Pi operation receives an aborted signal after a budget failure");
    assert.equal(requests.length, beforeBlocked, "an abort-respecting provider dispatches no oversized request");
    assert(errors.some((error) => JSON.stringify(error).includes("Nothing was silently shortened")));
  } finally { session.dispose(); }
};

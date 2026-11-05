"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

module.exports = async function ({ factory, load, SessionManager, root, makeContext, user, assistant, text, toolCall, jiti, piRoot, saveSession }) {
  console.log("== Compact-filtered: ordinary compaction first, shared editor, no-op fallback and independent cancellation ==");
  const { FILTER_MARKER, FILTER_EXPLANATION, PREFLAG_ENTRY, FILTER_REVISION_ENTRY, preflaggedTurns, autoFilterEnabled, filterSpans } = await jiti.import(path.resolve(__dirname, "../extensions/lib/turn-filter.ts"));
  const { capSpans } = await jiti.import(path.resolve(__dirname, "../extensions/lib/checkpoint-cap.ts"));
  const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
  const { sessionEntryToContextMessages, buildSessionProjection } = await jiti.import("@earendil-works/pi-coding-agent");
  const key = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", end: "\x1b[F", home: "\x1b[H" };
  const kb = { matches: (data, action) => data === key[action.split(".").at(-1).replace("confirm", "enter").replace("cancel", "esc")] };
  const interact = (actions) => async (factory) => {
    let settled = false, result;
    const component = factory({ terminal: { rows: 18 }, requestRender() {} },
      { fg: (_color, s) => s, bg: (_color, s) => s, bold: (s) => s }, kb, (value) => { settled = true; result = value; });
    const render = (width = 100) => {
      const lines = component.render(width);
      for (const line of lines) assert(visibleWidth(line) <= width);
      return lines.join("\n");
    };
    for (const width of [1, 8, 42, 100]) render(width);
    for (const action of actions) {
      if (typeof action === "function") action(render());
      else { component.handleInput(key[action] ?? action); render(); }
    }
    assert(settled, "interaction completes"); component.dispose(); return result;
  };
  const cwd = path.join(root, "filtered-project"), manager = SessionManager.inMemory(cwd), ref = { current: manager };
  let ext = load(factory, ref);
  manager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  const first = manager.appendMessage(user("LOW_VALUE_STARTUP"));
  const call = manager.appendMessage(assistant([text("LOW_VALUE_PROSE " + "wide 漢字 👋 ".repeat(50)), toolCall("read", { path: "ASIDE.md" }, "aside-read")], "toolUse"));
  const read = manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "aside-read", content: [text("LOW_VALUE_STARTUP_OUTPUT")], isError: false, timestamp: 0 });
  const split = manager.appendMessage(assistant([text("LOW_VALUE_AFTER_SPLIT"), toolCall("write", { path: "aside-only.ts", content: "PAYLOAD" }, "aside-write")], "toolUse"));
  const write = manager.appendMessage({ role: "toolResult", toolName: "write", toolCallId: "aside-write", content: [text("done")], isError: false, timestamp: 0 });
  const useful = manager.appendMessage(user("USEFUL_USER"));
  const usefulAgent = manager.appendMessage(assistant([text("USEFUL_AGENT"), toolCall("read", { path: "kept.ts" }, "kept-read")], "toolUse"));
  const tail = manager.appendMessage(user("RECENT_TAIL"));
  const notices = [];
  const ctx = { ...makeContext(manager, cwd), mode: "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    getSystemPromptOptions: () => ({ contextFiles: [{ path: "AGENTS.md", content: "<retain-reads>\nASIDE.md\n</retain-reads>" }] }),
    ui: { notify: (...args) => notices.push(args) } };
  const prepare = async (extension, context, session, ids, kept, reason = "manual", fileOps) => extension.handlers.session_before_compact({
    reason, signal: new AbortController().signal, branchEntries: session.getBranch(),
    preparation: { messagesToSummarize: ids.flatMap((id) => sessionEntryToContextMessages(session.getEntry(id))),
      turnPrefixMessages: [], firstKeptEntryId: kept, tokensBefore: 10000,
      fileOps: fileOps ?? { read: new Set(), written: new Set(), edited: new Set() } },
  }, context);
  const compact = async (ids, kept, reason = "manual", fileOps) => {
    const result = await prepare(ext, ctx, manager, ids, kept, reason, fileOps);
    assert(result?.compaction, "ordinary compaction supplies a checkpoint");
    const c = result.compaction;
    const id = manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
    return { ...c, id };
  };
  const edit = async (actions, context = ctx, extension = ext) => {
    context.ui.custom = interact(actions);
    await extension.commands["filter-turns"].handler("", context);
  };
  const project = (extension = ext, session = manager) => {
    const messages = session.buildSessionContext().messages;
    return extension.handlers.context_with_system({ messages }, { ...ctx, sessionManager: session })?.messages ?? messages;
  };
  const summary = () => project().filter((m) => m.role === "compactionSummary").map((m) => m.summary).join("\n");
  const older = await compact([first, call, read], split, "manual", { read: new Set(["ASIDE.md"]), written: new Set(), edited: new Set() });
  assert(older.summary.includes("LOW_VALUE_STARTUP_OUTPUT"));
  assert(older.details.span.turnIds.every((id) => id === first));
  const command = ext.commands["compact-filtered"];

  let requested;
  ctx.compact = (options) => { requested = options; };
  const pending = command.handler("", ctx);
  assert(requested && requested.customInstructions === undefined, "no special compaction instructions or hook protocol");
  requested.onError(new Error("Compaction cancelled")); await pending;
  for (const bad of [{ mode: "rpc" }, { mode: "json" }, { mode: "print" }, { hasUI: false },
    { isIdle: () => false }, { hasPendingMessages: () => true }]) {
    requested = undefined; await command.handler("", { ...ctx, ...bad }); assert.equal(requested, undefined);
  }
  requested = undefined; await command.handler("unexpected", ctx); assert.equal(requested, undefined);
  manager.appendCustomEntry("transparent-compact:compaction-method", { method: "summary" });
  await command.handler("", ctx); assert.equal(requested, undefined);
  manager.branch(older.id);

  // A no-op opens the old checkpoint, but its split turn remains locked.
  ctx.compact = (options) => options.onError(new Error("Already compacted"));
  ctx.ui.custom = interact([" ", "enter", (screen) => assert(screen.includes("No filtering changes")), "esc", "esc"]);
  const beforeLocked = JSON.stringify(manager.getBranch());
  await command.handler("", ctx);
  assert.equal(JSON.stringify(manager.getBranch()), beforeLocked);

  // The new checkpoint is persisted before the picker starts. Escape only
  // cancels the editor, not the already completed compaction.
  let completed;
  ctx.compact = (options) => {
    assert.equal(options.customInstructions, undefined);
    void compact([split, write, useful, usefulAgent], tail, "manual", { read: new Set(["kept.ts"]), written: new Set(["aside-only.ts"]), edited: new Set() })
      .then((c) => { completed = c; options.onComplete(c); }, options.onError);
  };
  ctx.ui.custom = async (factory) => {
    assert(completed && manager.getBranch().at(-1).id === completed.id, "picker sees the committed checkpoint");
    return interact(["esc"])(factory);
  };
  const beforeCompact = JSON.stringify(manager.getBranch());
  await command.handler("", ctx);
  assert.equal(JSON.stringify(manager.getBranch().slice(0, -1)), beforeCompact);
  assert.equal(manager.getBranch().at(-1).id, completed.id);
  assert(completed.summary.includes("LOW_VALUE_AFTER_SPLIT") && !completed.details.filteredTurnIds);
  assert.equal(manager.getBranch().filter((e) => e.customType === FILTER_REVISION_ENTRY).length, 0);

  // Both current Pi no-op outcomes share the same editor, not another compaction.
  ctx.compact = (options) => options.onError(new Error("Nothing to compact (session too small)"));
  ctx.ui.custom = interact(["right", "down", " ", "enter", (screen) => assert(screen.includes("LOW_VALUE_STARTUP")),
    "end", (screen) => { assert(screen.includes("LOW_VALUE_AFTER_SPLIT")); assert(screen.includes("LOW_VALUE_STARTUP_OUTPUT")); },
    "esc", "enter", "home", "enter"]);
  await command.handler("", ctx);
  const filteredRevision = manager.getBranch().at(-1), filteredHead = filteredRevision.id;
  assert.equal(filteredRevision.customType, FILTER_REVISION_ENTRY);
  assert.equal(filteredRevision.data.compactionId, completed.id);
  assert.deepEqual(filteredRevision.data.filteredTurnIds, [first]);
  assert(!summary().includes("LOW_VALUE_PROSE") && !summary().includes("LOW_VALUE_AFTER_SPLIT") && !summary().includes("aside-only.ts"));
  assert(summary().includes("LOW_VALUE_STARTUP_OUTPUT") && summary().includes('filtered-turn="true"'), "explicit read retention survives turn pruning");
  assert(summary().includes("USEFUL_USER") && summary().includes("USEFUL_AGENT") && summary().includes("kept.ts"));
  assert.equal(summary().split(FILTER_MARKER).length - 1, 2, "one explanation plus one positioned marker across spans");
  assert(manager.getEntry(completed.id).summary.includes("LOW_VALUE_AFTER_SPLIT"), "saved checkpoint is not rewritten");
  assert.deepEqual(completed.details.readRetention, older.details.readRetention);
  assert.deepEqual(completed.details.readFiles, ["ASIDE.md", "kept.ts"]);
  assert.deepEqual(completed.details.modifiedFiles, ["aside-only.ts"]);
  assert(ext.handlers.before_agent_start({}, ctx).message.content.includes(FILTER_EXPLANATION));

  // Failures/cancellation must never fall through to editing stale context.
  let unexpectedPickerCalls = 0;
  const noPicker = () => { unexpectedPickerCalls++; throw new Error("picker must not open"); };
  ctx.ui.custom = noPicker;
  const untouched = JSON.stringify(manager.getBranch());
  for (const message of ["Compaction cancelled", "disk failure", "Nothing to compact due to a different error"]) {
    ctx.compact = (options) => options.onError(new Error(message)); await command.handler("", ctx);
    assert.equal(JSON.stringify(manager.getBranch()), untouched);
  }
  const empty = SessionManager.inMemory(cwd);
  await command.handler("", { ...ctx, sessionManager: empty, compact: (options) => options.onError(new Error("Nothing to compact (session too small)")) });
  assert.equal(empty.getBranch().length, 0, "no checkpoint means no no-op fallback");
  ctx.compact = (options) => { requested = options; };
  const branchRace = command.handler("", ctx);
  manager.branch(older.id); requested.onComplete(completed); await branchRace;
  manager.branch(filteredHead);
  let currentSession = manager;
  const switchedContext = { ...ctx, get sessionManager() { return currentSession; } };
  const sessionRace = command.handler("", switchedContext);
  currentSession = empty; requested.onComplete(completed); await sessionRace;
  assert(notices.some(([message]) => message.includes("Session/checkpoint changed")));
  assert.equal(unexpectedPickerCalls, 0, "no picker on failure, cancellation, empty session or session/branch race");

  console.log("== Standalone revisions: persistence, cancellation, raw recovery and subsequent compactions ==");
  const originalTail = project().filter((m) => m.role !== "compactionSummary");
  for (const actions of [["esc"], [" ", "enter", "esc", "esc"]]) {
    const before = JSON.stringify(manager.getBranch()); await edit(actions); assert.equal(JSON.stringify(manager.getBranch()), before);
  }
  ctx.ui.custom = async () => { throw new Error("UI failed"); };
  await ext.commands["filter-turns"].handler("", ctx); assert.equal(JSON.stringify(manager.getBranch()), untouched);
  manager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "warn", budget: { unit: "chars", value: 500 } });
  ctx.ui.select = async (_title, choices) => { assert(choices.includes("Cancel checkpoint update")); return "Cancel checkpoint update"; };
  const beforeCapCancel = JSON.stringify(manager.getBranch());
  await edit([" ", "enter", "enter"]); assert.equal(JSON.stringify(manager.getBranch()), beforeCapCancel);
  manager.branch(filteredHead);
  await edit([" ", "enter", (screen) => assert(screen.includes("Restore: turn")), "enter"]);
  const restoredHead = manager.getLeafId();
  assert(summary().includes("LOW_VALUE_STARTUP_OUTPUT") && summary().includes("aside-only.ts"));
  assert(!summary().includes(FILTER_EXPLANATION));
  assert.deepEqual(project().filter((m) => m.role !== "compactionSummary"), originalTail);
  const compactions = manager.getBranch().filter((e) => e.type === "compaction").length;
  const beforeNoOp = manager.getLeafId(); await edit(["enter", "enter"]); assert.equal(manager.getLeafId(), beforeNoOp);
  assert.equal(manager.getBranch().filter((e) => e.type === "compaction").length, compactions);
  manager.branch(filteredHead);
  ext = load(factory, ref);
  const next = manager.appendMessage(user("NEXT_TAIL"));
  const later = await compact([tail], next, "threshold");
  assert.deepEqual(later.details.filteredTurnIds, [first]);
  assert(!later.summary.includes("LOW_VALUE_PROSE") && later.summary.includes("LOW_VALUE_STARTUP_OUTPUT"));
  const file = path.join(root, "filtered-session.jsonl"); saveSession(manager, file);
  const reopened = SessionManager.open(file), resumed = load(factory, { current: reopened });
  assert(project(resumed, reopened).find((m) => m.role === "compactionSummary").summary.includes("LOW_VALUE_STARTUP_OUTPUT"));
  const recovered = await resumed.tools.context_show_entry.execute("recover", { id: read }, undefined, undefined, { ...ctx, sessionManager: reopened });
  assert(JSON.stringify(recovered).includes("LOW_VALUE_STARTUP_OUTPUT"));
  manager.branch(older.id); assert(!ext.handlers.before_agent_start({}, ctx).message.content.includes(FILTER_EXPLANATION));
  manager.branch(restoredHead);
  const restoredNext = manager.appendMessage(user("RESTORED_NEXT_TAIL"));
  const restoredLater = await compact([tail], restoredNext);
  assert(!restoredLater.details.filteredTurnIds && restoredLater.summary.includes("LOW_VALUE_STARTUP_OUTPUT"));

  // A summary compaction must consume the active revision as well.
  await edit([" ", "enter", "enter"]);
  const activeRevision = manager.getBranch().at(-1);
  manager.appendCustomEntry("transparent-compact:compaction-method", { method: "summary" });
  const summaryPreparation = { previousSummary: "stale", firstKeptEntryId: restoredNext,
    messagesToSummarize: [assistant([toolCall("read", { path: "NEW_SUMMARY_READ.ts" }, "summary-read")])],
    turnPrefixMessages: [], fileOps: { read: new Set(["ASIDE.md", "kept.ts"]), edited: new Set(["aside-only.ts"]), written: new Set() } };
  assert.equal(await ext.handlers.session_before_compact({ preparation: summaryPreparation, branchEntries: manager.getBranch(), reason: "manual" }, ctx), undefined);
  assert.equal(summaryPreparation.previousSummary, activeRevision.data.summary);
  assert.deepEqual([...summaryPreparation.fileOps.read].sort(), ["NEW_SUMMARY_READ.ts", "kept.ts"]);
  assert.equal(summaryPreparation.fileOps.edited.size, 0);

  console.log("== Pre-flags: idle submission, pending cancellation, automatic application and keep overrides ==");
  const asideManager = SessionManager.inMemory(cwd), asideRef = { current: asideManager };
  const asideExt = load(factory, asideRef);
  const asideCtx = { ...ctx, sessionManager: asideManager, ui: { notify: (...args) => notices.push(args) } };
  asideManager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  const appendUser = (value, source = "interactive") => {
    asideExt.handlers.input({ text: value, source }, asideCtx);
    const message = user(value, Date.now()); asideExt.handlers.message_end({ message }, asideCtx);
    return asideManager.appendMessage(message);
  };
  asideRef.sendUserMessage = (content) => appendUser(content, "extension");
  const noMessageLeaf = asideManager.getLeafId();
  assert(!asideExt.commands.aside);
  for (const name of ["filter-later", "fl"]) {
    await asideExt.commands[name].handler("", asideCtx); assert.equal(notices.at(-1)[0], `Usage: /${name} <message>`);
    await asideExt.commands[name].handler("busy", { ...asideCtx, isIdle: () => false });
    await asideExt.commands[name].handler("queued", { ...asideCtx, hasPendingMessages: () => true });
  }
  assert.equal(asideManager.getLeafId(), noMessageLeaf);
  await asideExt.commands["filter-later"].handler("PREFLAGGED_USER", asideCtx);
  const asideUser = asideManager.getLeafId();
  assert.deepEqual([...preflaggedTurns(asideManager.getBranch())], [asideUser]);
  const asideAgent = asideManager.appendMessage(assistant([text("PREFLAGGED_AGENT"), toolCall("read", { path: "ASIDE.md" }, "preflag-read")], "toolUse"));
  const asideRead = asideManager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "preflag-read", isError: false, content: [text("PREFLAGGED_READ_OUTPUT")], timestamp: 0 });
  const asideTail = appendUser("ORDINARY_TAIL");
  const runAside = (ids, kept, reason = "threshold") => prepare(asideExt, asideCtx, asideManager, ids, kept, reason,
    { read: new Set(["ASIDE.md"]), written: new Set(), edited: new Set() });
  const persistAside = (c) => asideManager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
  const defaultOff = (await runAside([asideUser, asideAgent, asideRead], asideTail)).compaction;
  assert(defaultOff.summary.includes("PREFLAGGED_AGENT") && !defaultOff.details.filteredTurnIds);
  const policyLeaf = asideManager.getLeafId();
  for (const value of ["", "invalid", "off"]) await asideExt.commands["filter-auto"].handler(value, asideCtx);
  assert.equal(asideManager.getLeafId(), policyLeaf);
  await asideExt.commands["filter-auto"].handler("on", asideCtx); assert(autoFilterEnabled(asideManager.getBranch()));
  const splitAside = (await runAside([asideUser], asideAgent)).compaction, splitAsideId = persistAside(splitAside);
  assert(!splitAside.details.filteredTurnIds, "never strip half a turn from the recent tail");
  await edit([" ", "enter", "enter"], asideCtx, asideExt);
  assert.deepEqual(asideManager.getBranch().at(-1).data.keptAsideTurnIds, [asideUser]);
  assert.equal(asideManager.getEntry(splitAsideId).firstKeptEntryId, asideAgent);
  asideManager.branch(splitAsideId);
  asideCtx.ui.custom = noPicker;
  for (const reason of ["threshold", "overflow"]) {
    const automatic = (await runAside([asideAgent, asideRead], asideTail, reason)).compaction;
    assert.deepEqual(automatic.details.filteredTurnIds, [asideUser]);
    assert(!automatic.summary.includes("PREFLAGGED_AGENT") && !automatic.summary.includes("PREFLAGGED_USER"));
    assert(automatic.summary.includes("PREFLAGGED_READ_OUTPUT"), "automatic turn pruning also preserves explicitly retained reads");
    const id = persistAside(automatic);
    asideExt.handlers.session_compact({ compactionEntry: asideManager.getEntry(id), willRetry: true }, asideCtx);
    assert(asideManager.getBranch().at(-1).content.includes(FILTER_EXPLANATION));
    asideManager.branch(splitAsideId);
  }
  await edit([" ", "enter", (screen) => assert(screen.includes("Cancel pre-flag")), "enter"], asideCtx, asideExt);
  const kept = (await runAside([asideAgent, asideRead], asideTail)).compaction; persistAside(kept);
  assert(!kept.details.filteredTurnIds && kept.summary.includes("PREFLAGGED_READ_OUTPUT"));
  await edit([" ", "enter", "enter"], asideCtx, asideExt);
  const prunedAsideHead = asideManager.getLeafId();
  assert.deepEqual(asideManager.getBranch().at(-1).data.filteredTurnIds, [asideUser]);
  assert.deepEqual(asideManager.getBranch().at(-1).data.keptAsideTurnIds, []);
  await asideExt.commands["filter-auto"].handler("off", asideCtx);
  const secondTail = appendUser("SECOND_TAIL");
  const disabled = (await runAside([asideTail], secondTail)).compaction; persistAside(disabled);
  assert.deepEqual(disabled.details.filteredTurnIds, [asideUser], "disabling auto does not restore existing pruning");
  await edit([" ", "enter", "enter"], asideCtx, asideExt);
  await asideExt.commands["filter-auto"].handler("on", asideCtx);
  const thirdTail = appendUser("THIRD_TAIL");
  const restored = (await runAside([secondTail], thirdTail, "overflow")).compaction; persistAside(restored);
  assert(!restored.details.filteredTurnIds && restored.summary.includes("PREFLAGGED_AGENT"));
  assert.deepEqual(restored.details.keptAsideTurnIds, [asideUser]);
  const asideFile = path.join(root, "aside-resume.jsonl"); saveSession(asideManager, asideFile);
  const reopenedAside = SessionManager.open(asideFile); assert(autoFilterEnabled(reopenedAside.getBranch()));
  assert.deepEqual(reopenedAside.getBranch().at(-1).details.keptAsideTurnIds, [asideUser]);
  asideManager.branch(prunedAsideHead); assert(autoFilterEnabled(asideManager.getBranch()));
  asideManager.branch(policyLeaf); assert(!autoFilterEnabled(asideManager.getBranch()));
  asideRef.sendUserMessage = (content) => asideExt.handlers.input({ text: content, source: "extension" }, asideCtx);
  await asideExt.commands.fl.handler("UNSENT_ASIDE", asideCtx);
  assert(!preflaggedTurns(asideManager.getBranch()).has(appendUser("AFTER_FAILED_ASIDE")));
  const flagsBefore = [...preflaggedTurns(asideManager.getBranch())];
  asideManager.appendCustomEntry(PREFLAG_ENTRY, { timestamp: -1 }); appendUser("AFTER_ORPHANED_FLAG");
  assert.deepEqual([...preflaggedTurns(asideManager.getBranch())], flagsBefore);

  // Canonical filtering preserves tool indices and raw ownership under edits.
  const spans = [{ lines: ["[User]: aside", "[Tools]: read", "[User]: kept", "[Tools]: bash"], turnIds: ["a", "a", "b", "b"],
    tools: { version: 2, lines: [{ index: 1, calls: [], mergeable: true }, { index: 3, calls: [], mergeable: true }] } },
    { lines: ["[Assistant]: continuation"], turnIds: ["a"] }];
  const beforeSpans = JSON.stringify(spans), filtered = filterSpans(spans, new Set(["a"]));
  assert.deepEqual(filtered.map((s) => s.lines), [[FILTER_MARKER, "[User]: kept", "[Tools]: bash"], []]);
  assert.deepEqual(filtered[0].tools.lines.map((r) => r.index), [2]); assert.equal(JSON.stringify(spans), beforeSpans);
  assert.deepEqual(capSpans(filtered, 0).lines, [[FILTER_MARKER], []]);
  const duplicates = SessionManager.inMemory(cwd);
  duplicates.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  const da = duplicates.appendMessage(user("identical")), aa = duplicates.appendMessage(assistant([text("identical response")]));
  const db = duplicates.appendMessage(user("identical")); duplicates.appendMessage(assistant([text("identical response")]));
  const dt = duplicates.appendMessage(user("duplicate tail")); duplicates.appendContextEdit(aa, { content: [text("explicit replacement")] });
  const projected = buildSessionProjection(duplicates.getBranch()).entries;
  const replacementResult = await ext.handlers.session_before_compact({ reason: "manual", branchEntries: duplicates.getBranch(),
    preparation: { messagesToSummarize: projected.slice(0, projected.findIndex((e) => e.sourceEntry.id === dt)).flatMap((e) => e.messages),
      turnPrefixMessages: [], firstKeptEntryId: dt, tokensBefore: 10000, fileOps: { read: new Set(), edited: new Set(), written: new Set() } } }, { ...ctx, sessionManager: duplicates });
  assert(replacementResult.compaction.summary.includes("explicit replacement"));
  assert.deepEqual(replacementResult.compaction.details.span.turnIds, [da, da, db, db]);

  console.log("== Actual Pi: compact then edit, both no-op paths, cancellation, automatic inheritance and provider requests ==");
  const fs = require("node:fs"), scenario = require("./reorientation-fixture.cjs");
  const { ModelRuntime } = await jiti.import("@earendil-works/pi-coding-agent");
  const { AssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
  const runtimeCwd = path.join(root, "filtered-runtime"); fs.mkdirSync(runtimeCwd);
  const runtimeManager = SessionManager.inMemory(runtimeCwd);
  runtimeManager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  const asideId = runtimeManager.appendMessage(user("RUNTIME_LOW_VALUE_USER"));
  runtimeManager.appendMessage(assistant([text("RUNTIME_LOW_VALUE_AGENT")]));
  runtimeManager.appendMessage(user("RUNTIME_USEFUL_TASK"));
  for (let i = 0; i < 24; i++) runtimeManager.appendMessage(assistant([text(`KEEP_RUNTIME_${i} ` + "Useful retained context. ".repeat(200))]));
  const runtime = await ModelRuntime.create({ authPath: path.join(runtimeCwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.hasConfiguredAuth = () => true; runtime.getAuth = async () => ({ auth: { apiKey: "test-only-no-network" } });
  runtime.complete = async () => { throw new Error("No model call during compact/filter commands"); };
  const requests = [];
  runtime.streamSimple = (_model, context) => {
    requests.push(structuredClone(context));
    const stream = new AssistantMessageEventStream(), message = assistant([text("Done.")]);
    stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
  };
  const model = { id: "stub-model", provider: "stub", api: "test", name: "Test", baseUrl: "http://127.0.0.1:1/never",
    reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const { session } = await scenario.createSession({ jiti, piRoot, cwd: runtimeCwd, manager: runtimeManager, runtime, model });
  try {
    let pickerCalls = 0;
    const runtimeUi = { notify() {}, custom: async (factory) => {
      pickerCalls++;
      assert(runtimeManager.getBranch().some((e) => e.type === "compaction"), "real Pi saved the checkpoint before opening controls");
      assert(session.isIdle, "compaction is no longer busy");
      return interact(["esc"])(factory);
    } };
    await session.bindExtensions({ mode: "tui", uiContext: runtimeUi });
    await session.prompt("/compact-filtered");
    assert.equal(pickerCalls, 1); assert.equal(requests.length, 0);
    const checkpoint = runtimeManager.getBranch().at(-1);
    assert.equal(checkpoint.type, "compaction"); assert(checkpoint.summary.includes("RUNTIME_LOW_VALUE"));
    assert(!checkpoint.details.filteredTurnIds, "Escape leaves an ordinary completed compaction");
    runtimeUi.custom = interact([" ", "enter", "enter"]);
    await session.prompt("/compact-filtered"); // Already compacted, checkpoint is the leaf.
    const revision = runtimeManager.getBranch().at(-1);
    assert.equal(revision.data.compactionId, checkpoint.id); assert.deepEqual(revision.data.filteredTurnIds, [asideId]);
    assert.equal(runtimeManager.getBranch().filter((e) => e.type === "compaction").length, 1);
    runtimeUi.custom = interact(["esc"]);
    await session.prompt("/compact-filtered"); // Nothing to compact, revision is the leaf.
    assert.equal(runtimeManager.getLeafId(), revision.id);
    await session.prompt("Continue the useful task.");
    assert.equal(requests.length, 1);
    assert(!JSON.stringify(requests[0]).includes("RUNTIME_LOW_VALUE"));
    assert(JSON.stringify(requests[0]).includes("KEEP_RUNTIME_23") && JSON.stringify(requests[0]).includes(FILTER_EXPLANATION));

    let unsubscribe;
    const settled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("/fl did not settle")); }, 10000);
      unsubscribe = session.subscribe((event) => { if (event.type === "agent_settled") { clearTimeout(timer); unsubscribe(); resolve(); } });
    });
    await session.prompt("/fl RUNTIME_PREFLAGGED_TURN"); await settled;
    const [runtimeAsideId] = preflaggedTurns(runtimeManager.getBranch()); assert(runtimeAsideId);
    assert(JSON.stringify(requests.at(-1)).includes("RUNTIME_PREFLAGGED_TURN"));
    await session.prompt("USEFUL_BOUNDARY_AFTER_ASIDE");
    for (let i = 0; i < 24; i++) runtimeManager.appendMessage(assistant([text(`KEEP_AFTER_ASIDE_${i} ` + "Useful retained context. ".repeat(200))]));
    const lastAssistant = session.agent.state.messages.findLast((m) => m.role === "assistant");
    lastAssistant.usage = { ...lastAssistant.usage, input: 90000, totalTokens: 90000 }; lastAssistant.timestamp = Date.now() + 1000;
    await session.prompt("/filter-auto on"); session.setAutoCompactionEnabled(true); runtimeUi.custom = noPicker;
    await session.prompt("CONTINUE_AFTER_AUTO_FILTERING");
    const autoCheckpoint = runtimeManager.getBranch().findLast((e) => e.type === "compaction");
    assert.deepEqual(autoCheckpoint.details.filteredTurnIds, [asideId, runtimeAsideId]);
    assert(!JSON.stringify(requests.at(-1)).includes("RUNTIME_PREFLAGGED_TURN"));
    const count = runtimeManager.getBranch().filter((e) => e.type === "compaction").length, requestsBefore = requests.length;
    runtimeUi.custom = interact([" ", "down", "down", "down", " ", "enter", "enter"]);
    await session.prompt("/filter-turns");
    assert.deepEqual(runtimeManager.getBranch().at(-1).data.filteredTurnIds, []);
    assert.deepEqual(runtimeManager.getBranch().at(-1).data.keptAsideTurnIds, [runtimeAsideId]);
    assert.equal(requests.length, requestsBefore); assert.equal(runtimeManager.getBranch().filter((e) => e.type === "compaction").length, count);
    await session.prompt("CONTINUE_AFTER_RESTORATION");
    assert(JSON.stringify(requests.at(-1)).includes("RUNTIME_PREFLAGGED_TURN") && JSON.stringify(requests.at(-1)).includes("RUNTIME_LOW_VALUE"));
    assert(!JSON.stringify(requests.at(-1)).includes(FILTER_EXPLANATION));
    runtimeUi.custom = interact([" ", "enter", "enter"]); await session.prompt("/filter-turns");
    await session.prompt("Advance the normal compaction boundary.\n" + "Additional useful task context. ".repeat(500));
    await session.compact();
    const afterNormal = runtimeManager.getBranch().findLast((e) => e.type === "compaction");
    assert.deepEqual(afterNormal.details.filteredTurnIds, [asideId]);
    assert.deepEqual(afterNormal.details.keptAsideTurnIds, [runtimeAsideId]);

    // Cancellation in phase one does not open phase two, even with a checkpoint.
    session.setAutoCompactionEnabled(false);
    runtimeManager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "warn", budget: { unit: "chars", value: 500 } });
    runtimeManager.appendMessage(user("NEW_CAP_HISTORY"));
    for (let i = 0; i < 24; i++) runtimeManager.appendMessage(assistant([text("New cap history. ".repeat(400))]));
    runtimeManager.appendMessage(user("NEW_CAP_TAIL"));
    const beforeCancel = runtimeManager.getLeafId();
    runtimeUi.custom = noPicker;
    runtimeUi.select = async (_title, choices) => { assert(choices.includes("Cancel compaction")); return "Cancel compaction"; };
    await session.prompt("/compact-filtered"); assert.equal(runtimeManager.getLeafId(), beforeCancel);
    assert.equal(unexpectedPickerCalls, 0, "automatic compaction and cancelled manual compaction never open controls");
  } finally { session.dispose(); }
};

"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

module.exports = async function ({ factory, load, SessionManager, root, makeContext, user, assistant, text, toolCall, jiti, piRoot, saveSession }) {
  console.log("== Manual turn filtering: tree, complete preview, atomic cancellation, persistence and recovery ==");
  const { FILTER_REQUEST, FILTER_MARKER, FILTER_EXPLANATION, PREFLAG_ENTRY, AUTO_FILTER_ENTRY, preflaggedTurns, autoFilterEnabled, filterSpans } = await jiti.import(path.resolve(__dirname, "../extensions/lib/turn-filter.ts"));
  const { capSpans } = await jiti.import(path.resolve(__dirname, "../extensions/lib/checkpoint-cap.ts"));
  const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
  const cwd = path.join(root, "filtered-project");
  const manager = SessionManager.inMemory(cwd), ref = { current: manager };
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
  const ctx = { ...makeContext(manager, cwd), mode: "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    getSystemPromptOptions: () => ({ contextFiles: [{ path: "AGENTS.md", content: "ASIDE.md" }] }) };
  const notices = [];
  ctx.ui = { notify: (...args) => notices.push(args) };
  const run = async (ids, kept, { filtered = false, reason = "manual", signal = new AbortController().signal, fileOps } = {}) => {
    const { sessionEntryToContextMessages } = await jiti.import("@earendil-works/pi-coding-agent");
    return ext.handlers.session_before_compact({ reason, signal, customInstructions: filtered ? FILTER_REQUEST : undefined,
      branchEntries: manager.getBranch(), preparation: { messagesToSummarize: ids.flatMap((id) => sessionEntryToContextMessages(manager.getEntry(id))),
        turnPrefixMessages: [], firstKeptEntryId: kept, tokensBefore: 10000,
        fileOps: fileOps ?? { read: new Set(), written: new Set(), edited: new Set() } } }, ctx);
  };
  const persist = (c) => manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
  const older = (await run([first, call, read], split, { fileOps: { read: new Set(["ASIDE.md"]), written: new Set(), edited: new Set() } })).compaction;
  const olderId = persist(older);
  assert(older.summary.includes("LOW_VALUE_STARTUP_OUTPUT"));
  assert(older.details.span.turnIds.every((id) => id === first));
  assert(!older.summary.includes(FILTER_MARKER) && !older.summary.includes(FILTER_EXPLANATION));
  const oldReorient = ext.handlers.before_agent_start({}, ctx).message;
  assert(!oldReorient.content.includes(FILTER_EXPLANATION));

  let requested;
  ctx.compact = (options) => { requested = options; };
  const command = ext.commands["compact-filtered"];
  await command.handler("", ctx);
  assert.equal(requested.customInstructions, FILTER_REQUEST);
  requested = undefined;
  for (const bad of [
    { mode: "rpc" }, { mode: "json" }, { mode: "print" }, { hasUI: false },
    { isIdle: () => false }, { hasPendingMessages: () => true },
  ]) { await command.handler("", { ...ctx, ...bad }); assert.equal(requested, undefined); }
  await command.handler("unexpected", ctx);
  assert.equal(requested, undefined);
  manager.appendCustomEntry("transparent-compact:compaction-method", { method: "summary" });
  await command.handler("", ctx);
  assert.equal(requested, undefined);
  manager.appendCustomEntry("transparent-compact:compaction-method", { method: "verbatim" });

  // Drive the actual TUI component rather than returning manufactured selections.
  const key = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", end: "\x1b[F", home: "\x1b[H" };
  const kb = { matches: (data, action) => data === key[action.split(".").at(-1).replace("confirm", "enter").replace("cancel", "esc")] };
  let screen = [], renders = 0;
  const interact = (actions, { abort } = {}) => (factory) => new Promise((resolve) => {
    let settled = false;
    const component = factory({ terminal: { rows: 18 }, requestRender: () => { renders++; } }, { fg: (_color, s) => s }, kb,
      (value) => { settled = true; resolve(value); });
    const render = (width = 42) => {
      screen = component.render(width);
      for (const line of screen) assert(visibleWidth(line) <= width, `line fits ${width}: ${line}`);
      return screen.join("\n");
    };
    for (const width of [1, 8, 42, 100]) render(width);
    for (const action of actions) {
      if (typeof action === "function") action({ component, render });
      else { component.handleInput(key[action] ?? action); render(); }
    }
    if (abort) abort();
    assert(settled, "interaction completes");
    component.dispose?.();
  });

  ctx.ui.custom = interact(["enter", "enter"]);
  const noSelection = (await run([split, write, useful, usefulAgent], tail, { filtered: true })).compaction;
  assert(noSelection && !noSelection.details.filteredTurnIds && !noSelection.summary.includes(FILTER_EXPLANATION));

  // A split turn still touching the recent tail cannot be selected.
  ctx.ui.custom = interact([" ", "enter", ({ render }) => assert(render(100).includes("No turns selected")), "esc", "esc"]);
  const unchanged = JSON.stringify(manager.getBranch());
  assert.deepEqual(await run([split], write, { filtered: true }), { cancel: true });
  assert.equal(JSON.stringify(manager.getBranch()), unchanged);
  ctx.ui.custom = interact(["esc"]);
  assert.deepEqual(await run([split, write, useful, usefulAgent], tail, { filtered: true }), { cancel: true });
  assert.equal(JSON.stringify(manager.getBranch()), unchanged);

  const controller = new AbortController();
  ctx.ui.custom = interact([], { abort: () => controller.abort() });
  assert.deepEqual(await run([split, write, useful, usefulAgent], tail, { filtered: true, signal: controller.signal }), { cancel: true });
  assert.equal(JSON.stringify(manager.getBranch()), unchanged);
  ctx.ui.custom = async () => { throw new Error("UI failed"); };
  assert.deepEqual(await run([split, write, useful, usefulAgent], tail, { filtered: true }), { cancel: true });

  ctx.ui.custom = interact([
    "right", "down", " ", // toggling an agent subentry selects its entire user group
    "enter", ({ render }) => { const s = render(100); assert(s.includes("LOW_VALUE_STARTUP")); },
    "end", ({ render }) => { const s = render(100); assert(s.includes("LOW_VALUE_STARTUP_OUTPUT")); assert(s.includes("LOW_VALUE_AFTER_SPLIT")); },
    "esc", "enter", "home", "enter",
  ]);
  const result = await run([split, write, useful, usefulAgent], tail, { filtered: true,
    fileOps: { read: new Set(["kept.ts"]), written: new Set(["aside-only.ts"]), edited: new Set() } });
  assert(result.compaction);
  const c = result.compaction;
  assert.deepEqual(c.details.filteredTurnIds, [first]);
  assert.equal(JSON.stringify(manager.getBranch()), unchanged, "filtering never edits source entries");
  assert.equal(c.summary.split(FILTER_MARKER).length - 1, 2, "one explanatory mention plus one positioned marker across two spans");
  for (const omitted of ["LOW_VALUE_STARTUP", "LOW_VALUE_PROSE", "LOW_VALUE_AFTER_SPLIT", "ASIDE.md", "aside-only.ts"])
    assert(!c.summary.includes(omitted), `excluded: ${omitted}`);
  for (const kept of ["USEFUL_USER", "USEFUL_AGENT", "kept.ts"]) assert(c.summary.includes(kept));
  assert.deepEqual(c.details.startupReads.reads, older.details.startupReads.reads, "canonical startup reads stay available for restoration");
  assert.deepEqual(c.details.readFiles, ["ASIDE.md", "kept.ts"]);
  assert.deepEqual(c.details.modifiedFiles, ["aside-only.ts"], "canonical file operations are reversible, but not visible in the filtered checkpoint");
  assert.equal(c.firstKeptEntryId, tail);
  const filteredId = persist(c);
  assert(manager.buildSessionContext().messages.some((m) => JSON.stringify(m).includes("RECENT_TAIL")));
  assert(ext.handlers.before_agent_start({}, ctx).message.content.includes(FILTER_EXPLANATION));
  assert(renders > 0);

  // A reload and later ordinary/automatic compaction preserve filtering.
  ext = load(factory, ref);
  const next = manager.appendMessage(user("NEXT_TAIL"));
  ctx.ui.custom = () => { throw new Error("ordinary compaction must not open picker"); };
  const later = (await run([tail], next, { reason: "threshold" })).compaction;
  assert(later && later.summary.includes(FILTER_MARKER) && !later.summary.includes("LOW_VALUE_"));
  assert.deepEqual(later.details.filteredTurnIds, [first]);
  persist(later);
  const file = path.join(root, "filtered-session.jsonl");
  saveSession(manager, file);
  const reopened = SessionManager.open(file);
  const resumed = load(factory, { current: reopened });
  assert(resumed.handlers.before_agent_start({}, { ...ctx, sessionManager: reopened }).message.content.includes(FILTER_EXPLANATION));
  const recovered = await resumed.tools.context_show_entry.execute("recover", { id: read }, undefined, undefined, { ...ctx, sessionManager: reopened });
  assert(JSON.stringify(recovered).includes("LOW_VALUE_STARTUP_OUTPUT"), "raw excluded output stays recoverable");
  manager.branch(olderId);
  assert(!ext.handlers.before_agent_start({}, ctx).message.content.includes(FILTER_EXPLANATION), "abandoned filtering does not leak across branches");
  manager.branch(filteredId);
  assert(ext.handlers.before_agent_start({}, ctx).message.content.includes(FILTER_EXPLANATION));

  // Previously filtered groups start checked and can be restored without
  // rewriting any older entry, including startup-read copies and file lists.
  const restoreTail = manager.appendMessage(user("RESTORE_TAIL"));
  const beforeRestore = JSON.stringify(manager.getBranch());
  ctx.ui.custom = interact([" ", "enter", "esc", "esc"]);
  assert.deepEqual(await run([tail], restoreTail, { filtered: true }), { cancel: true });
  assert.equal(JSON.stringify(manager.getBranch()), beforeRestore);
  ctx.ui.custom = interact([" ", "enter", ({ render }) => assert(render(100).includes("Restore: turn")), "enter"]);
  const restored = (await run([tail], restoreTail, { filtered: true })).compaction;
  assert(restored && !restored.details.filteredTurnIds);
  for (const value of ["LOW_VALUE_STARTUP", "LOW_VALUE_AFTER_SPLIT", "LOW_VALUE_STARTUP_OUTPUT", "ASIDE.md", "aside-only.ts"])
    assert(restored.summary.includes(value), `restored: ${value}`);
  assert(!restored.summary.includes(FILTER_MARKER) && !restored.summary.includes(FILTER_EXPLANATION));
  assert.equal(JSON.stringify(manager.getBranch()), beforeRestore);
  persist(restored);
  assert(!ext.handlers.before_agent_start({}, ctx).message.content.includes(FILTER_EXPLANATION));

  console.log("== Aside pre-flags: real user boundaries, opt-in auto filtering, pending undo and restoration overrides ==");
  const asideManager = SessionManager.inMemory(cwd), asideRef = { current: asideManager };
  let asideExt = load(factory, asideRef);
  const asideCtx = { ...ctx, sessionManager: asideManager, mode: "json", hasUI: false,
    ui: { notify: (...args) => notices.push(args), custom: () => { throw new Error("automatic filtering must never open a picker"); } } };
  asideManager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  const appendUser = (value, source = "interactive") => {
    asideExt.handlers.input({ text: value, source }, asideCtx);
    const message = user(value, Date.now());
    asideExt.handlers.message_end({ message }, asideCtx);
    return asideManager.appendMessage(message);
  };
  asideRef.sendUserMessage = (content) => appendUser(content, "extension");
  const noMessageLeaf = asideManager.getLeafId();
  assert(!asideExt.commands.aside, "the old command name is not registered");
  for (const name of ["filter-later", "fl"]) {
    await asideExt.commands[name].handler("", asideCtx);
    assert.equal(notices.at(-1)[0], `Usage: /${name} <message>`);
    await asideExt.commands[name].handler("busy", { ...asideCtx, isIdle: () => false });
    await asideExt.commands[name].handler("queued", { ...asideCtx, hasPendingMessages: () => true });
  }
  assert.equal(asideManager.getLeafId(), noMessageLeaf);
  await asideExt.commands["filter-later"].handler("PREFLAGGED_USER", asideCtx);
  const asideUser = asideManager.getLeafId();
  assert.equal(asideManager.getEntry(asideUser).message.content, "PREFLAGGED_USER");
  assert.deepEqual([...preflaggedTurns(asideManager.getBranch())], [asideUser]);
  const asideAgent = asideManager.appendMessage(assistant([text("PREFLAGGED_AGENT"), toolCall("read", { path: "ASIDE.md" }, "preflag-read")], "toolUse"));
  const asideRead = asideManager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "preflag-read", isError: false, content: [text("PREFLAGGED_READ_OUTPUT")], timestamp: 0 });
  const asideTail = appendUser("ORDINARY_TAIL");
  assert.deepEqual([...preflaggedTurns(asideManager.getBranch())], [asideUser], "ordinary input is not pre-flagged");
  const runAside = async (ids, kept, reason, filtered = false) => {
    const { sessionEntryToContextMessages } = await jiti.import("@earendil-works/pi-coding-agent");
    return asideExt.handlers.session_before_compact({ reason, signal: new AbortController().signal,
      customInstructions: filtered ? FILTER_REQUEST : undefined, branchEntries: asideManager.getBranch(),
      preparation: { messagesToSummarize: ids.flatMap((id) => sessionEntryToContextMessages(asideManager.getEntry(id))),
        turnPrefixMessages: [], firstKeptEntryId: kept, tokensBefore: 10000,
        fileOps: { read: new Set(["ASIDE.md"]), written: new Set(), edited: new Set() } } },
      filtered ? { ...asideCtx, mode: "tui", hasUI: true } : asideCtx);
  };
  const persistAside = (c) => asideManager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
  const defaultOff = (await runAside([asideUser, asideAgent, asideRead], asideTail, "threshold")).compaction;
  assert(defaultOff.summary.includes("PREFLAGGED_AGENT") && !defaultOff.details.filteredTurnIds);
  assert.equal(autoFilterEnabled(asideManager.getBranch()), false);
  const policyLeaf = asideManager.getLeafId();
  await asideExt.commands["filter-auto"].handler("", asideCtx);
  await asideExt.commands["filter-auto"].handler("invalid", asideCtx);
  await asideExt.commands["filter-auto"].handler("off", asideCtx);
  assert.equal(asideManager.getLeafId(), policyLeaf, "queries, invalid policy and unchanged settings do not write state");
  await asideExt.commands["filter-auto"].handler("on", asideCtx);
  assert(autoFilterEnabled(asideManager.getBranch()));
  asideExt = load(factory, asideRef);
  assert(autoFilterEnabled(asideManager.getBranch()), "auto opt-in survives extension reload");
  const splitAside = (await runAside([asideUser], asideAgent, "threshold")).compaction;
  assert(!splitAside.details.filteredTurnIds, "a pre-flag never strips half a turn from the recent tail");
  const splitAsideId = persistAside(splitAside);
  for (const reason of ["threshold", "overflow"]) {
    const automaticallyFiltered = (await runAside([asideAgent, asideRead], asideTail, reason)).compaction;
    assert.deepEqual(automaticallyFiltered.details.filteredTurnIds, [asideUser], reason);
    assert(!automaticallyFiltered.summary.includes("PREFLAGGED_"));
    const autoId = persistAside(automaticallyFiltered);
    asideExt.handlers.session_compact({ compactionEntry: asideManager.getEntry(autoId), willRetry: true }, asideCtx);
    assert(asideManager.getBranch().at(-1).content.includes(FILTER_EXPLANATION), "automatic retry gets conditional reorientation");
    asideManager.branch(splitAsideId);
  }
  // Undo a pending flag while it still overlaps the tail. This explicit keep
  // decision must defeat the original pre-flag on all future auto compactions.
  asideCtx.ui.custom = interact([" ", "enter", ({ render }) => assert(render(100).includes("Cancel pre-flag")), "enter"]);
  const undoPending = (await runAside([asideAgent], asideRead, "manual", true)).compaction;
  assert(!undoPending.details.filteredTurnIds);
  assert.deepEqual(undoPending.details.keptAsideTurnIds, [asideUser]);
  persistAside(undoPending);
  asideCtx.ui.custom = () => { throw new Error("no auto picker"); };
  const keptAside = (await runAside([asideRead], asideTail, "threshold")).compaction;
  assert(keptAside.summary.includes("PREFLAGGED_USER") && keptAside.summary.includes("PREFLAGGED_READ_OUTPUT"));
  assert(!keptAside.details.filteredTurnIds);
  persistAside(keptAside);
  const secondTail = appendUser("SECOND_ASIDE_TAIL");
  asideCtx.ui.custom = interact([" ", "enter", "enter"]);
  const refiltered = (await runAside([asideTail], secondTail, "manual", true)).compaction;
  assert.deepEqual(refiltered.details.filteredTurnIds, [asideUser]);
  assert(!refiltered.details.keptAsideTurnIds, "rechecking removes the keep override");
  const refilteredId = persistAside(refiltered);
  await asideExt.commands["filter-auto"].handler("off", asideCtx);
  const thirdTail = appendUser("THIRD_ASIDE_TAIL");
  const disabled = (await runAside([secondTail], thirdTail, "threshold")).compaction;
  assert.deepEqual(disabled.details.filteredTurnIds, [asideUser], "turning auto off does not silently restore an existing exclusion");
  persistAside(disabled);
  asideCtx.ui.custom = interact([" ", "enter", "enter"]);
  const fourthTail = appendUser("FOURTH_ASIDE_TAIL");
  const restoredAside = (await runAside([thirdTail], fourthTail, "manual", true)).compaction;
  assert(!restoredAside.details.filteredTurnIds);
  assert.deepEqual(restoredAside.details.keptAsideTurnIds, [asideUser]);
  assert(restoredAside.summary.includes("PREFLAGGED_READ_OUTPUT"));
  persistAside(restoredAside);
  await asideExt.commands["filter-auto"].handler("on", asideCtx);
  const fifthTail = appendUser("FIFTH_ASIDE_TAIL");
  const keptAfterRestore = (await runAside([fourthTail], fifthTail, "overflow")).compaction;
  assert(!keptAfterRestore.details.filteredTurnIds && keptAfterRestore.summary.includes("PREFLAGGED_AGENT"));
  persistAside(keptAfterRestore);
  const asideFile = path.join(root, "aside-resume.jsonl");
  saveSession(asideManager, asideFile);
  const reopenedAside = SessionManager.open(asideFile);
  assert(autoFilterEnabled(reopenedAside.getBranch()));
  assert.deepEqual(reopenedAside.getBranch().findLast((e) => e.type === "compaction").details.keptAsideTurnIds, [asideUser]);
  asideManager.branch(refilteredId);
  assert(autoFilterEnabled(asideManager.getBranch()), "policy changes on an abandoned branch do not leak");
  asideManager.branch(policyLeaf);
  assert.equal(autoFilterEnabled(asideManager.getBranch()), false);

  // Failed or consumed input must not flag a later unrelated prompt.
  asideRef.sendUserMessage = (content) => asideExt.handlers.input({ text: content, source: "extension" }, asideCtx);
  await asideExt.commands.fl.handler("UNSENT_ASIDE", asideCtx);
  const afterFailure = appendUser("USER_AFTER_FAILED_ASIDE");
  assert(!preflaggedTurns(asideManager.getBranch()).has(afterFailure));
  const flagsBefore = [...preflaggedTurns(asideManager.getBranch())];
  asideManager.appendCustomEntry(PREFLAG_ENTRY, { timestamp: -1 });
  const unrelated = appendUser("USER_AFTER_ORPHANED_MARKER");
  assert.deepEqual([...preflaggedTurns(asideManager.getBranch())], flagsBefore);
  assert(!preflaggedTurns(asideManager.getBranch()).has(unrelated));

  // Pure filtering reindexes tools, never mutates canonical data, and markers
  // survive even the destructive cap. Reused text cannot spoof turn ownership.
  const spans = [{ lines: ["[User]: aside", "[Tools]: read", "[User]: kept", "[Tools]: bash"],
    turnIds: ["a", "a", "b", "b"], tools: { version: 2, lines: [{ index: 1, calls: [], mergeable: true }, { index: 3, calls: [], mergeable: true }] } },
    { lines: ["[Assistant]: aside continuation"], turnIds: ["a"] }];
  const before = JSON.stringify(spans);
  const filtered = filterSpans(spans, new Set(["a"]));
  assert.deepEqual(filtered.map((s) => s.lines), [[FILTER_MARKER, "[User]: kept", "[Tools]: bash"], []]);
  assert.deepEqual(filtered[0].tools.lines.map((r) => r.index), [2]);
  assert.equal(JSON.stringify(spans), before);
  assert.deepEqual(capSpans(filtered, 0).lines, [[FILTER_MARKER], []]);

  // Ownership uses raw user boundaries even for identical messages and
  // projected replacements; no content-based user-turn guessing is allowed.
  const duplicateManager = SessionManager.inMemory(cwd);
  duplicateManager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  const duplicateA = duplicateManager.appendMessage(user("identical user"));
  const duplicateAssistant = duplicateManager.appendMessage(assistant([text("identical assistant")]));
  const duplicateB = duplicateManager.appendMessage(user("identical user"));
  duplicateManager.appendMessage(assistant([text("identical assistant")]));
  const duplicateTail = duplicateManager.appendMessage(user("duplicate tail"));
  duplicateManager.appendContextEdit(duplicateAssistant, { content: [{ type: "text", text: "explicit replacement" }] });
  const { buildSessionProjection } = await jiti.import("@earendil-works/pi-coding-agent");
  const projected = buildSessionProjection(duplicateManager.getBranch()).entries;
  const duplicateResult = await ext.handlers.session_before_compact({ reason: "manual", signal: new AbortController().signal,
    branchEntries: duplicateManager.getBranch(), preparation: { messagesToSummarize: projected.slice(0, projected.findIndex((e) => e.sourceEntry.id === duplicateTail)).flatMap((e) => e.messages),
      turnPrefixMessages: [], firstKeptEntryId: duplicateTail, tokensBefore: 10000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() } } }, { ...ctx, sessionManager: duplicateManager });
  assert.deepEqual(duplicateResult.compaction.details.span.turnIds, [duplicateA, duplicateA, duplicateB, duplicateB]);
  assert(duplicateResult.compaction.summary.includes("explicit replacement"));

  console.log("== Actual Pi filtered compaction and post-compaction provider request ==");
  const fs = require("node:fs");
  const scenario = require("./reorientation-fixture.cjs");
  const { ModelRuntime } = await jiti.import("@earendil-works/pi-coding-agent");
  const { AssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
  const runtimeCwd = path.join(root, "filtered-runtime");
  fs.mkdirSync(runtimeCwd);
  const runtimeManager = SessionManager.inMemory(runtimeCwd);
  runtimeManager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  const asideId = runtimeManager.appendMessage(user("RUNTIME_LOW_VALUE_USER"));
  runtimeManager.appendMessage(assistant([text("RUNTIME_LOW_VALUE_AGENT")]));
  runtimeManager.appendMessage(user("RUNTIME_USEFUL_TASK"));
  for (let i = 0; i < 24; i++) runtimeManager.appendMessage(assistant([text(`KEEP_RUNTIME_${i} ` + "Useful retained context. ".repeat(200))]));
  const runtime = await ModelRuntime.create({ authPath: path.join(runtimeCwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.hasConfiguredAuth = () => true;
  runtime.getAuth = async () => ({ auth: { apiKey: "test-only-no-network" } });
  runtime.complete = async () => { throw new Error("No model call during filtered compaction"); };
  const requests = [];
  runtime.streamSimple = (_model, context) => {
    requests.push(structuredClone(context));
    const stream = new AssistantMessageEventStream(), message = assistant([text("Done.")]);
    stream.push({ type: "done", reason: "stop", message }); stream.end(message);
    return stream;
  };
  const model = { id: "stub-model", provider: "stub", api: "test", name: "Test", baseUrl: "http://127.0.0.1:1/never",
    reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const { session } = await scenario.createSession({ jiti, piRoot, cwd: runtimeCwd, manager: runtimeManager, runtime, model });
  try {
    const runtimeUi = { notify() {}, custom: interact([" ", "enter", "enter"]) };
    await session.bindExtensions({ mode: "tui", uiContext: runtimeUi });
    await session.compact(FILTER_REQUEST);
    const checkpoint = runtimeManager.getBranch().findLast((e) => e.type === "compaction");
    assert.deepEqual(checkpoint.details.filteredTurnIds, [asideId]);
    assert(!checkpoint.summary.includes("RUNTIME_LOW_VALUE"));
    assert(checkpoint.summary.includes(FILTER_MARKER));
    await session.prompt("Continue the useful task.");
    assert.equal(requests.length, 1);
    const request = JSON.stringify(requests[0]);
    assert(!request.includes("RUNTIME_LOW_VALUE"));
    assert(request.includes("KEEP_RUNTIME_23"));
    assert(request.includes(FILTER_EXPLANATION));
    assert(JSON.stringify(requests[0].messages.at(-1)).includes(FILTER_EXPLANATION), "conditional guidance is delivered after the tail");
    assert(runtimeManager.getEntry(asideId).message.content.includes("RUNTIME_LOW_VALUE"));

    // Exercise the real /fl alias's asynchronous input/message persistence,
    // then automatic threshold compaction and restoration in provider requests.
    let unsubscribe;
    const settled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("/fl did not settle")); }, 10000);
      unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_settled") { clearTimeout(timer); unsubscribe(); resolve(); }
      });
    });
    await session.prompt("/fl RUNTIME_PREFLAGGED_TURN");
    await settled;
    const runtimeFlagged = [...preflaggedTurns(runtimeManager.getBranch())];
    assert.equal(runtimeFlagged.length, 1);
    const runtimeAsideId = runtimeFlagged[0];
    assert.equal(runtimeManager.getEntry(runtimeAsideId).message.content[0].text, "RUNTIME_PREFLAGGED_TURN");
    assert(JSON.stringify(requests.at(-1)).includes("RUNTIME_PREFLAGGED_TURN"), "asides participate normally before compaction");
    await session.prompt("USEFUL_BOUNDARY_AFTER_ASIDE");
    assert.deepEqual([...preflaggedTurns(runtimeManager.getBranch())], runtimeFlagged);
    for (let i = 0; i < 24; i++) runtimeManager.appendMessage(assistant([text(`KEEP_AFTER_ASIDE_${i} ` + "Useful retained context. ".repeat(200))]));
    const lastAssistant = session.agent.state.messages.findLast((m) => m.role === "assistant");
    lastAssistant.usage = { ...lastAssistant.usage, input: 90000, totalTokens: 90000 };
    // The shared assistant fixture uses a fixed historical epoch. Pi correctly
    // ignores usage predating its latest checkpoint, so advance this test clock.
    lastAssistant.timestamp = Date.now() + 1000;
    await session.prompt("/filter-auto on");
    session.setAutoCompactionEnabled(true);
    runtimeUi.custom = () => { throw new Error("automatic compaction cannot open the picker"); };
    await session.prompt("CONTINUE_AFTER_AUTO_FILTERING");
    const autoCheckpoint = runtimeManager.getBranch().findLast((e) => e.type === "compaction");
    assert.equal(autoCheckpoint.details.span.reason, "threshold");
    assert.deepEqual(autoCheckpoint.details.filteredTurnIds, [asideId, runtimeAsideId]);
    assert(!JSON.stringify(requests.at(-1)).includes("RUNTIME_PREFLAGGED_TURN"));
    assert(JSON.stringify(requests.at(-1)).includes("KEEP_AFTER_ASIDE_23"));
    await session.prompt("Advance the next normal compaction boundary.\n" + "Additional useful task context. ".repeat(500));
    runtimeUi.custom = interact([" ", "down", "down", "down", " ", "enter", "enter"]);
    await session.compact(FILTER_REQUEST);
    const restoredCheckpoint = runtimeManager.getBranch().findLast((e) => e.type === "compaction");
    assert(!restoredCheckpoint.details.filteredTurnIds);
    assert.deepEqual(restoredCheckpoint.details.keptAsideTurnIds, [runtimeAsideId]);
    await session.prompt("CONTINUE_AFTER_RESTORATION");
    const restoredRequest = JSON.stringify(requests.at(-1));
    assert(restoredRequest.includes("RUNTIME_PREFLAGGED_TURN") && restoredRequest.includes("RUNTIME_LOW_VALUE"));
    assert(!restoredRequest.includes(FILTER_EXPLANATION), "stale filtered reorientation is removed on restoration");
  } finally { session.dispose(); }
};

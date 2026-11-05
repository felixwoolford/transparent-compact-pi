"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { stripVTControlCharacters: plain } = require("node:util");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const key = { down: "\x1b[B", up: "\x1b[A", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", end: "\x1b[F", home: "\x1b[H" };
const kb = { matches: (data, action) => data === key[action.split(".").at(-1).replace("confirm", "enter").replace("cancel", "esc")] };
const theme = { fg: (color, s) => color === "error" ? `\x1b[31m${s}\x1b[39m` : s, bg: (_c, s) => s, bold: (s) => s };

module.exports = async function (h) {
  const { jiti, factory, load, SessionManager, root, makeContext, user, assistant, text, toolCall } = h;
  const { pickFilteredTurns, FILTER_EXPLANATION, FILTER_MARKER } = await jiti.import(path.resolve(__dirname, "../extensions/lib/turn-filter.ts"));
  const { messageTokens, contextReserve, checkpointContextMessages, retainedTailMessages } = await jiti.import(path.resolve(__dirname, "../extensions/lib/turn-context.ts"));
  const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
  const { sessionEntryToContextMessages } = await jiti.import("@earendil-works/pi-coding-agent");
  console.log("== Live context readout: asynchronous updates, stale-result suppression, failures, resize and lifecycle ==");
  const pending = [], renders = { count: 0 };
  const estimate = (selection) => new Promise((resolve, reject) => pending.push({ selection, resolve, reject }));
  const turns = [{ id: "turn", label: "[User]: A task", lines: ["[User]: A task", "[Assistant]: Agent detail"] },
    { id: "locked", label: "[User]: Recent tail", lines: [], unavailable: "in retained recent tail" }];
  let finished = false;
  const tui = { terminal: { rows: 26 }, requestRender: () => { renders.count++; } };
  await pickFilteredTurns({ ui: { custom: async (create) => {
    const component = create(tui, theme, kb, () => { finished = true; });
    const render = (width = 100) => {
      const lines = component.render(width);
      for (const line of lines) { assert(visibleWidth(line) <= width); if (width >= 8) assert.equal(visibleWidth(line), width); }
      assert(lines.length <= tui.terminal.rows);
      return lines.join("\n");
    };
    const press = (name) => component.handleInput(key[name] ?? name);
    const readout = () => render().split("\n").filter((line) => /Estimated context:|Est\. ~|Net Δ|Size limit/.test(line));
    const value = (tokens, delta = 0, window = 100000) => ({ tokens, delta, contextWindow: window, reserve: 8192,
      headroom: window ? window - tokens - 8192 : undefined, tailTokens: 17321 });
    assert(render().includes("calculating tokens"));
    await tick(); assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].selection, { pruned: [], fidelity: {} });
    pending[0].resolve(value(10000)); await tick();
    assert(render().includes("~10,000 / 100,000 tokens (10.0%)"));
    assert(render().includes("free 81,808") && render().includes("reserve 8,192"));
    assert(render().includes("incl. ~17,321 tail"));
    assert(!render().includes("cap warn") && !render().includes("Size limit"));
    for (const rows of [10, 18, 32]) for (const width of [1, 8, 24, 42, 80, 120]) {
      tui.terminal.rows = rows; render(width);
    }
    tui.terminal.rows = 26;
    component.invalidate(); press("right"); press("down"); press("left"); press("down"); press("f"); press(" "); press("up");
    await tick(); assert.equal(pending.length, 1, "navigation, theme invalidation and locked controls do not rebuild estimates");
    const savedReadout = readout();
    press(" ");
    assert.deepEqual(readout(), savedReadout, "pending recalculation retains the last values and styling, without a loading flash");
    assert(!render().includes("calculating tokens") && render().includes("Prune — replace this whole turn with a marker"));
    await tick();
    assert.deepEqual(readout(), savedReadout, "the readout stays stable even when estimation takes longer than a render");
    assert.deepEqual(pending[1].selection.pruned, ["turn"]);
    press("f"); await tick(); // Pruned -> prose, leaving the preceding request unresolved.
    pending[2].resolve(value(12000, 2000)); await tick();
    assert(render().includes("~12,000") && render().includes("Δ +2,000"));
    pending[1].resolve(value(70000, 60000)); await tick();
    assert(render().includes("~12,000") && !render().includes("~70,000"), "an old estimate cannot replace the current one");
    press("f"); await tick(); // Prose -> tools.
    assert.deepEqual(pending[3].selection.fidelity, { turn: "tools" });
    pending[3].resolve({ ...value(110000, 100000), shortening: "confirmation" }); await tick();
    const over = render();
    assert(over.includes("OVER 18,192") && over.includes("\x1b[31m"), "reserve-aware overflow is highlighted");
    assert(over.includes("Size limit shortened this preview; saving asks for confirmation."));
    press("enter");
    assert(render().includes("2/2 Review") && render().includes("~110,000"));
    press("esc"); assert(render().includes("1/2 Select") && render().includes("~110,000"));
    await tick(); assert.equal(pending.length, 4, "review/back uses the same readout without another calculation");
    const readyBudgetReadout = readout();
    press("f"); await tick();
    assert.deepEqual(readout(), readyBudgetReadout, "pending updates retain warning color and row count as well as values");
    pending[4].reject(new Error("Unavailable \x1b[2J old native record")); await tick();
    assert(render().includes("Estimated context: unavailable") && !render().includes("\x1b[2J"));
    press(" "); await tick();
    pending[5].resolve({ ...value(8000, -2000),
      noticeDelta: { pruning: 137, revision: 34, fidelity: 0 }, shortening: "automatic" }); await tick();
    assert(render().includes("~8,000"), "a failed estimate can recover on the next mode change");
    const scaffoldingLine = plain(render()).split("\n").find((line) => line.includes("scaffolding"));
    assert(scaffoldingLine?.includes("Estimated context:") && scaffoldingLine.includes("tail · +~171 scaffolding"),
      "the combined scaffolding cost follows the tail on the estimated-context line");
    assert(!plain(render()).split("\n").find((line) => line.includes("Net Δ"))?.includes("scaffolding"));
    assert(render(80).includes("tail · +~171 scaffolding"), "compact formatting accounts for the inline scaffolding width");
    assert(!render().includes("reply/framing") && !render().includes("Notes ") && !render().includes("checkpoint update"));
    assert.equal(render().split("\n").filter((line) => line.includes("scaffolding")).length, 1);
    for (const rows of [10, 16, 18, 32]) for (const width of [1, 8, 24, 42, 80, 120]) { tui.terminal.rows = rows; render(width); }
    tui.terminal.rows = 26;
    press("f"); await tick();
    pending[6].resolve({ tokens: 8000, reserve: 8192 }); await tick();
    assert(render().includes("~8,000 tokens") && render().includes("window unknown") && render().includes("Δ unknown"));
    press("f"); await tick();
    const late = pending[7], beforeClose = renders.count;
    press("esc"); component.dispose();
    late.resolve(value(20000)); await tick();
    assert.equal(renders.count, beforeClose, "closing the dialog discards pending results without rendering");
  } } }, turns, new AbortController().signal, estimate);
  assert(finished);

  console.log("== Whole-context estimates: actual cap rendering, active schemas, native payloads, startup deduplication and no writes ==");
  const activeTool = { name: "active", description: "Active tool schema", parameters: { type: "object", properties: { query: { type: "string" } } } };
  const inactiveTool = { name: "inactive", description: "UNUSED_SCHEMA".repeat(10000), parameters: { type: "object" } };
  const wrapped = (api) => factory({ ...api, getActiveTools: () => [activeTool.name], getAllTools: () => [activeTool, inactiveTool] });
  const manager = SessionManager.inMemory(path.join(root, "readout")), ext = load(wrapped, { current: manager });
  const capEntry = (mode, value = 80000) => manager.appendCustomEntry("transparent-compact:cap-compaction", { mode, budget: { unit: "chars", value } });
  capEntry("off");
  manager.appendMessage({ role: "system", content: "OBSOLETE_SYSTEM".repeat(10000), timestamp: 0 });
  const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
  const first = manager.appendMessage(user([text("EARLY_USER"), image]));
  const call = manager.appendMessage(assistant([{ type: "thinking", thinking: "THINKING ".repeat(2500) }, text("Native prose"),
    toolCall("read", { path: "STARTUP.md", payload: "FULL_ARGS ".repeat(700) }, "readout-read")], "toolUse"));
  const output = manager.appendMessage({ role: "toolResult", toolCallId: "readout-read", toolName: "read", content: [text("READ_OUTPUT ".repeat(1200))], isError: false, timestamp: 0 });
  const middle = manager.appendMessage(user("MIDDLE_USER"));
  const prose = manager.appendMessage(assistant([text("PROSE_WEIGHT " + "P".repeat(40000))]));
  const tail = manager.appendMessage(user("RECENT_TAIL " + "R".repeat(10000)));
  manager.appendContextEdit(tail, { content: [text("TAIL_REPLACED")] });
  manager.appendCustomMessageEntry("transparent-compact:reorient", "STALE_CHECKLIST".repeat(10000), false, { compactionId: "old" });
  manager.appendMessage({ role: "bashExecution", command: "ignored", output: "EXCLUDED_BASH".repeat(10000), exitCode: 0, excludeFromContext: true, timestamp: 0 });
  let dialogs = 0;
  const notices = [];
  const ctx = { ...makeContext(manager, manager.getCwd()), mode: "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    model: { id: "stub-model", provider: "stub", contextWindow: 500000, maxTokens: 4096 }, abort() { throw new Error("Unexpected abort"); },
    getSystemPrompt: () => "SYSTEM_WEIGHT " + "S".repeat(6000),
    getSystemPromptOptions: () => ({ contextFiles: [{ path: "AGENTS.md", content: "<retain-reads>\nSTARTUP.md\n</retain-reads>" }] }),
    ui: { notify: (...args) => notices.push(args), select: () => { dialogs++; throw new Error("Preview must not prompt"); } } };
  const prepared = await ext.handlers.session_before_compact({ reason: "manual", signal: new AbortController().signal,
    branchEntries: manager.getBranch(), preparation: {
      messagesToSummarize: [first, call, output, middle, prose].flatMap((id) => sessionEntryToContextMessages(manager.getEntry(id))),
      turnPrefixMessages: [], firstKeptEntryId: tail, tokensBefore: 10000,
      fileOps: { read: new Set(["STARTUP.md"]), written: new Set(), edited: new Set() },
    } }, ctx);
  assert(prepared.compaction);
  const c = prepared.compaction;
  manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
  assert.throws(() => checkpointContextMessages(c.summary, [], {}, manager.getBranch(), "missing"), /retained context boundary/);
  const system = { role: "system", content: ctx.getSystemPrompt(), toolsAdded: [activeTool], timestamp: 0 };
  const actualTokens = () => {
    const reminder = { ...ext.handlers.before_agent_start({}, ctx).message, role: "custom", timestamp: 0 };
    const input = [system, ...manager.buildSessionContext().messages.filter((m) => m.role !== "system"), reminder];
    const projected = ext.handlers.context_with_system({ messages: input }, ctx)?.messages ?? input;
    assert(!JSON.stringify(projected).includes("STALE_CHECKLIST"));
    return messageTokens(projected);
  };
  const tokenCount = (screen) => {
    const match = screen.match(/Estimated context: ~([\d,]+) \/ 500,000 tokens/);
    assert(match, screen); return Number(match[1].replaceAll(",", ""));
  };
  const ui = (scenario) => async (create) => {
    let result, done = false;
    const component = create({ terminal: { rows: 26 }, requestRender() {} }, theme, kb, (value) => { result = value; done = true; });
    const render = () => plain(component.render(120).join("\n"));
    const press = async (name) => { component.handleInput(key[name] ?? name); await tick(); return render(); };
    try { await scenario({ component, render, press }); assert(done); return result; }
    finally { component.dispose(); }
  };
  const baseline = actualTokens();
  const measuredTail = messageTokens(retainedTailMessages(manager.getBranch(), tail));
  let fullSize, fullDelta;
  const before = JSON.stringify(manager.getBranch()), noticeCount = notices.length;
  ctx.ui.custom = ui(async ({ render, press }) => {
    await tick(); assert.equal(tokenCount(render()), baseline, "unchanged selection uses the actual saved checkpoint, not a hypothetical rebuild");
    assert(render().includes(`incl. ~${measuredTail.toLocaleString()} tail`), "the actual tail is measured, not a hard-coded retention target");
    const pruned = tokenCount(await press(" ")); assert(pruned > 0, "independently retained reads still contribute after pruning");
    assert.equal(tokenCount(await press(" ")), baseline);
    const tools = tokenCount(await press("f"));
    fullSize = tokenCount(await press("f")); assert(fullSize > tools, "recorded thinking contributes to FULL but not PROSE+TOOLS");
    fullDelta = fullSize - baseline;
    assert(render().includes(`Δ +${fullDelta.toLocaleString()}`));
    assert(render().includes(`free ${(500000 - fullSize - contextReserve(ctx)).toLocaleString()}`));
    assert.equal(JSON.stringify(manager.getBranch()), before, "live native estimates do not persist any state");
    assert.equal(notices.length, noticeCount, "readout builds emit no notifications");
    await press("enter"); assert.equal(tokenCount(render()), fullSize, "review keeps the same whole-context count");
    await press("enter");
  });
  await ext.commands["filter-turns"].handler("", ctx);
  assert.equal(actualTokens(), fullSize, `readout matches the saved revision's actual projected input: ${JSON.stringify(notices)}`);
  assert.equal(dialogs, 0);
  const fullHead = manager.getLeafId();

  // Warn-mode previews passively assume applying the current cap, without opening
  // chooseCapBudget or making any persistence changes. Cap-on must predict the same result.
  capEntry("warn", 5000);
  const beforeWarn = JSON.stringify(manager.getBranch());
  let cappedSize;
  ctx.ui.custom = ui(async ({ render, press }) => {
    await tick(); assert.equal(tokenCount(render()), fullSize);
    await press(" "); await press(" ");
    cappedSize = tokenCount(render()); assert(cappedSize < baseline, "the estimate applies the prose cap rather than summing uncapped turn sizes");
    assert(render().includes("Size limit shortened this preview; saving asks for confirmation."));
    assert(!render().includes("cap warn"));
    assert.equal(dialogs, 0); assert.equal(JSON.stringify(manager.getBranch()), beforeWarn);
    await press("esc");
  });
  await ext.commands["filter-turns"].handler("", ctx);
  assert.equal(JSON.stringify(manager.getBranch()), beforeWarn);
  capEntry("on", 5000);
  ctx.ui.custom = ui(async ({ render, press }) => {
    await tick(); await press(" "); await press(" "); assert.equal(tokenCount(render()), cappedSize);
    await press("enter"); await press("enter");
  });
  await ext.commands["filter-turns"].handler("", ctx);
  assert.equal(actualTokens(), cappedSize);
  assert(manager.getBranch().at(-1).data.summary.includes('trimmed="true"'));
  assert.equal(dialogs, 0);

  // A broken original pin has no honest baseline delta, but removing it can still
  // produce a complete new estimate. Never invent a zero-token baseline.
  manager.branch(fullHead);
  manager.appendContextEdit(output, null);
  const broken = JSON.stringify(manager.getBranch());
  ctx.ui.custom = ui(async ({ render, press }) => {
    await tick(); assert(render().includes("Estimated context: unavailable"));
    await press(" "); assert(tokenCount(render()) > 0 && render().includes("Δ unknown"));
    await press("esc");
  });
  await ext.commands["filter-turns"].handler("", ctx);
  assert.equal(JSON.stringify(manager.getBranch()), broken);

  console.log("== Small-turn pruning: net savings, measured notices, quoted guidance and distinct user boundaries ==");
  const small = SessionManager.inMemory(path.join(root, "small-prune"));
  const smallExt = load(wrapped, { current: small });
  small.appendCustomEntry("transparent-compact:cap-compaction", { mode: "warn", budget: { unit: "chars", value: 80000 } });
  const smallUserText = "First turn " + "a".repeat(385), smallReply = "Reply " + "b".repeat(320);
  assert.equal(smallUserText.length + smallReply.length, 722);
  const smallUser = small.appendMessage(user(smallUserText));
  const smallAssistant = small.appendMessage(assistant([text(smallReply)]));
  const secondUser = small.appendMessage(user("SECOND_GROUP_USER_UNIQUE"));
  const secondAssistant = small.appendMessage(assistant([text("SECOND_GROUP_REPLY_UNIQUE\n" + FILTER_EXPLANATION)]));
  const smallTail = small.appendMessage(user("TAIL_DIFFERENT_FROM_RETENTION_TARGET ".repeat(70)));
  const smallCtx = { ...ctx, cwd: small.getCwd(), sessionManager: small, ui: { ...ctx.ui } };
  const initial = await smallExt.handlers.session_before_compact({ reason: "manual", signal: new AbortController().signal,
    branchEntries: small.getBranch(), preparation: {
      messagesToSummarize: [smallUser, smallAssistant, secondUser, secondAssistant].flatMap((id) => sessionEntryToContextMessages(small.getEntry(id))),
      turnPrefixMessages: [], firstKeptEntryId: smallTail, tokensBefore: 10000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    } }, smallCtx);
  const original = initial.compaction;
  small.appendCompaction(original.summary, original.firstKeptEntryId, original.tokensBefore, original.details, true);
  const groupLines = original.details.span.lines.filter((_line, index) => original.details.span.turnIds[index] === smallUser);
  assert.equal(groupLines.length, 2, "a group ends at the next raw user boundary");
  const grossSaving = Math.ceil((groupLines.reduce((n, line) => n + line.length + 1, 0) - FILTER_MARKER.length - 1) / 4);
  const signedCount = (sign, digits) => (sign === "−" ? -1 : 1) * Number(digits.replaceAll(",", ""));
  let firstNotes;
  smallCtx.ui.custom = ui(async ({ render, press }) => {
    await tick(); assert(!render().includes("scaffolding"), "unchanged context has no added scaffolding indicator");
    assert(!render().includes("Size limit"), "warn policy alone does not imply shortening");
    assert(render().includes(`incl. ~${messageTokens(retainedTailMessages(small.getBranch(), smallTail)).toLocaleString()} tail`));
    await press(" ");
    const screen = render();
    const note = screen.match(/([+−])~([\d,]+) scaffolding/);
    const net = screen.match(/Net Δ ([+−])([\d,]+)/);
    assert(note && net, screen);
    firstNotes = signedCount(note[1], note[2]);
    assert(screen.split("\n").some((line) => line.includes("Estimated context:") && line.includes("tail ·") && line.includes("scaffolding")),
      "overhead follows the tail on the estimated-context line");
    assert(Math.abs((firstNotes - signedCount(net[1], net[2])) - grossSaving) <= 1,
      "net change reconciles with removed turn/marker content plus measured notice overhead");
    assert(!screen.includes("Size limit"), "a small prune does not activate the size limit");
    await press("enter");
    assert(!render().includes("SECOND_GROUP_USER_UNIQUE") && !render().includes("SECOND_GROUP_REPLY_UNIQUE"),
      "pruning one turn does not show the next user turn as deleted");
    await press("enter");
  });
  await smallExt.commands["filter-turns"].handler("", smallCtx);
  const smallRevision = small.getBranch().at(-1);
  assert.deepEqual(smallRevision.data.filteredTurnIds, [smallUser]);
  assert(smallRevision.data.summary.includes("SECOND_GROUP_USER_UNIQUE") && smallRevision.data.summary.includes(FILTER_EXPLANATION));
  assert(firstNotes > 0);
  smallCtx.ui.custom = ui(async ({ render, press }) => {
    await tick(); assert(!render().includes("scaffolding"), "existing scaffolding is not labelled as newly added");
    const restored = await press(" ");
    const removed = restored.match(/([+−])~([\d,]+) scaffolding/), net = restored.match(/Net Δ ([+−])([\d,]+)/);
    assert(removed && net && removed[1] === "−", restored);
    assert(Math.abs(signedCount(net[1], net[2]) - signedCount(removed[1], removed[2]) - grossSaving) <= 1,
      "restoring the last prune removes guidance without adding the update notice again");
    await press("esc");
  });
  await smallExt.commands["filter-turns"].handler("", smallCtx);
};

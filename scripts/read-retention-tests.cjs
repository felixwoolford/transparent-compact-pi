"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function ({ factory, load, SessionManager, root, makeContext, assistant, toolCall, text, user, saveSession, jiti }) {
  console.log("== Explicit read retention: defaults, episodes, edits, tail/native deduplication and independent turn filtering ==");
  const { readCatalog, episodeCoverage, readMode } = await jiti.import(path.resolve(__dirname, "../extensions/lib/read-retention.ts"));
  const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
  const cwd = path.join(root, "retained-reads"); fs.mkdirSync(cwd);
  const declaration = "Mentioned.md is merely mentioned.\n<retain-reads>\ndocs/SPEC.md\nlatest: GUIDE.md\na guide.md\nREPLACED.md\nOMIT.md\nFAILED.md\nIMAGE.md\nDUP.md\nWRONG.md\nUNKNOWN.md\nCALL-OMITTED.md\n</retain-reads>";
  const sources = [{ path: path.join(cwd, "AGENTS.md"), content: declaration }];
  function rig(manager = SessionManager.inMemory(cwd), contextFiles = sources) {
    const notices = [], ext = load(factory, { current: manager });
    const ctx = { ...makeContext(manager, cwd), mode: "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
      getSystemPromptOptions: () => ({ contextFiles }), ui: { notify: (message) => notices.push(message) } };
    let counter = manager.getBranch().length;
    const append = (m) => manager.appendMessage(m);
    const call = (file, args = {}, name = "read", id = `read-${counter++}`) => {
      const entry = append(assistant([toolCall(name, { path: file, ...args }, id)], "toolUse")); return { entry, id };
    };
    const result = (id, value, isError = false, name = "read", details) => append({ role: "toolResult", toolCallId: id, toolName: name,
      isError, content: typeof value === "string" ? [text(value)] : value, timestamp: 0, details });
    const read = (file, value, args = {}) => { const c = call(file, args); return result(c.id, value); };
    const compact = async (kept) => {
      const entries = manager.getBranch(), previous = entries.findLast((e) => e.type === "compaction");
      const start = previous ? entries.findIndex((e) => e.id === previous.firstKeptEntryId) : 0;
      const end = entries.findIndex((e) => e.id === kept);
      const response = await ext.handlers.session_before_compact({ branchEntries: entries, reason: "manual", signal: new AbortController().signal,
        preparation: { messagesToSummarize: entries.slice(start, end).filter((e) => e.type === "message").map((e) => e.message),
          turnPrefixMessages: [], firstKeptEntryId: kept, tokensBefore: 90000,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() } } }, ctx);
      assert(response?.compaction, JSON.stringify(notices));
      const c = response.compaction, id = manager.appendCompaction(c.summary, kept, c.tokensBefore, c.details, true);
      return { ...c, id };
    };
    const project = () => {
      const messages = manager.buildSessionContext().messages;
      return ext.handlers.context_with_system({ messages }, ctx)?.messages ?? messages;
    };
    return { manager, ctx, notices, ext, append, call, result, read, compact, project };
  }
  // Providers may serialize omitted optional arguments as null. These are
  // successful ordinary reads, including batched calls, not invalid ranges.
  const nullable = rig(); nullable.append(user("Read with nullable arguments"));
  nullable.append(assistant([
    toolCall("read", { path: "docs/SPEC.md", offset: 1, limit: null }, "null-spec"),
    toolCall("read", { path: "GUIDE.md", offset: null, limit: null }, "null-guide"),
  ], "toolUse"));
  nullable.result("null-spec", "NULL_SPEC_CONTENT");
  nullable.result("null-guide", "NULL_GUIDE_FIRST");
  nullable.read("GUIDE.md", "NULL_GUIDE_LATEST", { offset: null, limit: null });
  nullable.read("null-pages", "a\nb\n\n[1 more lines in file. Use offset=3 to continue.]", { offset: null, limit: 2 });
  nullable.read("null-pages", "c", { offset: 3, limit: null });
  for (const limit of [0, -1, 1.5, "2", false]) nullable.read("invalid-limit", "INVALID_LIMIT_CONTENT", { limit });
  const nullCatalog = readCatalog(nullable.manager.getBranch(), cwd);
  assert.equal(nullCatalog.length, 3, "null means omitted; other invalid limits remain excluded");
  const nullGuide = nullCatalog.find((f) => f.path.endsWith("/GUIDE.md"));
  assert.equal(nullGuide.episodes.length, 2);
  assert.equal(nullGuide.episodes[0].reads[0].offset, 1);
  assert.equal(nullGuide.episodes[0].reads[0].limit, undefined);
  assert.equal(episodeCoverage(nullGuide.episodes[0]), "full");
  const nullPages = nullCatalog.find((f) => f.path.endsWith("/null-pages"));
  assert.equal(nullPages.episodes.length, 1);
  assert.equal(nullPages.episodes[0].reads.length, 2);
  assert.equal(episodeCoverage(nullPages.episodes[0]), "full");
  const nullTail = nullable.append(user("Tail")), nullCheckpoint = await nullable.compact(nullTail);
  assert(nullCheckpoint.summary.includes("NULL_SPEC_CONTENT") && nullCheckpoint.summary.includes("NULL_GUIDE_LATEST"));
  assert(!nullCheckpoint.summary.includes("NULL_GUIDE_FIRST"));

  const r = rig();
  const owner = r.append(user("First task"));
  const page1 = "SPEC_PAGE_ONE\n  whitespace  \n\n[2 more lines in file. Use offset=3 to continue.]";
  const page2 = "SPEC_PAGE_TWO\nend";
  const p1 = r.read("docs/SPEC.md", page1, { limit: 2 });
  r.append(assistant([text("Continue reading the document.")]));
  const p2 = r.read("./docs/SPEC.md", page2, { offset: 3 });
  r.read("GUIDE.md", "GUIDE_FIRST");
  r.read("Mentioned.md", "NOT_EXPLICITLY_RETAINED");
  r.read("a guide.md", "SPACED_PATH_CONTENT");
  r.read("nested/AGENTS.md", "<retain-reads>\nEXTRA.md\n</retain-reads>");
  r.read("nested/EXTRA.md", "NESTED_CONTENT");
  const omitted = r.read("OMIT.md", "OMITTED_CONTENT"); r.manager.appendContextEdit(omitted, null);
  const replaced = r.read("REPLACED.md", "OLD_CONTENT"); r.manager.appendContextEdit(replaced, { content: "REPLACEMENT_CONTENT" });
  const failed = r.call("FAILED.md"); r.result(failed.id, "FAILED_CONTENT", true);
  const unknown = r.call("UNKNOWN.md");
  r.append({ role: "toolResult", toolCallId: unknown.id, toolName: "read", content: [text("UNKNOWN_CONTENT")], timestamp: 0 });
  r.read("IMAGE.md", [text("IMAGE_CONTENT"), { type: "image", data: "IMAGE_BYTES", mimeType: "image/png" }]);
  r.call("DUP.md", {}, "read", "duplicate"); r.call("DUP.md", {}, "read", "duplicate"); r.result("duplicate", "AMBIGUOUS_CONTENT");
  const wrong = r.call("WRONG.md"); r.result(wrong.id, "WRONG_TOOL_CONTENT", false, "bash");
  const omittedCall = r.call("CALL-OMITTED.md"); r.result(omittedCall.id, "OMITTED_CALL_CONTENT"); r.manager.appendContextEdit(omittedCall.entry, null);
  r.append(user("Second task"));
  r.read("docs/SPEC.md", "SPEC_LATER");
  r.read("GUIDE.md", "GUIDE_LATEST");
  const tail = r.append(user("Tail"));
  const first = await r.compact(tail);
  const catalog = readCatalog(r.manager.getBranch(), cwd), spec = catalog.find((f) => f.path.endsWith("/docs/SPEC.md"));
  assert.equal(spec.episodes.length, 2);
  assert.deepEqual(spec.episodes[0].reads.map((read) => read.entryId), [p1, p2]);
  assert.equal(episodeCoverage(spec.episodes[0]), "full");
  for (const value of [page1, page2, "GUIDE_LATEST", "SPACED_PATH_CONTENT", "NESTED_CONTENT", "REPLACEMENT_CONTENT"])
    assert(first.summary.includes(value), value);
  for (const value of ["SPEC_LATER", "GUIDE_FIRST", "NOT_EXPLICITLY_RETAINED", "OMITTED_CONTENT", "OLD_CONTENT", "FAILED_CONTENT", "UNKNOWN_CONTENT", "IMAGE_CONTENT", "IMAGE_BYTES", "AMBIGUOUS_CONTENT", "WRONG_TOOL_CONTENT", "OMITTED_CALL_CONTENT"])
    assert(!first.summary.includes(value), value);
  assert(!JSON.stringify(first.details.readRetention).includes(page1), "selection metadata does not duplicate raw outputs");
  assert(first.summary.indexOf("### Retained reads") > first.summary.lastIndexOf("</compacted-span>"));
  assert(first.summary.indexOf("### Retained reads") < first.summary.indexOf("**Evidence boundary:**"));

  const file = path.join(root, "read-retention-resume.jsonl"); saveSession(r.manager, file);
  const resumed = rig(SessionManager.open(file));
  resumed.read("GUIDE.md", "GUIDE_AFTER_RESUME");
  const next = resumed.append(user("Next tail")), repeated = await resumed.compact(next);
  assert(repeated.summary.includes(page1) && repeated.summary.includes("GUIDE_AFTER_RESUME"));
  assert.equal(repeated.summary.split(page1).length - 1, 1);
  r.manager.branch(p1);
  const alternateTail = r.append(user("Different task")), alternate = await r.compact(alternateTail);
  assert(alternate.summary.includes(page1) && !alternate.summary.includes(page2), "only the active branch supplies read candidates");

  // A split episode can cross the checkpoint boundary without duplicating its tail page.
  const split = rig(); split.append(user("Long task"));
  split.read("docs/SPEC.md", page1, { limit: 2 });
  const splitCall = split.call("docs/SPEC.md", { offset: 3 }); split.result(splitCall.id, page2);
  const splitCheckpoint = await split.compact(splitCall.entry);
  assert(splitCheckpoint.summary.includes(page1) && !splitCheckpoint.summary.includes(page2));
  assert.equal(JSON.stringify(split.project()).split("SPEC_PAGE_TWO").length - 1, 1);
  const splitTail = split.append(user("Next task")), splitAgain = await split.compact(splitTail);
  assert(splitAgain.summary.includes(page1) && splitAgain.summary.includes(page2));

  const latestTail = rig(); latestTail.append(user("Read guide"));
  latestTail.read("GUIDE.md", "GUIDE_OLDER_SNAPSHOT");
  const guideCall = latestTail.call("GUIDE.md"); latestTail.result(guideCall.id, "GUIDE_IN_TAIL");
  const latestCheckpoint = await latestTail.compact(guideCall.entry);
  assert(!latestCheckpoint.summary.includes("GUIDE_OLDER_SNAPSHOT") && !latestCheckpoint.summary.includes("GUIDE_IN_TAIL"));
  assert.equal(JSON.stringify(latestTail.project()).split("GUIDE_IN_TAIL").length - 1, 1, "LATEST follows a read into the tail without retaining an older extra snapshot");

  const fallback = rig(undefined, []);
  delete fallback.ctx.getSystemPromptOptions;
  fallback.ctx.getSystemPrompt = () => `<project_instructions path="${path.join(cwd, "AGENTS.override.md")}">\n<retain-reads>\nGUIDE.md\n</retain-reads>\n</project_instructions>`;
  fallback.append(user("Read")); fallback.read("GUIDE.md", "FALLBACK_EXPLICIT_CONTENT");
  const fallbackTail = fallback.append(user("Tail"));
  assert((await fallback.compact(fallbackTail)).summary.includes("FALLBACK_EXPLICIT_CONTENT"));

  console.log("== Read episodes: adjacency, gaps, overlaps, mutations, errors and actual coverage ==");
  const e = rig(undefined, []); e.append(user("Ranges"));
  e.read("ranges", "a\nb\n\n[8 more lines in file. Use offset=3 to continue.]", { limit: 2 });
  e.read("ranges", "b\nc\n\n[7 more lines in file. Use offset=4 to continue.]", { offset: 2, limit: 2 });
  e.read("ranges", "gap", { offset: 9, limit: 1 }); // gap starts a new episode
  e.call("ranges", { edits: [] }, "edit");
  e.read("ranges", "after edit", { offset: 10 });
  e.append(user("New user boundary"));
  e.read("ranges", "new turn", { offset: 11 });
  e.read("ranges", "restart", { offset: 1, limit: 1 });
  const bad = e.call("ranges", { offset: 2 }); e.result(bad.id, "failure", true);
  e.read("ranges", "after error", { offset: 2 });
  const episodes = readCatalog(e.manager.getBranch(), cwd)[0].episodes;
  assert.equal(episodes.length, 6);
  assert.equal(episodes[0].reads.length, 2);
  assert.equal(episodeCoverage(episodes[0]), "partial: 1–3");
  assert.equal(episodeCoverage(episodes[1]), "partial: 9–9");
  const bytes = rig(undefined, []); bytes.append(user("Byte cap"));
  bytes.read("big", "chunk\n\n[Showing lines 1-2 of 3 (50KB limit). Use offset=3 to continue.]", { limit: 100 });
  bytes.read("big", "last", { offset: 3 });
  assert.equal(episodeCoverage(readCatalog(bytes.manager.getBranch(), cwd)[0].episodes[0]), "full");
  const unknownCoverage = rig(undefined, []); unknownCoverage.append(user("Oversized line"));
  const huge = unknownCoverage.call("huge"); unknownCoverage.result(huge.id, "[Line 1 is 100KB, exceeds 50KB limit. Use bash: ...]", false, "read", { truncation: { truncated: true } });
  assert.equal(episodeCoverage(readCatalog(unknownCoverage.manager.getBranch(), cwd)[0].episodes[0]), "partial: 1–?");

  const hiddenMutation = rig(undefined, []); hiddenMutation.append(user("Omitted mutation"));
  hiddenMutation.read("changing", "a\n\n[1 more lines in file. Use offset=2 to continue.]", { limit: 1 });
  const mutation = hiddenMutation.call("changing", { content: "changed" }, "write");
  hiddenMutation.manager.appendContextEdit(mutation.entry, null);
  hiddenMutation.read("changing", "b", { offset: 2 });
  assert.equal(readCatalog(hiddenMutation.manager.getBranch(), cwd)[0].episodes.length, 2, "an omitted mutation still breaks read episodes");

  console.log("== Read picker: first/latest ordering, complete preview, cancellation, defaults and checkpoint revisions ==");
  const key = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", end: "\x1b[F", home: "\x1b[H" };
  const kb = { matches: (data, action) => data === key[action.split(".").at(-1).replace("confirm", "enter").replace("cancel", "esc")] };
  const interact = (actions, rows = 18) => async (create) => {
    let done = false, result;
    const component = create({ terminal: { rows }, requestRender() {} }, { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s }, kb,
      (value) => { result = value; done = true; });
    const render = (width = 150) => {
      const lines = component.render(width); for (const line of lines) assert(visibleWidth(line) <= width);
      assert(lines.length <= rows, "picker fits available terminal height"); return lines.join("\n");
    };
    try {
      for (const width of [1, 8, 42, 150]) render(width);
      for (const action of actions) { if (typeof action === "function") action(render()); else { component.handleInput(key[action] ?? action); render(); } }
      assert(done, "interaction completes"); return result;
    } finally { component.dispose(); }
  };
  const following = rig(); following.append(user("Follow latest"));
  following.read("GUIDE.md", "OLD_SELECTED_GUIDE");
  const followingTail = following.append(user("Tail")); await following.compact(followingTail);
  following.read("GUIDE.md", "NEW_TAIL_GUIDE");
  following.ctx.ui.custom = interact(["enter", "enter"]);
  await following.ext.commands["retain-reads"].handler("", following.ctx);
  assert.equal(following.manager.getBranch().at(-1).customType, "transparent-compact:filter-revision");
  assert(!JSON.stringify(following.project()).includes("OLD_SELECTED_GUIDE"), "saving LATEST refreshes its candidate even without a mode toggle");
  assert.equal(JSON.stringify(following.project()).split("NEW_TAIL_GUIDE").length - 1, 1);
  assert.equal(following.manager.getBranch().filter((e) => e.type === "compaction").length, 1);

  const ui = rig(); const uiOwner = ui.append(user("Read things"));
  ui.read("docs/SPEC.md", "FIRST_VERSION\n" + "large line\n".repeat(40) + "FIRST_END");
  ui.read("other", "OTHER_OUTPUT");
  ui.read("docs/SPEC.md", "LATEST_VERSION");
  const beforePicker = JSON.stringify(ui.manager.getBranch());
  ui.ctx.ui.custom = interact([" ", "esc"]); await ui.ext.commands["retain-reads"].handler("", ui.ctx);
  assert.equal(JSON.stringify(ui.manager.getBranch()), beforePicker);
  ui.ctx.ui.custom = interact([
    (s) => assert(s.includes("FIRST") && s.includes("full")), "p", "end", (s) => assert(s.includes("FIRST_END")), "esc",
    "o", (s) => assert(s.indexOf("other") < s.indexOf("SPEC.md")), " ", // selected file follows the cursor after sorting: FIRST -> LATEST
    "enter", "enter",
  ]);
  await ui.ext.commands["retain-reads"].handler("", ui.ctx);
  assert.equal(ui.manager.getBranch().at(-1).customType, "transparent-compact:read-retention");
  const uiTail = ui.append(user("Tail")), uiCheckpoint = await ui.compact(uiTail);
  assert(uiCheckpoint.summary.includes("LATEST_VERSION") && !uiCheckpoint.summary.includes("FIRST_VERSION"));
  const rawTail = JSON.stringify(ui.manager.buildSessionContext().messages.filter((m) => m.role !== "compactionSummary"));
  ui.ctx.ui.custom = interact([" ", "enter", "enter"]); // LATEST -> OFF
  await ui.ext.commands["retain-reads"].handler("", ui.ctx);
  const offRevision = ui.manager.getBranch().at(-1);
  assert.equal(offRevision.customType, "transparent-compact:filter-revision");
  assert(!JSON.stringify(ui.project()).includes("LATEST_VERSION"));
  assert.equal(JSON.stringify(ui.manager.buildSessionContext().messages.filter((m) => m.role !== "compactionSummary")), rawTail);
  ui.ctx.ui.custom = interact(["d", "enter", "enter"]); // return to declared FIRST
  await ui.ext.commands["retain-reads"].handler("", ui.ctx);
  assert(JSON.stringify(ui.project()).includes("FIRST_VERSION"));
  ui.ctx.ui.custom = interact([" ", "enter", "enter"]); await ui.ext.commands["filter-turns"].handler("", ui.ctx);
  assert(JSON.stringify(ui.project()).includes("FIRST_VERSION") && JSON.stringify(ui.project()).includes('filtered-turn=\\"true\\"'));
  ui.ctx.ui.custom = interact([(s) => assert(s.includes("[filtered turn]")), "esc"]);
  await ui.ext.commands["retain-reads"].handler("", ui.ctx);
  const newTail = ui.append(user("Further task")), inherited = await ui.compact(newTail);
  assert(inherited.summary.includes("FIRST_VERSION") && inherited.details.filteredTurnIds.includes(uiOwner));
  assert.equal(readMode(inherited.details.readRetention, path.join(cwd, "docs/SPEC.md")), "first");
  // OFF choice remains an explicit override of the declaration after reload.
  saveSession(ui.manager, file);
  const loaded = rig(SessionManager.open(file)); loaded.ctx.ui.custom = interact([" ", " ", "enter", "enter"]); // first -> latest -> off
  await loaded.ext.commands["retain-reads"].handler("", loaded.ctx);
  const offHead = loaded.manager.getLeafId();
  loaded.ctx.ui.custom = interact(["enter", "enter"]);
  await loaded.ext.commands["retain-reads"].handler("", loaded.ctx);
  assert.equal(loaded.manager.getLeafId(), offHead, "saving an unchanged retention selection appends no revision");
  loaded.ctx.ui.custom = interact([" ", () => loaded.append(user("Concurrent input")), "enter", "enter"]);
  await loaded.ext.commands["retain-reads"].handler("", loaded.ctx);
  assert(loaded.notices.at(-1).includes("Session/checkpoint changed"));
  assert.equal(loaded.manager.getBranch().at(-1).type, "message", "a raced selection is not persisted");
  const loadedTail = loaded.append(user("Reloaded task")), loadedCheckpoint = await loaded.compact(loadedTail);
  assert(!loadedCheckpoint.summary.includes("FIRST_VERSION") && !loadedCheckpoint.summary.includes("LATEST_VERSION"));
  assert.equal(readMode(loadedCheckpoint.details.readRetention, path.join(cwd, "docs/SPEC.md")), "off");

  // Retained bytes remain intact even if they alone exceed the prose budget.
  const capped = rig(); capped.manager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "on", budget: { unit: "chars", value: 500 } });
  capped.append(user("First")); const large = "LARGE_START\n" + "reference contents\n".repeat(200) + "LARGE_END";
  capped.read("docs/SPEC.md", large); capped.append(assistant([text("Trimmable prose. ".repeat(500))]));
  const cappedTail = capped.append(user("Second")), cap = await capped.compact(cappedTail);
  assert(cap.summary.includes(large) && !cap.summary.includes("Trimmable prose."));
  assert(capped.notices.some((s) => s.includes("retained reads alone") && s.includes("kept un-capped")));
  assert.deepEqual(fs.readdirSync(cwd), [], "retention only uses prompt/session data, never source-file IO");
};

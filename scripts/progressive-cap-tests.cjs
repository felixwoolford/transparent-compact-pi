"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

module.exports = async function (h) {
  const { jiti, root, ext, SessionManager, compact, makeContext, assistant, toolCall, text, user, saveSession } = h;
  const { capSpans, commandPreview, renderCommand, renderToolLine } = await jiti.import(path.resolve(__dirname, "../extensions/lib/checkpoint-cap.ts"));
  console.log("== Progressive cap: presentation rungs precede omissions; canonical records stay immutable ==");
  const command = (value, { ref, retainRef = true, suffix = "" } = {}) => ({ prefix: "bash ", command: commandPreview(JSON.stringify(value)),
    suffix, retainRef, ...(ref ? { ref } : {}) });
  const longA = "cat " + "a".repeat(500) + "/OLDER_TARGET";
  const longB = "cat " + "b".repeat(500) + "/NEWER_TARGET";
  const span = (entries) => {
    const lines = [], records = [];
    for (const entry of entries) {
      if (typeof entry === "string") lines.push(entry);
      else {
        records.push({ index: lines.length, calls: entry.calls, mergeable: entry.mergeable ?? true });
        lines.push(renderToolLine(entry.calls));
      }
    }
    return { lines, tools: { version: 1, lines: records } };
  };
  const chars = (spans) => spans.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.length + 1, 0), 0);
  const freeze = (v) => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
  const original = freeze([span(["[User]: KEEP_USER", "[Assistant]: KEEP_PROSE", { calls: [command(longA, { ref: "older" })] }]),
    span([{ calls: [command(longB, { ref: "newer" })] }, "[User]: KEEP_RECENT"])]);
  const pristine = JSON.stringify(original);
  const normal = capSpans(original, chars(original));
  assert.deepEqual(normal.lines, original.map((s) => s.lines));
  assert.deepEqual(normal.tightened, [false, false]);
  assert.deepEqual(normal.trimmed, [false, false]);
  assert.deepEqual(capSpans(original).lines, normal.lines, "cap off restores the normal rendering");

  const mild = capSpans(original, chars(original) - 20);
  assert(mild.lines[0].some((l) => l.includes(renderCommand(commandPreview(JSON.stringify(longA)), 120))));
  assert.equal(mild.lines[1][0], original[1].lines[0], "stop once the older preview alone makes it fit");
  assert.deepEqual(mild.tightened, [true, false]);
  assert.deepEqual(mild.trimmed, [false, false]);
  assert(mild.lines[0].includes("[Assistant]: KEEP_PROSE"));
  const strong = capSpans(original, chars(original) - 100);
  assert(strong.lines[0].some((l) => l.includes(renderCommand(commandPreview(JSON.stringify(longA)), 80))));
  assert(strong.lines[1][0].includes(renderCommand(commandPreview(JSON.stringify(longB)), 120)), "try all 120-char previews before the oldest 80-char preview");
  assert.deepEqual(strong.trimmed, [false, false]);
  assert.equal(JSON.stringify(original), pristine);
  assert.deepEqual(capSpans(original, chars(original) - 20), mild, "a later larger budget does not inherit an 80-char presentation");

  const refs = freeze([span([{ calls: [command("cat file", { ref: "ordinary", retainRef: false,
    suffix: ' [unknown] → output: "no buffers"' }), command("python probe.py", { ref: "protected" })] }])]);
  const thin = capSpans(refs, chars(refs) - 1);
  assert(!thin.lines[0][0].includes("ref=ordinary") && thin.lines[0][0].includes("ref=protected"));
  assert(thin.lines[0][0].includes('[unknown] → output: "no buffers"'), "never shorten statuses or output observations");
  assert.deepEqual(thin.trimmed, [false]);

  const adjacent = freeze([span([{ calls: [command("one", { ref: "one" })] }, { calls: [command("two", { ref: "two" })] }])]);
  const grouped = capSpans(adjacent, chars(adjacent) - 1);
  assert.equal(grouped.lines[0].length, 1);
  assert.equal(grouped.lines[0][0], adjacent[0].lines[0] + "; " + adjacent[0].lines[1].slice("[Tools]: ".length));
  assert.deepEqual(grouped.trimmed, [false]);
  assert.deepEqual(grouped.tightened, [true]);

  const notAdjacent = freeze([span([{ calls: [command("one")], mergeable: false }, { calls: [command("two")] }, "[User]: boundary"])]);
  const noGroup = capSpans(notAdjacent, chars(notAdjacent) - 1);
  assert.deepEqual(noGroup.tightened, [false], "mixed prose/tool messages are not grouped with their successor");
  assert.deepEqual(noGroup.trimmed, [true]);
  const separated = freeze([span([{ calls: [command("one")] }, "[Assistant]: separator", { calls: [command("two")] }])]);
  assert(!capSpans(separated, chars(separated) - 1).lines[0].some((l) => l.includes('"one"; bash "two"')));

  const calls = [command("first", { ref: "first" }), command("second", { ref: "second" }), command("last", { ref: "last" })];
  const batch = freeze([span(["[User]: KEEP", { calls }])]);
  const lastOnly = chars([span(["[User]: KEEP", { calls: [calls[2]] }])]);
  const dropped = capSpans(batch, lastOnly);
  assert.equal(dropped.lines[0][1], renderToolLine([calls[2]]), "destructive fallback removes individual calls, not the entire batch");
  assert.deepEqual(dropped.trimmed, [true]);
  assert(dropped.lines[0].includes("[User]: KEEP"));
  assert(chars(dropped.lines.map((lines) => ({ lines }))) <= lastOnly);

  const legacy = freeze([{ lines: ['[Tools]: bash "legacy long command ' + "x".repeat(300) + '" ref=legacy', "[User]: KEEP"] }]);
  const legacyResult = capSpans(legacy, chars(legacy) - 1);
  assert.deepEqual(legacyResult.tightened, [false], "text-only spans are opaque, not parsed as new tool metadata");
  assert.deepEqual(legacyResult.trimmed, [true]);
  for (const invalid of [
    { version: 99, lines: adjacent[0].tools.lines },
    { version: 1, lines: [{ index: 0, calls: [command("NOT_THE_SOURCE")], mergeable: true }] },
    { version: 1, lines: [adjacent[0].tools.lines[0], adjacent[0].tools.lines[0]] },
  ]) {
    const data = freeze([{ lines: [adjacent[0].lines[0], "[User]: KEEP"], tools: invalid }]);
    assert.deepEqual(capSpans(data, chars(data) - 1).tightened, [false], "malformed/future metadata fails closed");
  }
  const fakeUser = freeze([{ lines: ["[User]: NEVER_PARSE_ME"], tools: { version: 1, lines: [{ index: 0, calls: [command(longA)], mergeable: true }] } }]);
  assert.deepEqual(capSpans(fakeUser, 500).lines, fakeUser.map((s) => s.lines));

  for (const value of ["x".repeat(72) + "😀".repeat(100), "a\nb \"quote\" \\slash ".repeat(50), "short"])
    for (const max of [160, 120, 80]) {
      const preview = renderCommand(commandPreview(JSON.stringify(value)), max);
      assert(preview.length <= max && preview.isWellFormed());
      assert(!preview.includes("\n"));
      assert.equal(preview, renderCommand(JSON.parse(JSON.stringify(commandPreview(JSON.stringify(value)))), max));
    }
  const hiddenMiddle = commandPreview(JSON.stringify("A".repeat(2000) + "MIDDLE_NOT_STORED" + "Z".repeat(2000)));
  assert(!JSON.stringify(hiddenMiddle).includes("MIDDLE_NOT_STORED"), "canonical cap records do not duplicate full script source");
  assert.deepEqual(capSpans(original, 0).lines, [[], []], "the final fallback still terminates below tiny budgets");

  console.log("== Progressive ref priorities: only recognizable local views are thinned ==");
  const priorities = SessionManager.inMemory(root);
  priorities.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  const file = "directory/".repeat(30) + "file.txt";
  const candidates = [
    [`cat ${file}`, false], [`cd . && sed -n '1,20p' ${file} | head -20`, false], [`git show HEAD:${file}`, false],
    [`cat ${file}; curl https://example.invalid`, true], [`cat ${file} | python -c 'print(1)'`, true],
    [`sed -n -i 'p' ${file}`, true], [`git diff --output=${file}`, true], [`cat $(curl https://example.invalid)/${file}`, true],
    [`cat ${file} && rm x`, true], [`echo probe && curl https://example.invalid/${file}`, true],
  ];
  const priorityIds = [];
  for (const [i, [cmd]] of candidates.entries()) {
    priorityIds.push(priorities.appendMessage(assistant([toolCall("bash", { command: cmd }, `priority-${i}`)], "toolUse")));
    priorityIds.push(priorities.appendMessage({ role: "toolResult", toolName: "bash", toolCallId: `priority-${i}`, isError: false, content: [text("output")], timestamp: 0 }));
  }
  priorityIds.push(priorities.appendMessage(assistant([toolCall("write", { path: "scratch.py", content: "PRIVATE_PAYLOAD_NOT_IN_CAP_RECORDS" }, "payload")], "toolUse")));
  const priorityTail = priorities.appendMessage(user("Tail"));
  const priorityCheckpoint = await compact(ext, makeContext(priorities, root), priorityIds, priorityTail);
  const priorityCalls = priorityCheckpoint.details.span.tools.lines.flatMap((line) => line.calls);
  for (let i = 0; i < candidates.length; i++) {
    assert(priorityCalls[i].ref, "a full truncated-command ref is stored before capping");
    assert.equal(priorityCalls[i].retainRef, candidates[i][1], candidates[i][0]);
  }
  assert(priorityCalls.at(-1).retainRef, "scratch payload refs stay protected");
  assert(!JSON.stringify(priorityCheckpoint.details.span).includes("PRIVATE_PAYLOAD_NOT_IN_CAP_RECORDS"));

  console.log("== Progressive cap integration: retroactive rendering, immutable history, resume/fork, and cap-off restoration ==");
  const manager = SessionManager.inMemory(root);
  manager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: 80000 } });
  const ids = [manager.appendMessage(user("PRESERVED_INSTRUCTION")), manager.appendMessage(assistant([text("PRESERVED_EARLIER_PROSE")]))];
  for (let i = 0; i < 25; i++) {
    ids.push(manager.appendMessage(assistant([toolCall("bash", { command: `cat ${"long-directory/".repeat(30)}file-${i}.txt` }, `cap-${i}`)], "toolUse")));
    ids.push(manager.appendMessage({ role: "toolResult", toolName: "bash", toolCallId: `cap-${i}`, isError: false, content: [text("read output")], timestamp: 0 }));
  }
  const kept = manager.appendMessage(user("First recent tail"));
  const ctx = makeContext(manager, root);
  const first = await compact(ext, ctx, ids, kept);
  const canonical = JSON.stringify(first.details);
  assert(first.details.span.tools.lines.length === 25);
  const lineSize = first.details.span.lines.reduce((n, l) => n + l.length + 1, 0);
  manager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "warn", budget: { unit: "chars", value: lineSize } });
  let dialogs = 0;
  const interactive = { ...ctx, hasUI: true, ui: { notify: () => {}, select: async () => { dialogs++; return "Apply trimming"; } } };
  const next = manager.appendMessage(user("Second recent tail"));
  const second = await compact(ext, interactive, [kept], next);
  assert.equal(dialogs, 1, "warn mode still asks before presentation-only tightening");
  assert(second.summary.includes('tools-tightened="true"') && !second.summary.includes('trimmed="true"'));
  assert(second.summary.includes("PRESERVED_INSTRUCTION") && second.summary.includes("PRESERVED_EARLIER_PROSE"));
  assert.equal(JSON.stringify(manager.getEntry(first.id).details), canonical, "earlier compaction metadata is not rewritten");
  const saved = path.join(root, "progressive-cap-session.jsonl");
  saveSession(manager, saved);
  for (const resumed of [SessionManager.open(saved), SessionManager.forkFrom(saved, root, path.join(root, "progressive-forks"))]) {
    const leaf = resumed.appendMessage(user("Resumed tail"));
    const c = await compact(ext, makeContext(resumed, root), [next], leaf);
    assert(c.summary.includes('tools-tightened="true"') && !c.summary.includes('trimmed="true"'), "stored structured records survive resume/fork");
    assert.equal(JSON.stringify(resumed.getEntry(first.id).details), canonical);
  }
  manager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "off", budget: { unit: "chars", value: lineSize } });
  const final = manager.appendMessage(user("Uncapped tail"));
  const restored = await compact(ext, ctx, [next], final);
  for (const line of first.details.span.lines) assert(restored.summary.includes(line), "restore full 160-char lines and refs from canonical metadata");
  assert(!restored.summary.includes('tools-tightened="true"') && !restored.summary.includes('trimmed="true"'));
  assert.equal(JSON.stringify(manager.getEntry(first.id).details), canonical);
};

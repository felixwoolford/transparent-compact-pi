"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function (h) {
  const { jiti, ext, factory, load, root, SessionManager, compact, makeContext, user, assistant, text, toolCall, toolText, saveSession } = h;
  const { expandTargets, expansionDigest, pairedToolResults } = await jiti.import(path.resolve(__dirname, "../extensions/lib/context-expansion.ts"));
  const { expandCheckpointText } = await jiti.import(path.resolve(__dirname, "../extensions/index.ts"));
  const { capSpans, commandPreview, renderToolLine } = await jiti.import(path.resolve(__dirname, "../extensions/lib/checkpoint-cap.ts"));
  const { filterSpans } = await jiti.import(path.resolve(__dirname, "../extensions/lib/turn-filter.ts"));
  const { fidelitySpans } = await jiti.import(path.resolve(__dirname, "../extensions/lib/turn-context.ts"));
  const { retainReadSpans } = await jiti.import(path.resolve(__dirname, "../extensions/lib/read-retention.ts"));
  console.log("== Quote expansion backend: renderer provenance, ambiguity, isolation, bounded pages and stale cursors ==");
  assert.deepEqual(Object.keys(ext.tools), ["context_lookup", "context_expand"]);
  const expansion = ext.tools.context_expand;
  assert.deepEqual(Object.keys(expansion.parameters.properties), ["text", "selector", "cursor"]);
  assert.deepEqual(expansion.parameters.required, ["text"]);
  assert(!Object.hasOwn(expansion, "promptSnippet"), "expansion has no additional system-prompt advertisement");
  const manager = SessionManager.inMemory(root), ctx = makeContext(manager, root);
  const invoke = (params, context = ctx, signal) => expansion.execute("expand-test", params, signal, undefined, context);
  const nextCursor = (reply) => /^cursor: ([\w-]+)$/m.exec(reply)?.[1];
  const payload = (reply) => reply.slice(reply.indexOf("\n") + 1).split("\n\nMore content is available.")[0];
  const ids = [];
  const add = (message) => { const id = manager.appendMessage(message); ids.push(id); return id; };
  const output = (id, name, value, content) => ({ role: "toolResult", toolCallId: id, toolName: name,
    content: content ?? [text(value)], isError: false, timestamp: 0 });
  const baseline = add(user("Run the baseline tests"));
  const first = add(assistant([text("Baseline pass"), toolCall("bash", { command: "npm test", hidden: "FIRST_FULL_ARGUMENT" }, "test")], "toolUse"));
  const firstResult = add(output("test", "bash", "FIRST_OBSERVED_OUTPUT"));
  add(user("Run tests after the parser fix"));
  const second = add(assistant([{ type: "thinking", thinking: "THINKING_MUST_NOT_LEAK" },
    toolCall("bash", { command: "npm test", hidden: "SECOND_FULL_ARGUMENT" }, "test"),
    toolCall("write", { path: "scratch.txt", content: "SIBLING_PAYLOAD_MUST_NOT_LEAK" }, "write")], "toolUse"));
  add(output("write", "write", "SIBLING_OUTPUT_MUST_NOT_LEAK"));
  const secondResult = add(output("test", "bash", "SECOND_OBSERVED_OUTPUT"));
  const kept = manager.appendMessage(user("Retained tail"));
  const checkpoint = await compact(ext, ctx, ids, kept);
  assert(checkpoint.details.expansionTargets.length >= 3);
  assert(checkpoint.details.expansionTargets.every((target) => checkpoint.summary.includes(target.text)), "only final displayed fragments are indexed");
  for (const hidden of ["FIRST_FULL_ARGUMENT", "SECOND_FULL_ARGUMENT", "THINKING_MUST_NOT_LEAK", "SIBLING_PAYLOAD_MUST_NOT_LEAK"])
    assert(!JSON.stringify(checkpoint.details).includes(hidden), "provenance stores no omitted payload copies");
  const query = { text: 'bash "npm test"' };
  const before = JSON.stringify(manager.getBranch());
  const choices = expandCheckpointText(ctx, query);
  assert.equal(choices.status, "ambiguous"); assert.equal(choices.total, 2);
  assert.equal(choices.candidates[0].before, "Run the baseline tests");
  assert.equal(choices.candidates[1].before, "Run tests after the parser fix");
  assert(!JSON.stringify(choices).includes("FULL_ARGUMENT"), "ambiguity responses do not expose raw payloads");
  const selected = expandCheckpointText(ctx, { ...query, selector: choices.candidates[1].selector });
  assert.equal(selected.status, "expanded");
  assert.deepEqual(selected.entryIds, [second, secondResult]);
  assert(selected.content.includes("SECOND_FULL_ARGUMENT") && selected.content.includes("SECOND_OBSERVED_OUTPUT"));
  for (const hidden of ["FIRST_FULL_ARGUMENT", "THINKING_MUST_NOT_LEAK", "SIBLING_PAYLOAD_MUST_NOT_LEAK", "SIBLING_OUTPUT_MUST_NOT_LEAK"])
    assert(!selected.content.includes(hidden), "tool expansion stays within the selected call/result pair");
  const firstQuery = { ...query, selector: choices.candidates[0].selector };
  const firstSelected = expandCheckpointText(ctx, firstQuery);
  assert.equal(firstSelected.status, "expanded"); assert.deepEqual(firstSelected.entryIds, [first, firstResult]);
  assert.equal(expandCheckpointText(ctx, { ...firstQuery, text: '[Tools]: bash "npm test"' }).status, "expanded");

  // Exercise the registered tool and follow the guidance actually returned to the agent.
  const offered = await invoke(query);
  assert.equal(offered.details, undefined, "do not persist a duplicate response payload in details");
  assert(!offered.isError);
  const selectors = [...toolText(offered).matchAll(/^selector: (\w+)$/gm)].map((match) => match[1]);
  assert.deepEqual(selectors, choices.candidates.map((candidate) => candidate.selector));
  assert(toolText(offered).includes("Run the baseline tests") && toolText(offered).includes("Run tests after the parser fix"));
  const viaTool = await invoke({ ...query, selector: selectors[1] }, { ...ctx, model: undefined });
  assert(!viaTool.isError && toolText(viaTool).startsWith("Historical expansion (ENTRY "));
  assert.deepEqual(JSON.parse(payload(toolText(viaTool))), JSON.parse(selected.content));
  assert(toolText(await invoke({ text: "not a displayed fragment" })).includes("context_lookup"));
  assert((await invoke({ ...query, selector: "invented" })).isError);
  assert((await invoke({ text: " " })).isError);
  const aborted = new AbortController(); aborted.abort();
  const cancelled = await invoke(query, { sessionManager: { getBranch() { throw new Error("Cancelled expansion must not read history"); } } }, aborted.signal);
  assert(cancelled.isError && toolText(cancelled).includes("cancelled"));
  assert.equal(expandCheckpointText(ctx, { text: "npm.*test" }).status, "not-found", "quotes are literal, not regexes");
  assert.equal(expandCheckpointText(ctx, { text: "THINKING_MUST_NOT_LEAK" }).status, "not-found", "not a general history search");
  assert.equal(expandCheckpointText(ctx, { text: "Run the baseline tests" }).status, "not-found", "ordinary untruncated prose remains a lookup task");
  assert.equal(expandCheckpointText(ctx, { ...query, selector: "invented" }).status, "invalid");
  for (const value of ["", " ", "[Tools]: ", "x".repeat(4001)]) assert.equal(expandCheckpointText(ctx, { text: value }).status, "invalid");
  assert.equal(JSON.stringify(manager.getBranch()), before, "expansion is read-only and model-free");
  const secondArgs = manager.getEntry(second).message.content[1].arguments;
  secondArgs.command = "different command, same call ID";
  assert.equal(expandCheckpointText(ctx, { ...query, selector: choices.candidates[1].selector }).status, "unavailable",
    "matching an ID/name is insufficient when projected call contents differ from the raw source");
  secondArgs.command = "npm test";

  // A checkpoint may repeat an alias of the same underlying source. Count the source once.
  const targets = checkpoint.details.expansionTargets;
  const unique = expandTargets(manager.getBranch(), [...targets, targets[0]], query);
  assert.equal(unique.status, "ambiguous"); assert.equal(unique.total, 2); assert.equal(unique.candidates.length, 2);
  const pagedMatches = expandTargets(manager.getBranch(), targets, query, { maxCandidates: 1 });
  assert.equal(pagedMatches.total, 2); assert.equal(pagedMatches.candidates.length, 1); assert(pagedMatches.nextCursor);
  const nextMatches = expandTargets(manager.getBranch(), targets, { ...query, cursor: pagedMatches.nextCursor }, { maxCandidates: 1 });
  assert.equal(nextMatches.candidates[0].selector, choices.candidates[1].selector); assert(!nextMatches.nextCursor);
  assert.equal(expandTargets(manager.getBranch(), targets, { text: "write", cursor: pagedMatches.nextCursor }).status, "invalid");

  // Exact Unicode reconstruction, media omission, and cursor binding to data/query.
  const huge = "BEGIN\n" + "😀".repeat(12000) + "\nEND";
  const rawResult = manager.getEntry(secondResult).message;
  rawResult.content = [text(huge), { type: "image", mimeType: "image/png", data: "IMAGE_BINARY_MUST_NOT_LEAK" }];
  rawResult.structuredContent = { value: "STRUCTURED_OUTPUT" };
  const selectedQuery = { ...query, selector: choices.candidates[1].selector };
  let cursor, joined = "", pages = 0, firstCursor;
  do {
    const page = expandTargets(manager.getBranch(), targets, { ...selectedQuery, ...(cursor ? { cursor } : {}) }, { maxChars: 97 });
    assert.equal(page.status, "expanded"); assert(page.content.length <= 97 && page.content.isWellFormed());
    joined += page.content; cursor = page.nextCursor; firstCursor ??= cursor; assert(++pages < 1000);
  } while (cursor);
  const recovered = JSON.parse(joined);
  assert.equal(recovered.result.text, huge); assert.equal(recovered.result.imagesOmitted, 1);
  assert.equal(recovered.result.structuredContent.value, "STRUCTURED_OUTPUT");
  assert(!joined.includes("IMAGE_BINARY_MUST_NOT_LEAK"));
  let apiCursor, apiJoined = "", apiPages = 0;
  do {
    const page = await invoke({ ...selectedQuery, ...(apiCursor ? { cursor: apiCursor } : {}) });
    assert(!page.isError && page.details === undefined);
    const reply = toolText(page), body = payload(reply);
    assert(body.length <= 12000 && body.isWellFormed());
    apiJoined += body; apiCursor = nextCursor(reply); assert(++apiPages < 10);
  } while (apiCursor);
  assert(apiPages > 1);
  assert.equal(apiJoined, joined, "real tool cursors reconstruct the exact same call/result payload");
  assert.equal(expandTargets(manager.getBranch(), targets, { ...firstQuery, cursor: firstCursor }).status, "invalid");
  rawResult.content = [text("SOURCE_CHANGED")];
  assert.equal(expandTargets(manager.getBranch(), targets, { ...selectedQuery, cursor: firstCursor }).status, "invalid");
  assert.equal(expandTargets(manager.getBranch(), targets, { ...selectedQuery, cursor: "not-a-cursor" }).status, "invalid");

  // Branch membership and resume do not rely on an in-memory cache.
  const file = path.join(root, "expansion-session.jsonl"); saveSession(manager, file);
  const resumed = SessionManager.open(file);
  assert.equal(expandCheckpointText(makeContext(resumed, root), firstQuery).status, "expanded");
  const leaf = manager.getLeafId(); manager.branch(baseline);
  assert.equal(expandCheckpointText(ctx, query).status, "not-found"); manager.branch(leaf);
  const pruned = SessionManager.inMemory(root);
  const prunedTail = pruned.appendMessage(user("Pruned tail"));
  pruned.appendCompaction(checkpoint.summary, prunedTail, 1000, checkpoint.details);
  assert.equal(expandCheckpointText(makeContext(pruned, root), firstQuery).status, "unavailable");
  const sourceTarget = targets.find((target) => target.source.entryId === first);
  assert.equal(expandTargets(pruned.getBranch(), [sourceTarget], { text: sourceTarget.text }).status, "unavailable");
  assert(toolText(await invoke(firstQuery, makeContext(pruned, root))).includes("original source is unavailable"));
  try {
    process.env.MECH_COMPACT_LOOKUP_SESSION_FILE = file;
    assert.equal(expandCheckpointText(makeContext(pruned, root), firstQuery).status, "expanded");
    process.env.MECH_COMPACT_LOOKUP_SESSION_FILE = "relative.jsonl";
    assert.throws(() => expandCheckpointText(ctx, query), /absolute path/);
    const failed = await invoke(query);
    assert(failed.isError && toolText(failed).startsWith("context_expand failed:") && toolText(failed).includes("absolute path"));
  } finally { delete process.env.MECH_COMPACT_LOOKUP_SESSION_FILE; }

  // Original prose can already be expanded when the cap truncates a user message.
  const proseManager = SessionManager.inMemory(root), proseCtx = makeContext(proseManager, root);
  proseManager.appendCustomEntry("transparent-compact:cap-compaction", { mode: "on", budget: { unit: "chars", value: 5000 } });
  const longProse = "USER_PROSE_START " + "q".repeat(12000) + " USER_PROSE_END";
  const proseId = proseManager.appendMessage(user(longProse));
  const proseTail = proseManager.appendMessage(user("Prose tail"));
  const proseCheckpoint = await compact(ext, proseCtx, [proseId], proseTail);
  const proseTarget = proseCheckpoint.details.expansionTargets.find((target) => target.source.kind === "prose");
  assert(proseTarget && proseTarget.text.length < longProse.length);
  let proseCursor, whole = "";
  do {
    const page = expandCheckpointText(proseCtx, { text: "USER_PROSE_START", ...(proseCursor ? { cursor: proseCursor } : {}) });
    assert.equal(page.status, "expanded"); whole += page.content; proseCursor = page.nextCursor;
  } while (proseCursor);
  assert.equal(whole, longProse);

  // Stable final-row provenance through preview tightening, prefix folding, deletion,
  // retained-read insertion, whole-turn filtering and native-fidelity replacement.
  const calls = ["A", "B"].map((label) => ({ prefix: "bash ", command: commandPreview(JSON.stringify(label.repeat(500))), suffix: "" }));
  const anchor = (index, callIndex, entryId) => ({ index, callIndex,
    source: { kind: "tool", entryId, blockIndex: 0, callId: entryId, name: "bash", digest: "test-only" } });
  const span = { lines: ["[User]: user", renderToolLine(calls), renderToolLine([calls[1]])], turnIds: ["u", "u", "v"],
    tools: { version: 2, lines: [{ index: 1, calls, mergeable: true }, { index: 2, calls: [calls[1]], mergeable: true }] },
    expansionAnchors: [anchor(1, 0, "a"), anchor(1, 1, "b"), anchor(2, 0, "c")], readPositions: [{ entryId: "read", index: 1 }] };
  const originalSpan = JSON.stringify(span), chars = span.lines.reduce((n, line) => n + line.length + 1, 0);
  const observed = [];
  capSpans([span], chars - 30, undefined, undefined, (...row) => observed.push(row));
  assert(observed.some((row) => row[3]?.some((call) => call.text.length < renderToolLine(calls).length / 2)));
  const dropped = [];
  capSpans([span], 160, undefined, undefined, (...row) => dropped.push(row));
  assert(dropped.flatMap((row) => row[3] ?? []).length < 3, "removed calls have no expansion target");
  assert.equal(JSON.stringify(span), originalSpan);
  const inserted = retainReadSpans([span], [{ entryId: "read", owner: "u", path: "file", offset: 1, text: ["read output"] }], new Set()).spans[0];
  assert.deepEqual(inserted.expansionAnchors.map((a) => a.index), [2, 2, 3]);
  const filtered = filterSpans([span], new Set(["u"]))[0];
  assert.deepEqual(filtered.expansionAnchors.map((a) => a.source.entryId), ["c"]);
  assert.equal(filtered.expansionAnchors[0].index, 1);
  const native = fidelitySpans([span], { u: "tools" }).spans[0];
  assert.deepEqual(native.expansionAnchors.map((a) => a.source.entryId), ["c"]);
  assert.equal(native.expansionAnchors[0].index, 1);

  // Repeated compaction uses canonical provenance, not already truncated text.
  const next = manager.appendMessage(user("Next retained tail"));
  const repeated = await compact(ext, ctx, [kept], next);
  assert(repeated.details.expansionTargets.some((target) => target.source.entryId === first));
  assert.equal(expandCheckpointText(ctx, firstQuery).status, "expanded");
  // Explicit checkpoint revisions replace the index, never silently reuse stale targets.
  manager.appendCustomEntry("transparent-compact:filter-revision", { compactionId: repeated.id, summary: repeated.summary,
    expansionTargets: [], filteredTurnIds: [], keptAsideTurnIds: [], readRetention: repeated.details.readRetention });
  assert.equal(expandCheckpointText(ctx, query).status, "not-found");

  // Bash executions expand their own output, not neighbouring tool calls.
  const bashManager = SessionManager.inMemory(root);
  const bash = { role: "bashExecution", command: "printf hello", output: "hello", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 };
  const bashId = bashManager.appendMessage(bash);
  const bashTarget = { text: 'bash "printf hello" [output removed]',
    source: { kind: "bash", entryId: bashId, digest: expansionDigest([bash.command, bash.output]) } };
  const bashExpanded = expandTargets(bashManager.getBranch(), [bashTarget], { text: "printf hello" });
  assert.equal(bashExpanded.status, "expanded"); assert.equal(JSON.parse(bashExpanded.content).output, "hello");

  // Pairing does not invent relations from duplicate concurrent IDs or mismatched names.
  const a = toolCall("bash", {}, "dup"), b = toolCall("bash", {}, "dup");
  assert.equal(pairedToolResults([assistant([a, b]), output("dup", "bash", "ambiguous")]).size, 0);
  assert.equal(pairedToolResults([assistant([a]), output("dup", "read", "wrong tool")]).size, 0);
  assert.equal(pairedToolResults([assistant([a]), output("dup", "bash", "first"), assistant([b]), output("dup", "bash", "second")]).size, 2);
  assert.deepEqual(Object.keys(load(factory).tools), ["context_lookup", "context_expand"]);

  // Candidate-list pagination uses the same protocol; selection starts without its cursor.
  const many = SessionManager.inMemory(root), manyCtx = makeContext(many, root), manyIds = [];
  for (let i = 0; i < 11; i++) {
    manyIds.push(many.appendMessage(user(`Candidate turn ${i}`)));
    manyIds.push(many.appendMessage(assistant([toolCall("bash", { command: "echo fixture" }, `candidate-${i}`)], "toolUse")));
    manyIds.push(many.appendMessage(output(`candidate-${i}`, "bash", `RESULT_${i}`)));
  }
  const manyTail = many.appendMessage(user("Many candidates tail"));
  await compact(ext, manyCtx, manyIds, manyTail);
  const manyQuery = { text: 'bash "echo fixture"' };
  const firstChoices = toolText(await invoke(manyQuery, manyCtx));
  assert.equal([...firstChoices.matchAll(/^selector:/gm)].length, 8);
  const candidateCursor = nextCursor(firstChoices); assert(candidateCursor);
  const lastChoices = toolText(await invoke({ ...manyQuery, cursor: candidateCursor }, manyCtx));
  const lastSelectors = [...lastChoices.matchAll(/^selector: (\w+)$/gm)].map((match) => match[1]);
  assert.equal(lastSelectors.length, 3); assert(!nextCursor(lastChoices));
  const lastChoice = await invoke({ ...manyQuery, selector: lastSelectors[2] }, manyCtx);
  assert.equal(JSON.parse(payload(toolText(lastChoice))).result.text, "RESULT_10");
  assert((await invoke({ ...manyQuery, selector: lastSelectors[2], cursor: candidateCursor }, manyCtx)).isError);
  assert.equal(fs.readFileSync(file, "utf8").includes("IMAGE_BINARY_MUST_NOT_LEAK"), false);
};

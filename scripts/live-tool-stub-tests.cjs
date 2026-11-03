const assert = require('node:assert/strict');
const path = require('node:path');
const { locationId } = require('./location-test-helpers.cjs');

module.exports = async function (h) {
  const { factory, load, SessionManager, root, makeContext, assistant, toolCall, text, user, compact, saveSession, jiti } = h;
  console.log('== Live tool breadcrumbs: stable bindings, cap cost, filtering, fidelity, and no raw payload copies ==');
  const { capSpans, renderToolLine } = await jiti.import(path.resolve(__dirname, '../extensions/lib/checkpoint-cap.ts'));
  const cwd = path.join(root, 'live-stubs');
  const rig = () => {
    const manager = SessionManager.inMemory(cwd), ext = load(factory, { current: manager });
    manager.appendCustomEntry('transparent-compact:cap-compaction', { mode: 'off', budget: { unit: 'chars', value: 80000 } });
    const ctx = { ...makeContext(manager, cwd), model: { id: 'stub-model', provider: 'stub', contextWindow: 131072, maxTokens: 4096 } };
    return { manager, ext, ctx };
  };
  let serial = 0;
  const appendCall = (manager, name, args) => {
    const id = `live-${serial++}`;
    const a = manager.appendMessage(assistant([toolCall(name, args, id)], 'toolUse'));
    const t = manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name,
      content: [text('discarded result')], isError: false, timestamp: 0 });
    return [a, t];
  };
  const long = command => command + ' # ' + 'OPAQUE_COMMENT_NOT_STORED'.repeat(20);
  const table = summary => summary.slice(summary.lastIndexOf('<locations '), summary.lastIndexOf('</locations>') + '</locations>'.length);

  const r = rig();
  const firstUser = r.manager.appendMessage(user('Preserve prose @999 literally.'));
  const calls = [
    ...appendCall(r.manager, 'read', { path: 'src/a.ts', offset: 2, limit: 3, extensionSecret: 'METADATA_MUST_DISAPPEAR' }),
    ...appendCall(r.manager, 'bash', { command: long('cd src && cat a.ts | grep needle; cat /tmp/first-bash-only.txt'),
      background: true, delivery: null, arbitraryNewControl: 'METADATA_MUST_DISAPPEAR' }),
    ...appendCall(r.manager, 'unfamiliar', { query: 'retain me', background: true }),
  ];
  const kept = r.manager.appendMessage(user('First retained tail'));
  const first = await compact(r.ext, r.ctx, [firstUser, ...calls], kept);
  const firstSource = JSON.stringify(first.details);
  const aId = locationId(first, 'src/a.ts');
  assert(first.summary.includes(`read ${aId}:2-4`));
  assert(first.summary.includes(`cat ${aId} | grep`), 'the same file in read and bash shares an identity');
  assert(!first.summary.includes('METADATA_MUST_DISAPPEAR'));
  assert(first.summary.includes('unfamiliar(query="retain me", background=true)'));
  assert(!JSON.stringify(first.details.span).includes('OPAQUE_COMMENT_NOT_STORED'));
  assert(first.summary.includes('Preserve prose @999 literally.'));
  assert(!first.details.locations.some(entry => entry.id === '@999'));
  assert.equal(first.summary.split('<locations ').length - 1, 1);
  assert(first.summary.indexOf('<locations ') > first.summary.lastIndexOf('</compacted-span>'));
  assert(first.summary.indexOf('</locations>') < first.summary.lastIndexOf('Conversation'));

  const nextCalls = appendCall(r.manager, 'read', { path: 'src/a.ts' });
  const newCalls = appendCall(r.manager, 'bash', { command: long('cat /tmp/new-bash-only.txt') });
  const next = r.manager.appendMessage(user('Second retained tail'));
  const second = await compact(r.ext, r.ctx, [kept, ...nextCalls, ...newCalls], next);
  assert.equal(locationId(second, 'src/a.ts'), aId);
  assert.deepEqual(second.details.locations.slice(0, first.details.locations.length), first.details.locations);
  assert.equal(JSON.stringify(r.manager.getEntry(first.id).details), firstSource);
  for (const line of first.details.span.lines) assert(second.summary.includes(line));
  const file = path.join(root, 'live-stubs-resume.jsonl');
  saveSession(r.manager, file);
  for (const manager of [SessionManager.open(file), SessionManager.forkFrom(file, cwd, path.join(root, 'live-stub-forks'))]) {
    const extension = load(factory, { current: manager });
    const tail = manager.appendMessage(user('Resumed tail'));
    const checkpoint = await compact(extension, { ...r.ctx, sessionManager: manager }, [next], tail);
    assert.equal(locationId(checkpoint, 'src/a.ts'), aId);
    assert(checkpoint.summary.includes('/tmp/first-bash-only.txt'));
  }
  r.manager.branch(firstUser);
  const alternativeCalls = appendCall(r.manager, 'read', { path: 'alternative.ts' });
  const alternativeTail = r.manager.appendMessage(user('Alternative retained tail'));
  const alternative = await compact(r.ext, r.ctx, [firstUser, ...alternativeCalls], alternativeTail);
  assert.equal(locationId(alternative, 'alternative.ts'), '@1');
  assert(!alternative.summary.includes('/tmp/first-bash-only.txt'), 'abandoned branch locations are not inherited');

  // Dictionary bytes can force a call to be dropped even when its tiny skeleton
  // alone fits. Removing that call also removes its dictionary cost and entries.
  const costed = rig();
  costed.manager.appendCustomEntry('transparent-compact:cap-compaction', { mode: 'on', budget: { unit: 'chars', value: 700 } });
  const cu = costed.manager.appendMessage(user('KEEP_CAP_USER'));
  const url = 'https://example.invalid/' + 'resource-segment/'.repeat(200);
  const costCalls = appendCall(costed.manager, 'bash', { command: `curl '${url}'` });
  const ct = costed.manager.appendMessage(user('Cap tail'));
  const capped = await compact(costed.ext, costed.ctx, [cu, ...costCalls], ct);
  assert(capped.summary.includes('trimmed="true"'));
  assert(!capped.summary.includes(url));
  assert(!capped.summary.includes('<locations '));
  assert(capped.summary.includes('KEEP_CAP_USER'));
  const cappedCanonical = JSON.stringify(capped.details);
  costed.manager.appendCustomEntry('transparent-compact:cap-compaction', { mode: 'off', budget: { unit: 'chars', value: 700 } });
  const ct2 = costed.manager.appendMessage(user('Uncapped tail'));
  const uncapped = await compact(costed.ext, costed.ctx, [ct], ct2);
  assert(uncapped.summary.includes(url));
  assert.equal(JSON.stringify(costed.manager.getEntry(capped.id).details), cappedCanonical);

  const pureCalls = [{ prefix: 'bash{cat @1}', suffix: '', locations: ['@1'] }, { prefix: 'bash{cat @2}', suffix: '', locations: ['@2'] }];
  const pure = { lines: pureCalls.map(call => renderToolLine([call])), tools: { version: 2,
    lines: pureCalls.map((call, index) => ({ index, calls: [call], mergeable: false })) } };
  const oneCost = pure.lines[1].length + 1 + 100;
  const pruned = capSpans([pure], oneCost, ids => ids.length * 100);
  assert.deepEqual(pruned.locationIds, ['@2']);
  assert.deepEqual(pruned.lines, [[pure.lines[1]]]);

  // Bash-only paths have no read/modified list membership. Their visibility must
  // still follow turn filtering and full-fidelity replacement, then restoration.
  const f = rig();
  const hidden = f.manager.appendMessage(user('LOW_PRIORITY_TURN'));
  const hiddenCalls = appendCall(f.manager, 'bash', { command: long('cat hidden-only/location.txt') });
  const useful = f.manager.appendMessage(user('USEFUL_TURN'));
  const usefulCalls = appendCall(f.manager, 'bash', { command: long('cat useful-only/location.txt') });
  const ft = f.manager.appendMessage(user('Recent tail'));
  const full = await compact(f.ext, f.ctx, [hidden, ...hiddenCalls, useful, ...usefulCalls], ft);
  const hiddenId = locationId(full, 'hidden-only/location.txt');
  let selection = { pruned: [hidden], fidelity: {} };
  const ui = { ...f.ctx, mode: 'tui', hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify() {}, custom: async () => selection } };
  const revise = async () => {
    await f.ext.commands['filter-turns'].handler('', ui);
    const revision = f.manager.getBranch().at(-1);
    assert.equal(revision.customType, 'transparent-compact:filter-revision');
    return revision.data;
  };
  const filtered = await revise();
  assert(!table(filtered.summary).includes('hidden-only/location.txt'));
  assert(table(filtered.summary).includes('useful-only/location.txt'));
  selection = { pruned: [], fidelity: { [hidden]: 'tools' } };
  const native = await revise();
  assert(!table(native.summary).includes('hidden-only/location.txt'));
  const projected = f.ext.handlers.context_with_system({ messages: f.manager.buildSessionContext().messages }, ui).messages;
  assert(projected.some(message => message.role === 'assistant' && message.content.some(block => block.arguments?.command?.includes('hidden-only/location.txt'))));
  selection = { pruned: [], fidelity: {} };
  const restored = await revise();
  assert(table(restored.summary).includes(`${hiddenId} "hidden-only/location.txt"`));
  assert.equal(JSON.stringify(f.manager.getEntry(full.id).details), JSON.stringify(full.details));
};

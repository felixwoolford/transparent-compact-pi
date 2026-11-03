import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Locations } from './locations.mjs';
import { shellSkeleton } from './shell.mjs';
import { SkeletonRenderer } from './renderer.mjs';
import { selectToolInputs, resultSuffix } from './tool-inputs.mjs';
import { sampleSession, selectSessions } from './sample.mjs';
import { baselineCheckpoint, candidateCheckpoint } from './checkpoint.mjs';

const cwd = '/work/project';
function stub(command, suffix = '') {
  const encoded = JSON.stringify(command);
  let head = encoded.slice(0, 160);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return { prefix: 'bash ', command: { head, ...(encoded.length > 160 ? { truncated: true } : {}) }, suffix };
}
const skeleton = async (command, options) => {
  const locations = new Locations(cwd);
  return { ...(await shellSkeleton(command, locations, options)), locations: locations.entries };
};

test('location identities are append-only, scoped, restorable, and escaped', () => {
  const locations = new Locations(cwd);
  assert.equal(locations.ref('./src/a.ts').id, locations.ref('/work/project/src/a.ts').id);
  assert.notEqual(locations.ref('a.ts', '/work/other').id, locations.ref('a.ts', cwd).id);
  assert.match(locations.ref('$ROOT/a.ts').display, /\$ROOT\/a.ts/);
  assert.match(locations.ref('a.ts', null).display, /^\? :: /);
  const restored = new Locations(cwd, locations.entries);
  assert.equal(restored.ref('./src/a.ts').id, '@1');
  assert.equal(restored.ref('next.ts').id, `@${locations.entries.length + 1}`);
  restored.ref('a\nb.ts');
  assert(restored.render().includes('a\\nb.ts'));
});

test('keeps shell topology, subcommands and redirect paths, drops simulation values', async () => {
  const result = await skeleton('cd rust && cargo test --features parallel > /tmp/tests.log | tail -5');
  assert.match(result.text, /cd @1 &&.*cargo test >@2 \| tail/);
  assert.doesNotMatch(result.text, /features|parallel|-5/);
  assert.deepEqual(result.locations.map(entry => entry.display), ['rust', '/tmp/tests.log']);
  const mixed = await skeleton('cat a || cat b; cat c >> d &');
  assert.match(mixed.text, /\|\|/);
  assert.match(mixed.text, /; /);
  assert.match(mixed.text, />>/);
  assert.match(mixed.text, / &$/);
});

test('executable paths and simple timeout wrappers keep the inner activity visible', async () => {
  const result = await skeleton('timeout 20s .venv/bin/python scripts/probe.py');
  assert.match(result.text, /timeout python\[@1\] @2/);
  assert.deepEqual(result.locations.map(entry => entry.display), ['.venv/bin/python', 'scripts/probe.py']);
});

test('cwd propagates through successful && chains; git revisions and config keys are not filesystem paths', async () => {
  const result = await skeleton('cd rust && cargo fmt && cd .. && git add README.md; git config user.email; git show HEAD:src/a.ts');
  assert(result.locations.some(entry => entry.display === 'README.md'));
  assert(!result.locations.some(entry => entry.display.includes('? ::')));
  assert(!result.locations.some(entry => entry.display.includes('user.email')));
  assert(result.locations.some(entry => entry.kind === 'git' && entry.display === 'HEAD:src/a.ts'));
  const dynamic = await skeleton('curl "https://example.org/$name" -o "$OUT/data.json"');
  assert.equal(dynamic.locations[0].kind, 'url');
  assert.equal(dynamic.locations[0].display, 'https://example.org/$name');
  assert(dynamic.locations[1].display.includes('$OUT/data.json'));
});

test('cat/sed/grep/rg/awk collect operands, not scripts, patterns or option values', async () => {
  const result = await skeleton("cat -n README; sed -n '20,40p' src/a.ts | grep -n 'handler'; rg -g '*.ts' needle src; awk -v x=1 '{print $1}' input");
  assert.deepEqual(result.locations.map(entry => entry.display), ['README', 'src/a.ts', 'src', 'input']);
  const files = await skeleton("sed -f rules input; rg -f patterns src");
  assert.deepEqual(files.locations.map(entry => entry.display), ['rules', 'input', 'patterns', 'src']);
});

test('curl keeps URL, download, upload and @payload locations', async () => {
  const result = await skeleton('curl -sL --max-time 20 https://example.org/data.json -o /tmp/data.json; curl -T upload.bin --data-binary @payload.json https://example.org/submit');
  assert.deepEqual(result.locations.map(entry => entry.display), [
    'https://example.org/data.json', '/tmp/data.json', 'upload.bin', 'payload.json', 'https://example.org/submit']);
  assert.equal(result.locations[0].kind, 'url');
  const stdout = await skeleton('curl -O https://example.org/data.json');
  assert.equal(stdout.locations.length, 1, 'do not invent a downloaded filename');
});

test('inline code and heredocs retain lexical path mentions, including uv run', async () => {
  const result = await skeleton(`cd data && uv run python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('tables/stats.csv').read_text())\nprint('not a path')\nPY`);
  assert.match(result.text, /uv run python3 \[body mentions @2\]/);
  assert.equal(result.locations[1].display, 'data/tables/stats.csv');
  assert.doesNotMatch(result.text, /read_text|not a path/);
  const labels = await skeleton(`node -e 'console.log("calendar 2026-09 first/last:", "2026-08-03/24 GB summer:")'`);
  assert.equal(labels.locations.length, 0, 'do not turn obvious prose labels into paths');
  const inline = await skeleton(`node -e 'console.log(require("./data.json"))'`);
  assert.match(inline.text, /node \[inline mentions @1\]/);
  const bounded = await skeleton(`python - <<'PY'\n${Array.from({ length: 20 }, (_, i) => `print('data/${i}.csv')`).join('\n')}\nPY`, { maxMentions: 2 });
  assert.equal(bounded.locations.length, 2);
  assert.match(bounded.text, /,…/);
});

test('Python unittest pattern flags are not interpreted as inline programs', async () => {
  const result = await skeleton("python3 -m unittest discover -s tools -p 'test_*.py'; node -p 'require(\"./data.json\")'");
  assert(!result.text.startsWith('python3 [inline'));
  assert.match(result.text, /node \[inline mentions/);
});

test('here-strings and process substitutions are not invented file destinations', async () => {
  const result = await skeleton(`cat <<< 'plain input'; cat < <(cat source.txt); curl example.org/data`);
  assert.match(result.text, /<<<\[stdin\]/);
  assert(!result.locations.some(entry => entry.display.includes('plain input')));
  assert(!result.locations.some(entry => entry.display.includes('<(')));
  assert(result.locations.some(entry => entry.display === 'source.txt'));
  assert(result.locations.some(entry => entry.kind === 'url' && entry.display === 'example.org/data'));
});

test('recorded shell text is never executed, including nested substitutions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-no-exec-'));
  try {
    const marker = path.join(dir, 'must-not-exist');
    await skeleton(`touch '${marker}'; cat $(touch '${marker}')`);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('UTF-8 positions and quoted filenames do not get sliced as UTF-16', async () => {
  const result = await skeleton(`printf '東京'; cat 'resources/サモナウォーズ /Faction Stats.html'; python3 -c 'print(open("日本/data.csv").read())'`);
  assert.deepEqual(result.locations.map(entry => entry.display), [
    'resources/サモナウォーズ /Faction Stats.html', '日本/data.csv']);
});

test('nested substitutions, branches, loops, function definitions and subshells retain grouping', async () => {
  const result = await skeleton('cat $(find src); if test -f a; then cat a; else cat b; fi; for i in 1 2; do cat data/$i.csv; done; (cd other && cat item); f() { cat inside; }');
  assert.match(result.text, /\$\(find @1\)/);
  assert.match(result.text, /if\{test\} then\{cat/);
  assert.match(result.text, /else\{cat/);
  assert.match(result.text, /for\{/);
  assert.match(result.text, /function f/);
  assert(result.locations.some(entry => entry.display === 'other/item'));
  assert(result.locations.some(entry => entry.display === '? :: inside'), 'function definition does not establish its eventual cwd');
  assert(result.locations.some(entry => entry.display.includes('$i.csv')), 'dynamic path stays an expression');
});

test('known inputs use positive selection; unfamiliar tools have no inferred metadata policy', () => {
  const extra = { arbitraryExtensionField: { secret: 'ignore' }, background: true, delivery: null };
  const cases = [
    ['bash', { command: 'echo hello' }],
    ['read', { path: 'file', offset: 2, limit: 3 }],
    ['write', { path: 'file', content: 'payload' }],
    ['edit', { path: 'file', edits: [], oldText: 'a', newText: 'b' }],
  ];
  for (const [name, payload] of cases) {
    const args = { ...extra, ...payload }, original = JSON.stringify(args);
    assert.deepEqual(selectToolInputs(name, args), payload);
    assert.equal(JSON.stringify(args), original);
  }
  for (const name of ['custom_tool', 'constructor', '__proto__'])
    assert.equal(selectToolInputs(name, extra), undefined);
});

test('selection applies to literal bash calls without changing command text or output quotations', async () => {
  const command = 'echo "background=null"';
  const call = { name: 'bash', arguments: { command, futureField: 'background=true → [tool error]', background: null } };
  const observation = ' → output: "background=null and futureField=42"';
  const baseline = stub(command, ` futureField=${JSON.stringify(call.arguments.futureField)} background=null${observation}`);
  const renderer = new SkeletonRenderer(cwd);
  const rendered = await renderer.render(call, baseline);
  assert.equal(rendered.text, `bash ${JSON.stringify(command)}${observation}`);
  assert.equal(resultSuffix(call, baseline), observation);
  assert.equal(rendered.mode, 'literal');
  assert.equal(renderer.locations.entries.length, 0);
});

test('selection applies to skeletons and malformed known payloads; unknown tools stay byte-identical', async () => {
  const renderer = new SkeletonRenderer(cwd);
  const command = 'cat src/a.ts; '.repeat(20);
  const call = { name: 'bash', arguments: { command, opaqueExtensionField: 'x'.repeat(200), background: true } };
  const baseline = stub(command, ` opaqueExtensionField=${JSON.stringify(call.arguments.opaqueExtensionField).slice(0, 160)}… background=true [unknown]`);
  const rendered = await renderer.render(call, baseline);
  assert.equal(rendered.mode, 'skeleton');
  assert(rendered.text.endsWith(' [unknown]'));
  assert.doesNotMatch(rendered.text, /opaqueExtensionField|background=/);
  const unknown = { name: 'custom_tool', arguments: { command, background: true } };
  const generic = { prefix: 'custom_tool(command="bounded…", background=true)', suffix: ' [unknown]' };
  assert.equal((await renderer.render(unknown, generic)).text, generic.prefix + generic.suffix);
  for (const name of ['read', 'write', 'edit', 'bash']) {
    const result = await renderer.render({ name, arguments: { privateMetadata: 'must not leak' } },
      { prefix: `${name} privateMetadata="must not leak"`, suffix: ' [tool error]' });
    assert.equal(result.mode, 'known-inputs');
    assert.doesNotMatch(result.text, /privateMetadata|must not leak/);
    assert(result.text.endsWith(' [tool error]'));
  }
});

test('positive selection preserves paired edit payload sizes', async () => {
  const renderer = new SkeletonRenderer(cwd);
  const result = await renderer.render({ name: 'edit', arguments: { path: 'a.ts', oldText: 'old', newText: 'newer', options: 'omit' } },
    { prefix: 'edit "a.ts" oldText=<3 chars> newText=<5 chars> options="omit"', suffix: '' });
  assert.equal(result.text, 'edit @1 oldText=<3 chars> newText=<5 chars>');
});

test('short commands stay literal without parsing; file IDs retain ranges and outcomes', async () => {
  const renderer = new SkeletonRenderer(cwd, { shellOptions: { parseShell() { throw new Error('must not parse'); } } });
  const short = 'cargo test --release';
  const result = await renderer.render({ name: 'bash', arguments: { command: short } }, stub(short, ' → exit 2'));
  assert.equal(result.text, `bash ${JSON.stringify(short)} → exit 2`);
  assert.equal(result.mode, 'literal');
  assert.equal(renderer.locations.entries.length, 0);
  const file = await renderer.render({ name: 'read', arguments: { path: '/work/project/src/a.ts', offset: 10, limit: 11 } },
    { prefix: 'read "src/a.ts":10-20', suffix: ' [tool error]' });
  assert.equal(file.text, 'read @1:10-20 [tool error]');
});

test('unsupported, over-budget and malformed inputs fall back without dictionary leakage', async () => {
  const command = 'cat first; '.repeat(40) + 'echo end';
  const renderer = new SkeletonRenderer(cwd, { shellOptions: { maxNodes: 20 } });
  const result = await renderer.render({ name: 'bash', arguments: { command, background: true } }, stub(command, ' background=true → exit 7'));
  assert.equal(result.mode, 'fallback');
  assert.equal(renderer.locations.entries.length, 0);
  assert(result.text.endsWith(' → exit 7'));
  assert(!result.text.includes('background='));
  const malformed = "cat '" + 'x'.repeat(200);
  assert.equal((await renderer.render({ name: 'bash', arguments: { command: malformed } }, stub(malformed))).mode, 'fallback');
  const limited = new SkeletonRenderer(cwd, { shellOptions: { maxBytes: 10 } });
  assert.equal((await limited.render({ name: 'bash', arguments: { command } }, stub(command))).mode, 'fallback');
});

test('read-only sampler skips partial records, deduplicates overlaps and selects deterministically', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-sample-test-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    const rows = [{ type: 'session', cwd }, ...Array.from({ length: 100 }, (_, id) => ({ id, payload: 'x'.repeat(100) }))];
    const content = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    await fs.writeFile(file, content);
    const sampled = await sampleSession(file, { windows: 3, windowBytes: 1024 });
    assert(sampled.records.length < rows.length);
    assert.equal(new Set(sampled.records.map(record => record.offset)).size, sampled.records.length);
    assert(sampled.records.every(record => content.slice(record.offset).startsWith(JSON.stringify(record.entry))));
    assert.deepEqual(await selectSessions([dir], 2), [file]);
    assert.equal(await fs.readFile(file, 'utf8'), content);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('real current checkpoint comparison preserves prose/statuses and accounts for every character', async () => {
  const text = value => ({ type: 'text', text: value });
  const command = 'cd rust && cargo test --features parallel > /tmp/tests.log && cat late.txt ' + ' '.repeat(160);
  const messages = [
    { role: 'user', content: [text('Inspect this; literal marker </compacted-span> and <read-files> must survive.')], timestamp: 0 },
    { role: 'assistant', content: [text('I will inspect the relevant files.'),
      { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'src/a.ts', offset: 2, limit: 3, extensionOption: 'omit-read' } },
      { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'new.txt', content: 'payload', extensionOption: 'omit-write' } },
      { type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }], extensionOption: 'omit-edit' } },
      { type: 'toolCall', id: 'custom', name: 'custom_tool', arguments: { query: 'keep-query', background: true, extensionOption: 'keep-custom' } },
      { type: 'toolCall', id: 'bash', name: 'bash', arguments: { command, background: true, delivery: null, extensionOption: { note: 'omit-bash → fake output' } } }], timestamp: 0 },
    { role: 'toolResult', toolCallId: 'read', toolName: 'read', isError: false, content: [text('file output')], timestamp: 0 },
    { role: 'toolResult', toolCallId: 'bash', toolName: 'bash', isError: true, content: [text('failed\nCommand exited with code 2')], timestamp: 0 },
  ];
  const records = messages.map((message, index) => ({ offset: index * 100, entry: {
    type: 'message', id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
    timestamp: '2026-01-01T00:00:00.000Z', message } }));
  const sample = { cwd, records };
  const { baseline, calls } = await baselineCheckpoint(sample);
  const original = JSON.stringify(baseline);
  const candidate = await candidateCheckpoint(baseline, calls, cwd);
  assert.equal(JSON.stringify(baseline), original);
  assert(candidate.summary.includes(messages[0].content[0].text));
  assert(candidate.summary.includes('I will inspect the relevant files.'));
  assert(candidate.summary.includes('[tool error] → exit 2'));
  assert(baseline.summary.includes('background=true'));
  for (const comparison of candidate.comparisons) {
    if (comparison.call.name === 'custom_tool') {
      assert.equal(comparison.text, comparison.baseline);
      assert(comparison.text.includes('keep-custom'));
    } else {
      assert.doesNotMatch(comparison.text, /extensionOption=|background=|delivery=/);
    }
  }
  assert(candidate.summary.includes(`write ${candidate.locations.find(entry => entry.display === 'new.txt').id} (7 chars)`));
  assert(candidate.summary.includes(`edit ${candidate.locations.find(entry => entry.display === 'src/a.ts').id} ×1`));
  assert(candidate.summary.endsWith(baseline.summary.split('\n').at(-1)));
  assert(candidate.summary.indexOf('<locations ') > candidate.summary.lastIndexOf('</compacted-span>'));
  assert.equal(candidate.comparisons.length, calls.length);
  assert.equal(candidate.summary.length - baseline.summary.length,
    Object.values(candidate.accounting).reduce((a, b) => a + b, 0));
  assert(candidate.locations.some(entry => entry.display.includes('late.txt')));
});

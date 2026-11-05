import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Locations } from '../extensions/lib/tool-stubs/locations.mjs';
import { shellSkeleton } from '../extensions/lib/tool-stubs/shell.mjs';
import { ToolRenderer } from '../extensions/lib/tool-stubs/renderer.mjs';
import { selectToolInputs } from '../extensions/lib/tool-stubs/inputs.mjs';
import { commandPreview } from '../extensions/lib/tool-stubs/display.mjs';

const cwd = '/work/project';
const skeleton = async command => {
  const locations = new Locations(cwd);
  return { ...(await shellSkeleton(command, locations)), locations: locations.entries };
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

test('location rendering is a plain lookup scoped to selected definitions', () => {
  const locations = new Locations(cwd);
  const file = locations.ref('a\nb.ts');
  const url = locations.ref('https://example.invalid/source');
  const before = JSON.stringify(locations.entries);
  assert.deepEqual(locations.render().split('\n').slice(1, -1), [
    `${file.id} "a\\nb.ts"`, `${url.id} URL "https://example.invalid/source"`,
  ]);
  assert(!locations.render(new Set([url.id])).includes(file.id));
  assert.equal(locations.render(new Set()), '');
  assert.equal(JSON.stringify(locations.entries), before);
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
  const bounded = await skeleton(`python - <<'PY'\n${Array.from({ length: 20 }, (_, i) => `print('data/${i}.csv')`).join('\n')}\nPY`);
  assert.equal(bounded.locations.length, 8);
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
  const renderer = new ToolRenderer(cwd);
  const rendered = await renderer.render(call.name, call.arguments, observation);
  assert.deepEqual(rendered, { prefix: 'bash ', command: { head: JSON.stringify(command) }, suffix: observation });
  assert.equal(renderer.locations.entries.length, 0);
});

test('selection applies to skeletons and malformed known payloads; unknown tools remain generic', async () => {
  const renderer = new ToolRenderer(cwd);
  const command = 'cat src/a.ts; '.repeat(20);
  const rendered = await renderer.render('bash', { command, opaqueExtensionField: 'x'.repeat(200), background: true }, ' [unknown]');
  assert(rendered.prefix.startsWith('bash{'));
  assert.equal(rendered.suffix, ' [unknown]');
  assert.doesNotMatch(JSON.stringify(rendered), /opaqueExtensionField|background=/);
  const unknown = await renderer.render('custom_tool', { query: 'keep me', background: true }, ' [unknown]');
  assert.deepEqual(unknown, { prefix: 'custom_tool(query="keep me", background=true)', suffix: ' [unknown]' });
  for (const name of ['read', 'write', 'edit', 'bash']) {
    const result = await renderer.render(name, { privateMetadata: 'must not leak' }, ' [tool error]');
    assert.deepEqual(result, { prefix: `${name} [${name === 'bash' ? 'command' : 'path'} unavailable]`, suffix: ' [tool error]' });
  }
});

test('positive selection preserves paired edit payload sizes', async () => {
  const renderer = new ToolRenderer(cwd);
  const result = await renderer.render('edit', { path: 'a.ts', oldText: 'old', newText: 'newer', options: 'omit' });
  assert.deepEqual(result, { prefix: 'edit @1 oldText=<3 chars> newText=<5 chars>', suffix: '', locations: ['@1'] });
});

test('short commands stay literal without parsing; file IDs retain ranges and outcomes', async () => {
  const renderer = new ToolRenderer(cwd);
  const short = 'cat short.txt';
  const result = await renderer.render('bash', { command: short }, ' → exit 2');
  assert.deepEqual(result, { prefix: 'bash ', command: { head: JSON.stringify(short) }, suffix: ' → exit 2' });
  assert.equal(renderer.locations.entries.length, 0, 'literal commands do not allocate AST path references');
  const file = await renderer.render('read', { path: '/work/project/src/a.ts', offset: 10, limit: 11 }, ' [tool error]');
  assert.deepEqual(file, { prefix: 'read @1:10-20', suffix: ' [tool error]', locations: ['@1'] });
});

test('unsupported, over-budget and malformed inputs fall back without dictionary leakage', async () => {
  const renderer = new ToolRenderer(cwd);
  renderer.locations.ref('already-known.txt');
  for (const command of [
    'cat first; '.repeat(1000), // Traversal budget, after allocating path references.
    'cat first; '.repeat(30000), // Parser byte budget.
    "cat '" + 'x'.repeat(200), // Syntax error.
    'declare -a values; ' + 'cat first; '.repeat(20), // Unsupported declaration node.
  ]) {
    const result = await renderer.render('bash', { command, background: true }, ' → exit 7');
    assert.deepEqual(result, { prefix: 'bash ', command: commandPreview(JSON.stringify(command)), suffix: ' → exit 7' });
    assert.equal(renderer.locations.entries.length, 1);
    assert.equal(renderer.locations.byKey.size, 1);
  }
  assert.equal(renderer.locations.ref('next.txt').id, '@2', 'failed renders leave no gaps or stale bindings');
});

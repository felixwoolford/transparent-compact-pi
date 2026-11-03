import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseShell } from '../extensions/lib/tool-stubs/parse.mjs';
import { shellSkeleton } from '../extensions/lib/tool-stubs/shell.mjs';
import { Locations } from '../extensions/lib/tool-stubs/locations.mjs';

const asset = name => new URL(`../extensions/lib/tool-stubs/parser/${name}`, import.meta.url);
const globals = () => Object.fromEntries(['Go', 'fs', 'path', 'registerShellParser'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

test('concurrent first use shares initialization without installing Go globals in Pi', async () => {
  const before = globals();
  const trees = await Promise.all(Array.from({ length: 12 }, (_, n) => parseShell(`cat source${n}.txt`)));
  trees.forEach((tree, n) => assert.equal(tree.Stmts[0].Cmd.Args[1].Parts[0].Value, `source${n}.txt`));
  assert.deepEqual(globals(), before);
});

test('returns upstream typed JSON, including string operators and unmodified byte positions', async () => {
  const tree = await parseShell(`printf '東京'; cat '日本/file.txt' && cat other | head`);
  assert.equal(tree.Type, 'File');
  assert.equal(tree.type, undefined, 'there is no wrapper AST schema');
  const binary = tree.Stmts[1].Cmd;
  assert.equal(binary.Type, 'BinaryCmd');
  assert.equal(binary.Op, '&&');
  assert.equal(binary.Y.Cmd.Op, '|');
  const arg = binary.X.Cmd.Args[1];
  assert.equal(arg.Pos.Offset, Buffer.byteLength(`printf '東京'; cat `));
  assert.equal(arg.Parts[0].Value, '日本/file.txt');
});

test('omitted zero-value fields and concrete Else clauses retain their meaning', async () => {
  const tree = await parseShell('if test -f x; then cat ""; else cat b; fi');
  const clause = tree.Stmts[0].Cmd;
  assert.equal(clause.Type, 'IfClause');
  assert.equal(clause.Else.Type, undefined, 'the concrete Go field does not need a Type key');
  assert.equal(clause.Then[0].Cmd.Args[1].Parts[0].Parts, undefined, 'empty double quotes omit their Parts');
  const output = await shellSkeleton('if test -f x; then cat ""; else cat b; fi', new Locations('/work'));
  assert.equal(output.text, 'if{test} then{cat @1} else{cat @2}');
  assert.equal((await parseShell('')).Type, 'File');
  assert.equal((await shellSkeleton('', new Locations('/work'))).text, '');
});

test('process substitution uses upstream operator spelling without an extra parenthesis', async () => {
  const output = await shellSkeleton('cat < <(cat source.txt)', new Locations('/work'));
  assert.equal(output.text, 'cat <[dynamic] <(cat @1)');
});

test('byte bounds and syntax errors do not poison subsequent parsing', async () => {
  await assert.rejects(parseShell('é', { maxBytes: 1 }), /byte budget/);
  await assert.rejects(parseShell(null), TypeError);
  await assert.rejects(parseShell("cat '"), SyntaxError);
  assert.equal((await parseShell('cat ok')).Stmts[0].Cmd.Type, 'CallExpr');
});

test('bundled WASM and unmodified Go support script match their build provenance', async () => {
  const build = JSON.parse(await readFile(asset('build.json'), 'utf8'));
  const gomod = await readFile(asset('go.mod'), 'utf8');
  assert.equal(build.module, 'mvdan.cc/sh/v3');
  assert(gomod.includes(`require ${build.module} ${build.version}`));
  assert(gomod.includes(`go ${build.go.slice(2)}`));
  for (const [name, digest] of [['shell.wasm', build.wasmSha256], ['wasm_exec.js', build.runtimeSha256], ...Object.entries(build.sourceSha256)])
    assert.equal(createHash('sha256').update(await readFile(asset(name))).digest('hex'), digest);
});

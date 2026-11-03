import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkeletonRenderer, renderBaseline, auditCues, checkpointPath, EXPERIMENT_LEGEND } from './renderer.mjs';
import { resultSuffix } from './tool-inputs.mjs';

const require = createRequire(import.meta.url);
const { piRoot, jitiAliases } = require('../../scripts/pi-runtime.cjs');
const { createJiti } = require(require.resolve('jiti', { paths: [piRoot] }));
const snapshotExtension = require('../../scripts/git-extension-snapshot.cjs');
export const BASELINE_REF = process.env.TC_BASELINE_REF || '92ae62a';
let handlerPromise;
async function baselineHandler() {
  return handlerPromise ??= (async () => {
    const jiti = createJiti(fileURLToPath(import.meta.url), { alias: jitiAliases });
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stub-baseline-'));
    process.once('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
    const baseline = snapshotExtension(fileURLToPath(new URL('../../', import.meta.url)), BASELINE_REF, temp);
    const factory = (await jiti.import(baseline.entryPath)).default;
    let handler;
    factory({ on: (name, fn) => { if (name === 'session_before_compact') handler = fn; },
      registerTool() {}, registerCommand() {} });
    assert(handler);
    return handler;
  })();
}

/** Run the pre-candidate renderer on one synthetic, cap-off excerpt checkpoint.
 * No historical compactions, control entries, context edits or forks are replayed.
 * Both candidates see identical messages/prose/results and the same artificial cut.
 */
export async function baselineCheckpoint(sample) {
  const selected = sample.records.filter(({ entry }) => entry.type === 'message' && entry.message &&
    ['user', 'assistant', 'toolResult', 'bashExecution'].includes(entry.message.role));
  const branch = selected.map(({ entry }, index) => ({ ...entry, id: `sample-${index}`, parentId: index ? `sample-${index - 1}` : null }));
  const calls = selected.flatMap(({ entry, offset }) => entry.message.role === 'assistant' && Array.isArray(entry.message.content)
    ? entry.message.content.filter(block => block.type === 'toolCall').map(call => ({ call, entryId: entry.id, offset })) : []);
  const messages = branch.map(entry => entry.message);
  const fileOps = { read: new Set(), written: new Set(), edited: new Set() };
  for (const { call } of calls) {
    const name = { read: 'read', write: 'written', edit: 'edited' }[call.name];
    if (name && typeof call.arguments?.path === 'string') fileOps[name].add(call.arguments.path);
  }
  const now = '2026-01-01T00:00:00.000Z';
  branch.push({ type: 'message', id: 'sample-tail', parentId: branch.at(-1)?.id ?? null, timestamp: now,
    message: { role: 'user', content: [{ type: 'text', text: 'Synthetic retained tail (offline comparison).' }], timestamp: 0 } });
  branch.push({ type: 'custom', id: 'sample-cap', parentId: 'sample-tail', timestamp: now,
    customType: 'transparent-compact:cap-compaction', data: { mode: 'off', budget: { unit: 'chars', value: 80000 } } });
  const ctx = { cwd: sample.cwd, sessionManager: { getBranch: () => branch }, model: { contextWindow: 10000000 },
    hasUI: false, mode: 'json', ui: { notify(message, level) { if (level === 'error') throw new Error(message); } } };
  const response = await (await baselineHandler())({ branchEntries: branch, reason: 'manual', signal: new AbortController().signal,
    preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: 'sample-tail', tokensBefore: 0, fileOps } }, ctx);
  assert(response?.compaction, 'baseline must not silently fall back to a model');
  const baseline = response.compaction;
  assert.equal(baseline.details.span.tools?.lines.reduce((n, line) => n + line.calls.length, 0) ?? 0, calls.length);
  return { baseline, calls, messages: messages.length, selectedRecords: selected.length };
}

function replaceBody(baseline, lines) {
  const heading = '\n### Compacted conversation (oldest first)\n';
  const headingAt = baseline.summary.indexOf(heading);
  assert(headingAt >= 0);
  const opening = baseline.summary.indexOf('\n<compacted-span ', headingAt + heading.length);
  assert(opening >= 0);
  const start = baseline.summary.indexOf('\n', opening + 1) + 1;
  const original = baseline.details.span.lines.join('\n');
  assert.equal(baseline.summary.slice(start, start + original.length), original);
  assert(baseline.summary.slice(start + original.length).startsWith('\n</compacted-span>'));
  return { prefix: baseline.summary.slice(0, start), body: lines.join('\n'),
    suffix: baseline.summary.slice(start + original.length) };
}

export async function candidateCheckpoint(baseline, calls, cwd, options = {}) {
  const renderer = new SkeletonRenderer(cwd, options);
  for (const file of [...baseline.details.readFiles, ...baseline.details.modifiedFiles]) renderer.locations.ref(file, cwd, 'path', true);
  const lines = baseline.details.span.lines.slice(), comparisons = [];
  let at = 0;
  for (const record of baseline.details.span.tools?.lines ?? []) {
    const rendered = [];
    for (const stub of record.calls) {
      const provenance = calls[at++];
      const candidate = await renderer.render(provenance.call, stub);
      assert(candidate.text.endsWith(resultSuffix(provenance.call, stub)), 'tool status and outcomes must survive after argument selection');
      rendered.push(candidate.text);
      comparisons.push({ ...provenance, baseline: renderBaseline(stub), ...candidate, cues: auditCues(stub, candidate) });
    }
    lines[record.index] = '[Tools]: ' + rendered.join('; ');
  }
  assert.equal(at, calls.length);
  const parts = replaceBody(baseline, lines);
  const oldPrefix = parts.prefix;
  const introStart = parts.prefix.indexOf('\n- In the compacted spans,');
  assert(introStart >= 0);
  const introEnd = parts.prefix.indexOf('\n', introStart + 1);
  parts.prefix = parts.prefix.slice(0, introStart + 1) + EXPERIMENT_LEGEND + parts.prefix.slice(introEnd);
  const oldSuffix = parts.suffix;
  // Only rewrite the last generated file-list block, never prose or startup reads.
  const fileNotice = '\nFile lists record earlier operations.';
  const listsAt = parts.suffix.lastIndexOf(fileNotice);
  if (listsAt >= 0) {
    const before = parts.suffix.slice(0, listsAt), after = parts.suffix.slice(listsAt);
    const paths = [...baseline.details.readFiles, ...baseline.details.modifiedFiles]
      .map(file => [checkpointPath(file, cwd), renderer.locations.ref(file, cwd, 'path', true).id]).sort((a, b) => b[0].length - a[0].length);
    const rewritten = after.split('\n').map(line => {
      const match = paths.find(([display]) => line === display || line.startsWith(display + ' ('));
      return match ? match[1] + line.slice(match[0].length) : line;
    }).join('\n');
    parts.suffix = before + rewritten;
  }
  const dictionary = renderer.locations.render();
  const dictionaryBlock = dictionary ? '\n\n' + dictionary : '';
  // The existing retained-boundary line remains the very last line.
  const boundary = parts.suffix.lastIndexOf('\n\n**Evidence boundary:**');
  assert(boundary >= 0);
  const summary = parts.prefix + parts.body + parts.suffix.slice(0, boundary) + dictionaryBlock + parts.suffix.slice(boundary);
  const beforeTools = baseline.details.span.tools?.lines.reduce((n, record) => n + linesLength(baseline.details.span.lines[record.index]), 0) ?? 0;
  const afterTools = baseline.details.span.tools?.lines.reduce((n, record) => n + linesLength(lines[record.index]), 0) ?? 0;
  const accounting = { toolDeltaChars: afterTools - beforeTools, dictionaryChars: dictionaryBlock.length,
    fileListDeltaChars: parts.suffix.length - oldSuffix.length, legendDeltaChars: parts.prefix.length - oldPrefix.length };
  assert.equal(summary.length - baseline.summary.length, Object.values(accounting).reduce((a, b) => a + b, 0));
  // All non-tool span lines, including user/assistant prose, are byte-for-byte identical.
  const toolIndices = new Set(baseline.details.span.tools?.lines.map(line => line.index));
  lines.forEach((line, index) => { if (!toolIndices.has(index)) assert.equal(line, baseline.details.span.lines[index]); });
  return { summary, lines, comparisons, locations: renderer.locations.entries, beforeStubChars: beforeTools, afterStubChars: afterTools, accounting };
}
const linesLength = line => line.length + 1;

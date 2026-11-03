#!/usr/bin/env node
// Offline only. Recorded commands are DATA: never executed, fetched or expanded.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sampleSession, selectSessions } from './sample.mjs';
import { baselineCheckpoint, candidateCheckpoint, BASELINE_REF } from './checkpoint.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1]) throw new Error(`Missing value for ${name}`);
  return args.splice(at, 2)[1];
}
const outOption = option('--out', null);
const limits = String(option('--limits', '120,160')).split(',').map(Number);
const sessionsPerDir = Number(option('--sessions-per-dir', 2));
const windows = Number(option('--windows', 4)), windowBytes = Number(option('--window-bytes', 393216));
assert(limits.every(n => Number.isInteger(n) && n >= 1 && n <= 160), '--limits must be comma-separated values in 1–160');
assert(Number.isInteger(sessionsPerDir) && sessionsPerDir > 0);
assert(Number.isInteger(windows) && windows > 0 && windows <= 32);
assert(Number.isInteger(windowBytes) && windowBytes >= 1024 && windowBytes <= 16777216);
assert(args.length && args.every(arg => !arg.startsWith('--')),
  'Usage: node experiments/tool-stubs/compare.mjs [--out DIR] [--limits 120,160] [--sessions-per-dir 2] [--windows 4] [--window-bytes 393216] <session.jsonl|directory> [...]');
const out = outOption ? path.resolve(outOption) : await fs.mkdtemp(path.join(os.tmpdir(), 'tc-skeleton-'));
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const save = (file, text) => fs.writeFile(path.join(out, file), text, { mode: 0o600, flag: 'wx' });
const digest = records => createHash('sha256').update(JSON.stringify(records)).digest('hex');
const files = await selectSessions(args, sessionsPerDir);
assert(files.length, 'No session JSONL files found');
const sourceFiles = ['../../extensions/index.ts', '../../extensions/lib/checkpoint-cap.ts',
  '../../extensions/lib/tool-stubs/display.mjs', '../../extensions/lib/tool-stubs/inputs.mjs',
  '../../extensions/lib/tool-stubs/locations.mjs', '../../extensions/lib/tool-stubs/shell.mjs', '../../extensions/lib/tool-stubs/renderer.mjs',
  './locations.mjs', './shell.mjs', './tool-inputs.mjs', './renderer.mjs', './checkpoint.mjs', './sample.mjs', './compare.mjs'];
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file,
  createHash('sha256').update(await fs.readFile(new URL(file, import.meta.url))).digest('hex')])));
const report = { baselineRef: BASELINE_REF, sources, node: process.version, methodology: [
  'Bounded deterministic byte windows; partial boundary records and overlapping duplicates are skipped.',
  'Raw sampled message records, not reconstructed active branches. Historical controls/compactions/context edits are not replayed.',
  'One synthetic cap-off checkpoint per sampled session, with the same artificial cut and identical prose/results for every renderer.',
  'Baseline is the pre-candidate extension at baselineRef (override with TC_BASELINE_REF); candidate changes only tool display, its legend, file-list path references, and a location dictionary.',
  'No model calls, recorded-command execution, path reads, URL requests, environment expansion, or SessionManager opens/migrations.',
  'All sizes are UTF-16 characters, not tokenizer counts. Full checkpoint sizes include dictionary and legend costs.',
  'Cue visibility measures per-call lexical associations, not necessarily facts absent globally from prose or file lists. It does not establish semantic correctness, comprehensive extraction, or agent performance.',
  'Known tools retain positively selected inputs only, dropping all other call arguments regardless of extension. Unknown tools retain the baseline bounded argument display.',
  'Short bash commands keep their literal command preview but drop other call arguments. They do not require parsing or create additional dictionary entries.',
], sampling: { sessionsPerDir, windows, windowBytes }, limits, sessions: [] };

for (const [index, file] of files.entries()) {
  const sample = await sampleSession(file, { windows, windowBytes });
  const signature = digest(sample.records);
  const { baseline, calls, messages, selectedRecords } = await baselineCheckpoint(sample);
  const name = `${index + 1}-${path.basename(path.dirname(file))}-${path.basename(file, '.jsonl')}`;
  await save(`${name}.baseline.md`, baseline.summary);
  const session = { file, cwd: sample.cwd, fileBytes: sample.size, ranges: sample.ranges,
    sampledRecordsHash: signature, selectedRecords, messages, toolCalls: calls.length,
    baselineCheckpointChars: baseline.summary.length, variants: [] };
  for (const shortLimit of limits) {
    const candidate = await candidateCheckpoint(baseline, calls, sample.cwd, { shortLimit });
    assert.equal(digest(sample.records), signature, 'rendering must not mutate input records');
    const modes = {}, cues = {};
    for (const comparison of candidate.comparisons) {
      modes[comparison.mode] = (modes[comparison.mode] ?? 0) + 1;
      for (const cue of comparison.cues) {
        const counts = cues[cue.kind] ??= { total: 0, baselineVisible: 0, candidateVisible: 0, newlyVisible: 0 };
        counts.total++;
        counts.baselineVisible += Number(cue.baselineVisible);
        counts.candidateVisible += Number(cue.candidateVisible);
        counts.newlyVisible += Number(cue.candidateVisible && !cue.baselineVisible);
      }
    }
    const variant = { shortLimit, checkpointChars: candidate.summary.length,
      deltaChars: candidate.summary.length - baseline.summary.length,
      deltaPercent: 100 * (candidate.summary.length / baseline.summary.length - 1),
      beforeStubChars: candidate.beforeStubChars, afterStubChars: candidate.afterStubChars,
      locations: candidate.locations.length, accounting: candidate.accounting, modes, cues };
    session.variants.push(variant);
    await save(`${name}.${shortLimit}.md`, candidate.summary);
    await save(`${name}.${shortLimit}.calls.json`, JSON.stringify(candidate.comparisons, null, 2));
    // Include all calls in a readable review, so examples are not cherry-picked.
    const review = candidate.comparisons.map((call, n) => [
      `## ${n + 1}. ${call.call.name} — ${call.mode}`, `Source entry ${call.entryId}; byte ${call.offset}`,
      '### Original arguments', '```json', JSON.stringify(call.call.arguments, null, 2), '```',
      '### Current', '```text', call.baseline, '```', '### Candidate', '```text', call.text, '```',
      ...(call.reason ? [`Fallback: ${call.reason}`] : []),
      'Referenced locations: ' + candidate.locations.filter(entry => call.refs.includes(entry.id))
        .map(entry => `${entry.id}=${JSON.stringify(entry.display)}`).join('; '),
    ].join('\n')).join('\n\n');
    await save(`${name}.${shortLimit}.review.md`, review);
    console.log(`${path.basename(path.dirname(file))}/${path.basename(file)} limit=${shortLimit}: ${calls.length} calls; checkpoint ${baseline.summary.length} → ${candidate.summary.length} (${variant.deltaPercent.toFixed(1)}%); stubs ${variant.beforeStubChars} → ${variant.afterStubChars}; ${modes.fallback ?? 0} fallbacks`);
  }
  // Re-read only the same bounded windows, not entire sessions, to check inputs.
  const after = await sampleSession(file, { windows, windowBytes });
  assert.equal(digest(after.records), signature, 'sampled source records changed during the audit');
  report.sessions.push(session);
}
report.totals = limits.map(shortLimit => {
  const variants = report.sessions.map(session => session.variants.find(variant => variant.shortLimit === shortLimit));
  const baselineChars = report.sessions.reduce((n, session) => n + session.baselineCheckpointChars, 0);
  const candidateChars = variants.reduce((n, variant) => n + variant.checkpointChars, 0);
  const beforeStubChars = variants.reduce((n, variant) => n + variant.beforeStubChars, 0);
  const afterStubChars = variants.reduce((n, variant) => n + variant.afterStubChars, 0);
  const cues = {};
  for (const variant of variants) for (const [kind, counts] of Object.entries(variant.cues)) {
    const total = cues[kind] ??= { total: 0, baselineVisible: 0, candidateVisible: 0, newlyVisible: 0 };
    for (const key of Object.keys(total)) total[key] += counts[key];
  }
  return { shortLimit, baselineChars, candidateChars, deltaPercent: 100 * (candidateChars / baselineChars - 1),
    beforeStubChars, afterStubChars, stubDeltaPercent: 100 * (afterStubChars / beforeStubChars - 1), cues };
});
await save('report.json', JSON.stringify(report, null, 2));
console.log(`\nArtifacts (private session content): ${out}`);
console.log(JSON.stringify(report.totals, null, 2));

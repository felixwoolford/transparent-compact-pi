# Contributing

## Setup

Use Node.js 22.19 or newer:

```bash
npm ci --ignore-scripts
npm test
```

The development dependency pins Pi 1.1.0. Runtime imports are host-provided peer
dependencies; do not bundle additional copies of Pi's runtime packages.

To test against an existing Pi installation instead, point to its package root:

```bash
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent npm test
```

This must contain `dist/index.js`, not be the CLI binary. The test helper also
checks local dependencies and global npm installations.

## Tests

`npm test` runs:

- Synthetic-session integration tests using real Pi session managers and stubbed
  model responses: recovery across three compactions, full thinking/output/args,
  flat spans, cumulative file lists, branch scoping, and exact entry rendering.
- Instruction-envelope regressions: recovery guidance before the compacted spans,
  boundary warning after them, and a mandatory checklist/recovery recap after a
  roughly 20k-token retained tail. Real SDK turns cover persistence across responses,
  repeated compaction without duplicate instructions, mid-run compaction and overflow
  retry; branch tests cover reload/resume and old checklists in spans or the tail.
  These test delivery, not model compliance.
- Retained file-evidence annotations: built-in read truncation/limits, path aliases,
  visible write payloads, later mutations, context edits, startup reads, and repeated
  compaction. Actual SDK requests cover both retained-source and plan-only tails.
- Skill validation and agreement with the question-only lookup contract.
- Compact stub rendering, head/tail command previews, conservative historical
  output labels, and direct call/result refs. Synthetic regressions cover tiny
  outputs versus truncated/media results, read/search false positives, deleted
  scratch payload recovery, repeated compaction, related-entry pagination, reverse
  results, reused/ambiguous IDs, and branch scoping. These test mechanics, not
  live-model recovery quality.
- Header/section spoofing resistance and internal lookup tool dispatch.
- Absolute session-file override tests, including pruned forks, reload at lookup
  time, invalid paths, missing/empty files, and no silent fallback.
- Empty/no-model, cancellation, provider-error, and exhausted write-up tests.
  Fresh-process lookup tests cover the 25-turn default, environment overrides,
  invalid-value fallbacks, and the 3× total-call ceiling. Soft-limit answers cover
  incomplete markers, fallback guidance, pagination, and long/empty responses.
- Default-budget retention, small-budget termination, and cross-span size guards.
- A package smoke test checking `npm pack --dry-run`, then Pi's real package
  resolver, extension loader, registered tool/schema, and skill loader.

No live model calls, credentials, network inference, or GPU are needed. Fixtures
and temporary session files are synthetic and removed after the tests. The
runner clears configuration variables in child processes so personal settings
cannot redirect lookups to real session files.

Individual scripts are `test:integration`, `test:cap`, `test:caphang`,
`test:capspans`, and `test:package`.

### Optional local session-audit replay

To measure file-list footprint on explicitly supplied session history:

```bash
node scripts/file-evidence-replay.cjs /path/to/session.jsonl
```

This is a read-only audit, not the agent's compaction-recovery workflow or part of
`npm test`. It rebuilds both versions at the recorded cut points, with a
131072-token model window and a default 25% cap; recorded session cap settings
still apply. All spans are re-rendered, rather than inheriting old tool signatures.
The default baseline is the 0.8.7 commit; set `TC_BASELINE_REF` to override it.
Inputs are not modified or copied into fixtures. Results measure deterministic
formatting and evidence labels, not live-model behaviour. Do not commit private
sessions or sensitive audit output.

For tool-stub comparisons, use the separate read-only replay:

```bash
TC_BASELINE_REF=81aa585e node scripts/tool-stub-replay.cjs /path/to/session.jsonl
```

Choose the pre-change baseline commit (`HEAD` by default). This rebuilds both
renderers at recorded active-branch cut points with capping disabled, checks prose
and reference preservation, and smoke-tests paginated call/result recovery. It
writes before/after checkpoints and a JSON report into a private temporary directory
(or `--out DIR`). Artifacts contain session content: do not commit or share them
without approval. Measurements are characters, not tokens or live-model outcomes;
recorded tool commands are never executed and input files remain byte-identical.

## Manual check

Load the checkout with `pi -e /absolute/path/to/transparent-compact`, avoiding duplicate
installed copies. In a disposable project, produce a distinctive tool result,
trigger `/compact`, and ask for the exact earlier result through `context_lookup`.
Repeat across several compactions. Verify the retained boundary, file lists,
entry citations, and that recovery uses retained session history without creating
additional files.

Do not use real credentials or private session history in fixtures. Reports
should include the Pi version, model/provider, relevant settings, and a minimal
redacted reproduction. Recovered thinking is not independently verified evidence.

## Changes

Keep runtime behavior, skill instructions, and documentation consistent. Add a
regression for changes to span boundaries, branch scope, lookup sources, or output
limits. Put evaluation results in `docs/` and distinguish integration tests from
model-quality experiments. Historical pilot figures must remain labeled with the
implementation actually evaluated.

The source is loaded as TypeScript by Pi; no build step is required. Contributions
are distributed under the project's MIT license.

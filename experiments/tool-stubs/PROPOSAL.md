# Experimental tool breadcrumbs

## Goal and status

Give the future agent more clues about **where it was operating and the broad
activity between prose messages**, with smaller checkpoints. Intent comes from
prose; detailed methods and outcomes remain recoverable from the session.
A small size increase is acceptable when it preserves useful additional clues.

The candidate is now the **live default on this branch**, implemented in
`extensions/lib/tool-stubs/`. This directory remains the offline comparison and
review harness, sharing the exact live renderer rather than maintaining a second
candidate implementation. No feature flag is needed for real-world tests.

## Proposed display policy

1. Keep short bash commands in the current literal display, including its
   working-directory shortening. Default cutoff: **160 encoded characters**;
   also compare 120. Retain only the `command` argument, not execution options.
   Short commands bypass the parser and create no additional dictionary entries:
   their locations are already visible literally.
2. Parse the full original command for longer calls, never its truncated prefix.
   Render a shell skeleton retaining command names, common subcommands, paths,
   pipes, conditional sequencing, redirects, background markers and grouping.
3. Generally discard flags and other arguments. Parse some options to locate
   their path values, but do not print the flags themselves. No attempt to
   preserve simulation parameters or command replayability.
4. Replace dedicated read/write/edit paths and skeleton location operands with
   append-only IDs. Keep requested read ranges and write/edit payload sizes/counts.
5. For interpreter bodies, retain the interpreter and bounded, lexical path
   mentions; omit program text. Do not infer purpose or filesystem effects.
6. Preserve the current tool status and selected output observations unchanged.
   The prototype does not add outcome inference.
7. Fall back to the existing literal command preview for malformed, unsupported
   or oversized shell syntax. Argument selection still applies on fallback;
   execution options do not reappear. Do not leave unused IDs after a failed attempt.

Example (illustrative, not a recorded session):

```text
[Tools]: read @1:10-40
[Tools]: bash{cd @2 && cargo fmt && cargo test >@3 | tail}
[Tools]: bash{python3 [body mentions @4]}

<locations ...>
@1 "rust/src/lib.rs"
@2 "rust"
@3 "/tmp/tests.log"
@4 "data/results.csv"
</locations>
```

Skeletons are display notation, not executable commands. There is no hard
160-character cutoff for the resulting skeleton: later actions and operands
should not be hidden merely to reproduce the existing preview length.

### Known-tool input selection

Known tools use a positive selection, independent of which extension supplies
extra arguments:

| Tool | Retained inputs |
|---|---|
| bash | `command` |
| read | `path`, `offset`, `limit` |
| write | `path`, `content` (displayed as a character count) |
| edit | `path`, `edits` (count), `oldText`/`newText` (sizes) |

All other arguments are omitted, including arbitrary future extension fields,
not just named options such as `background`, `delivery` or `timeout`. Missing
primary inputs produce a minimal unavailable-input marker rather than exposing
unselected arguments. Shell syntax such as `&` remains part of the command, not
harness metadata.

Unknown tools keep the current bounded, agnostic argument display unchanged.
There is no schema guessing or extension blacklist. Result status and selected
output observations remain separate and survive input selection unchanged.

### Locations, not a filesystem-access audit

The dictionary covers references actually used by IDs. It is not an exhaustive
inventory of every access, every short command, or every file printed in output.
Existing read/modified lists retain their operation/evidence annotations, but
refer to the dictionary by ID rather than repeating full paths.

The small operand-rule set covers:

- Explicit dedicated file-tool paths.
- File operands for cat/head/tail/wc/ls/cp/mv/rm/mkdir/touch and similar utilities.
- Input operands for sed/awk/grep/rg, excluding recognized patterns/programs.
- Explicit find roots, not the search expression or discovered files.
- Git path operands and separately labelled `revision:path` references.
- Curl URL operands, output/upload/config paths, and `@file` payloads.
- Shell redirection targets. Descriptor duplication and here-string text are not
  invented filesystem paths.
- Path-shaped operands for unfamiliar commands, and quoted path-shaped strings
  in opaque inline bodies.

Ordinary sed is not automatically classified as an edit. Curl's stdout is not
invented as a local file, and `curl -O` does not synthesize a destination filename.
A location reference alone does not claim a successful read, write or modification.

Paths are lexical and scoped to the recorded session cwd. Static `cd` chains
follow the success path relevant to `&&`; pipelines/subshells do not leak cwd
changes. Ambiguous branches and function-definition bodies can have unknown cwd,
shown as `? :: relative/path`. Variables, globs and brace expressions are not
expanded. No filesystem probes or symlink resolution occur. An absolute-looking
string inside program text is only a mention: it may be a concatenation fragment,
not the complete runtime pathname.

## Modules and experimental seams

| File | Responsibility |
|---|---|
| `locations.mjs`, `shell.mjs` | Re-export the live dictionary and AST implementation. |
| `tool-inputs.mjs` | Re-export live positive selection; isolate result annotations from the old baseline. |
| `renderer.mjs` | Thin comparison adapter around the live renderer's diagnostics API. |
| `sample.mjs` | Deterministic bounded session selection and byte-window sampling. |
| `checkpoint.mjs` | Invoke the real current extension, then substitute only generated tool presentation. |
| `compare.mjs` | Run variants, write candidates/reviews and report accounting. |
| `tests.mjs` | Behavioural tests and a real-extension comparison invariant. |

`SkeletonRenderer.render(call, baselineStub)` consumes original arguments and the
current bounded presentation record. It returns display text, referenced IDs,
mode/fallback information, and lexical cues for inspection. It does not modify
arguments, baseline records or checkpoint metadata. The baseline adapter checks
and removes the exact argument-derived suffix prefix for bash; it never searches
for marker text that could also occur inside arguments or quoted output.

To change an experiment, edit the corresponding module in
`extensions/lib/tool-stubs/`, or instantiate `SkeletonRenderer` with a different
`shortLimit` or `shellOptions`. Production compaction stores only display stubs,
not the offline diagnostic cues. Location identities are persisted in compaction
details and remain append-only across subsequent checkpoints.

The baseline is the original truncation implementation at git ref `92ae62a`,
materialized read-only in a temporary directory. `TC_BASELINE_REF` can select
another pre-candidate ref. Keep the baseline commit available in repository
history when running comparisons.

### Parser choice

Use the complete mvdan/sh AST exposed by
[`@questi0nm4rk/shell-ast`](https://github.com/Questi0nM4rk/shell-ast), pinned as a
**runtime** dependency. Only its parser is used; no effect classifier,
execution engine or security policy is adopted. It bundles WASM, so comparison
requires neither Python, Go nor an installed shfmt executable.

[`bashxtract`](https://github.com/AnswerDotAI/safecmd/blob/main/safecmd/bashxtract.py)
is useful reference material, but its final command list and operator set flatten
relationships that the skeleton should retain. Its `shfmt --to-json` input is the
right structural model.

The evaluated `sh-syntax` API exposes reduced nodes that lose command arguments;
it is insufficient for this prototype. The full-AST wrapper remains replaceable
at the live `shell.mjs`. The pinned published package is MIT-licensed and is
installed with the extension as an ordinary runtime dependency.

Limits are deliberately simple: default 256 KiB parser input, 2,048 traversal
visits, 64 KiB scanned per body and eight distinct body path mentions. Exceeding
the parser/traversal limits falls back to the existing preview. Body mention
limits produce an ellipsis. These are resource guardrails, not runtime performance
claims; performance/compliance evaluation is separate.

## Running comparisons

From the repository root, after `npm ci`:

```bash
npm run test:tool-stubs

npm run compare:tool-stubs -- \
  --out /tmp/tc-stub-review \
  --limits 120,160 \
  --sessions-per-dir 2 \
  --windows 4 \
  --window-bytes 393216 \
  ~/.pi/agent/sessions/tmp/ \
  ~/.pi/agent/sessions/--work-summonerwars--/ \
  ~/.pi/agent/sessions/--work-alife-jc--/ \
  ~/.pi/agent/sessions/--work-compaction-verbatim-compact-release--/
```

An explicit session JSONL path can replace any directory. Directory selection is
a deterministic spread across sorted filenames. Omit `--out` for a fresh temporary
directory. Artifact files are created privately and never overwritten; choose a
new output directory for another run. They contain private conversation and tool
arguments and should not be committed. Use idle sessions: changed sampled records
cause the audit to fail.

Outputs include:

- `*.baseline.md`: checkpoint from the pinned pre-candidate extension.
- `*.120.md`, `*.160.md`: complete candidate checkpoints.
- `*.calls.json`: all source calls, source entry IDs/byte offsets, baseline and
  candidate displays, ID references, lexical cue visibility and fallback reasons.
- `*.review.md`: readable comparisons of **all calls**, not selected success cases.
- `report.json`: sampling provenance, source hashes, per-session and aggregate
  sizes, mode counts and cue diagnostics.

All sizes are **UTF-16 characters, not tokens**. Report checkpoint size including
its dictionary and legend, not just shortened stub bodies. Accounting separately
identifies tool changes, dictionary cost, existing-file-list changes and legend
changes. Prose, status suffixes and non-tool span lines are asserted unchanged.

### What this experiment does and does not establish

The harness reads bounded byte windows, skips partial boundary records and
removes overlapping duplicates. It constructs **one synthetic, cap-off excerpt
checkpoint per session** from the selected raw messages. Both renderers see
identical prose/results and the same artificial cut. It does not replay historical
compaction cuts, reconstruct the active branch, apply historical context edits,
or carry native-fidelity selections. Thus these are sampled checkpoint sizes,
**not rebuilt historical checkpoint sizes**.

No models, recorded tools, URLs or referenced files are accessed. No sessions are
opened through SessionManager or migrated. The current extension is loaded with a
stubbed extension-registration API and its real compaction handler is invoked in
memory. Sampled records are checked for mutation and re-read from the same bounded
windows at the end.

Cue visibility is a lexical review aid: it counts candidate-captured command,
subcommand, location and operator associations missing from the old per-call
preview. It does not measure total information, prove extraction completeness,
or imply those facts were absent globally from prose/file lists. The candidate
can discard useful literal arguments, and path heuristics can retain irrelevant
strings. In particular, combined short flags, uncommon option arities, nested
shell-interpreter bodies and commands embedded in `find -exec`/xargs are not
comprehensively understood. Unix pathname syntax is assumed. Review original
arguments alongside both displays, including size regressions, before choosing
a policy.

## Live integration and further experiments

Live compaction renders from the original projected arguments and persists only
its display records and canonical location registry. It never reconstructs a
skeleton from a saved truncated preview. Filtering, full-fidelity replacement and
capping remove unused dictionary definitions without deleting canonical bindings.
The cap counts dictionary characters and does not shorten skeletons into partial syntax.
Package tests load and compact from an isolated package tree with the runtime
parser and no experiment files or devDependencies.

**Dictionary placement remains at the end.** Preserve the checkpoint's start for
session-start information. A future independent behavioural experiment should
compare dictionary-first with dictionary-last; do not duplicate the table or move
it merely on the basis of indirect prompt-order research.

See `RESULTS.md` for the initial bounded-sample measurements.

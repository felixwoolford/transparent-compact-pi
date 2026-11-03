# Bounded-sample comparisons

Baseline: current extension source at `92ae62a`, unchanged by this experiment.
Initial candidate: the prototype before positive argument selection, using the
pinned full-AST parser. The updated candidate is measured in the follow-up below.

This is an information/display and size comparison, **not an agent-performance
study or runtime benchmark**. The raw arguments and both displays are available
for separate review. Method and commands are in `PROPOSAL.md`.

## Sample

Default deterministic selection from the four requested session directories:
seven sessions, four windows of up to 393,216 bytes per session, **603 assistant
tool calls**. Windows can overlap in small sessions; records are deduplicated.
Partial boundary records are excluded, so very large records can be missed.

Each session becomes one synthetic cap-off excerpt checkpoint. These are not the
original checkpoints and do not reconstruct active branches or historical cuts.
All variants retain identical sampled prose/results and use the actual current
extension for their baseline. Sizes below are UTF-16 characters, not tokens.

## Aggregate sizes

| Presentation | Whole checkpoints | Change | Tool lines | Change |
|---|---:|---:|---:|---:|
| Current 160-character prefixes | 232,867 | — | 55,281 | — |
| Skeletons; keep literals through 120 | 221,555 | −4.86% | 32,651 | −40.94% |
| Skeletons; keep literals through 160 | 222,499 | −4.45% | 33,686 | −39.06% |

Whole-checkpoint totals include the location dictionary, revised display legend,
and existing read/modified lists rewritten to IDs. Stub-only savings would
substantially overstate the final benefit.

For the 160 variant, the net −10,368 characters comprise:

- Tool-line reduction: **−21,595**.
- Location dictionaries: **+15,486**.
- Existing file-list path replacement: **−3,706**.
- Display-legend change: **−553**.

## Per-session sizes, 160 variant

| Sample | Current | Candidate | Change |
|---|---:|---:|---:|
| tmp / holiday-map | 22,134 | 20,296 | −8.3% |
| tmp / jsonpath | 48,553 | 44,778 | −7.8% |
| summonerwars | 15,657 | 13,982 | −10.7% |
| alife-jc / 2026-10-01 14:30 | 11,844 | 11,156 | −5.8% |
| alife-jc / 2026-10-28 | 103,095 | 103,771 | **+0.7%** |
| this project / 2026-10-27 16:05 | 11,911 | 11,316 | −5.0% |
| this project / 2026-11-01 | 19,673 | 17,200 | −12.6% |

The growing sample is retained in the evaluation, not rejected because of size.
It has substantial prose and numerous additional path mentions: its tool lines
shrink, but the larger dictionary more than consumes those savings.

## Additional visible associations

For both cutoffs, the lexical diagnostic identifies the following
candidate-captured associations absent from the old **per-call** display:

- 125 command-name associations.
- 56 subcommand associations.
- 268 path associations.
- 12 URL associations.
- One git `revision:path` association.
- 52 operator associations.

Counts are deduplicated by kind/value within each call. They are **not a measure
of total information**: names may already occur in prose or elsewhere, path
mentions can be irrelevant/fragments, and dropped arguments are not scored.
The review artifacts include every original call so these trade-offs can be
examined rather than inferred from the counters.

The 160 variant keeps 77 bash calls literal and skeletonizes 156; 354 dedicated
file calls use IDs and 16 other calls remain unchanged. No sampled call required
a syntax/resource fallback. Behavioural tests separately exercise those fallbacks,
scoped identities, shell grouping, Unicode offsets, opaque bodies and no execution.

## Follow-up: positive argument selection

Repeated the exact same seven samples (matching sampled-record hashes and
baseline sizes), retaining only the documented payload fields of known tools.
Unknown-tool displays remain byte-for-byte identical to the baseline. Known-tool
execution options are removed even on literal and fallback paths. Also corrected
the Python unittest `-p` pattern being mistaken for inline program text.

| Presentation | Whole checkpoints | Change vs baseline | Tool lines | Change vs baseline |
|---|---:|---:|---:|---:|
| Current 160-character prefixes | 232,867 | — | 55,281 | — |
| Updated candidate; literals through 120 | 218,964 | −5.97% | 29,999 | −45.73% |
| Updated candidate; literals through 160 | 219,908 | −5.56% | 31,034 | −43.86% |

The 160 variant is another **2,591 characters smaller** than the initial
candidate. All seven sampled checkpoints are now smaller than the baseline.
The previously growing alife-jc sample is 102,504 characters, versus 103,095
baseline (−0.57%). Result annotations remain intact; only unselected call
arguments are discarded. The lexical path diagnostic adds one newly visible
association, now 269; other newly visible association counts are unchanged.

Fresh private artifacts are in `/tmp/tc-stub-positive-inputs/`. The older artifacts
remain untouched for comparison. No known call display in this sample retains
`background=`, `delivery=` or `timeout=`; all 15 unknown-tool displays are unchanged.
One malformed known bash call now has an explicit unavailable-command marker.

## Live branch integration

The candidate is now enabled in live compaction on this branch. The offline
adapter calls that same renderer and keeps the old truncation baseline pinned at
`92ae62a`. A final 160-cutoff replay of the same samples gives **221,393** total
checkpoint characters (−4.93%) and **31,034** tool-line characters (−43.86%).
The changed whole-checkpoint total includes the live explanatory legend and the
refined lexical-scope display. All seven sampled checkpoints remain smaller than
the baseline. Raw review artifacts are in `/tmp/tc-live-branch-review/`.

Integration tests additionally cover stable bindings through repeated compaction,
resume/fork, filtering and native-fidelity restoration, pruning of unused
bash-only definitions, dictionary-aware cap cost, and an isolated production
package/WASM load. This is still not a live-model behavioural result.

## Provisional preference

Keep **160** as the default experimental cutoff. The 120 variant saves another
944 characters across either run, but exposes the same counted new associations
while discarding more literal arguments. Independent evaluation should decide
whether that extra literal detail is useful.

The main remaining trade-off is dictionary cost, especially one-off long URLs
and uncertain path mentions. Avoid adding a large command-semantics catalogue to
chase perfect coverage. Evaluate where the existing small rule set gives useful
breadcrumbs, and whether narrower mention extraction or selective inlining is
worth a follow-up experiment.

Private raw artifacts from the initial run are under `/tmp/tc-stub-review-final/`
and the updated run under `/tmp/tc-stub-positive-inputs/` on the working machine;
only aggregate measurements are recorded here. Regenerate them
with the proposal's command when evaluating elsewhere.

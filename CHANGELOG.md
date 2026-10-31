# Changelog

## 0.9.0

- Add progressive capping in the pure `extensions/lib/checkpoint-cap.ts` module.
  Before omitting history, try 120/80-character previews, fewer lower-priority
  refs, and folded adjacent tool-only prefixes, oldest first and only as needed.
  Protect file paths, observed outcomes, and history-bearing refs. Preserve
  independently trimmable calls after grouping. Distinguish `tools-tightened`
  presentation changes from `trimmed` omissions.
- Persist versioned bounded tool-display records alongside uncapped span lines.
  Later checkpoints can tighten earlier structured spans without editing stored
  compactions or reinterpreting raw history. Budget increases/cap-off restore
  normal rendering. Text-only legacy spans and invalid/future records remain
  opaque. Retained startup reads, inherited bases, and cap-policy dialogs retain
  their existing protection/behavior.

- Render compact `[Tools]:` signatures with complete file paths, requested read
  ranges, payload sizes/counts, and 160-character head-and-tail bash previews.
  Keep escaped newlines and shell syntax intact; omit tool-level timeout fields.
  Replace new `[ok]` labels with conservative historical output observations;
  retain explicit tool-error/unknown status. Recognized test/build summaries,
  HTTP observations, tiny complete historical outputs, and commit hashes can
  remain visible. Unlabelled calls do not imply success. Normal rendering keeps
  messages separate; progressive capping may fold tool-only prefixes. No command
  diffs, arbitrary output tails, or read folding.
- Add checkpoint `ref=ID` hints for write/edit payloads, truncated commands, and
  likely historical observations. `context_show_entry` can open refs directly
  with `includeRelated=true`, recovering matched calls and results together in
  bounded pages. Ordinary single-entry retrieval stays unchanged; related-entry
  indexing respects tool names, duplicate ambiguity, sequential reuse, and the
  active branch. Refs do not depend on deletion inference; no ref makes no
  reproducibility claim. Existing saved span lines are preserved.

- Add read-only compaction timing and headroom replays, including valid doubled
  histories with remapped IDs. Record the first destructive cap at identical cut
  points; keep reconstruction costs separate from timed compaction hooks. Baseline
  snapshots preserve relative imports after modular source refactors. These are
  local performance/evidence-retention checks, not live-model quality results.
- Known performance limitation: the final destructive fallback recounts remaining
  rows after each deletion, so heavily capped histories can scale superlinearly.
  Incremental size accounting is deferred; the presentation-only stages are not
  subject to that repeated-recount path.

## Earlier development notes

- Raise the default lookup budget from 10 to 25 substantive search turns (75 total
  search-phase model calls, plus a final tool-free write-up). Keep the consecutive
  lookup limit at 1. Mark plain-text answers after the paging-only budget warning
  as potentially incomplete and include fallback guidance. Instruct the subagent
  not to turn incomplete searches into claims that evidence was never recorded.
- Advertise the retrieval skill as guidance on targeting evidence, phrasing lookup
  questions, and handling incomplete findings, without a mandatory preflight read.

- Replace misleading file-list content-absence claims with compact retained-evidence
  labels, recomputed from Pi's projected tail at each checkpoint. Distinguish full,
  partial, and uncertain reads; visible write payloads; and subsequent tracked
  changes. Preserve startup-read labels and give modified paths a narrowly factual
  negative label when no retained read/write evidence is established. Read-list
  headers state the negative default once instead of repeating it per path. No
  extra filesystem reads, model calls, or source-content duplication.
- Add a narrow safeguard before whole-file `write` replacement: reread unless
  current contents are already visible, and do not reconstruct unchanged sections
  from memory. Small exact-match edits do not require a blanket reread.

- Advertise recovery positively as retrieving history hidden by compaction, with
  explicit provenance and contradiction triggers in the lookup description, skill,
  and post-compaction reminders. Distinguish historical observations from current
  source contents; allow cheap rereads/recomputations and avoid blanket fact
  re-verification. Re-orientation leads with ordinary input restoration and makes
  lookup conditional on a hidden historical need, rather than reusing the tool
  advertisement. Shorten fallback descriptions by referring to lookup's scope
  rather than repeating it. Keep recovery scope, fallback, and filesystem boundaries.

- Make compaction tool signatures leaner: short outcome labels, relative project
  paths, write sizes and edit counts instead of payload previews, and a single
  ellipsis for abbreviated arguments. Keep bash previews at 160 characters and
  preserve complete file-tool paths. Bound user bash-execution stubs too. Raw
  history, retained outputs, and user/assistant prose are unchanged.
- Mark all size-trimmed spans, including partial removals and shortened user
  messages; no longer label originally empty spans as trimmed.

- Scope recovery guidance to specific earlier details hidden by compaction in the
  current conversation, not startup, project discovery, or missing requirements.
  Filesystem restrictions apply only to that recovery workflow, not user-requested
  session audits, debugging, or cross-session analysis. Remove the misleading
  pre-task skill trigger and align lookup, fallback, and checkpoint descriptions.
- Remove obsolete recovery-interface guidance and legacy metadata rendering.
  Agent-facing instructions describe only the current session-backed tools;
  independent exports are documented through Pi's `/export`.

- Rename the extension entry point to `extensions/index.ts` so Pi's compact
  extension list shows the npm package name without a `:transparent-compact.ts` suffix.

- Deterministic checkpoints retain user messages and assistant prose, subject to
  a size guard; thinking, full tool outputs, and arguments remain in Pi's session.
- Startup text reads whose names appear in AGENTS/CLAUDE instructions are retained
  verbatim, including pagination chunks. Selection scans the first user-prompt
  interval without model calls, agent action or filesystem reads, then freezes
  after the second prompt. Later compactions carry the outputs forward separately
  from conversation spans, without duplicating reads still in the recent tail.
  Retained reads count as fixed cap overhead but are never silently trimmed.
- Remove the required-document and edit-target reread checklist. Recovery guidance
  now asks only for missing task-relevant evidence; retained reads remain usable.
- Newly compacted custom messages become bounded type stubs marked `content
  removed`, regardless of their source extension. Bodies remain recoverable from
  raw session history; previously saved spans are not rewritten. Managed
  re-orientation messages continue to be regenerated instead.
- Tool signatures record per-call `ok`, `error`, or `unknown` outcomes from
  matched tool-result metadata; the header explains that outputs are removed. Missing or
  ambiguous outcomes are never inferred, including unlabelled older spans.
- Read-file entries distinguish retained startup reads from removed content; a closing
  evidence rule directs historical evidence/provenance questions to lookup and
  current-state questions to the source.
- The instruction envelope now has recovery explanations before all compacted
  spans, one evidence-boundary warning after them, and numbered
  recovery reminders plus brief recovery recap after the retained tail.
  The checklist is persisted and remains active after the first response. Later
  compactions regenerate the envelope: old generated checklists are neither
  summarized into spans nor replayed from the retained tail. Raw originals remain
  available for audit/recovery. Offline SDK tests cover ~20k-token tail placement,
  persistence, repeated compaction, reload/resume, mid-run and overflow continuation,
  without making a live-model compliance claim.
- Flat chronological spans avoid repeatedly summarizing earlier facts.
- Session-persistent `/compaction-method verbatim|summary` selects manual,
  automatic, and overflow-recovery compaction independently of auto-compaction
  on/off. `/compact` autocomplete reflects the method when supported, without
  replacing the command or footer.
- Summary-mode warnings appear only on actual switches, not status checks or
  compaction. They clarify that changing the setting alone does not alter context.
  Mixed-context warnings explicitly scope the verbatim guarantee; switching back
  after applying a summary cannot restore earlier model-summarized context to verbatim.
- Session-backed `context_lookup` searches the full raw active branch across all
  compactions, using an in-memory transcript with authoritative entry attribution.
- Transcript rendering uses retained session history in memory, without additional
  files, ownership matching, or pruning.
- Optional `MECH_COMPACT_LOOKUP_SESSION_FILE` supports full-session recovery from
  pruned harness forks, with explicit failures for invalid overrides.
- Subagent lookup provides list, grep, and entry-retrieval tools; exhausted lookups
  receive one final tool-free write-up of partial findings. The extension appends
  fallback guidance even when the write-up fails or its findings are truncated.
- Subagent continuation-only turns no longer spend the substantive search-turn
  budget when they use previously issued, single-use cursors with unchanged
  effective parameters. New searches, mixed batches, invented/replayed cursors,
  and duplicate continuations still count. A separate ceiling allows at most
  3× the configured budget in search-phase model calls (75 by default), plus
  one final tool-free write-up. This is a safety guard, not a measured optimum;
  no telemetry or subagent trace is persisted.
- Paging guidance now asks for continuation only when omitted evidence matters,
  rather than exhausting every page. Invalid grep `charOffset` errors explain
  the unchanged-parameter requirement and how to restart the match at
  `charOffset=0`.
- Hybrid recovery is now the default: `context_list_entries`, `context_grep`, and
  `context_show_entry` provide bounded direct search when subagent findings are
  incomplete. The checkpoint, tool descriptions, and bundled skill consistently
  permit these tools while prohibiting raw session-file recovery through
  filesystem tools. This intentionally changes recovery prompting.
- `MECH_COMPACT_LOOKUP_MAX_CALLS` defaults to 1 consecutive lookup attempt
  (0 = unlimited). User messages, ordinary-work tool results, and bash executions
  reset the limit; narration and thinking do not. The three direct fallback
  tools neither increase nor reset the count, preventing alternating lookup/
  direct-search cycles from repeatedly launching subagents. Branch-based call/result
  accounting also covers pending earlier calls in a batch, preventing parallel
  lookups from bypassing the cap. Lookup requests use sequential execution when
  supported by Pi.
- Shared subagent/direct search tools now support complete paginated retrieval,
  with continuation cursors and explicit remaining-content notices, including
  oversized individual lines. Listing/grep cursors pin the original last entry
  id, excluding newly appended calls/results without creating a snapshot. Existing grep/entry payload guards remain 12,000/
  24,000 characters; entry listings are now paginated at 12,000 characters.
  `truncateMiddle` was renamed to `truncateHead` to match its actual behavior.
  These are retrieval changes, not new measurements of historical study arms.
- Lookup model calls no longer force caching off; provider defaults apply, with
  a stable separate session id for each lookup. Cache eligibility remains
  provider-dependent.
- Session/branch-persistent `/cap-compaction [on|off|warn] [80000c|20000t|25%]`
  controls trimming; the default is `warn 25%` of the current model context window.
  Tokens use a four-characters-per-token estimate (now explicit in budget status),
  percentages follow model changes, and explicit character
  budgets retain the existing scope and algorithm. The environment character
  setting remains an initial-budget override.
- `MECH_COMPACT_MAX_SUMMARY_PERCENT` configures the initial percentage budget
  (default 25, fractional values supported). Session settings override explicit
  character settings, which override the percentage setting; invalid percentages
  fall back to 25.
- Trim prompts can apply the cap, persist `off`, change the budget, or cancel.
  Non-interactive mode warns and caps; cancellation never falls through to summary.
  For unattended interactive sessions, use `/cap-compaction on` to avoid waiting
  for trim dialogs. The `warn` default and conversion factor are unchanged.
- Removed obsolete file-backed recovery interfaces and their configuration.
- Bundled `context-retrieval` skill describes session-backed evidence recovery,
  branch scope, historical provenance, and re-verification after compaction.
- Deterministic tests cover session recovery, overrides, attribution, size guards,
  cap dialogs/modes/budgets, percentage defaults/model changes, cancellation,
  the skill, and Pi's real package loader. Hybrid regressions additionally cover
  narration, same-message/parallel attempts, pagination and oversized lines,
  continuation budget accounting/replay protection, total-call ceilings,
  cursor-error recovery, truncation boundaries, provider caching options, and
  real Pi agent-turn persistence ordering with a stubbed model (no live inference).
- Preliminary synthetic pilot figures are preserved as historical results from
  the earlier file-backed implementation, not measurements of the current implementation.

Full live-model evaluation remains pending; integration tests and local replay
benchmarks are not live-model quality measurements.

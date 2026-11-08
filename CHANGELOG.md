# Changelog

## 0.12.0

- Add explicit main-agent context-recovery opt-in through
  `transparentCompact.mainAgentLookup` in Pi settings or
  `MECH_COMPACT_MAIN_AGENT_LOOKUP=1`. Only sessions without existing compactions
  can adopt it; the choice persists through compaction, resume, and inherited
  forks. The default subagent tools, instructions, and behavior are unchanged.

## 0.11.3

- Replace heuristic startup-read retention with explicit `<retain-reads>` declarations
  in AGENTS/CLAUDE files: default to the first read, or use `latest:`.
- Add `/retain-reads` with OFF/FIRST/LATEST selection, first/latest read ordering,
  complete previews, coverage labels and filtered-turn flags. Group consecutive
  partial reads into episodes; preserve selected outputs independently of turn
  filtering without duplicating recent-tail or native-turn outputs. Choices persist
  in the session branch; confirmed edits can revise an existing checkpoint without
  additional compaction.
- Keep retained read outputs at their original positions, or directly after their
  filtered-turn marker, without a separate retained-read section. Preserve placement
  through restoration and repeated compactions; keep inline outputs untrimmed.
- Document the potential next-request prompt-cache cost of manual context edits.
- Add `/export-checkpoint [path]` to export the current branch's saved checkpoint
  as plain text, including confirmed manual revisions, without rebuilding it or
  changing context.

## 0.11.2

- Remove read/modified file inventories and per-file evidence annotations from
  checkpoints. Keep the location dictionary as a plain ID-to-location lookup and
  remove related agent-facing guidance; file operations remain in conversation context.

## 0.11.2

- Added manual context filtering.

## 0.11.0

- Use shared location IDs and AST-based skeletons for long bash tool calls.
  Keep short commands literal and unknown tools generic; remove non-payload
  arguments from known tools. Preserve historical outcome observations.
- Keep the location dictionary near the checkpoint end, with stable branch-local
  IDs across compaction, resume, fork and turn-mode changes. Count dictionary
  cost under the cap and omit unused definitions after filtering or trimming.
- Bundle the official mvdan/sh parser and typed-JSON encoder as WebAssembly,
  using a small in-package bridge. No third-party npm parser wrapper, runtime
  downloads, Go installation, or external shfmt executable is required.
- Remove version-comparison harnesses and comparison-only runtime diagnostics;
  test tool rendering directly against production modules.

## 0.10.0

- Clarify the context readout: label delta as net, show measured tail inclusion,
  and show combined notice-cost changes after the tail as `+~N scaffolding`,
  without a separate row or breakdown. Keep the last completed readout visible
  during recalculation to avoid loading/color flashes on each selection.
  Remove the `reply/framing` label.
  Replace `cap warn` labels with plain-language size-limit information only when
  the preview was actually shortened. Add small-turn/adjacent-user regressions
  reconciling content savings with generated-notice overhead.

- Add a live whole-context size readout to turn selection and review: estimated
  input tokens/window usage, delta from saved context, and reserve-aware headroom.
  Preview the actual capped checkpoint and native expansions with current
  system/tool overhead, without dialogs, writes or model calls. Discard stale
  estimates and label unavailable sizes rather than inventing zero-token counts.

- Simplify `/compact-filtered` to ordinary compaction followed by the shared
  `/filter-turns` editor. The checkpoint is committed before selection; cancelling
  the picker leaves that compaction intact. With nothing new to compact, edit the
  existing checkpoint instead. Failed/cancelled compactions never open controls.
  Remove the special interactive compaction-hook path and its request sentinel.

- Add whole-turn context modes: `[X] PRUNED`, `[ ] PROSE`, `[○] PROSE+TOOLS`, and
  `[■] FULL`; preserve `[-] LOCKED`. Space retains the prune/restore shortcut;
  `f` cycles modes, including from agent/tool subentries. Preview native content,
  explicit mode transitions and estimated token growth.
- Reinsert selected original messages at their chronological positions without
  compacted/startup-read duplicates. PROSE+TOOLS retains complete recorded tools
  with thinking markers; FULL retains recorded thinking/signatures and images.
  Persist reversible branch-local choices through reload and later compactions,
  respect explicit context edits, protect native turns from trimming, and reject
  oversized selections rather than silently losing fidelity. Normal provider
  compatibility transformations still apply.

- Clarify the filtering TUI with framed selection/review steps, a highlighted
  focused row, numbered turns, semantic action labels and fixed keyboard controls.
  Separate preview instructions from turn content and show a change summary.

- Add `/filter-turns` to immediately filter or restore an existing checkpoint,
  without compacting additional history, moving the boundary or starting an agent
  turn. Persist branch-local revisions, refresh reorientation for each revision,
  and carry choices into later verbatim or summary compaction. Recent messages
  remain untouched; pending pre-flags can still be cancelled.

- Add `/filter-later <message>` (alias `/fl`) to submit a normal user turn pre-flagged for future
  filtering. Add branch-local `/filter-auto on|off` (default off) to apply eligible
  user pre-flags during verbatim threshold/overflow compaction without a picker.
- Allow previously filtered turns to be unchecked and restored using `/filter-turns`
  or manual filtered compaction. Preview restorations and pending-flag cancellations; preserve
  canonical startup-read and file-operation metadata for reversible checkpoints.
  Explicit keep/restore decisions prevent automatic re-filtering of the same aside.

- Add `/compact-filtered` for optional manual whole-turn filtering in the terminal:
  ordinary compaction followed by tree-like selection and scrollable confirmation.
  Cancelling turn edits leaves the completed compaction and original history intact. Replace excluded groups with `[Turn manually filtered]`, remove their
  retained startup-read copies and exclusive file-list paths, and explain the
  marker conditionally in the checkpoint and reorientation. Exclusions persist
  through later verbatim compactions and follow the active branch; original
  history remains recoverable. Recent-tail turns cannot be partially filtered.

## 0.9.3

- Restore the `706b04b` advertisements for lookup, listing, and grep, including the
  lookup question description; omit "authoritative" from grep attribution. Keep
  the 0.9.2 `context_show_entry` advertisement and ref-free checkpoints unchanged.
  This changes wording only; capping, retrieval behavior, the current lookup-call
  limit, re-orientation, and the retrieval skill remain unchanged.
- consecutive context_lookups now default to a limit of 3 rather than 1

## 0.9.2

- Remove inline checkpoint refs, their selection heuristics, stored locator/priority
  fields, the ref-thinning cap stage, and associated prompting and replay metrics.
  Keep compaction-aware, focused recovery tools and ENTRY ids returned by recovery
  results for targeted follow-up. Keep output observations, head-only previews,
  preview tightening, tool-only prefix folding, and destructive cap behavior.
  No migration or compatibility handling for saved checkpoints is added.

## 0.9.1

- Keep recovery tool advertisements explicitly compaction-aware while adding
  question-led examples: exact earlier commands/results, provenance, conflicting
  observations, and uncertainty about what was done, observed, or decided.
  Distinguish locating an entry, finding a narrow passage, and reading
  a specific detail at a known ENTRY id/ref. Make paging conditional on the missing
  detail, including incomplete or ambiguous passages, and stop once the question
  is answered; do not promote bulk expansion. Partial searches do not prove absence.
  Ref locators are not verification. Retrieval code, payload limits, and defaults
  are unchanged; this is a prompting experiment, not a bounded-return redesign.

- Restore the 0.8.9 lookup-first re-orientation and compaction-aware recovery
  framing. Keep refs as raw-entry locators that may narrow a lookup question,
  not citations or validation.
  Restore explicit missing-detail cautions in the checkpoint boundary, tool
  advertisements, and skill. Keep compact signatures, output observations, ref
  selection, progressive capping, and paired-entry retrieval behavior unchanged.
- Return new bash previews to the first 160 encoded characters plus an omission
  marker, with head-only 120/80-character cap stages. Store bounded prefixes in
  version-2 tool-display records. No legacy rendering or upgrade logic is added.

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

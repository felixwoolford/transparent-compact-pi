
## How it works

### Deterministic checkpoint

Pi selects the compacted messages and retained boundary. In verbatim mode, the
extension builds a checkpoint without changing that boundary or calling a model:

| Content | Treatment |
|---|---|
| User messages | Kept verbatim, subject to the size guard. |
| Assistant prose | Kept, subject to the size guard. |
| Tool calls | Short signatures with outcome labels; full arguments and outputs remain recoverable. |
| Assistant thinking | Removed from the checkpoint; retained in the raw session. |
| Tool outputs | Mostly removed; selected bash observations and explicitly retained reads remain. All remain in raw history. |
| Custom messages | Short type stubs marked `content removed`; bodies remain in the raw session. Managed re-orientation messages are regenerated instead. |
| Recent conversation | Pi keeps its normal verbatim tail. |
| Earlier compacted spans | Re-rendered chronologically, without repeated model summarization. |

New tool lines use `[Tools]:` with compact display signatures:

```text
read @1:12-41
write @2 (2144 chars)
edit @1 ×2
bash "uv run pytest -q 2>&1 | tail -25" → output: "3 failed, 16 passed in 0.21s"
bash{cd @3 && cargo test >@4 | tail}
```

Known tools use positive input selection: bash retains `command`; read retains
`path`, `offset` and `limit`; write/edit retain their path and payload-derived
sizes/counts. Other call arguments are omitted regardless of extension, including
non-null execution controls. Unknown tools keep bounded agnostic argument previews.
Read ranges describe requests, not returned coverage or symbol positions.

Quoted bash commands of at most 160 encoded characters stay literal, with cwd
shortening and escaped newlines. Longer commands use a full mvdan/sh AST to retain
commands, common subcommands, path operands, pipes, sequencing, redirects and
grouping. Flags and non-location arguments are generally omitted. Inline program
bodies become explicit `[inline]`/`[body]` markers with bounded lexical path mentions;
these are not effect analysis. Unsupported, oversized or malformed shell input
falls back to a head-only literal preview, still without execution metadata.

A shared `<locations>` dictionary near the checkpoint end resolves `@N` IDs.
IDs are append-only and branch-local, persisted in compaction details so resume,
fork, filtering/restoration and repeated compaction do not renumber old references.
Definitions are rendered only for surviving structured tool references, never
discovered by regex-scanning prose. Canonical metadata keeps the
complete registry so restoring a turn or disabling the cap restores its definitions.
Raw command/program payloads are not copied into display records.

The cap counts dictionary characters, including their removal when a call is
trimmed. Unused definitions are omitted after pruning, native-turn replacement
and capping. Skeletons are not
shortened into partial syntax. Literal previews can tighten to 120 then 80 encoded
characters before adjacent tool-only prefixes are grouped and destructive trimming
starts. Calls remain independently removable and ordered.

All signatures are display notation, not replayable commands or tool arguments.
No command diffs or read folding are performed.

**Parser dependency and rebuilds.** `extensions/lib/tool-stubs/parser/go.mod`
pins the official `mvdan.cc/sh/v3` module at `v3.14.1`. Our small Go bridge calls
`syntax.NewParser` and upstream's `syntax/typedjson.Encode` directly; the renderer
consumes that upstream JSON format without an intermediate AST schema. It does
not import an interpreter. The JavaScript loader initializes the bundled WASM
lazily, once, with Go's globals isolated from Pi. There are no npm parser
runtime dependencies, external executables, downloads, or target-file reads.

Checked-in WASM keeps npm and Git installs self-contained. Rebuild with Go
1.27.3 available on PATH:

```bash
npm run build:shell-parser
```

The build uses pinned module checksums, `-trimpath`, no VCS stamping and no build
ID. It copies the matching Go support script unmodified. `parser/build.json`
records source/asset hashes and toolchain/upstream versions; tests detect stale
sources or assets. The bundled Go and mvdan/sh licenses are in that directory.
Go is a build-only requirement; users do not need it.

**Development experiment — dictionary placement:** keep the shared dictionary at
the end for now, preserving the checkpoint's start for session-start information.
Compare dictionary-first versus dictionary-last in independent behavioural tests;
prompt-order research is suggestive, not a direct evaluation of this format. Do
not duplicate the dictionary without evidence that the extra context cost helps.

`[tool error]` means a safely matched result was flagged as an error; `[unknown]`
means no safely matched result/status. Plain successes have no status label; this
**does not establish exit 0 or passing tests**. Legacy `[ok]` means only that the
result was not flagged as an error. Selected bash observations appear after `→`:
reported nonzero shell status, `no output`, recognized test/build summary lines,
explicit HTTP status observations for leading curl/wget commands, or a short
error-text quote. Detectors are conservative lexical heuristics, not verdicts.
Test summaries are scanned only for recognized test/build invocations; error text
only for recognized execution commands, not leading file-read/search/git commands.
Unknown formats remain unlabelled. A status for a pipeline does not establish the
status of its individual commands. A bracketed git commit hash can also be retained.

Likely historical bash observations (network, terminal, scripts, timings) may retain
a complete text output of at most 100 characters, but not arbitrary output tails.
Media, structured-only results, and detected truncated output do not qualify as tiny
complete observations. Every quote is escaped and bounded. All observations are
historical, not proof of current state; assistant prose remains a record of claims,
not independent verification.

Only selected preparation messages supply output labels; raw history and the
retained tail do not supply missing outcomes. Stored canonical span lines remain
unchanged; their presentation in a later checkpoint may tighten under budget pressure.

When omitted observations, payloads, or provenance are needed, prefer
`context_lookup` with a specific historical question. Recovery results supply
ENTRY ids for targeted follow-up questions. For current state, inspect files.
There is no required-document reread checklist.

All newly compacted custom messages follow the same stub policy, regardless of
extension, display setting, or content format. Long type names are abbreviated
like tool-call arguments. This applies even with the cap disabled. Previously
saved canonical spans are not rewritten; older custom-message bodies may remain in them.

### User-controlled turn filtering

`/compact-filtered` sequences ordinary verbatim manual compaction and the shared
`/filter-turns` editor. It waits for Pi's completion callback, so the new checkpoint
is already saved and the host is idle before the picker opens. There is no special
custom-instruction sentinel or interactive filtering path in `session_before_compact`.
The first phase inherits all existing choices like ordinary `/compact`; the second
phase proposes a separate reversible revision. Escape in the picker leaves the
completed compaction intact. A failed or cancelled first phase never opens it.
Pi's current no-op outcomes (`Already compacted` and `Nothing to compact (session too
small)`) open an existing checkpoint only if the session/branch is unchanged. A
session/branch change or unexpected checkpoint result cancels the workflow; the
shared editor rechecks idle/UI/method state before opening.

Only turns wholly before the saved boundary can be excluded; pre-flagged turns
still overlapping the retained tail remain pending and their flags can be cancelled
in the picker. Other recent turns stay locked. Agent/tool subentries are inspection
views of their owning user turn. Previously pruned turns start checked; unchecking
restores their compacted representation. Confirmation distinguishes pruning,
restoration, fidelity and pending-flag changes. Escape goes back from confirmation,
or cancels only the proposed revision. No filtering UI runs in ordinary manual,
threshold or overflow compaction itself.

`/filter-turns` uses the same selection/confirmation UI against the existing
checkpoint only. It does not invoke Pi's compaction preparation, append a compaction,
add a span, move `firstKeptEntryId`, or start an agent turn. It therefore also works
immediately after compaction when Pi has nothing more to compact. An existing
verbatim checkpoint and an idle interactive session are required; recent messages
remain untouched, though pending aside flags can be cancelled.

Canonical span lines carry parallel `turnIds`, anchored to raw user entry IDs
through Pi's source-preserving projection (including explicit context replacements).
A group includes all activity until the next raw user message, even across multiple
compaction spans. Confirmed exclusions are stored as the current `filteredTurnIds`
snapshot on the compaction entry or its standalone revision, not an append-only
union. Later verbatim checkpoints apply that branch-local selection to the original canonical spans before size
trimming, reindexing tool display records without changing stored history.
Read-retention choices apply independently after turn filtering; selected read
outputs survive even when their owning turn is pruned. Restoring a turn restores
its prose and location definitions without filesystem reads. There is no migration
or reconstruction of saved spans without turn ownership; opaque content is not
individually selectable.

One `[Turn manually filtered]` marker replaces each excluded group at its original
position, even across spans. Markers survive the size cap. Explicitly retained reads
follow their turn's marker directly, in recorded order, even across spans; location
definitions used only by excluded turns are removed.
Filtering does not undo filesystem mutations. The checkpoint introduction and
persistent reorientation conditionally explain that the user excluded low-value
context, which remains retrievable from the full raw history. Recovery tools are
unchanged. Cancelling or failing a turn edit saves no revision. Mechanical compaction
with existing pruning, fidelity or read-retention choices cancels on build failure
rather than falling through to a model summary that would lose those choices.

Standalone updates append a non-context `transparent-compact:filter-revision`
entry containing the source compaction ID, rendered checkpoint, exclusions and
keep overrides. The latest revision for the active compaction wins. At request
time, `context_with_system` replaces Pi's projected `compactionSummary` with the
revised text and any selected native turn segments, and refreshes the managed
reminder for that revision. Original compaction entries and
the raw recent tail are never edited. Host views/estimates based solely on Pi's
saved projection can still reflect the original summary; actual provider requests
receive the revision. The checkpoint size guard applies before a revision is saved.

Reload/resume and tree navigation select revisions from the raw active branch.
The next real verbatim compaction inherits their choices and supersedes the old
revision; model-summary compaction is also given the revised previous summary and
file-operation metadata rather than stale saved checkpoint content. Cancelling the picker or
size-cap decision saves no filtering revision. No-op confirmation writes nothing.

`/filter-later <message>` (alias `/fl`) submits an ordinary user message through Pi's user-message API.
A short-lived bridge from that submission's input event writes a non-context
`transparent-compact:aside-turn` entry just before its user message is persisted.
The next raw user entry consumes the flag, guarded by that message's timestamp.
A failed/handled input is cleared by the next input, and session changes clear the
bridge; no content heuristic is used to flag historical messages. Asides remain
visible until eligible and are pre-checked by manual filtering.

`/filter-auto on|off` persists a branch-local
`transparent-compact:auto-filter` policy (default off). When enabled, threshold
and overflow compaction apply eligible user pre-flags without opening a picker.
Ordinary `/compact` does not apply new pre-flags; summary mode is unchanged.
The compaction's `keptAsideTurnIds` snapshot records explicit manual keep/restore
overrides, so future auto compactions do not re-exclude those asides. Turning off
auto filtering affects new applications, not existing exclusions. No automatic
relevance judgment, model call or filesystem mutation is introduced.

### Selective full-fidelity turns

The same picker has four modes: `[X] PRUNED`, `[ ] PROSE`, `[○] PROSE+TOOLS`, and
`[■] FULL`. `[-] LOCKED` is an independent availability state and remains unchanged.
Space switches any kept mode to PRUNED, or PRUNED to PROSE. `f` cycles all four modes;
for pending recent-tail pre-flags it only toggles PRUNED/PROSE. Both controls always
act on the whole owning user turn. Expansion and confirmation preview show the
chosen representation; preview also estimates token growth.

The compaction/revision stores a `fidelity` map of raw user IDs to `tools`/`full`
and generated `slots`, never another copy of raw payloads. PRUNED continues to use
`filteredTurnIds`; absent fidelity means PROSE. Before capping, every compacted copy
of a selected native turn is replaced by a single generated slot, even across
multiple canonical spans. Slots are structurally protected from trimming. Generated
random markers are resolved to checked UTF-16 offsets in the final checkpoint;
request projection never interprets historical text as a managed placeholder.

At request time, the checkpoint is split at those offsets into chronological
compacted segments interleaved with original user/assistant/tool messages. The raw
projection disables compaction while preserving branch topology and Pi's explicit
context edits and custom-message conversion. Historical system configuration and
obsolete managed reorientation messages are not replayed. Tool-call/result groups
must be complete and unambiguous. PROSE+TOOLS replaces each thinking block with a
text marker in place; FULL retains stored blocks/signatures/images. Request-local
copies prevent later transforms from mutating canonical session records. Provider
compatibility transformations still apply, including cross-model reasoning and
non-vision image handling; no unavailable reasoning or nested outputs are invented.

Native turns replace their compacted prose and retained-read duplicates, not the
canonical source data. PROSE restoration makes separately selected reads visible
at their original read positions again. Mode choices inherit through
reload/resume, tree navigation and later verbatim compactions; explicit fidelity
choices also override aside pre-flags. An empty revision clears old fidelity rather
than falling back to the source checkpoint's map. Explicit summary compaction gets
expanded historical text as its previous summary and may summarize it normally.

Native message token estimates count as fixed overhead in the character cap; only
PROSE is trimmable. Independent context-window checks run before saving and after
system restoration on each actual request, with output/framing headroom. They use
Pi's token estimates, not a provider tokenizer. Oversized updates save no revision;
subsequent budget/projection failures explicitly abort the active operation (a hook
exception alone is not a cancellation gate). Existing full-fidelity content is never
silently dropped or downgraded to make room. The user can remove/downgrade a pin,
even if later context edits made its original tool group unreplayable. Host views
and compaction-boundary selection still use Pi's saved checkpoint; provider requests
include native expansions and are checked separately.

### Live context size preview

Selection and review share a live whole-context estimate: input tokens/context
window, percentage, net delta from saved input, and headroom after the same output
and framing reserve used by the context guard. The total explicitly includes the
measured tail size, not the configured retention target. Short terminals show the
total only.
The editor supplies a read-only estimator to the picker. It renders proposed
selections through the same checkpoint builder as saving, with passive cap
resolution and no notifications/dialogs/persistence. Warn assumes applying the
current budget on changes; unchanged selections use the actual saved checkpoint,
not a hypothetical rebuild under a newly changed cap policy. A presentation result
from the real cap renderer records actual trimming/tightening; only then does the UI
mention the size limit, in plain language, including whether saving asks first.
Raw `cap warn` policy/debug labels are not shown.

Notice accounting separately measures generated pruning guidance, checkpoint
revision notices and full-fidelity guidance using counterfactual messages through
the real estimator. Only the generated introduction before `SECTION_HEADER` and
the generated reminder are edited in these counterfactuals; quoted historical text
is untouched. Costs therefore follow the actual text/estimator, with no fixed token
allowance. Activation/removal changes are summed into one inline `+~N scaffolding`
(or `−~N scaffolding`) indicator after the tail on the estimated-context row,
already included in the total and net delta.
No notice breakdown or extra notice row is shown; unchanged context has no added
scaffolding indicator. Existing notice rounding is not presented as fresh overhead
on every checkbox.
The first prune and first checkpoint update can therefore add noticeable one-time
cost even when little prose is removed. The delta still includes marker replacements
and size-limit effects; it is not a raw selected-text token count.

The estimator expands generated native slots, removes retained-read duplicates,
and respects explicit context edits. It counts the untouched live tail (excluding
old system configuration, obsolete managed checklists and context-excluded bash
output), plus the current prompt/active tool schemas and one current reminder.
These are Pi estimates before provider-specific transformations; future input and
other extensions' future request transformations cannot be predicted. A failed
baseline leaves delta unknown, while repaired proposed context can still get an
honest total. Failed estimates are shown as unavailable, never zero.

Estimation is asynchronous and coalesced per mode change; navigation, resize and
theme changes reuse the last result. Pending recalculations retain the completed
readout, its styling and row count, replacing values only when a new estimate is
ready. Loading text appears only before any successful estimate (or when retrying
a failed estimate), not on every toggle. Generation checks reject stale results, and
closing/disposing the dialog invalidates pending work. No estimated sizes are
persisted in checkpoint metadata, and no model calls are introduced.

### Explicit read retention

`extensions/lib/read-retention.ts` derives a file/episode catalog from Pi's
context-edited original projection of the active branch. Only unambiguous,
successful, text-only `read` pairs qualify. Failed, missing-status, orphaned,
non-text and explicitly omitted reads do not. Replacements supply their projected
bytes. Shell and nested reads have no standalone result to retain. No source
files are opened, and no model calls or additional tool operations are involved.

Defaults come only from `<retain-reads>` blocks in AGENTS/CLAUDE context files
(including `AGENTS.override.md`) or their recorded reads. Named project-instruction
blocks provide a fallback when structured context files are absent. Each line is
a literal path resolved relative to its instruction file: plain paths select FIRST,
`latest:` selects LATEST. Ordinary mentions, basenames elsewhere and globs have
no matching semantics. Current system context files override recorded copies.
There is no special first-user-turn selection window.

Consecutive successful reads of the same normalized path and user turn form an
episode when their ranges advance and connect or overlap. Assistant commentary
is allowed between pages; other tool calls, gaps, errors, restarted ranges and
new user turns break adjacency. Source call order, not tool completion order,
defines adjacency. The first/latest episode is selected per file. Requested limits
are not output coverage: Pi pagination notices and delivered text determine
coverage, and unknown truncation stays partial. Outputs remain separate verbatim
blocks, including their original pagination notices; no synthetic file is built.

`/retain-reads` uses a local draft with OFF/FIRST/LATEST, first/latest ascending
ordering, full scrollable previews, coverage/size labels and filtered-turn flags.
Enter reviews and then saves; Escape cancels. Manual overrides, including OFF,
persist branch-locally and can be reset to declarations. Before any checkpoint,
choices are custom state; afterward they share the checkpoint revision mechanism
with turn controls. Revisions preserve the existing boundary, tail and native
placements, with session/leaf checks before saving. Compaction details and revisions
store defaults and overrides, not additional copies of raw read bodies. Saving
also refreshes changed read candidates without requiring a mode toggle; no-op
checks compare generated retained copies against the previous revision's branch
inputs, never parsed checkpoint text.

Canonical spans record `readPositions`: result entry IDs and insertion boundaries
between prose/tool lines, including reads currently OFF. They contain no read bodies.
Rendering inserts selected original outputs at those positions, with structural
protection from trimming and remapped tool-record indices. There is no separate
retained-read section or introduction. Batched results keep recorded result order;
episode grouping/selection still uses call order.

Retention survives turn pruning: protected read rows from a pruned turn, including
later-span rows, move directly after its single first marker, with
`filtered-turn="true"`. Restoration returns them to their original positions.
Native expansion preserves protection on other turns' reads. An unplaceable selected
read (such as one covered only by an opaque model summary) rejects the rebuild rather
than silently dropping or moving it to an invented location. OFF does not remove
normal tool content. Tail/native outputs are not duplicated. Repeated compactions select
original projected outputs again (FIRST stays first; LATEST follows later reads),
not text parsed from earlier checkpoints. Reload, resume and tree navigation use
the active branch's choices and candidates.

#### How cap trimming works

The pure renderer/size guard lives in `extensions/lib/checkpoint-cap.ts`, separately
from Pi hooks, cap-policy dialogs, and session access in `extensions/index.ts`.
It accepts canonical span data and a line budget and never mutates its inputs.
**Presentation reductions precede history omission.** Each rung walks oldest first
across all eligible spans, stopping as soon as the budget fits:

1. Shorten bash previews from 160 to 120 encoded characters.
2. If still over budget, shorten them to 80 characters.
3. Fold repeated `[Tools]:` prefixes across adjacent tool-only messages in the
   same span. Do not cross prose, custom messages, user messages, or span boundaries.
4. Only then remove non-user content, oldest first. Structured tool batches remain
   independently trimmable by call even after prefixes have been folded.
5. Shorten long user messages to marked prefix stubs, oldest first.
6. As a last resort, remove the oldest remaining content, including user messages.

File paths, read ranges, tool status, and output observations are not shortened by
presentation stages. User and assistant prose remains verbatim until the destructive
fallback. `tools-tightened="true"` identifies presentation changes without omitted
prose/calls; `trimmed="true"` and a recovery note identify actual omissions or user
text shortening. Both attributes can occur on one span. Empty spans are not marked
unless they became empty through omission.

New spans store versioned, bounded display records in `details.span.tools`, alongside
their normal uncapped `lines`. Records contain signature fragments, original encoded
command prefixes, and annotations—not unbounded commands, write/edit payloads, or
full tool outputs. Smaller previews are always derived from
the same canonical prefix, never from a previous 120/80-character rendering.
Version-2 records distinguish a truncated prefix from a complete short command.
Stored compaction entries are not edited: a later checkpoint re-renders its earlier
spans for the current budget. Increasing the budget or disabling the cap restores
normal previews; reload/resume/fork follow the active branch's records.

Only records that exactly reproduce the stored canonical tool line can be tightened.
Legacy text-only spans, unsupported versions, and malformed/mismatched records stay
opaque and use the conservative omission fallback. They are not regex-parsed or
reconstructed from current raw history, which might differ from the projected
content originally compacted. Inherited model-summary/opaque bases remain fixed.

Explicitly retained reads count once in the span budget as protected rows and are never trimmed.
Like an inherited base, they can exceed the budget by themselves; in that case
the extension warns and preserves them. The conversation-line budget still has
a 500-character minimum. Space for span annotations is reserved in the size guard.
Originals remain recoverable from the session; cap settings and warn/on/off dialog
behavior are unchanged.


### Session-backed lookup

Pi normally saves append-only JSONL sessions under:

```text
~/.pi/agent/sessions/--<project-path>--/<timestamp>_<session-id>.jsonl
```

Compaction adds an entry; it does not delete earlier thinking, tool calls, or
tool results. At each lookup, the extension obtains the current branch through
`ctx.sessionManager.getBranch()`, **not** the compacted model-context projection.
Custom session locations work automatically. In-memory sessions work while the
process lives, but cannot be resumed after exit.

The raw branch is mechanically rendered **in memory** into readable transcript
lines. Blocks have `ENTRY` headers; assistant sections have `[thinking]`,
`[text]`, and `[toolCall]` markers. Thinking, tool arguments, and textual tool
outputs are preserved without truncation in that representation. An authoritative
entry/section index prevents header-like text inside output from spoofing
attribution.

The subagent uses three internal tools: `list_entries`, `grep`, and `show_entry`.
These search the rendered lines directly, so no temporary file, second session
copy, or cleanup is needed. Individual results and the final answer have size
limits. Follow pages only when omitted content is needed, not to exhaust every
match or entry.

The default substantive search budget is 25 turns. Valid continuation-only turns
do not spend it; new queries, changed parameters, or replayed cursors do. A separate
ceiling caps all search-phase model calls at three times the configured turn budget
(75 by default). A turn may batch multiple tool calls; these are not individual
search counts. When either budget ends searching, one final tool-free model call
writes up partial findings; a failed write-up falls back to the latest text,
explicitly labeled incomplete. A plain-text answer after the paging-only budget
warning also carries an incomplete-findings marker, without
an extra write-up call. Both normal-answer and forced-write-up instructions distinguish
unreached evidence from absence: an incomplete search does not establish that the
answer was never recorded. Lookup requests use normal provider caching
defaults rather than forcing caching off; actual cache behavior and savings vary
by provider.

### Recover historical details

Compaction hides earlier details from the model's current view; the recorded history,
including tool outputs and reasoning, remains in the session. Recovery can retrieve
specific outputs, trace where an earlier finding came from or why a conclusion was
reached, and check historical evidence when earlier notes conflict with new evidence.
These triggers are advertised in the tool description and conditionally explained
in post-compaction reminders, not just in the skill body. Reminders lead with
restoring task-relevant inputs, current-file reads, and cheap recomputation;
compaction alone is not a lookup trigger. Advertising and re-orientation use
separate wording. The skill description advertises procedural guidance for targeting
earlier evidence, phrasing lookup questions, and handling incomplete findings,
without requiring a skill read before every lookup. This is guidance, not a
guarantee of model compliance.

Re-read project files for their current contents. Prefer lookup for what was
observed earlier or to avoid repeating slow external research or expensive
computations; cheap local rereads (including downloaded sources) and recomputations
remain reasonable. Current external facts may require fresh research. Retrieval
establishes what was recorded, not whether an earlier conclusion was correct.

Use recovery for history established by this conversation or its checkpoint, not
project discovery, requirements never supplied, other sessions, or abandoned branches.
For unfamiliar project details or missing requirements, inspect project files or
ask the user instead.

For this recovery workflow, use the recovery tools rather than reading raw session
files through filesystem tools. This restriction does not apply to user-requested
session audits, debugging, or cross-session analysis, which can use ordinary file
tools. Lookup itself still cannot search other sessions or abandoned branches.

By default, the extension registers one main-agent recovery tool:

| Tool | Purpose |
|---|---|
| `context_lookup` | Recover outputs, findings, decisions, reasoning, and provenance hidden by compaction, including conflicts with new evidence. A subagent searches the raw branch and returns relevant findings. Accepts only `question`. |

For example, ask the agent to recover the build error observed before compaction.
It can call `context_lookup` with:

```json
{
  "question": "What exact build error did we observe for src/auth.ts before compaction? Include the ENTRY id and observed tool output."
}
```

ENTRY ids returned by lookup can narrow subsequent `context_lookup` questions.
The skill explains recovery scope and limitations, including that a partial
search does not establish absence.

Ordinary entry retrieval defaults to `includeRelated=false`. Related expansion
is available to the subagent; it is one-hop and chronological: a result includes
its originating assistant entry (including any
sibling calls), not sibling outputs; an assistant includes its matched results.
Relations come from raw call IDs and matching tool names, never transcript text.
Ambiguous duplicate IDs, orphan results, and mismatched tool names do not establish
relations. Sequential ID reuse is matched separately. Branch scoping and source
overrides apply to both single-entry and related-entry retrieval.

Related expansions share the usual character/line guards. Keep `includeRelated`
unchanged when following an offset; changing it starts a different retrieval and
spends a substantive subagent search turn. An expansion of an unfinished call may
change if results arrive later; restart paging if its source changes.

The subagent searches in its own context and returns findings with entry
references. Its raw search results stay out of the main conversation.
Budget-limited findings retain an incomplete marker even if the write-up fails.

By default, three consecutive `context_lookup` attempts are allowed until a user
message, a bash execution, or another tool's result resets the limit. Assistant
text and thinking neither increase nor reset the count. Pending lookup calls in
the same batch also count, preventing parallel calls from bypassing the limit.
Blocked attempts return a short limit notice without launching a subagent;
later lookups after other work remain available.

### Explicit direct-recovery opt-in

Subagent recovery remains the primary path. Its tool definition, model loop,
admission limits, prompts, skill, and default checkpoint/reminder wording are
unchanged. `extensions/lib/main-agent-lookup.ts` owns the optional direct adapter.
It receives the existing retrieval schemas and callbacks, without copying or
moving the subagent backend.

The adapter reads `transparentCompact.mainAgentLookup` from Pi's effective merged
settings; `MECH_COMPACT_MAIN_AGENT_LOOKUP=1|0` overrides that initial preference.
Without an opt-in or saved choice it does not change tools, skills, messages, or
session state. An unassigned session with any existing compaction (including on
another branch or from summary mode) cannot adopt direct recovery.

An accepted opt-in writes a non-model-facing custom entry before compaction.
That saved choice wins over later configuration. It is session-wide for tree
navigation; the adapter ensures a marker is present on each visited branch so
forks copying that history inherit it. Sessions without a marker keep the normal
subagent behavior. No checkpoint migration or mixed-mode compatibility is needed.

Direct mode withdraws `context_lookup` with hidden exposure, preventing both direct
calls and discovery through codemode/tool search. It registers only its three
replacement tools: `context_list_entries`, `context_search`, and
`context_show_entry`. They reuse session source validation, indexed attribution,
related-entry matching, output limits, and pagination. Each call renders the raw
current branch afresh; listing/search continuation boundaries exclude newly
appended recovery calls. There is no nested model call or subagent search budget.

Small presentation seams adapt only extension-authored guidance, including custom
message and truncation suffixes. Historical prose and retained outputs are never
rewritten. Adaptation precedes size/placement accounting. The default guidance is
returned verbatim; the direct adapter supplies its own recovery paragraph and
replaces generated references to the unavailable tool. It also replaces this
package's advertised retrieval skill and explicit skill-command expansion in direct
sessions only. The ordinary bundled skill stays unchanged.

### Instruction envelope and persistent re-orientation

Pi projects the checkpoint before its retained recent history (normally about
20,000 tokens). The extension separates explanations about that history from the
instructions that must be prominent at the actual point of resumption:

```text
Checkpoint introduction: what was removed + full recovery instructions
All compacted spans (oldest first, with retained reads in place), then location dictionary
One evidence-boundary warning + start-of-verbatim-tail marker
Retained verbatim tail
Any pending new user input
Task-relevant recovery reminders + brief recovery recap
```

The recovery reminders identify selected retained reads and the uncompacted tail
as available evidence. They ask for recovery only when task-relevant inputs are
missing, not for rediscovery of reading requirements or blanket document rereads.
They also distinguish restoring inputs from repeating completed writes, call for
inspecting Git state, and ask the agent to resolve task-relevant uncertainty or
contradictions using supporting output or current-state verification before treating
a claim as established. Retained prose can guide continuation without re-verifying
every fact; unresolved claims should be labelled unverified, and retrieved reasoning
remains a historical hypothesis. Historical outputs do not establish current file
or build/test state.
There is no blanket edit-target reread. Before replacing an existing file with
`write`, the guidance requires rereading unless current contents are already in
view, and forbids reconstructing unchanged sections from memory. Small exact-match
edits and newly created files do not acquire a blanket reread requirement.
It is a saved
custom message tagged with the current compaction entry ID and, after standalone
filtering, its revision ID, not a temporary nudge:
subsequent responses and user turns retain it in history before the work that
followed it. `before_agent_start` adds it on normal starts/resume when missing;
`session_compact` steers it into automatic mid-run and overflow continuations.
Idle/post-run compaction waits for the next run and does not trigger extra work.

The final `context_with_system` phase places the checklist last on the first
post-compaction request, after ordinary context transforms and pending input.
It also removes obsolete or duplicate **managed** checklist messages, including
those Pi retained in its recent tail. On later turns the current message stays in
history rather than being moved to the end again. Branch-based IDs make this
work through reload, resume, forks and tree navigation without an in-memory flag.

Subsequent verbatim compactions skip these managed messages when building spans,
then regenerate one envelope around the entire accumulated compacted context.
Old generated checklists therefore do not accumulate inside spans or the active
tail. Their original entries remain in raw session history for recovery/audit.
User and assistant prose is never stripped by matching instruction text. Other
custom messages become type stubs regardless of whether their content resembles
instructions. Opaque inherited model summaries/legacy checkpoints are likewise not rewritten
to remove text that looks like an old instruction envelope.

Offline tests inspect actual SDK requests with roughly 20k-token tails, multiple
compactions, persisted instructions and interrupted/automatic continuations.
These verify delivery and placement, not live-model compliance.


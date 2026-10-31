
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
| Tool outputs | Mostly removed; selected bash observations and startup reads remain. All remain in raw history. |
| Custom messages | Short type stubs marked `content removed`; bodies remain in the raw session. Managed re-orientation messages are regenerated instead. |
| Recent conversation | Pi keeps its normal verbatim tail. |
| Earlier compacted spans | Re-rendered chronologically, without repeated model summarization. |
| Read/modified file lists | Cumulative operation lists with checkpoint-relative retained-evidence annotations. |

New tool lines use `[Tools]:` with compact display signatures:

```text
read "src/example.ts":12-41
write "scratch.py" (2144 chars) ref=0123abcd
edit "src/example.ts" ×2 ref=4567abcd
bash "uv run pytest -q 2>&1 | tail -25" → output: "3 failed, 16 passed in 0.21s"
```

File paths remain complete and are relative to the session working directory where
possible. Read ranges record requested lines, not actual returned coverage or symbol
locations. Write bodies become sizes; edit arrays become counts (individual
`oldText`/`newText` fields become sizes). Bash omits its tool-level `timeout` argument
but retains other arguments such as `background`. Commands abbreviate the working
directory to `.` at path boundaries. Their JSON-encoded previews keep up to 160
characters, about 62% head plus an ellipsis and the tail. Newlines remain escaped;
imports, redirections, and shell syntax are not rewritten. Other argument previews
remain bounded prefixes. These signatures are display notation, not replayable shell
commands. Calls normally remain separate across assistant messages. The size guard
may fold adjacent tool-only prefixes while preserving ordering and independently
removable calls. No command diffs or read folding are performed.

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

`ref=ID` supplies an existing raw ENTRY id for write/edit payloads and for bash
commands that are truncated or have a positive historical-observation hint. It is
not a requirement to look up, and its absence makes no reproducibility claim.
Write/edit refs do not depend on inferring later deletion or filesystem state.
A ref normally points at the matched result, identifying one call in a batch; an
unmatched call can point at its assistant entry. IDs are assigned only by object
identity with raw branch entries, never by guessing from command text or timestamps.
Projected replacement content can therefore lack a ref. Only selected preparation
messages supply output labels; raw history and the retained tail do not supply
missing outcomes. Stored canonical span lines remain unchanged; their presentation
in a later checkpoint may tighten under budget pressure.

Open a known ref directly with `context_show_entry({id: "0123abcd", includeRelated: true})`.
This recovers the original call/payload and result together, including code no longer
on disk. For current state, inspect files; for a historical question without a known
ref, prefer `context_lookup`. There is no required-document reread checklist.

All newly compacted custom messages follow the same stub policy, regardless of
extension, display setting, or content format. Long type names are abbreviated
like tool-call arguments. This applies even with the cap disabled. Previously
saved canonical spans are not rewritten; older custom-message bodies may remain in them.

### File-list evidence annotations

The lists record reads and modifications in compacted history, not an exhaustive
inventory of current file contents. At every checkpoint, the extension checks
Pi's model-context projection from `firstKeptEntryId` onward. The turn prefix is
being compacted and is not treated as retained evidence. Context omissions and
replacements are respected; replacement read text has unknown completeness.
No filesystem reads or model calls are made for annotation.

Successful, unambiguously paired `read` results receive `(full read in tail)`,
`(partial read in tail)`, or `(read output in tail)` when completeness is uncertain.
For Pi's read contract, offset/limit alone does not imply partialness: an offset of
1 with a limit beyond EOF can still be complete. Truncation metadata and continuation
notices are checked. Separate partial pages are not combined into a full-file claim.
A later partial read does not hide an earlier complete snapshot with no intervening
tracked modification.

Successful writes with a visible full payload receive `(write content in tail)`.
Recorded subsequent edits/writes invalidate earlier snapshots and produce labels
such as `(read in tail, then edited)`. Mutation metadata can invalidate a snapshot
even when the mutation's message was omitted, but cannot restore omitted source
contents. Nested calls can invalidate snapshots, not supply visible file contents.
Same-path sibling operations may run concurrently, so ambiguous read/write versus
mutation ordering receives `(read in tail; order uncertain)` or the write equivalent
instead of treating result order as proof of freshness.

Modified paths without retained read/write evidence receive `(no read-tool output
in tail)`, unless a selected startup read is retained separately. Startup reads
keep their existing positive annotation. Unmodified paths without established
retained evidence remain unannotated; the read-list header states the default once:
"unless annotated, no retained read-tool output identified". A bare path does not
establish that document contents are still visible. The shared explanation states that labels
apply as of this checkpoint, not to live filesystem state; shell reads/changes and
external modifications are not inferred. File contents are never duplicated into
these lists, and annotations are recomputed rather than persisted as file metadata.

### Retained startup reads

On the first verbatim compaction, the extension scans successful text-only `read`
call/result pairs between the first and second user messages on the active branch.
It retains outputs whose file paths or bare names occur literally in AGENTS/CLAUDE
context files supplied by Pi, or in AGENTS/CLAUDE files read during that interval.
`AGENTS.override.md` is recognized too. Named project-instruction blocks in the
rendered system prompt provide a fallback when structured context files are not
available. No files are opened and no model or agent action is involved.

Matching accepts absolute paths, paths relative to the working directory or
instruction file, and standalone basenames. It rejects substrings of other paths
or filenames. A bare basename can select multiple same-named files. This is a
lexical heuristic, not a required-reading parser: optional links can qualify;
indirect references, shell reads, nested tool calls and reads after the second
user message do not. Custom messages do not close the startup interval.

All selected output chunks are preserved verbatim, with entry IDs, paths, offsets
and limits. Pagination/truncation notices are retained too; retention never
invents missing pages or claims a partial read is a complete document. Failed,
ambiguous and non-text results are excluded. Selection respects explicit context
omissions/replacements. It does not check on-disk freshness.

The selection is stored in compaction details, separately from conversation spans.
Subsequent verbatim compactions carry it forward unchanged, without re-compacting
checkpoint text. If the second user message has not arrived yet, selection remains
open: later compactions scan the startup interval again and add newly qualifying
reads until it closes. Reads still in the uncompacted tail are not duplicated in
the checkpoint; they move into its retained-read section when the cut passes them.
Reload, resume and branch navigation follow the stored state on the active branch.
An older checkpoint without retention metadata initializes selection from the
original branch, not from its summary prose.

#### How cap trimming works

The pure renderer/size guard lives in `extensions/lib/checkpoint-cap.ts`, separately
from Pi hooks, cap-policy dialogs, and session access in `extensions/index.ts`.
It accepts canonical span data and a line budget and never mutates its inputs.
**Presentation reductions precede history omission.** Each rung walks oldest first
across all eligible spans, stopping as soon as the budget fits:

1. Shorten bash previews from 160 to 120 encoded characters.
2. If still over budget, shorten them to 80 characters.
3. Remove lower-priority refs from positively recognizable local read/view
   commands or pipelines. Preserve refs on writes/edits, external probes,
   terminal interactions, scripts, timings, and unknown shell shapes. This is
   a priority heuristic, not a claim that unreferenced evidence is reproducible.
4. Fold repeated `[Tools]:` prefixes across adjacent tool-only messages in the
   same span. Do not cross prose, custom messages, user messages, or span boundaries.
5. Only then remove non-user content, oldest first. Structured tool batches remain
   independently trimmable by call even after prefixes have been folded.
6. Shorten long user messages to marked prefix stubs, oldest first.
7. As a last resort, remove the oldest remaining content, including user messages.

File paths, read ranges, tool status, and output observations are not shortened by
presentation stages. User and assistant prose remains verbatim until the destructive
fallback. `tools-tightened="true"` identifies presentation changes without omitted
prose/calls; `trimmed="true"` and a recovery note identify actual omissions or user
text shortening. Both attributes can occur on one span. Empty spans are not marked
unless they became empty through omission.

New spans store versioned, bounded display records in `details.span.tools`, alongside
their normal uncapped `lines`. Records contain signature fragments, the original
encoded command preview ends, annotations, and ref priorities—not unbounded
commands, write/edit payloads, or full tool outputs. Smaller previews are always derived
from these same canonical ends, never from a previous 120/80-character rendering.
Stored compaction entries are not edited: a later checkpoint re-renders its earlier
spans for the current budget. Increasing the budget or disabling the cap restores
normal previews and refs; reload/resume/fork follow the active branch's records.

Only records that exactly reproduce the stored canonical tool line can be tightened.
Legacy text-only spans, unsupported versions, and malformed/mismatched records stay
opaque and use the conservative omission fallback. They are not regex-parsed or
reconstructed from current raw history, which might differ from the projected
content originally compacted. Inherited model-summary/opaque bases remain fixed.

Retained startup reads count as fixed budget overhead and are never trimmed.
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
copy, or cleanup is needed. They share the fallback tools' paginated search
functions. Individual results and the final answer have size limits. Follow
pages only when omitted content is needed, not to exhaust every match or entry.

The default substantive search budget is 25 turns. Valid continuation-only turns
do not spend it; new queries, changed parameters, or replayed cursors do. A separate
ceiling caps all search-phase model calls at three times the configured turn budget
(75 by default). A turn may batch multiple tool calls; these are not individual
search counts. When either budget ends searching, one final tool-free model call
writes up partial findings; a failed write-up falls back to the latest text,
explicitly labeled incomplete. A plain-text answer after the paging-only budget
warning also carries an incomplete-findings marker and fallback guidance, without
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

The extension registers a subagent lookup and three direct-search fallback tools:

| Tool | Purpose |
|---|---|
| `context_lookup` | Recover specific historical details from the full raw session branch. Accepts only `question`. |
| `context_list_entries` | Fallback: list entry ids, roles, timestamps, and previews. |
| `context_grep` | Fallback: regex-search the raw branch with surrounding lines and entry attribution. |
| `context_show_entry` | Open a known checkpoint ref directly, or retrieve an entry after lookup. Optional `includeRelated` recovers matched call/result entries. |

For example, ask the agent to recover the build error observed before compaction.
It can call `context_lookup` with:

```json
{
  "question": "What exact build error did we observe for src/auth.ts before compaction? Include the ENTRY id and observed tool output."
}
```

With a checkpoint `ref=ID`, skip the search and use
`context_show_entry({id: "ID", includeRelated: true})`. Ordinary entry retrieval
(default `includeRelated=false`) is unchanged. Related expansion is one-hop and
chronological: a result includes its originating assistant entry (including any
sibling calls), not sibling outputs; an assistant includes its matched results.
Relations come from raw call IDs and matching tool names, never transcript text.
Ambiguous duplicate IDs, orphan results, and mismatched tool names do not establish
relations. Sequential ID reuse is matched separately. Branch scoping and source
overrides apply equally to both modes.

Related expansions share the usual character/line guards. Keep `includeRelated`
unchanged when following an offset; changing it starts a different retrieval and
spends a substantive subagent search turn. An expansion of an unfinished call may
change if results arrive later; restart paging if its source changes.

The subagent searches in its own context and returns findings with entry
references. Its raw search results stay out of the main conversation. If findings
are incomplete, the fallback tools run the same searches directly; their results
enter the main context. Turn-limit write-ups include a note recommending these
tools for further detail on the same query, even if the write-up fails.

By default, only one `context_lookup` attempt is allowed until a user message,
a bash execution, or a tool result outside these four recovery tools resets the
limit. Fallback searches, assistant text, and thinking neither increase nor reset
the count. Pending lookup calls in the same batch also count, preventing parallel
calls from bypassing the limit. Blocked attempts return a short fallback note
without launching a subagent; later lookups after other work remain available.

### Instruction envelope and persistent re-orientation

Pi projects the checkpoint before its retained recent history (normally about
20,000 tokens). The extension separates explanations about that history from the
instructions that must be prominent at the actual point of resumption:

```text
Checkpoint introduction: what was removed + full recovery instructions
All compacted spans (oldest first), then retained startup reads and file lists
One evidence-boundary warning + start-of-verbatim-tail marker
Retained verbatim tail
Any pending new user input
Task-relevant recovery reminders + brief recovery recap
```

The recovery reminders identify retained startup reads and the uncompacted tail
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
custom message tagged with the current compaction entry ID, not a temporary nudge:
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


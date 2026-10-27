
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
| Tool outputs | Removed from the checkpoint except selected startup reads; all remain in the raw session. |
| Custom messages | Short type stubs marked `content removed`; bodies remain in the raw session. Managed re-orientation messages are regenerated instead. |
| Recent conversation | Pi keeps its normal verbatim tail. |
| Earlier compacted spans | Re-rendered chronologically, without repeated model summarization. |
| Read/modified file lists | Carried forward, distinguishing retained startup reads from removed content. |

Checkpoints label tool outcomes as `ok`, `error`, or `unknown` and remind the
agent to recover missing evidence when needed. These labels describe tool
results, not a guarantee that tests passed. There is no required-document reread
checklist: retained reads remain available as evidence.

All newly compacted custom messages follow the same stub policy, regardless of
extension, display setting, or content format. Long type names are abbreviated
like tool-call arguments. This applies even with the cap disabled. Previously
saved spans are not rewritten; older custom-message bodies may remain in them.

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

**User messages are prioritized**—capping is not simply an oldest-first cutoff:

1. Remove non-user content, oldest first.
2. If still over budget, shorten long user messages to marked prefix stubs,
   oldest first.
3. As a last resort, remove the oldest remaining content, including user messages.

Retained startup reads count as fixed budget overhead and are never trimmed.
Like an inherited base, they can exceed the budget by themselves; in that case
the extension warns and preserves them. The conversation-line budget still has
a 500-character minimum. Originals remain recoverable from the session.


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

Valid continuation-only turns do not spend the substantive search budget; new
queries, changed parameters, or replayed cursors do. A separate ceiling caps all
search-phase model calls at three times the configured turn budget (30 by default).
When either budget ends searching, one final tool-free model call writes up
partial findings; a failed write-up falls back to the latest text, explicitly
labeled incomplete. Lookup requests use normal provider caching
defaults rather than forcing caching off; actual cache behavior and savings vary
by provider.

### Recover historical details

The extension registers a subagent lookup and three direct-search fallback tools:

| Tool | Purpose |
|---|---|
| `context_lookup` | Recover specific historical details from the full raw session branch. Accepts only `question`. |
| `context_list_entries` | Fallback: list entry ids, roles, timestamps, and previews. |
| `context_grep` | Fallback: regex-search the raw branch with surrounding lines and entry attribution. |
| `context_show_entry` | Fallback: retrieve an entry by id. |

For example, ask the agent to recover the build error observed before compaction.
It can call `context_lookup` with:

```json
{
  "question": "What exact build error did we observe for src/auth.ts before compaction? Include the ENTRY id and observed tool output."
}
```

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
inspecting Git state, and require verification before relying on removed evidence.
There is no blanket edit-target reread. It is a saved
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


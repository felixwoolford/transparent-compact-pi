
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
| Tool outputs | Removed from the checkpoint; retained in the raw session. |
| Recent conversation | Pi keeps its normal verbatim tail. |
| Earlier compacted spans | Re-rendered chronologically, without repeated model summarization. |
| Read/modified file lists | Carried forward, with file contents marked as removed. |

Checkpoints label tool outcomes as `ok`, `error`, or `unknown` and remind the
agent to recover missing evidence and re-read required documents before relying
on them. These labels describe tool results, not a guarantee that tests passed.

#### How cap trimming works

**User messages are prioritized**—capping is not simply an oldest-first cutoff:

1. Remove non-user content, oldest first.
2. If still over budget, shorten long user messages to marked prefix stubs,
   oldest first.
3. As a last resort, remove the oldest remaining content, including user messages.

Trimming stops once the budget is satisfied. Originals remain recoverable from
the session.


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

After compaction, the checkpoint instructs the agent to re-read required documents,
even if previously read, re-acquire missing task information, inspect Git state
when in a Git repository, and re-read files before modifying them.


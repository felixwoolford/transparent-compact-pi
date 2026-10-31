---
name: context-retrieval
description: "Guidance for using context_lookup after compaction: how to target earlier evidence, phrase effective lookup questions, and handle incomplete findings."
---

# Session context recovery

## Applicability

Compaction hides earlier details from your current view. The original conversation
history, including recorded tool outputs and your reasoning, is preserved in the
session and can be retrieved. Retained startup reads and the uncompacted tail
remain available as evidence; recover only hidden information needed for the task.

Use the recovery tools for history established by this conversation or its checkpoint,
not project discovery, requirements never supplied, other sessions, or abandoned branches.
For unfamiliar project details or missing requirements, inspect project files or
ask the user instead.

User-requested session audits, debugging, and cross-session analysis are separate
tasks, not this recovery workflow. Its filesystem restrictions do not apply to
those tasks; use ordinary file tools as needed for the requested analysis.

This skill pairs with the `@foliox/transparent-compact-pi` extension, which provides:

- **Verbatim compaction** — a deterministic checkpoint retains user messages, assistant prose, and compact tool-call signatures. Thinking and most tool outputs are removed from the active model context, not from the raw session history. Selected startup read outputs remain verbatim in the checkpoint or uncompacted tail. Earlier spans are re-rendered flat, with recovery guidance before them and an evidence-boundary warning after them. Persistent task-relevant recovery reminders and a recap follow the retained tail; later compactions replace the old generated reminders rather than duplicating them. An inherited opaque base is kept when needed.
- **`context_lookup`** — the preferred search when no checkpoint ref already identifies the evidence: a subagent searches the full raw session branch in its **own** context and returns relevant findings. At lookup time, the extension mechanically renders the branch into entry-anchored text with an authoritative entry/section index, in memory.
- **Direct retrieval and bounded fallback tools** — open a known checkpoint `ref=ID` directly with `context_show_entry({id: "ID", includeRelated: true})`. This includes the matched call and result, so a result ref recovers the full command or write/edit payload too. Without a known ref, prefer `context_lookup`; if its findings are incomplete, use `context_list_entries`, `context_grep`, and `context_show_entry`. Their results enter this conversation. For recovery of details hidden by compaction, these are the permitted fallback, not filesystem access to session files.

Pi normally saves sessions under `~/.pi/agent/sessions/`; custom session locations also work. In-memory sessions retain history only while the process lives and cannot be resumed after exit.

If `context_lookup` is not in your tool list, say that subagent recovery is unavailable. Use the bounded fallback tools if available; otherwise report that limitation. Do not search session files manually as a fallback for compaction recovery.

## When to use

- You need an earlier output, exact error, previously read content, full tool-call arguments, instruction, decision, or reasoning hidden by compaction.
- You are unsure where an earlier finding came from, what a command actually printed, or why you reached a conclusion.
- Earlier notes conflict with new evidence and you need to check the historical evidence behind them.

If a checkpoint `ref=ID` identifies the evidence, open it directly with
`context_show_entry({id: "ID", includeRelated: true})`. Refs mark useful historical
evidence, not a lookup requirement; no ref makes no claim that the evidence is
reproducible. Output labels are selected historical observations, not current-state
verification. Unlabelled calls do not establish exit 0 or passing tests.

Otherwise ask `context_lookup` a **specific historical question** to recover hidden supporting
evidence. This can avoid repeating slow or unreliable research. For example:
"Where did our earlier Holi 2026 date come from: a
published source or our own computation? Include the observed output and ENTRY id."

### Lookup or inspect the source?

- Re-read project files when you need their current contents.
- Prefer lookup when you need what was observed earlier, or when recovering earlier external research or expensive computations would avoid repeating slow or unreliable work.
- Cheap local rereads (including downloaded sources) and recomputations remain reasonable; needing a current external fact may require fresh research.
- Retained prose can guide continuation without re-verifying every fact. When uncertainty or a contradiction matters to the current task, check the supporting output or verify current state; label unresolved claims unverified. Retrieval establishes what was recorded, not whether an earlier conclusion was correct.

## How to ask

```text
context_lookup({ question: "What exact error did the earlier test run return for the N=7 case? Include the ENTRY id and observed tool output." })
```

For `context_lookup`, only supply `question`. Lookup covers all earlier compactions on the current branch automatically. It does **not** search abandoned branches or unrelated sessions. If the detail is absent, report that limitation instead of claiming it was recovered or widening this recovery search through filesystem tools.

A study harness may configure `MECH_COMPACT_LOOKUP_SESSION_FILE` to make the extension search a full session rather than a pruned fork. This is extension configuration, not a tool argument or a file the main agent should read. Do not discover or change the override to broaden a lookup.

## Bounded fallback and pagination

If the subagent comes up short, use `context_list_entries` for an overview,
`context_grep` for specific historical evidence, and `context_show_entry` for
an identified entry. Do not immediately repeat the subagent query. The three
fallback tools neither increase nor reset the lookup count: they are part of
the same recovery episode. Narration and thinking do not reset it either. Only
a tool result outside the four recovery tools, a user message, or a bash
execution resets the limit.

Search responses are pages, not necessarily complete evidence. Follow pages
only when omitted content is needed; do not exhaust every match or entry merely
because a continuation is available. Keep other parameters unchanged and use
all continuation parameters printed at the end of a limited page:

- Listings and entry retrieval: `offset` counts characters (UTF-16 code units)
  in the rendered listing or entry, starting at 0.
- Grep: `offset` counts matches, starting at 0; `charOffset` continues within
  the context of an oversized match. Grep reports how many matches remain.
- `maxLines` and `maxMatches` limit a page, not the backing history. Increasing
  them does not remove the character guard. Use the reported cursor instead.
- `context_show_entry` defaults to a single entry. `includeRelated=true` adds
  unambiguously matched tool call/result entries in chronological order. Keep
  this flag unchanged when paging. A result expands to its originating assistant,
  not sibling outputs; an assistant expands to its matched results.

Listing/grep cursors also report `throughEntry`: retain this original last-entry
id on subsequent pages, so newly appended calls/results cannot keep expanding
the search. The source is rendered afresh. If you change
search/context parameters or navigate to another branch, restart at `offset=0`
(and `charOffset=0` for grep) without `throughEntry`. If grep reports an invalid
`charOffset`, retry that match at the same `offset` with `charOffset=0` and your
intended context parameters.

## Rules

1. **For recovery of details hidden by compaction, do not read or grep raw session JSONL files through filesystem tools.** Open a known checkpoint ref directly; otherwise prefer `context_lookup`, using bounded fallback tools when its findings are incomplete. Raw filesystem recovery would refill the compacted context. This restriction does not apply to user-requested session audits, debugging, or cross-session analysis.
2. Ask narrowly scoped questions using exact error strings, file paths, function names, or the command whose output you need. Recover tightly related details together; use separate queries for independent facts. Ask the subagent for evidence, not for a solution to the broader task.
3. Findings cite ENTRY ids and the logical transcript name. Retain these citations when relying on recovered facts. The renderer preserves full thinking, text, tool-call arguments, and tool results, although individual search results have output limits.
4. Distinguish **user instructions**, **observed tool output**, and **reasoning at the time**. A recovered `[thinking]` block is a historical hypothesis, not verified fact. Earlier assistant prose is not independently observed evidence either.
5. Historical tool output proves what was observed then, not what is true now. Review uncommitted work and re-verify current build/test state when needed. **Before using `write` to replace an existing file, re-read it unless its current contents are already visible in context. Do not reconstruct unchanged sections from memory.** This is not a blanket reread requirement for small exact-match `edit`s. File-list annotations describe retained evidence as of the checkpoint, not live filesystem state; a read or write payload may already be visible in the tail.
6. Lookups can return incomplete findings or fail. State what remains missing; do not invent details or treat a partial answer as exhaustive.

## Independent exports

Pi provides `/export` for independent session exports; review exports for sensitive content before sharing.

Session history and recovered findings can contain credentials, private code, and conversation details. Do not commit or share them without the user's explicit approval.

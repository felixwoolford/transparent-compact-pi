---
name: context-retrieval
description: Use context_lookup when compaction has removed a specific detail from earlier in this same conversation and that detail is needed again. Not for session startup, project discovery, missing requirements, or auditing session files.
---

# Session context recovery

## Applicability

Use this skill only to recover a specific detail previously present on this
conversation's active branch and now missing because of compaction. The visible
conversation or compaction checkpoint must establish relevant earlier history;
do not call recovery tools to discover whether such history exists. Missing
requirements or an unfamiliar project do not imply forgotten context: inspect
project files or ask the user instead.

Retained startup reads and the uncompacted tail remain available as evidence.
Do not recover information that is still visible, or information never supplied.
These tools cannot search other sessions or abandoned branches.

User-requested session audits, debugging, and cross-session analysis are separate
tasks, not this recovery workflow. Its filesystem restrictions do not apply to
those tasks; use ordinary file tools as needed for the requested analysis.

This skill pairs with the `@foliox/transparent-compact-pi` extension, which provides:

- **Verbatim compaction** — a deterministic checkpoint retains user messages, assistant prose, and compact tool-call signatures. Thinking and most tool outputs are removed from the active model context, not from the raw session history. Selected startup read outputs remain verbatim in the checkpoint or uncompacted tail. Earlier spans are re-rendered flat, with recovery guidance before them and an evidence-boundary warning after them. Persistent task-relevant recovery reminders and a recap follow the retained tail; later compactions replace the old generated reminders rather than duplicating them. An inherited opaque base is kept when needed.
- **`context_lookup`** — the preferred first step for this recovery workflow: a subagent searches the full raw session branch in its **own** context and returns relevant findings. At lookup time, the extension mechanically renders the branch into entry-anchored text with an authoritative entry/section index, in memory.
- **Bounded fallback tools** — if those findings are incomplete, use `context_list_entries`, `context_grep`, and `context_show_entry` for direct evidence recovery. Their results enter this conversation. For recovery of details lost to compaction, these are the permitted fallback, not filesystem access to session files.

Pi normally saves sessions under `~/.pi/agent/sessions/`; custom session locations also work. In-memory sessions retain history only while the process lives and cannot be resumed after exit.

If `context_lookup` is not in your tool list, say that subagent recovery is unavailable. Use the bounded fallback tools if available; otherwise report that limitation. Do not search session files manually as a fallback for compaction recovery.

## When to use

- After a compaction, you need an exact error message, a full tool output, previously read file content, full tool-call arguments, an earlier instruction or decision, or reasoning that was dropped → call `context_lookup` with a **specific** question.
- A compaction checkpoint contains a claim whose supporting tool output was removed → re-read the current source or ask `context_lookup` for that historical evidence before relying on the claim. If you cannot verify it, explicitly label it unverified.

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

Listing/grep cursors also report `throughEntry`: retain this original last-entry
id on subsequent pages, so newly appended calls/results cannot keep expanding
the search. The source is rendered afresh. If you change
search/context parameters or navigate to another branch, restart at `offset=0`
(and `charOffset=0` for grep) without `throughEntry`. If grep reports an invalid
`charOffset`, retry that match at the same `offset` with `charOffset=0` and your
intended context parameters.

## Rules

1. **For recovery of details lost to compaction, do not read or grep raw session JSONL files through filesystem tools.** Prefer `context_lookup`; when its findings are incomplete, use the bounded fallback tools above. Raw filesystem recovery would refill the compacted context. This restriction does not apply to user-requested session audits, debugging, or cross-session analysis.
2. Ask narrowly scoped questions using exact error strings, file paths, function names, or the command whose output you need. Recover tightly related details together; use separate queries for independent facts. Ask the subagent for evidence, not for a solution to the broader task.
3. Findings cite ENTRY ids and the logical transcript name. Retain these citations when relying on recovered facts. The renderer preserves full thinking, text, tool-call arguments, and tool results, although individual search results have output limits.
4. Distinguish **user instructions**, **observed tool output**, and **reasoning at the time**. A recovered `[thinking]` block is a historical hypothesis, not verified fact. Earlier assistant prose is not independently observed evidence either.
5. Historical tool output proves what was observed then, not what is true now. Review uncommitted work and re-verify current build/test state when needed; compaction alone does not require rereading edit targets.
6. Lookups can return incomplete findings or fail. State what remains missing; do not invent details or treat a partial answer as exhaustive.

## Independent exports

Pi provides `/export` for independent session exports; review exports for sensitive content before sharing.

Session history and recovered findings can contain credentials, private code, and conversation details. Do not commit or share them without the user's explicit approval.

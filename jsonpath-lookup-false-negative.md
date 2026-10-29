# A context_lookup that ran out of budget and reported the answer as absent (jsonpath, TC 0.8.8)

From the toy-factory supersession, 2026-10-29. This is a static analysis of the session. I didn't
rerun the lookup.

- **Session:** `subfactories/jsonpath/state/pi/sessions/2026-10-29T07-34-49-678Z_01a18695-3c4d-72ea-b86f-5cbcfcd932ef.jsonl`
- **Setup:** pi 1.4.0, Qwen 27B at 176k, TC 0.8.8 with defaults (`MECH_COMPACT_LOOKUP_TURNS` = 10). The
  lookup ran on the session model. Line numbers are JSONL lines.

## What happened

- **691/695 (09:43–09:45):** the dev ran its benchmark before optimising. The bash results hold
  the baseline: `json.load: 0.233s (48.6 MB document)`, `query '$..*': 2.790s (best of 3)`, and
  so on. At 696 it wrote "Baseline captured. Now profile…".
- **722 (09:58):** compaction, with the tail kept from 698. The stubs for 691/695 show `[ok]`.
- **732 (10:01):** `context_lookup`: "What were the exact baseline benchmark numbers (before
  optimization) … the timing for $..*, $..author, $..[?@.price < 10], $..[?match(@.title,
  '^A.*')], $.items[*].id, and the separate JSON parsing time? Also what was the exact final
  document size and structure (counts of books/items)?"
- **734 (35 s later):** the answer.
  - Its first line is right: "I was unable to reach the benchmark results entries before the
    search budget was exhausted."
  - Its body then says, under "What is missing (not found in transcript)":
    - the baseline numbers weren't captured;
    - "the session appears to have ended (last entry 93af5348) while still in the
      pre-optimization analysis/planning phase";
    - "No tool output containing benchmark results … was captured";
    - the document size "was never reported in any tool result";
    - "the main agent should not assume any specific baseline timings exist".

  All of that is false. The latest entry it cites from the work itself is `ffbd8d5c` (665), the
  benchmark planning; the numbers came 26 entries later. (`93af5348` is line 733, the dev's
  `read` in the same turn.)
- **735–740:** the dev recovered well. "The baseline numbers weren't saved, so I'll regenerate
  them by running the old engine from git against the same document." The optimization was
  uncommitted, so HEAD was still the old engine. It copied HEAD to /tmp/oldpkg, checked which
  package was being imported, then re-timed. The new numbers (2.790 / 1.486 / 4.067 / 4.163 s)
  match the originals (2.790 / 1.498 / 4.115 / 4.217 s). It cost about 3 minutes, and it's to
  the dev's credit, not the lookup's.

## 1. The soft-limit path returns without the partial-findings marker (code, verified)

The answer has no `[subagent reached the …]` marker and no `LOOKUP_FALLBACK_NOTE`. That fits
this path in `runLookupSubagent`:
1. `searchTurns` reaches `lookupTurns` while continuation pages are still outstanding.
2. The loop pushes "The substantive search-turn budget is exhausted. Only follow previously
   issued continuation pages if needed, or answer now."
3. The model answers with no tool calls.
4. The answer goes out through `if (toolCalls.length === 0) return truncateHead(text …)`, as a
   normal, complete answer.

`lookupPartialFindings` (the status marker plus the fallback note) runs only after a hard
`break`. So on this path the only sign that the answer is partial is whatever the subagent
chooses to say. Here it said so in its first line, then contradicted it.

**Suggestion:** if `pagingOnlyNotified` was set, wrap the final answer with
`lookupPartialFindings` as the hard-limit path does. That gives the marker, and the fallback note
pointing at `context_grep` / `context_show_entry`. Possibly also have the write-up phrase
anything unfound as "not reached within the budget (searched up to ENTRY X)", never "not in the
transcript".

## 2. What likely made it expensive (from the transcript, not observed)

The subagent's own calls aren't logged, so this is a reading of what its tools would have
returned for this question.
- **Size and duplication:** the rendered branch is about 48k lines and 2.7M chars.
  - It includes six full checkpoints (25k→118k chars, about 430k in all). Each repeats earlier
    narration verbatim, so most terms match several copies.
  - It also includes very large thinking blocks: 665 is 31k chars, 698 is 101k.
  - The opening overview is the first 60 entries, from 07:34, nowhere near the question.
- **The obvious terms land on planning first:**
  - Page 1 of `grep benchmark` (15 matches) is all 661–665: the user's request and the 31k-char
    planning entry, with 14 matches in its thinking. That planning is what the answer reports
    as the "work in progress at the time of truncation".
  - `baseline` page 1 is the dev's narration around 665–696 and doesn't match the result lines.
  - The result lines contain neither word. Terms that match them hit 691/695 on page 1:
    `best of` (15 lines), `json\.load:` (8 lines) and `48\.6 MB` (4 lines).
- **The checkpoint copy is a decoy.** In the 722 checkpoint, 686–696 appear as narration
  ("Now generate the document…", "capture the full baseline", "Baseline captured") with the
  bash results as `[ok]` stubs. A subagent reading that copy sees the benchmark running with no
  timings anywhere. That matches the answer's "No tool output containing benchmark results …
  was captured", if that's what it read.
- **The question is a compound one:** eight separate values, and selectors full of regex
  metacharacters. `grep` falls back to escaping only when a pattern is invalid. A literal
  `$..*` is a valid JS regex that can never match (`$` is end of input), and
  `[?@.price < 10]` is a character class that matches nearly every line. Either one wastes a
  turn without warning, and the first looks like "not there". I don't know whether it tried
  these.

## 3. The budget

`MECH_COMPACT_LOOKUP_TURNS` = 10 was tightened after a benchmark with dozens of lookups. In
these sessions a lookup is rare: one in a 2.7-hour, 7-compaction session here, and two in
pi-clean-copy's 3.5 hours. This one took 35 s. A bigger budget, or one that grows with
transcript size, costs almost nothing at this rate. Felix's view: the current budget is
needlessly strict when there is one lookup in a multi-hour session.

## 4. The skill wasn't read

The dev never opened `context-retrieval/SKILL.md` in this session. It's advertised in the
system prompt's skill list, and nothing in the session reads it. The same is true of
pi-clean-copy: 0 reads, though both of its lookups were good. puzzle-box read it 15 times.

The question it asked goes against rule 2 of the skill: "Ask narrowly scoped questions using
exact error strings, file paths, function names, or the command whose output you need …
use separate queries for independent facts."
- It asked for eight values, plus the document's structure and book/item counts, as one
  compound question. The structure and counts are a separate fact.
- The command whose output it needed was in its own checkpoint, as a tool-call signature:
  `bash(command="cd . && uv run python bench/benchmark.py --regenerate 2>&1", timeout=600) [ok]`,
  the call just before "Baseline captured".
- A question like "What did the last `bench/benchmark.py --regenerate` run before 'Baseline
  captured' print? Quote the output and ENTRY id" gives the subagent one target. Grepping
  `benchmark.py --regenerate` finds the calls at 686/690/694, and the results follow them
  directly.

**Felix's reading:** a very difficult lookup for the subagent, and at some point we have to
admit the model failed a tough job. Moving the skill's advice into the checkpoint or the
reorientation would just be chasing a model that isn't reading the skill. What could help is
**better advertising for the skill**, so it gets opened when it matters.

The advertisement in the system prompt's skill list is currently:

> Use context_lookup to recover earlier conversation details hidden by compaction, trace where
> an earlier finding came from, or investigate contradictions between earlier notes and new
> evidence.

That reads as complete guidance in itself: it says when to use the tool, so there's no reason to
open the file. Nothing says the file holds advice on how to ask, or what to do when a lookup
comes up short. A description that makes the content visible might get it read, for example:
"Read before calling context_lookup: how to phrase lookup questions so they find the evidence,
and what to do when a lookup comes up short." That's a sketch for the TC dev to judge. The aim
is to advertise what the skill contains, not to carry its rules.

## Ranked

1. The soft-limit path should carry the partial-findings marker and fallback note (a small code
   change).
2. Raise the default `MECH_COMPACT_LOOKUP_TURNS`, perhaps scaling it with transcript size, and
   possibly keep the tight value for a lookup-heavy mode.
3. Skill advertising (section 4): a description that says the skill holds how-to-ask guidance,
   so it gets opened before a lookup.

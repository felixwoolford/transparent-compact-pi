# transparent-compact

Deterministic context compaction for [Pi](https://pi.dev/), with session-backed
recovery. Replaces Pi's model-generated compaction summary with a verbatim
compaction, with a checkpoint built mechanically from conversation text. Thinking and most tool outputs are removed
from the active model context, while user inputs, assistant text and selected startup reads are retained verbatim.
Tool calls and custom messages are reduced to short stubs; custom-message bodies remain recoverable from the session.
Verbatim compaction itself makes no model call. When a missing detail is needed, `context_lookup` runs a subagent over the session's
full raw branch and returns only relevant findings.
The goal is to let the agent withstand many (but finite) rounds of compaction without the copy-of-a-copy degradation of model-summary compaction, which is exacerbated in sub-frontier models.

Additionally, a manual filtering tool is provided to allow the user to selectively include or exclude full turns in the context checkpoint, at varying degrees of fidelity. 

The design principle is that:

- All algorithmic or model-based manipulation of prose has the potential to confound the model later, and should be avoided for as long as possible.
- History retrieval should be parsimonious, explicitly clear to the agent, and agnostic to the task and session structure. 

[This study](https://arxiv.org/abs/2610.20116) demonstrated that a minimal system like
this outperforms more complicated techniques with lightweight models, and is at least as effective with frontier models too. 
It helps weaker models to avoid confabulating the historical context and to more carefully verify what it does and does not know.

The advantages over other methods are most apparent in a strong local LLM with a reasonably large context window (>128k) : for example, through **Qwen 3.8 27B llama.cpp on an RTX 5090**. 
However it is also very practical for use with stronger models and larger context windows.

## Install

### Package installation

Install from npm:

```bash
pi install npm:@foliox/transparent-compact-pi
```

or from github:

```bash
pi install git:github.com/felixwoolford/transparent-compact-pi
```


or from a downloaded or cloned checkout:

```bash
pi install /absolute/path/to/transparent-compact
```

The extension entry point is `extensions/index.ts`, so Pi's compact extension list
shows `@foliox/transparent-compact-pi` without a filename suffix for npm installs.

## Usage

Pi's compaction uses transparent-compact by default once the extension is loaded.
To compact manually:

```text
/compact
```

The checkpoint begins with an explanation and full recovery instructions, and
ends with an evidence-boundary warning. Task-relevant recovery reminders and a
brief recovery recap follow **the retained recent history and any pending new
user input**. This is instruction delivery, not a guarantee of model compliance.

Compaction hides earlier details from the model's view; recorded history remains
retrievable. Recovery guidance explicitly names uncertain provenance (where a
finding came from or why a conclusion was reached) and contradictions between
earlier notes and new evidence. 

### Choose checkpoint turn fidelity

```text
/filter-turns       # edit the existing checkpoint; no compaction
/compact-filtered   # ordinary compaction first, then open the same editor
```

`/compact-filtered` completes an ordinary verbatim compaction, preserving existing
turn settings, **before** opening the `/filter-turns` editor. Cancelling that editor
leaves the completed compaction intact. If Pi has nothing new to compact, the command
opens the existing checkpoint instead. Cancelling compaction itself (including its
size-cap dialog), or a compaction failure, does not open the editor. No special
filtering step runs inside the compaction hook.

In the interactive terminal, the editor opens a framed checklist of user turns, with
a highlighted cursor, action labels and a separate fixed controls area. The review
step summarizes mode changes; a live estimated context readout stays visible on
both selection and review screens.
Each choice applies to a user message and everything following it until the next
user message, including turns spanning multiple compactions.

| Symbol | Mode | Active context |
| --- | --- | --- |
| `[X]` | **PRUNED** | A positioned filtering marker only |
| `[ ]` | **PROSE** | Our standard mechanical compaction, including compact tool stubs |
| `[○]` | **PROSE+TOOLS** | Original conversation text and complete recorded tool arguments/results; thinking markers only |
| `[■]` | **FULL** | Original conversation content, including all recorded thinking and image attachments |
| `[-]` | **LOCKED** | Unavailable; not a fifth fidelity mode |

The readout updates as you change modes, for example:

```text
Estimated context: ~29,365 / 272,000 tokens (10.8%) · incl. ~20,000 tail · +~160 scaffolding
Net Δ −20 · free 222,155 · reserve 20,480
```

Counts use Pi's rough characters/4 heuristic plus message-framing allowances, not
provider tokenization. 

Use **↑/↓** to navigate and **←/→** to collapse/expand details for the selected
mode. **Space** prunes any kept mode, or restores a pruned turn as PROSE. **f** cycles
PRUNED → PROSE → PROSE+TOOLS → FULL → PRUNED. Both keys act on the owning whole turn
when an agent/tool subentry is focused. **Enter** opens a complete, scrollable
change preview; **Enter** again confirms, **Esc** goes back or cancels.

Filtering requires verbatim mode and an idle agent. Turns overlapping Pi's retained
recent tail cannot be removed yet: filtering never removes only half a turn or
changes Pi's retention boundary. Content inside an opaque inherited summary cannot be
selected individually. 


`/filter-turns` requires an existing verbatim checkpoint
and works even when there is no new history to compact. It saves a reversible,
branch-local checkpoint revision without moving the retained boundary or starting
an agent turn. PROSE restoration uses the canonical spans, startup reads and file
operations and remains subject to the size cap. PROSE+TOOLS/FULL instead reinsert
original messages at their chronological positions, replacing their compacted
copies and any duplicate startup-read copies. Explicit context omissions and
replacements remain respected. Complete tool-call/result groups are required.
Before the first checkpoint, use `/compact-filtered`.

Full-fidelity choices persist through later verbatim compactions and reload/resume.
Their content is **never silently shortened by the prose cap**. Estimated native
message cost is treated as fixed overhead; only PROSE can be trimmed. The extension
checks the model context budget before saving and on actual requests, reserving
output/framing headroom. Oversized selections are rejected; if later context growth
or a model change makes existing choices too large, the request is aborted with
instructions to downgrade turns through `/filter-turns`. Large full-fidelity turns
can therefore prevent automatic compaction from freeing enough space. Token counts
are estimates, not provider tokenization guarantees.

FULL means all content actually recorded, not unavailable internal reasoning or
unrecorded nested-tool outputs. Pi's normal model/provider transformations still
apply: changing models can convert/drop signed or encrypted thinking, and non-vision
models cannot receive images. Switching to summary compaction still weakens the
verbatim guarantee; its summarizer receives the expanded recorded text.

Each excluded group becomes `[Turn manually filtered]`. Its retained startup reads
and file-list paths used only in excluded turns are removed too. The checkpoint
and post-compaction reorientation explain the marker only when filtering is present.
Exclusions follow the active branch through later verbatim compactions, reload and
resume. Original session entries remain unchanged and recoverable; filtering does
not undo file changes. Ordinary `/compact` never applies new pre-flags or opens the
picker. Automatic compactions apply new pre-flags only when explicitly enabled below.

### Pre-flag an aside and optionally apply flags automatically

```text
/filter-later <message>  # normal user turn, pre-checked in either filtering command
/fl <message>            # short alias for /filter-later
/filter-auto             # report current policy (default off)
/filter-auto on          # apply pre-flags during threshold/overflow compaction
/filter-auto off         # stop applying new pre-flags automatically
```

`/filter-later` (or `/fl`) requires an idle agent in verbatim mode. The message and its following
agent/tool activity remain in normal context until the entire group is eligible
for filtering. It is not an isolated `/btw` conversation. In `/filter-turns` or
`/compact-filtered`, you can uncheck the aside before exclusion, or restore it afterward.


### Automatic startup-read retention

Successful text reads between the first and second user prompts are retained when
their paths or filenames appear in AGENTS.md / CLAUDE.md instructions. Selection
is purely mechanical: no model call, agent tagging, or extra filesystem reads.
Original output chunks, including paginated reads, survive in a separate checkpoint
section and carry forward across later compactions. Copies still in the recent
tail are not duplicated. If compaction happens before the second prompt, collection
continues until that prompt arrives.

This is a literal filename-matching heuristic, not an interpretation of required
reading. It does not capture every possible reference or fill in incomplete reads.

### Control the compaction cap

When the checkpoint exceeds its budget, capping first tightens tool presentation:
160→120→80-character previews, then grouped tool-only prefixes. Only if those stages
cannot make it fit does it remove conversation content. `tools-tightened` marks presentation changes; `trimmed` marks actual
omissions. Earlier structured spans can be tightened in the new checkpoint without
editing their stored originals; disabling the cap restores their normal rendering.
Text-only legacy spans use a conservative fallback.
See [how cap trimming works](docs/DESIGN.md#how-cap-trimming-works) for the full order.
This is meant as a fallback option for allowing compaction rounds to run far in excess of the intended use case, and should probably be used to allow work to be wrapped up before handing off to a new session. 
If you find that in normal usage you frequently work over the compaction cap, other compaction tools are likely to be more suitable.

The default is **`warn 25%`**: a conversation-and-retained-reads budget estimated at 25% of
the current model's context window, using **4 characters per token**, not an
exact tokenizer. When tightening or omission would be needed, choose **Apply trimming**,
**Disable cap for this session**, **Change budget**, or **Cancel compaction**. Disabling persists as `off`, rather than
bypassing just once. 

```text
/cap-compaction                 # report mode and budget
/cap-compaction warn             # prompt before trimming (default)
/cap-compaction on               # trim without prompting
/cap-compaction off              # disable cap-based trimming
/cap-compaction warn 20000t      # estimated tokens
/cap-compaction warn 25%         # percentage of model context window
/cap-compaction on 80000c        # the original character guard
```

Mode and budget are independent: omitting either preserves it. Budget-only input
such as `/cap-compaction 40000c` also works. Both settings persist in the session
and follow branch history through reload, resume, fork, and tree navigation.
They apply only to verbatim compaction, not summary compaction, and do not change
Pi's auto-compaction enabled setting.

Tokens are estimated with `ceil(chars / 4)`, not an exact tokenizer. For a
192,000-token window, `25%` gives 48,000 estimated tokens, equivalent to 192,000
characters. 

The budget is a size guard, not a guarantee that the whole model context fits.
Instructions and file lists remain outside it. Retained startup reads count as
fixed overhead but are never trimmed; if they alone exceed the budget, the
extension warns and keeps them. Disabling the cap still removes thinking and
unselected tool outputs and abbreviates tool-call signatures.
It may leave too much context for the model, particularly during overflow recovery.

With no interactive UI, `warn` emits a warning and applies the cap. TUI and
supported RPC clients can answer the dialogs. In interactive sessions, `warn`
can wait for an answer even during automatic compaction; use `/cap-compaction on`
for unattended operation. If a percentage cannot be resolved because the model's
context window is unavailable, compaction is cancelled: choose a character/token
budget or turn the cap off.

## Configuration

No separate configuration file is required. Set environment variables before
starting Pi:

| Variable | Default | Meaning |
|---|---|---|
| `MECH_COMPACT_MAX_SUMMARY_CHARS` | Unset (uses percentage budget) | Initial conversation-and-retained-reads character budget override; takes precedence over the percentage setting. |
| `MECH_COMPACT_MAX_SUMMARY_PERCENT` | `25` | Initial percentage of the model's context window, using estimated tokens. Accepts numbers greater than 0 and at most 100, including decimals; invalid values fall back to 25. |
| `MECH_COMPACT_LOOKUP_MODEL` | Session model | Optional `provider/modelId` for lookups; must support tool calls and be available in Pi. An unresolved model falls back to the session model. |
| `MECH_COMPACT_LOOKUP_TURNS` | `25` | Maximum substantive search turns. Valid continuation-only turns are exempt; total search-phase model calls are capped at 3× this budget (75 by default), plus one tool-free write-up on exhaustion. |
| `MECH_COMPACT_LOOKUP_MAX_CALLS` | `1` | Maximum consecutive lookup attempts. `0` means unlimited; see [recovery reset rules](docs/DESIGN.md#recover-historical-details). Invalid values fall back to 1. |
| `MECH_COMPACT_LOOKUP_SESSION_FILE` | Unset | Optional absolute path to a full session JSONL, replacing the current branch as the lookup source. Intended for harnesses using pruned forks. |

Cap-budget precedence is **session setting → explicit character setting → percentage setting**.
The initial cap mode remains `warn`.

For a different percentage default, with the character override unset:

```bash
MECH_COMPACT_MAX_SUMMARY_PERCENT=30 pi
```

Or use a fixed character budget:

```bash
MECH_COMPACT_MAX_SUMMARY_CHARS=40000 pi
```

The lookup model, turn budget, consecutive-call limit, and initial cap settings are read when the extension loads.
Use `/cap-compaction` to change the session budget or mode without restarting. The
session-file override is checked at each lookup. Restart Pi after changing its
launching environment; `/reload` does not change inherited environment variables.

Leave the session-file override unset for ordinary use. When configured, lookup
opens that file with `SessionManager.open()` and renders its branch. Relative,
missing, empty, or invalid source files fail explicitly rather than silently
searching the pruned fork. Opening a legacy file may trigger Pi's normal session
migration. The override is extension configuration, not a tool argument or a
filesystem search route for the main agent.

The character budget is not a token limit or a hard cap on the whole checkpoint.
Instructions and file lists sit outside the budget; an inherited base and retained
startup reads are uncapped, and the line budget has a 500-character minimum. Tune it
alongside the model's context window and Pi's `compaction.keepRecentTokens`.

### Select the compaction method

```text
/compaction-method
/compaction-method verbatim
/compaction-method summary
```

`/compaction-method` is available to opt-in to Pi's builtin summary compaction for the current session.

The choice applies to manual `/compact`, automatic threshold compaction, and context-overflow recovery.
With no argument, the command reports the current method. 

The choice persists in the existing session, follows branch history through
reload, resume, fork, and tree navigation, and needs no extra configuration file.
New sessions default to verbatim. 


### Local inference engines

When lookups use the session model on a local server, they share its KV cache with the main session.

- **llama.cpp**: on a single-slot server (`-np 1`), each lookup call evicts the main session's KV cache. Enable host-memory prompt caching with `--cache-ram <MiB>`, sized to hold at least one full main-session state, so the main session resumes in seconds instead of re-processing its entire context.
- **Other engines**: make sure the main session's prefix survives lookup calls, via prefix caching (on by default in vLLM and SGLang), host-RAM KV offloading where available, or enough parallel capacity to keep both sessions resident. Engines without these will re-prefill the main session after every lookup.

## License

[MIT](LICENSE).

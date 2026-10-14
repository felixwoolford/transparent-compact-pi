# transparent-compact

Deterministic context compaction for [Pi](https://pi.dev/), with session-backed
recovery. By default, replaces Pi's model-generated compaction summary with a verbatim
compaction, with a checkpoint built mechanically from conversation text. Thinking and tool outputs are removed
from the active model context, while user inputs, assistant text, and tool call stubs are retained verbatim.
Verbatim compaction itself makes no model call. When a missing detail is needed, `context_lookup` runs a subagent over the session's
full raw branch and returns only relevant findings.
The goal is to let the agent withstand many (but finite) rounds of compaction without the copy-of-a-copy degradation of model-summary compaction, which is exacerbated in sub-frontier models.

The method is functionally similar to pi-vcc, but is specifically aimed at lighter weight models
such as **Qwen 3.8 27B** or **GPT-6 Luna**. The design principle is that:

- Algorithmic or model-based manipulation of prose has the potential to confound the model later, and should be avoided.
- History retrieval should be parsimonious, explicitly clear to the agent, and agnostic to the task and session structure. 

[This study](docs/transparent-compact_vs_pi_vs_pi-vdd.pdf) demonstrated that a minimal system like
this outperforms more complicated techniques with lightweight models, and is at least as effective with frontier models too. 
It helps weaker models to avoid confabulating the historical context and to more carefully verify what it does and does not know.

The primary intended use case is on a strong local LLM with a reasonably large context window (128k+) : for example,  through
**Qwen 3.8 27B llama.cpp on an RTX 5090**. Recovery uses the session model by default and does not require a second model to be loaded.

## Install

### Package installation

Install from git:

```bash
pi install git:github.com/felixwoolford/transparent-compact-pi
```

or from a downloaded or cloned checkout:

```bash
pi install /absolute/path/to/transparent-compact
```

This installs both the extension and the `context-retrieval` skill. Run `/reload`
in an existing Pi session, or restart Pi.

Use `pi install --local <source>` for a project-only installation. To load a
local checkout for one invocation without saving an installation:

```bash
pi -e /absolute/path/to/transparent-compact
```

Remove previously copied extensions and skills before installing the package,
so only one copy loads. Replace older copies of **both** resources when updating.

### Manual installation

From the checkout directory:

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
cp extensions/transparent-compact.ts ~/.pi/agent/extensions/
cp -r skills/context-retrieval ~/.pi/agent/skills/
```

Then `/reload`. Project equivalents are `.pi/extensions/` and `.pi/skills/`.


## Usage

Pi's compaction uses transparent-compact by default once the extension is loaded.
To compact manually:

```text
/compact
```

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

### Control the compaction cap

Capping of the context eventually applies to strip further elements from the checkpoint.
See [how cap trimming works](docs/DESIGN.md#how-cap-trimming-works) for the removal order.
This is meant as a fallback option for allowing compaction rounds to run far in excess of the intended use case, and should probably be used to allow work to be wrapped up before handing off to a new session. 
If you find that in normal usage you frequently work over the compaction cap, other compaction tools are likely to be more suitable.

The default is **`warn 25%`**: a conversation-section budget estimated at 25% of
the current model's context window, using **4 characters per token**, not an
exact tokenizer. When content would actually be trimmed, choose **Apply trimming**,
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
Instructions and file lists remain outside it. Disabling the cap
still removes thinking and tool outputs and abbreviates tool-call signatures.
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
| `MECH_COMPACT_MAX_SUMMARY_CHARS` | Unset (uses percentage budget) | Initial conversation-section character budget override; takes precedence over the percentage setting. |
| `MECH_COMPACT_MAX_SUMMARY_PERCENT` | `25` | Initial percentage of the model's context window, using estimated tokens. Accepts numbers greater than 0 and at most 100, including decimals; invalid values fall back to 25. |
| `MECH_COMPACT_LOOKUP_MODEL` | Session model | Optional `provider/modelId` for lookups; must support tool calls and be available in Pi. An unresolved model falls back to the session model. |
| `MECH_COMPACT_LOOKUP_TURNS` | `10` | Maximum substantive search turns. Valid continuation-only turns are exempt; total search-phase model calls are capped at 3× this budget (30 by default), plus one tool-free write-up on exhaustion. |
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
Instructions and file lists sit outside the conversation section; an inherited
base is uncapped and the line budget has a 500-character minimum. Tune it
alongside the model's context window and Pi's `compaction.keepRecentTokens`.

### Local inference engines

When lookups use the session model on a local server, they share its KV cache with the main session.

- **llama.cpp**: on a single-slot server (`-np 1`), each lookup call evicts the main session's KV cache. Enable host-memory prompt caching with `--cache-ram <MiB>`, sized to hold at least one full main-session state, so the main session resumes in seconds instead of re-processing its entire context.
- **Other engines**: make sure the main session's prefix survives lookup calls, via prefix caching (on by default in vLLM and SGLang), host-RAM KV offloading where available, or enough parallel capacity to keep both sessions resident. Engines without these will re-prefill the main session after every lookup.

## License

[MIT](LICENSE).

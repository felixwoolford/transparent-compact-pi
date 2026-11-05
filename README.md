# transparent-compact-pi

[Context compaction](#control-compaction) and pruning for [Pi](https://pi.dev/) that keeps conversation text verbatim instead of replacing it with a model-generated summary. It removes thinking and most tool output from the active context, while keeping user messages, assistant text, compact tool-call stubs and explicitly selected reads. The original session history remains available.

When the agent needs a detail that is no longer in context, it can use retrieval tools to search the recorded session with a subagent. Compaction itself does not make a model call.

The user can also [selectively manipulate which turns to hold in the current context](#filter-turns) in higher or lower fidelity, and [specify file reads to be retained in the context in full](#retain-reads), (e.g. a spec or plan).

This extension is aimed at addressing two main issues that other compaction techniques face, which are especially exacerbated in agents running on lightweight and local LLMs: 
- Model summaries such as Pi's default method can lead to degradation and confabulation of details that can cause confident blunders.
- Retrieval-based systems like `pi-vcc` can be effective when the agent knows what to look for, but omitting session structure from the retained context can make the actual use of retrieval less reliable.

`transparent-compact` is also a retrieval-based system, but its design keeps manipulation of conversation text to a minimum and maximises the agent's awareness of its own compacted state, with the aim of avoiding confabulation and encouraging accurate retrieval of historical details. [This study](https://arxiv.org/abs/2610.20116) found that a minimal approach outperformed more complex techniques with lightweight models and was at least as effective with frontier models.

The verbatim compaction system plays particularly nicely with manual pruning of the context. This allows you to decide which parts of the session remain important to the current work, without having to commit to a particular branching point with /tree or decide at the time of the prompt with something like claude's /btw.

The extension is particularly suited to capable local models with reasonably large context windows (over 128k tokens), such as Qwen 3.8 27B running on llama.cpp with an RTX 5090, but it is also effective with frontier models and larger context windows.

## Install

```bash
pi install npm:@foliox/transparent-compact-pi
```

Alternatively, install from GitHub or a local checkout:

```bash
pi install git:github.com/felixwoolford/transparent-compact-pi
pi install /absolute/path/to/transparent-compact
```

Once loaded, the extension uses verbatim compaction by default. Pi's automatic compaction continues to work, using the extension's configured method; to compact manually, enter:

```text
/compact
```

No additional setup is required. The agent can recover missing details from session history as needed.

## Filter turns

Use these commands while the agent is idle:

```text
/filter-turns       # edit an existing checkpoint
/compact-filtered   # compact first, then open the editor
```

Use `/compact-filtered` if there is no checkpoint yet. Cancelling its editor does not undo the compaction that just completed. If there is nothing new to compact, it opens the existing checkpoint.

Each selection covers a user message and all following activity up to the next user message:

| Mode | What stays in context |
| --- | --- |
| **PRUNED** `[X]` | A marker in place of the turn |
| **PROSE** `[ ]` | Conversation text and compact tool stubs |
| **PROSE+TOOLS** `[○]` | Conversation text and recorded tool arguments and results; thinking markers only |
| **FULL** `[■]` | All recorded content, including thinking and images |
| **LOCKED** `[-]` | Not available for editing |

Navigate with **↑/↓**; use **←/→** to collapse or expand details. Press **Space** to prune a turn or restore it to PROSE, or **f** to cycle through all four modes. Press **Enter** to review changes, then **Enter** again to save; **Esc** goes back or cancels. The editor shows an estimated context size as you choose.

You can restore filtered turns later. Choices persist in the current session branch through later verbatim compactions and reloads. Turns overlapping Pi's retained recent history are locked until they can be filtered as a whole; individual content inside an inherited summary cannot be selected.

PROSE+TOOLS and FULL can use substantial context. Oversized selections are rejected, and if later context growth or a model change makes them too large, use `/filter-turns` to downgrade them. FULL includes only what was recorded; provider and model limitations can still affect thinking and images.

### Manual context editing and caching
Manual context edits typically reduce prompt-cache reuse for the next model request, so frequent edits of the retained reads or turn filters are discouraged, and the best time to adjust them is just after compaction, before the next request.

The extension never automatically modifies the context outside of Pi's usual compaction trigger. The user is expected to control the filtering system, or simply ignore it when not needed.
Treat filtering/pruning/read-retention as useful tools when the situation calls for them, not necessary to the use of the compaction system.

### Flag an aside

```text
/filter-later <message>  # send a turn and flag it for filtering
/fl <message>            # short alias
/filter-auto             # show automatic filtering policy
/filter-auto on          # apply flags during automatic compaction
/filter-auto off         # stop automatically applying new flags
```

A flagged turn remains in context until it is eligible for filtering. It is preselected for pruning in the editor, where you can keep or later restore it. Automatic application of flags is **off** by default. `/fl` is a normal conversation turn, not an isolated aside.

## Retain reads

Use `/retain-reads` while the agent is idle to keep selected text-read outputs verbatim in the checkpoint. Each file can be **OFF**, **FIRST**, or **LATEST**. In the picker, controls are as in the turn-filtering picker.

Consecutive partial reads of the same file with connected ranges form one selectable read episode. Another tool operation, a restarted range, or a new user turn starts a new episode. The picker shows full or partial coverage and flags reads from filtered turns. Retention survives turn filtering; 

Retained outputs are historical snapshots of the read tool output, not current file contents. 

### Automatic file retention

Nothing is retained automatically, but files can be declared for retention in `AGENTS.md` or `CLAUDE.md` like so:

```text
<retain-reads>
docs/SPEC.md
latest: docs/WORKING-NOTES.md
</retain-reads>
```

Use one literal path per line, relative to the instruction file. Plain paths default to FIRST; `latest:` selects the latest read. These declarations do not read files themselves. Manual choices override the defaults.

## Control compaction

### Choose the method

```text
/compaction-method           # show current method
/compaction-method verbatim  # extension's compaction (default)
/compaction-method summary   # Pi's built-in summary compaction
```

The selection applies to manual and automatic compaction, including overflow recovery, and persists in the session branch. New sessions default to verbatim. Manual filtering requires verbatim mode.

### Set the size cap

By default, the extension warns before trimming a checkpoint that exceeds an estimated **25% of the model's context window**. The interactive prompt lets you apply trimming, disable the cap for the session, change the budget, or cancel compaction. Capping works by progressively reducing the size of tool stubs and then as a last resort truncating assistant prose and finally truncating user prose. With normal use, this shouldn't occur until over a dozen compactions.
If you regularly reach the cap, consider starting a new session or using a different compaction method that is more suited to your workflow.


```text
/cap-compaction               # show mode and budget
/cap-compaction warn          # prompt before trimming (default)
/cap-compaction on            # trim without prompting
/cap-compaction off           # disable cap-based trimming
/cap-compaction warn 20000t   # estimated token budget
/cap-compaction warn 25%      # percentage of model context window
/cap-compaction on 80000c     # character budget
/cap-compaction 40000c        # change budget without changing mode
```

Mode and budget persist in the session branch; changing one leaves the other unchanged. They apply only to verbatim compaction. The cap estimates tokens at four characters each and is not a limit on the whole model context. Some content, including retained reads, is not trimmed. Disabling the cap may leave too much context for the model.

For unattended use, choose `on` to avoid interactive prompts. Without an interactive UI, `warn` emits a warning and applies the cap. If the model's context window is unavailable, use a fixed token or character budget, or turn the cap off.

## Configuration

No configuration file is needed. Set these environment variables before starting Pi:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MECH_COMPACT_MAX_SUMMARY_PERCENT` | `25` | Initial cap as a percentage of the model's context window (greater than 0, up to 100). |
| `MECH_COMPACT_MAX_SUMMARY_CHARS` | Unset | Initial fixed character budget; overrides the percentage. |
| `MECH_COMPACT_LOOKUP_MODEL` | Session model | Lookup model as `provider/modelId`; it must be available in Pi and support tool calls. An unresolved model falls back to the session model. |
| `MECH_COMPACT_LOOKUP_TURNS` | `25` | Maximum substantive search turns per lookup. |
| `MECH_COMPACT_LOOKUP_MAX_CALLS` | `3` | Maximum consecutive lookup attempts; `0` means unlimited. |
| `MECH_COMPACT_LOOKUP_SESSION_FILE` | Unset | Absolute path to a full session JSONL to search instead of the current branch, for harnesses using pruned forks. Leave unset for ordinary use. |

For example:

```bash
MECH_COMPACT_MAX_SUMMARY_PERCENT=30 pi
MECH_COMPACT_LOOKUP_MODEL=provider/modelId pi
```

A session setting from `/cap-compaction` takes precedence over the environment defaults. Restart Pi after changing its launching environment; `/reload` cannot change inherited environment variables.

### Local inference

Lookups using the session model can disrupt the main session's prompt cache. For a single-slot llama.cpp server (`-np 1`), enable `--cache-ram <MiB>` with enough host memory for the main session state. On other engines, use prefix caching, KV offloading, or sufficient parallel capacity to keep both sessions resident.

## License

[MIT](LICENSE).

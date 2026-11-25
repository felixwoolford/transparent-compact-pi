# transparent-compact-pi

Context compaction and pruning for [Pi](https://pi.dev/) that keeps conversation text verbatim instead of replacing it with a model-generated summary or truncation. It removes thinking and most tool output from the active context, while keeping user messages, assistant text, algorithmically compacted tool-call stubs and explicitly selected reads. 

When the agent needs a detail that is no longer in context, it can use retrieval tools to search the recorded session history with a subagent (no extra extension required). Compaction itself does not make a model call.

The user can also [selectively manipulate which turns to hold in the current context](#filter-turns) in higher or lower fidelity, and [specify file reads to be retained in the context in full](#retain-reads), (e.g. a spec or plan).

This extension is aimed at addressing two main issues that other compaction techniques face, which are especially exacerbated in agents running on lightweight and local LLMs: 
- Model summaries such as Pi's default method can lead to degradation and confabulation of details that can cause confident blunders.
- Mechanical compression (i.e. no model call) + retrieval systems like `pi-vcc` can be effective when the agent knows what to look for, but omitting session structure from the retained context can make the actual use of retrieval less reliable.

`transparent-compact` is also a mechanical compression + retrieval system, but its design keeps manipulation of conversation text to a minimum and maximises the agent's awareness of its own compacted state, with the aim of avoiding confabulation and encouraging accurate retrieval of historical details. [This study](https://arxiv.org/abs/2610.20116) found that a minimal approach outperformed more complex techniques with lightweight models and was at least as effective with frontier models.

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

Once loaded, the extension uses verbatim mechanical compaction by default. Pi's automatic compaction triggering continues to work, using the extension's configured method; to compact manually, enter:

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

You can restore filtered turns later. Choices persist in the current session branch through later verbatim compactions and reloads. Turns overlapping Pi's retained recent history are locked until they can be filtered as a whole.

PROSE+TOOLS and FULL can use substantial context. FULL includes only what was recorded; provider and model limitations can still affect thinking and images.

### Manual context editing and caching
Manual context edits typically reduce prompt-cache reuse for the next model request, so frequent edits of the retained reads or turn filters are discouraged, and the best time to adjust them is just after compaction, before the next request.

The extension never automatically modifies the context outside of Pi's usual compaction trigger. The user is expected to control the filtering system, or simply ignore it when not needed.
Treat filtering/pruning/read-retention as useful tools when the situation calls for them, not necessary to the use of the compaction system.

### Flag an aside

```text
/filter-later <message>  # send a turn and flag it for pruning
/fl <message>            # short alias
```

Flagged turns are automatically pruned during manual or automatic verbatim compaction once they are fully outside the retained recent history. Until then, they remain in context and are locked in the filtering editor.

Use `/filter-turns` to keep or restore a flagged turn. Manually restored turns stay restored.

`/fl` sends a normal conversation turn, not an isolated aside.

## Retain reads

Use `/retain-reads` while the agent is idle to keep selected text-read outputs verbatim in the checkpoint. Each file can be **OFF**, **FIRST**, or **LATEST**. In the picker, controls are as in the turn-filtering picker.

Consecutive partial reads of the same file with connected ranges form one selectable read episode. Another tool operation, a restarted range, or a new user turn starts a new episode. The picker shows full or partial coverage and flags reads from filtered turns. Retention survives turn filtering; 

Retained outputs are historical snapshots of the read tool output, not current file contents. 

### Automatic read retention

Nothing is retained automatically, but files can be declared for retention in `AGENTS.md` or `CLAUDE.md` like so:

```text
<retain-reads>
docs/SPEC.md
latest: docs/WORKING-NOTES.md
</retain-reads>
```

Use one literal path per line, relative to the instruction file. Plain paths default to FIRST; `latest:` selects the latest read. These declarations do not read files themselves. Manual choices override the defaults.


## Settings menu and configuration

Optionally, open `/compact-settings` while the agent is idle to configure compaction, checkpoint size limits, lookup models and recovery.

Use **↑/↓** to navigate and **Space** or **e** to edit. Press **d** to restore a setting's built-in default. A `*` marks pending edits.

Press **Enter** to review, then choose where to apply your changes:

- **Session:** use them in the current session branch.
- **Project:** also save defaults in `.pi/settings.json`.
- **Global:** also save defaults in `~/.pi/agent/settings.json`.

Press **Enter** again to confirm, or **Esc** to go back or cancel. Session choices survive compaction and resume.

### Compaction method

**Verbatim** is the default and enables transparent-compact's compaction and context pruning.

**Summary** uses Pi's original model-generated compaction instead, effectively disabling transparent-compact's compaction and pruning features. Use this if you just want to use model summary with the `context_lookup` tool. Note that the agent may use the tool less effectively in this mode.

### Checkpoint size cap

By default, the extension warns before trimming a checkpoint that exceeds an estimated **25% of the model's context window**.

Choose a cap mode:

- **warn:** ask before trimming.
- **on:** trim without prompting.
- **off:** disable cap-based trimming.

And enter a budget such as `25%`, `20000t` for estimated tokens, or `80000c` for characters.

Trimming progressively reduces tool stubs before truncating assistant prose and, finally, user prose. Some content, including retained reads, is not trimmed. The cap applies only to verbatim checkpoints, not the whole model context; disabling it can leave too much context for the model.

For unattended use, choose **on**. Without an interactive UI, **warn** emits a warning and applies the cap.

### Lookup and recovery

By default, a subagent searches recorded history using the session model. The **Lookup model** picker offers Pi's scoped models—or all available models if no scope is configured. Search by model ID, provider or name, or choose **Use session model**.

**Lookup search turns** limits each search. **Consecutive lookups** limits consecutive retrieval attempts; `0` means unlimited.

**Direct recovery is experimental.** It lets the main agent search and read history itself, avoiding a separate model call but putting retrieved pages into the main context. The lookup-model and subagent search limits do not apply.

Choose recovery mode before the first compaction. Once direct recovery is enabled, or the session has compacted, the menu can only save recovery-mode defaults for new sessions.

### Settings files

If you save globally or locally the settings save to Pi's `~/.pi/agent/settings.json` or `.pi/settings.json`, e.g.:

```json
{
  "transparentCompact": {
    "maxSummaryPercent": 30,
    "lookupMaxCalls": 5
  }
}
```

| Key | Default | Values or purpose |
| --- | --- | --- |
| `compactionMethod` | `"verbatim"` | `"verbatim"` or `"summary"` |
| `capMode` | `"warn"` | `"warn"`, `"on"` or `"off"` |
| `maxSummaryPercent` | `25` | Cap as a percentage of the model's context window |
| `maxSummaryChars` | Unset | Fixed character cap; takes precedence over the percentage |
| `lookupModel` | Session model | `provider/modelId`; must support tool calls |
| `lookupTurns` | `25` | Maximum substantive search turns per lookup |
| `lookupMaxCalls` | `3` | Maximum consecutive lookup attempts; `0` means unlimited |
| `mainAgentLookup` | `false` | `true` enables experimental direct recovery |

Project settings override global settings. Environment overrides take precedence over files; recorded session choices take precedence over both.

### Environment overrides

For individual launches or automation:

| Variable | Corresponding setting |
| --- | --- |
| `MECH_COMPACT_MAX_SUMMARY_PERCENT` | `maxSummaryPercent` |
| `MECH_COMPACT_MAX_SUMMARY_CHARS` | `maxSummaryChars` |
| `MECH_COMPACT_LOOKUP_MODEL` | `lookupModel` |
| `MECH_COMPACT_LOOKUP_TURNS` | `lookupTurns` |
| `MECH_COMPACT_LOOKUP_MAX_CALLS` | `lookupMaxCalls` |
| `MECH_COMPACT_MAIN_AGENT_LOOKUP` | `mainAgentLookup`: `1` enables, `0` disables |

`MECH_COMPACT_LOOKUP_SESSION_FILE` optionally supplies an absolute session JSONL path for history retrieval instead of the current branch. Leave it unset for ordinary use.

## Other stuff
### Export the checkpoint

For debugging, use `/export-checkpoint [path]` to save the current checkpoint as plain text. Without a path, it writes `pi-checkpoint-<session-id>.txt` in the working directory; quote paths containing spaces.

This exports the saved text, including confirmed filtering and read-retention edits, without rebuilding or changing context. Recent messages and separately reinserted PROSE+TOOLS/FULL messages are not included.

### Local inference suggestion

Lookups using the session model can disrupt the main session's prompt cache. For a single-slot llama.cpp server (`-np 1`), enable `--cache-ram <MiB>` with enough host memory for the main session state. On other engines, use prefix caching, KV offloading, or sufficient parallel capacity to keep both sessions resident.

### License

[MIT](LICENSE).

<div align="right">
  <a href="./README.md">中文</a> | <span>English</span>
</div>

# Codex Promptor

Codex Promptor is a local Windows tool for managing Codex, Claude Code, and Cursor CLI conversations in tabs and submitting tasks to the same session in prompt-list order. Select the provider from the drop-down beside **Confirm and open** when connecting a new tab. The selection is persisted with the tab and cannot be changed after the tab is connected. PowerShell always runs the selected provider's real interactive TUI, so model selection, approvals, manual questions, and native commands remain available.

All three adapters share the same Prompt list, Final Answers, pause/interrupt behavior, automatic restoration, and JSON persistence, while their session-control paths differ:

- Codex keeps the App Server JSON-RPC architecture: normal queue items use `turn/start`, and **Insert now** uses `turn/steer`;
- Claude Code runs the native `claude` TUI, submits queued text through PTY bracketed paste, uses silent command hooks bridged to a tab-private loopback HTTP endpoint for session/prompt/completion/interruption events, and reconciles history from Claude's JSONL transcript;
- Cursor CLI runs the requested native `agent` TUI, submits through the PTY, and normalizes the official `sessionStart`, `beforeSubmitPrompt`, `afterAgentResponse`, `stop`, and `sessionEnd` hooks. Promptor merges rather than replaces `~/.cursor/hooks.json`, backs up an existing file under `data/backups/`, and the bridge is a no-op in Cursor sessions not launched by Promptor.

Claude/Cursor do not have Codex's structured `turn/start` path, so automated prompts and manual typing share the real TUI input box. Do not leave an unsubmitted draft in that box while the automatic queue is running. Submitted manual questions, in-progress follow-ups, and native selections remain under the CLI's control; hooks only observe lifecycle events and do not replace model or approval settings.

Each Codex tab uses an independent App Server. When a new conversation is created, the real remote TUI starts it with `thread/start`, and Promptor binds the tab as soon as it captures the successful response. It does not incorrectly pass an empty thread that has not yet been written to disk to `thread/read` or `codex resume`; the first queued or manually entered message creates the rollout normally. When a conversation is resumed or its terminal is reopened, the remote TUI loads the thread first. The queue controller calls `thread/resume` to subscribe to events only after the thread is confirmed as `idle` or genuinely `active`. This prevents completed historical conversations from remaining indefinitely in a false `Working` state in the TUI. The TUI connects to the App Server through a dedicated local proxy port for each tab. The proxy does not rewrite keyboard input. It normalizes `historyMode: paginated` in TUI requests for new threads to the officially supported `legacy` mode, which allows complete `thread/read` results, while forwarding all other protocol messages transparently. It also detects successful `/resume`, `/fork`, and `/new` operations and rebinds the tab and queue to the new thread. Whenever an existing rollout is resumed or selected, Promptor reads the full current thread: completed history from an old thread in the JSON files is replaced by the current history, while local prompts that have not run retain their order and are appended after the completed history. Closing a conversation terminates the complete process tree for that tab's provider and releases its session writer.

## Running

Requirements: Windows, Node.js 22–24, npm. A **Terminal** conversation (a plain PowerShell with no agent attached) needs no CLI at all; agent conversations need at least one signed-in CLI on `PATH`: `codex` for Codex (protocol baseline: `codex-cli 0.147.0`), `claude` for Claude Code (locally verified with 2.1.228), or `agent` for Cursor CLI. Check with `codex --version`, `claude --version`, or `agent --version`. Selecting a provider whose executable is missing produces an explicit pre-launch error and does not affect the others.

```powershell
npm ci
.\start.ps1
```

`start.ps1` starts a service that listens only on `127.0.0.1` and opens `http://127.0.0.1:4317/`. The same fixed address can also be opened manually. Before launching, the script compares the last write times of `src/`, `config/` and `package.json` against `dist/` and runs `npm run build` when the sources moved ahead; an unchanged tree starts immediately. Use `.\start.ps1 -Force` to rebuild unconditionally, or `.\start.ps1 -NoBuild` to launch the existing build without checking. After the last Promptor page closes, the backend waits 30 seconds; refreshing or reopening a page during that period cancels shutdown. If no page reconnects, it records which conversations are still open, interrupts active turns, stops all child processes, and exits. On the next launch, it uses each tab's persisted provider to restore its App Server or hook adapter, PowerShell/TUI, and history reconciliation in parallel. Tabs that the user explicitly closed with **Close conversation** are not restored automatically; their queues remain paused and do not resubmit prompts. Set `CODEX_PROMPTOR_AUTO_EXIT=0` to disable automatic shutdown. Each tab stores its data under `data/tabs/<tab-id>/`:

- `prompt-list.json`: prompts, ordering, start/completion times, attempts, and status;
- `final-answers.json`: per-turn start, completion/interruption state, and final answers;
- `runtime.json`: queue, terminal, and history-reconciliation state.

Terminal output itself is not persisted to disk. When a browser first attaches, it receives one in-memory snapshot; subsequent updates are delivered incrementally using a byte cursor. Reconnecting the WebSocket does not replay and redraw the terminal from the beginning. While a pane or window is being resized, xterm fits locally without delay, but real PTY resize events are coalesced until the dimensions briefly settle. The backend also ignores duplicate sizes and persists each tab's last confirmed rows and columns, so a restored ConPTY starts at the correct size instead of loading at 80×12 and immediately reflowing. During a large initial snapshot or long-thread reflow, a stable synchronization notice covers intermediate TUI frames and is removed only after the final input screen is recognized, so the user does not watch history sweep past from the beginning. After a Codex TUI completes its initial thread selection or resume, the backend writes one unsubmitted draft space into the real terminal to stabilize the TUI cursor in its otherwise empty input state. It happens once per PTY; page refreshes and WebSocket reconnects do not repeat it, and App Server queue submission is unaffected.

In the console sidebar, a gray square indicates a closed conversation and a larger green dot indicates an open but idle conversation. While the queue is executing a prompt, the green dot continuously pulses. After each queued prompt finishes, the browser plays a short two-tone notification and displays a clock icon beside the corresponding tab for 30 seconds. Notifications only respond to live completion events with `origin: queue`; importing history, interacting manually in the TUI, and refreshing the page do not replay notification sounds.

Rename and delete actions for groups and conversations are collected in the **⋮** menu on the right of each row. The Windows folder picker uses a foreground Explorer-style window. Only one picker can be open at a time; after it is canceled, another can be opened immediately. Any picker still waiting for input is also closed when the backend exits.

At the bottom of the console sidebar, the moon/sun icon on the left switches between light and dark themes, and `中 / En` on the right switches the complete application interface language. Both preferences are stored in `data/index.json` and restored after restart. Prompts, final answers, terminal output, paths, and user-defined names always remain in their original language. The prompt-list title, completed count, current state, and Start/Pause buttons share one row. In a narrow pane, the state description is truncated before the action buttons are hidden. Adding the first pending prompt to an empty queue starts it automatically; if the queue is paused and already has pending items, adding another prompt only enqueues it and does not resume execution. A pencil button edits a pending item. **Insert now** appends that item to the active turn; while idle, it runs the selected item first, and a previously paused queue returns to paused after that one item finishes.

As soon as the selected coding agent accepts a queued prompt for execution, Final Answers creates a **Running** record with the start time at the top right. When the final answer arrives, the same record is filled in and receives an end time at the bottom right. If closing, pausing, or service shutdown interrupts the turn, that record is finalized in place as **Interrupted** with its reason and no fabricated final answer.

## Resuming an Existing Conversation

In a tab, select **Continue an existing conversation** and enter its session/thread ID. After the terminal attaches, Codex uses `thread/read(includeTurns=true)` for structured history, Claude Code locates the JSONL transcript supplied by its hook or under `~/.claude/projects/`, and Cursor uses the hook's `transcript_path` or a discoverable transcript under `~/.cursor/`. All adapters import only completed turns containing both user input and a final answer and reconcile them idempotently by `(threadId, turnId)`, so repeated resumes do not duplicate records. Imported records use `origin: imported`, appear immediately, and are written to both JSON files. Any `running` or `dispatching` record orphaned by a service restart is changed to `interrupted`, so the queue cannot remain stuck in an executing state. **Sync history** performs the same full reconciliation, and **Reopen terminal** runs it automatically after restoration. Claude/Cursor transcript formats are controlled by their CLIs; if a later version cannot be recognized, synchronization reports an explicit failure instead of guessing answers.

Codex `/resume`, `/fork`, and `/new`, plus native Claude/Cursor switches that emit `SessionStart`, pause the old queue, rebind the page, and reconcile the newly selected history. The thread/session ID, working directory, Prompt list, and Final Answers update automatically, and the status panel persists the source, target, and time of the latest followed switch. Every executed `prompt-list.json` record includes a `threadId`, while Final Answers displays only the current thread/session. Unbound `pending` records are retained. Auxiliary threads created by detached reviews or subagents do not incorrectly change the tab binding.

## Development and Verification

```powershell
npm run typecheck
npm test
npm run build
```

See [IMPLEMENTATION_SPEC.md](./docs/IMPLEMENTATION_SPEC.md) for implementation details and the API/data contracts.

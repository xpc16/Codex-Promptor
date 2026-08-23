<div align="right">
  <a href="./README.md">中文</a> | <span>English</span>
</div>

# Codex Promptor

Codex Promptor is a local Windows tool for managing multiple Codex conversations in tabs and submitting tasks to the same Codex thread in prompt-list order. The PowerShell pane runs the real Codex TUI. The queue submits turns through the local App Server JSON-RPC `turn/start` method and does not simulate or override the model, approvals, or manual terminal input.

Each open tab uses an independent Codex App Server. When a new conversation is created, the real remote TUI starts it with `thread/start`, and Promptor binds the tab as soon as it captures the successful response. It does not incorrectly pass an empty thread that has not yet been written to disk to `thread/read` or `codex resume`; the first queued or manually entered message creates the rollout normally. When a conversation is resumed or its terminal is reopened, the remote TUI loads the thread first. The queue controller calls `thread/resume` to subscribe to events only after the thread is confirmed as `idle` or genuinely `active`. This prevents completed historical conversations from remaining indefinitely in a false `Working` state in the TUI. The TUI connects to the App Server through a dedicated local proxy port for each tab. The proxy does not rewrite keyboard input. It normalizes `historyMode: paginated` in TUI requests for new threads to the officially supported `legacy` mode, which allows complete `thread/read` results, while forwarding all other protocol messages transparently. It also detects successful `/resume`, `/fork`, and `/new` operations and rebinds the tab and queue to the new thread. Whenever an existing rollout is resumed or selected, Promptor reads the full current thread: completed history from an old thread in the JSON files is replaced by the current history, while local prompts that have not run retain their order and are appended after the completed history. Closing a conversation terminates the tab's complete PowerShell, remote TUI, proxy-port, and App Server process tree and releases the session writer, so `codex resume <session-id>` can be run immediately in an external terminal.

## Running

Requirements: Windows, Node.js 22–24, `codex-cli 0.147.0`, and npm.

```powershell
.\setup.ps1
.\start.ps1
```

`start.ps1` starts a service that listens only on `127.0.0.1` and opens `http://127.0.0.1:4317/`. The same fixed address can also be opened manually. After the last Promptor page closes, the backend waits five seconds to allow a normal page refresh to reconnect, records which conversations are still open, stops all child processes, and exits. On the next launch, it restores those conversations' App Servers, PowerShell/Codex TUIs, and history synchronization in parallel. Tabs that the user explicitly closed with **Close conversation** are not restored automatically; their queues remain paused and do not resubmit prompts. Set `CODEX_PROMPTOR_AUTO_EXIT=0` to disable automatic shutdown. Each tab stores its data under `data/tabs/<tab-id>/`:

- `prompt-list.json`: prompts, ordering, start/completion times, attempts, and status;
- `final-answers.json`: final answers stored separately and associated with their prompts;
- `runtime.json`: queue, terminal, and history-reconciliation state.

Terminal output is not persisted to disk. When a browser first attaches, it receives one in-memory snapshot; subsequent updates are delivered incrementally using a byte cursor. Reconnecting the WebSocket does not replay and redraw the terminal from the beginning.

In the console sidebar, a gray square indicates a closed conversation and a larger green dot indicates an open but idle conversation. While the queue is executing a prompt, the green dot continuously pulses. After each queued prompt finishes, the browser plays a short two-tone notification and displays a clock icon beside the corresponding tab for 30 seconds. Notifications only respond to live completion events with `origin: queue`; importing history, interacting manually in the TUI, and refreshing the page do not replay notification sounds.

Rename and delete actions for groups and conversations are collected in the **⋮** menu on the right of each row. The Windows folder picker uses a foreground Explorer-style window. Only one picker can be open at a time; after it is canceled, another can be opened immediately. Any picker still waiting for input is also closed when the backend exits.

At the bottom of the console sidebar, the moon/sun icon on the left switches between light and dark themes, and `中 / En` on the right switches the complete application interface language. Both preferences are stored in `data/index.json` and restored after restart. Prompts, final answers, terminal output, paths, and user-defined names always remain in their original language. The prompt-list title, completed count, current state, and Start/Pause buttons share one row. In a narrow pane, the state description is truncated before the action buttons are hidden.

## Resuming an Existing Conversation

In a tab, select **Continue an existing conversation** and enter its session/thread ID. After the terminal attaches, the service calls `thread/read(includeTurns=true)` and imports only completed turns that contain both user input and a final answer. Imports are idempotent by `(threadId, turnId)`, so resuming the same conversation repeatedly does not create duplicate records. Imported records use `origin: imported`, appear immediately in the Final Answers panel, and are written to both JSON files for the same tab. **Sync history** at the bottom of the console sidebar performs the same full reconciliation, and **Reopen terminal** runs it automatically after the conversation is restored.

Using `/resume`, `/fork`, or `/new` in the real PowerShell TUI triggers the same workflow. The thread/session ID, working directory, Prompt list, and Final Answers on the page update automatically. The status panel persistently shows the source, target, and time of the most recent followed switch. Every executed record in `prompt-list.json` includes a `threadId`, while `final-answers.json` retains answers only for the current thread so that answers from other conversations do not appear in the panel. Unbound `pending` records are not removed. Auxiliary threads created by detached reviews or subagents do not incorrectly change the tab binding.

## Development and Verification

```powershell
npm run typecheck
npm test
npm run build
```

See [IMPLEMENTATION_SPEC.md](./docs/IMPLEMENTATION_SPEC.md) for implementation details and the API/data contracts.

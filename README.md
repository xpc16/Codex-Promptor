<div align="right">
  <span>中文</span> | <a href="./README_en.md">English</a>
</div>

# Codex Promptor

本地 Windows 工具：用标签管理 Codex、Claude Code 和 Cursor CLI 对话，并按 prompt list 顺序向同一个会话提交任务。新标签连接时可从“确定并打开”旁的下拉框选择提供商；选择会随标签持久保存，已连接标签不能中途切换提供商。PowerShell 内始终运行所选工具的真实交互式 TUI，用户仍可选择模型、审批、输入问题或使用原生命令。

三种适配共用同一套 Prompt list、Final answers、暂停/中断、自动恢复和 JSON 持久化界面，但会话控制方式不同：

- Codex 保留现有 App Server JSON-RPC 架构，普通队列使用 `turn/start`，“立即插入”使用 `turn/steer`；
- Claude Code 运行原生 `claude` TUI，队列通过 PTY 的 bracketed paste 提交，使用静默 command hook 桥接到标签私有的本机 HTTP 端点，以判断会话、prompt 开始、完成和中断，并从 Claude JSONL transcript 对账历史；
- Cursor CLI 运行用户指定的 `agent` TUI，队列同样通过 PTY 提交，使用 Cursor 官方 hooks 的 `sessionStart`、`beforeSubmitPrompt`、`afterAgentResponse`、`stop` 和 `sessionEnd` 归一化生命周期。Promptor 会合并而不覆盖 `~/.cursor/hooks.json`，修改前备份到 `data/backups/`；桥接脚本在非 Promptor 启动的 Cursor 会话中自动变为无操作。

Claude/Cursor 没有使用 Codex 的结构化 `turn/start` 通道，自动 prompt 与人工输入共用真实 TUI 输入框；运行自动队列时不要在输入框中保留尚未提交的草稿。已经提交的人工问题、运行中的追加输入和原生选择仍由 CLI 自己处理，hook 只观察生命周期，不替换模型或审批设置。

Codex 标签各自使用独立 App Server。新建时由真实远程 TUI 直接发起 `thread/start`，工具捕获成功响应后立即绑定标签，不会把首个 turn 前尚未落盘的空 thread 误交给 `thread/read` 或 `codex resume`；第一条队列或手工消息会正常创建 rollout。恢复或重新打开时，远程 TUI 会先加载 thread，确认状态为 `idle` 或真实 `active` 后，队列控制端才调用 `thread/resume` 订阅事件；这避免已经完成的历史对话在 TUI 中永久停留于虚假 `Working`。TUI 经每标签独占的本机转发端口连接 App Server：转发层不改写键盘输入，并把 TUI 新建线程请求中的 `historyMode: paginated` 规范为官方支持完整 `thread/read` 的 `legacy`，其余协议消息透明转发；它还会在 `/resume`、`/fork`、`/new` 成功后识别新的 thread，把标签和队列重新绑定。每次恢复或切换到已有 rollout 都会全量读取当前 thread：JSON 中旧 thread 的完成历史会被当前历史替换，尚未执行的本地 prompt 则保持原顺序并追加在完成历史之后。关闭对话会终止该标签所属提供商的完整进程树并释放 session writer。

## 运行

环境要求：Windows、Node.js 22–24、npm。如果只用「终端」类型的对话（纯 PowerShell，不接代理），不需要安装任何 CLI；使用代理对话则需要至少一种已登录且位于 `PATH` 的 CLI：Codex 使用 `codex`（协议基准为 `codex-cli 0.147.0`）、Claude Code 使用 `claude`（本机验证版本 2.1.228）、Cursor CLI 使用 `agent`。可先分别运行 `codex --version`、`claude --version` 或 `agent --version` 检查；未安装的提供商会在连接前明确报错，不影响其他提供商。

```powershell
.\setup.ps1
.\start.ps1
```

`start.ps1` 会启动只监听 `127.0.0.1` 的服务并打开 `http://127.0.0.1:4317/`；该固定地址也可以直接手动打开。启动前脚本会比较 `src/`、`config/`、`package.json` 与 `dist/` 的最后修改时间，源码有变更时自动执行 `npm run build`，无变更则直接启动；`.\start.ps1 -Force` 强制重新构建，`.\start.ps1 -NoBuild` 跳过检查直接用现有构建。最后一个 Promptor 页面关闭后，后端会等待 30 秒；期间刷新或重新打开页面会取消退出。若 30 秒内没有页面重连，后端才记录当时仍开启的对话、中断正在执行的 turn、停止所有子进程并退出。下次启动会按标签保存的提供商并行恢复 App Server 或 hook 适配器、PowerShell/TUI 和历史同步；用户明确点击“关闭对话”的标签不会自动恢复，队列仍保持暂停且不会重复提交 prompt。设置环境变量 `CODEX_PROMPTOR_AUTO_EXIT=0` 可关闭自动退出。每个标签的数据在 `data/tabs/<tab-id>/`：

- `prompt-list.json`：prompt、顺序、开始/完成时间、attempt 和状态；
- `final-answers.json`：独立保存 turn 的开始、完成/中断状态及 final answer；
- `runtime.json`：队列、终端和历史对账状态。

终端输出本身不落盘。浏览器首次附着接收一次内存快照，之后按字节游标增量补发；WebSocket 重连不会从头重复刷新终端。拖动分栏或改变窗口尺寸时，xterm 会立即在浏览器中适配，但真实 PTY resize 会等待尺寸短暂稳定后合并发送；后端还会忽略重复尺寸，并持久保存每个标签最后确认的行列数，让下次恢复直接以正确尺寸创建 ConPTY，避免先以 80×12 加载再二次重排。长对话的大快照或 resize 重排期间，页面以稳定的同步提示覆盖 TUI 中间帧，确认最终输入画面后再解除，避免看见历史从头扫过。Codex TUI 完成初始 thread 选择或恢复后，后端会向真实终端的输入草稿写入一个未提交的空格，以稳定空输入状态下的 TUI 光标；同一 PTY 只写一次，页面刷新或 WebSocket 重连不会重复写入，App Server 队列不受影响。

控制台栏用灰色方块表示已关闭对话，用较大的绿色圆点表示已打开但空闲的对话；队列正在执行 prompt 时，绿色圆点持续呼吸变化。每条队列 prompt 完成后，浏览器播放一次简短双音提示，并在对应标签旁显示 30 秒钟形提醒。提示只响应 `origin: queue` 的实时完成事件，历史导入、手工 TUI 对话和页面刷新不会补播声音。

分组和对话行的修改、删除操作收纳在右侧“⋮”菜单中。Windows 文件夹选择器使用置前的 Explorer 风格窗口；同一时间只允许一个选择窗口，取消后可立即再次打开，后端退出时也会关闭仍在等待的选择窗口。

控制台栏最底部左侧的月亮/太阳图标切换浅色与深色主题，右侧的 `中 / En` 切换完整应用界面语言；两项偏好都写入 `data/index.json` 并在重启后恢复。prompt、final answer、终端输出、路径和用户命名始终保留原文。执行队列标题、完成数、当前状态及开始/暂停按钮位于同一行，窄栏时优先截断状态说明而不隐藏操作按钮。空队列添加第一条待执行 prompt 时会自动开始；如果队列已暂停且已有待执行项，继续添加 prompt 只会排队，不会解除暂停。待执行项用铅笔按钮进入编辑，用“立即插入”把该项追加到正在运行的同一轮；若当前空闲，则优先执行该项，原队列若为暂停状态，执行完该项后仍保持暂停。

队列 prompt 被所选编程代理接受并进入执行时，Final answers 会立即新建“执行中”记录，顶部右侧显示开始时间。收到 final answer 后会在同一条记录中填入回复，并在底部右侧显示结束时间；若 turn 被关闭、暂停或服务退出中断，该记录则原位收尾为“已中断”并写入原因，不伪造 final answer。

## 恢复已有对话

在标签中选择“继续旧对话”并填入 session/thread id。终端完成附着后，Codex 通过 `thread/read(includeTurns=true)` 读取结构化历史；Claude Code 从 hook 返回或 `~/.claude/projects/` 定位 JSONL transcript；Cursor 从 hook 的 `transcript_path` 或 `~/.cursor/` 定位可用 transcript。三者都会只导入同时具有用户输入和 final answer 的完成 turn，并按 `(threadId, turnId)` 幂等对账，因此重复恢复不会重复写入。导入记录的 `origin` 为 `imported`，会立即显示并写入同一标签的两个 JSON 文件。服务重启时遗留的 `running/dispatching` 记录会先转为 interrupted，避免队列永久显示执行中。控制台栏底部的“同步历史”执行同一次全量校正；“重新打开终端”也会在恢复后自动执行。Claude/Cursor 的 transcript 格式由各自 CLI 控制，版本变更后若无法识别会明确报告同步失败，而不会混入猜测出的回答。

Codex TUI 中的 `/resume`、`/fork`、`/new`，以及 Claude/Cursor TUI 中会触发 `SessionStart` 的原生会话切换，都会暂停旧队列、重新绑定页面并对账新历史。页面中的 thread/session、工作路径、Prompt list 和 Final answers 会自动更新；状态框会持久显示最近一次跟随切换的来源、目标和时间。`prompt-list.json` 的每条已执行记录带有 `threadId`，`final-answers.json` 只显示当前 thread/session 的回答，避免其他对话混入；未绑定的 `pending` 记录不会被清除。detached review 或 subagent 创建的辅助 thread 不会误改标签绑定。

## 开发与验证

```powershell
npm run typecheck
npm test
npm run build
```

实现细节和 API/数据契约见 [IMPLEMENTATION_SPEC.md](./docs/IMPLEMENTATION_SPEC.md)。

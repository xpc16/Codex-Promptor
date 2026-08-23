<div align="right">
  <span>中文</span> | <a href="./README_en.md">English</a>
</div>

# Codex Promptor

本地 Windows 工具：用标签管理多个 Codex 对话，并按 prompt list 顺序向同一个 Codex thread 提交任务。PowerShell 内运行的是 Codex 的真实 TUI；队列通过本地 App Server 的 JSON-RPC `turn/start` 提交，不会模拟或覆盖终端中的模型、审批和手工输入。

每个打开的标签使用独立 Codex App Server。新建时由真实远程 TUI 直接发起 `thread/start`，工具捕获成功响应后立即绑定标签，不会把首个 turn 前尚未落盘的空 thread 误交给 `thread/read` 或 `codex resume`；第一条队列或手工消息会正常创建 rollout。恢复或重新打开时，远程 TUI 会先加载 thread，确认状态为 `idle` 或真实 `active` 后，队列控制端才调用 `thread/resume` 订阅事件；这避免已经完成的历史对话在 TUI 中永久停留于虚假 `Working`。TUI 经每标签独占的本机转发端口连接 App Server：转发层不改写键盘输入，并把 TUI 新建线程请求中的 `historyMode: paginated` 规范为官方支持完整 `thread/read` 的 `legacy`，其余协议消息透明转发；它还会在 `/resume`、`/fork`、`/new` 成功后识别新的 thread，把标签和队列重新绑定。每次恢复或切换到已有 rollout 都会全量读取当前 thread：JSON 中旧 thread 的完成历史会被当前历史替换，尚未执行的本地 prompt 则保持原顺序并追加在完成历史之后。关闭对话会终止该标签的 PowerShell、远程 TUI、转发端口和 App Server 完整进程树并释放 session writer，因此可以立即在外部命令行执行 `codex resume <session-id>`。

## 运行

环境要求：Windows、Node.js 22–24、`codex-cli 0.147.0`、npm。

```powershell
.\setup.ps1
.\start.ps1
```

`start.ps1` 会启动只监听 `127.0.0.1` 的服务并打开 `http://127.0.0.1:4317/`；该固定地址也可以直接手动打开。最后一个 Promptor 页面关闭后，后端会等待 5 秒（允许普通刷新重连），随后记录当时仍开启的对话、停止所有子进程并退出。下次启动会并行恢复这些对话的 App Server、PowerShell/Codex TUI 和历史同步；用户明确点击“关闭对话”的标签不会自动恢复，队列仍保持暂停且不会重复提交 prompt。设置环境变量 `CODEX_PROMPTOR_AUTO_EXIT=0` 可关闭自动退出。每个标签的数据在 `data/tabs/<tab-id>/`：

- `prompt-list.json`：prompt、顺序、开始/完成时间、attempt 和状态；
- `final-answers.json`：独立保存 prompt 对应的 final answer；
- `runtime.json`：队列、终端和历史对账状态。

终端输出不落盘。浏览器首次附着接收一次内存快照，之后按字节游标增量补发；WebSocket 重连不会从头重复刷新终端。

控制台栏用灰色方块表示已关闭对话，用较大的绿色圆点表示已打开但空闲的对话；队列正在执行 prompt 时，绿色圆点持续呼吸变化。每条队列 prompt 完成后，浏览器播放一次简短双音提示，并在对应标签旁显示 30 秒钟形提醒。提示只响应 `origin: queue` 的实时完成事件，历史导入、手工 TUI 对话和页面刷新不会补播声音。

分组和对话行的修改、删除操作收纳在右侧“⋮”菜单中。Windows 文件夹选择器使用置前的 Explorer 风格窗口；同一时间只允许一个选择窗口，取消后可立即再次打开，后端退出时也会关闭仍在等待的选择窗口。

控制台栏最底部左侧的月亮/太阳图标切换浅色与深色主题，右侧的 `中 / En` 切换完整应用界面语言；两项偏好都写入 `data/index.json` 并在重启后恢复。prompt、final answer、终端输出、路径和用户命名始终保留原文。执行队列标题、完成数、当前状态及开始/暂停按钮位于同一行，窄栏时优先截断状态说明而不隐藏操作按钮。

## 恢复已有对话

在标签中选择“继续旧对话”并填入 session/thread id。终端完成附着后，服务调用 `thread/read(includeTurns=true)`，只导入已完成且同时有用户输入和 final answer 的 turn；导入按 `(threadId, turnId)` 幂等，重复恢复不会重复写入。导入记录的 `origin` 为 `imported`，会立即在 Final answers 区域显示，也会写入同一标签的两个 JSON 文件。控制台栏底部的“同步历史”执行同一次全量校正；“重新打开终端”也会在恢复后自动执行。

在真实 PowerShell TUI 中使用 `/resume`、`/fork` 或 `/new` 也会触发同一套流程。页面中的 thread/session、工作路径、Prompt list 和 Final answers 会自动更新；状态框会持久显示最近一次跟随切换的来源、目标和时间。`prompt-list.json` 的每条已执行记录带有 `threadId`，`final-answers.json` 只保留当前 thread 的回答，避免其他对话混入显示；未绑定的 `pending` 记录不会被清除。detached review 或 subagent 创建的辅助 thread 不会误改标签绑定。

## 开发与验证

```powershell
npm run typecheck
npm test
npm run build
```

实现细节和 API/数据契约见 [IMPLEMENTATION_SPEC.md](./docs/IMPLEMENTATION_SPEC.md)。

# Codex Promptor

本地 Windows 工具：用标签管理多个 Codex 对话，并按 prompt list 顺序向同一个 Codex thread 提交任务。PowerShell 内运行的是 Codex 的真实 TUI；队列通过本地 App Server 的 JSON-RPC `turn/start` 提交，不会模拟或覆盖终端中的模型、审批和手工输入。

每个打开的标签使用独立 Codex App Server。关闭对话会终止该标签的 PowerShell、远程 TUI 和 App Server 完整进程树并释放 session writer，因此可以立即在外部命令行执行 `codex resume <session-id>`。重新打开时会创建新服务；若 session 正被外部 Codex 使用，页面会保持关闭并提示先退出外部客户端。

## 运行

环境要求：Windows、Node.js 22–24、`codex-cli 0.147.0`、npm。

```powershell
.\setup.ps1
.\start.ps1
```

`start.ps1` 会启动只监听 `127.0.0.1` 的服务并打开 `http://127.0.0.1:4317/`；该固定地址也可以直接手动打开。最后一个 Promptor 页面关闭后，后端会等待 5 秒（允许普通刷新重连），随后自动停止所有子进程并退出。设置环境变量 `CODEX_PROMPTOR_AUTO_EXIT=0` 可关闭自动退出。每个标签的数据在 `data/tabs/<tab-id>/`：

- `prompt-list.json`：prompt、顺序、开始/完成时间、attempt 和状态；
- `final-answers.json`：独立保存 prompt 对应的 final answer；
- `runtime.json`：队列、终端和历史对账状态。

终端输出不落盘。浏览器首次附着接收一次内存快照，之后按字节游标增量补发；WebSocket 重连不会从头重复刷新终端。

## 恢复已有对话

在标签中选择“继续旧对话”并填入 session/thread id。服务会先调用 `thread/read(includeTurns=true)`，只导入已完成且同时有用户输入和 final answer 的 turn；导入按 `(threadId, turnId)` 幂等，重复恢复不会重复写入。导入记录的 `origin` 为 `imported`，会立即在 Final answers 区域显示，也会写入同一标签的两个 JSON 文件。

## 开发与验证

```powershell
npm run typecheck
npm test
npm run build
```

实现细节和 API/数据契约见 [IMPLEMENTATION_SPEC.md](./docs/IMPLEMENTATION_SPEC.md)。

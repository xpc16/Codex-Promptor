# 定时器与常用 Prompt 实施方案

> 状态：实现规格，待开发
>
> 设计取向：功能轻量、实现简单、优先复用、空闲零网络传输
>
> 适用范围：当前 Promptor 单机服务、浏览器远程控制、Prompt Queue、PTY 与 terminal projection 架构
>
> 当前代码基线：[queue.ts](../src/server/queue.ts)、[storage.ts](../src/server/storage.ts)、[http-cache.ts](../src/server/http-cache.ts)、[App.tsx](../src/client/App.tsx)、[schemas.ts](../src/shared/schemas.ts)
>
> 交互参考：[schedule_app/README.md](../../schedule_app/README.md)、[schedule_app/index.html](../../schedule_app/index.html)。仅参考规则编辑与列表交互，不复用其浏览器定时器和 `localStorage` 架构。
>
> 修订日期：2026-08-27

## 1. 结论

本功能只增加两个入口：

- Prompt Queue 添加区中，闹钟图标打开当前对话的定时器；
- 横向三点图标打开设备级常用 Prompt 库。

实现遵守以下约束：

1. 定时器在 Promptor 服务端调度。浏览器可以关闭，但 Promptor 后端必须仍在运行；启用 Timer 会成为后端的后台保活理由（§4.4）。
2. 一次触发只是把模板快照写成普通 `PromptRecord`，再交给现有 `QueueRunner` 串行执行。
3. 不创建第二套执行器、运行状态机或运行历史文件。
4. 定时器保存在所属 tab 目录；常用 Prompt 保存在一个设备级文件。
5. 不把 Timer 配置模板与 CommonPrompt 库正文放入 bootstrap、URL、WebSocket 控制事件或远程日志；模板触发后形成的普通 PromptRecord 仍走既有 prompt 数据链路。
6. 不增加常驻轮询请求和新的 WebSocket 事件。运行进度继续使用已有 `prompts.changed`。
7. 时间规则只在服务端计算，不把调度代码或时间库打进浏览器包。
8. 文件缺失按空数据懒加载；文件损坏时停止对应功能，绝不以空文件覆盖。

### 1.1 为什么定时器是“一次性队列批次”

当前 `QueueRunner` 已经提供所需语义：

| 需求 | 现有能力 |
| --- | --- |
| 同一 tab/thread 不并发 provider turn | 每个 tab 一个 `QueueRunner`、一个 `loopPromise` |
| 逐条提交并等待完成 | `runLoop` → `prepareDispatch` → `dispatch` |
| 临时执行一条但不改变滚动状态 | `pauseAfterPromptId` + `keepsRunning()` |
| 失败策略的持久配置 | `runtime.queueConfig.onFailure` 已存在；当前循环尚未真正读取，实施时补齐共用分支 |
| 重启清理孤儿运行项 | `recoverTerminalRuntime` |
| 结果落盘与同步 | `PromptRecord`、`AnswerRecord`、现有 delta |

因此只需把“临时执行一个 id”扩展为“临时执行一组 id”。以下设计不采用：

- `TabExecutionCoordinator`、lease 或第二套执行循环；
- `TimerRun` / `TimerRunItem` 实体及运行历史目录；
- `timer.run.changed` 或定时器进度专用事件；
- 通过读取 PowerShell 输出猜测执行是否结束。

Timer 不新增失败策略，但这不表示当前实现已经完整：`queueConfig.onFailure` 目前只被保存，`runLoop` 尚未依据它决定失败后暂停或继续。本次应在 QueueRunner 内补齐一次，普通 prompt 与 timer prompt 共用，不能把缺口复制到 TimerService。

定时器运行历史就是队列中 `origin="timer"` 的 Prompt/Answer。已具象化的条目继续使用现有编辑、删除、重试、跳过和中断行为。

### 1.2 精确的队列边界

- 到期时队列为 `paused` 或 `armed`，定时批次仍可临时启动，但不改写 `desiredState`。
- 同一 thread 正在运行 turn 时不打断、不 steer；定时批次等待当前 turn 自然结束。
- 触发之后用户再按开始、暂停或中断，用户操作优先，并可使剩余 timer prompt 保持 pending。
- “不被暂停状态阻塞”只描述**到期瞬间**；不表示定时器可以越过触发后的用户暂停或队列失败策略。
- 同一个 Timer 上一批仍有 pending/dispatching/running 时，下一次自动到期采用 coalesce：不新增重复条目，只推进规则。

两个排队策略：

| UI | 存储值 | 行为 |
| --- | --- | --- |
| 定时器优先 | `priority` | 插在第一条 pending 前；当前 turn 完成后优先执行 |
| 等待当前滚动队列 | `after_running_queue` | 插在触发时已有 pending 的末尾 |

`after_running_queue` 是触发时的快照语义。之后新加的普通 prompt 仍按用户操作进入队列；用户拖动后的实时顺序始终优先。

## 2. 前端交互

### 2.1 添加区

结构保持在现有 `.add-prompt` 内，不为两个按钮另建工具栏状态系统：

~~~text
add-prompt
├── textarea
├── compose-tools
│   ├── 闹钟：当前 tab 的 TimerDialog
│   └── 横向三点：CommonPromptDialog
└── 添加
~~~

按钮使用内联 SVG、`type="button"`、`title` 和 `aria-label`，文案接入现有中英文函数。桌面目标至少为 24×24 CSS px；移动端为 40×40。若保留 4 px 间距，textarea 最小高度应至少为 52 px，避免两个 24 px 按钮被压缩。

可用性：

- 没有当前 tab 时禁用两个入口；
- shell 终端没有 agent queue，禁用定时器并说明原因；
- agent session 关闭时仍可管理 Timer，但“立即运行”不可用；
- 输入框不可写时仍可管理常用 Prompt，只禁用“插入”；
- 对话框打开不停止 PTY、队列或终端订阅；键盘焦点由 modal 接管，避免按键误入终端；
- Escape 关闭后，焦点返回原图标按钮。

不显示侧栏 Timer 徽标。该徽标需要 bootstrap 字段和配置变更事件，却不属于核心功能；启用状态在 TimerDialog 内显示即可。

### 2.2 TimerDialog

TimerDialog 只管理当前 tab 的 Timer，避免下载其他对话的模板，也避免不同 tab 的编辑互相制造 ETag 冲突。

- 桌面端为左侧列表、右侧编辑器；窄屏为列表页与编辑页切换；
- 打开时发一次条件 GET，不分页；
- 每行显示：启用状态、标题、规则摘要、下次时间、模板数、最后触发状态；
- 操作：新建、编辑、复制、启停、立即运行、删除、手动刷新；
- 编辑发生在本地 draft，保存时整份 Timer 一次提交；
- 有未保存改动时，关闭提供“保存 / 放弃 / 取消”；
- 首次启用时明确提示：只要存在 enabled Timer，关闭最后一个浏览器页面后后端仍会后台运行；
- 精确的 `nextRunAt` 由服务端在保存响应中返回。前端只显示规则摘要，不复制时区与 DST 算法。

Timer 只保留一个策略字段 `externalQueuePolicy`。以下策略固定，不进 schema：

- active turn：始终 wait；
- overlap：始终 coalesce；
- session：要求绑定 tab 的 agent session 可用；
- failure：继承该 tab 的 `queueConfig.onFailure`。

### 2.3 规则编辑

第一版支持三种规则：

- 一次：本地日期 + 时间，分钟精度；过去时间拒绝保存；
- 每周：星期多选 + 本地时间 + 可选起止日期；全选七天即“每天”；
- 间隔：正整数 + 小时/天 + UTC 锚点 + 可选 UTC 结束时间。

间隔规则是固定时长：一小时为 3,600,000 ms，一天为 24 小时。因此跨 DST 时本地钟点可能变化；需要固定本地钟点时使用每周规则。

### 2.4 Timer 模板列表

每个 Timer 内联一个有序模板数组：新增、编辑、复制、删除、拖动排序。

- 空白模板不能保存；
- 编辑只改变下一次触发，已经写进队列的快照不变；
- 触发时按模板当前顺序创建 PromptRecord；
- 模板不提前写进 `prompt-list.json`；
- 已触发条目不在 TimerDialog 重复维护。

### 2.5 CommonPromptDialog

常用 Prompt 是设备级纯文本库，支持新建、编辑、复制、删除、拖动排序和本地搜索。第一版只保存标题与正文，不保存标签、分类、模板变量或脚本。

点击“插入”时不发请求，只调用现有受控 textarea 的草稿更新函数：

1. 打开对话框前记录 `selectionStart`、`selectionEnd` 和草稿版本；
2. 草稿未变化时，用正文替换选区或插在光标处；
3. 草稿已变化或选区失效时，插到当前光标，仍不可得则追加到末尾；
4. 通过 React 状态更新草稿，不直接改 DOM value；
5. 关闭对话框、恢复焦点，并把光标移到插入文本之后。

该动作不创建 PromptRecord、不调用添加 API。用户随后点击“添加”时才进入原有队列流程。

## 3. 数据模型与文件布局

### 3.1 对现有 Prompt schema 的最小扩展

~~~text
OriginSchema: 加 "timer"
PromptSchema: 加 timerId?: string
              加 timerOccurrenceId?: string
              加 timerAutoRun?: boolean
~~~

三个可选字段仅在 `origin="timer"` 时出现。`OriginSchema` 的扩展会让 PromptAttempt 与 AnswerRecord 接受该值，不另加答案专用字段；但当前代码仍有硬编码来源，必须一并修正：

- `queue.ts/prepareDispatch` 与 steer 路径的 `newAttempt("queue")` 改为 prompt 自身 origin；
- `queue.ts/dispatch` 调用 `recordTurn` 时不再写死 `origin: "queue"`；
- `history.ts` 的历史修复不能把已匹配的 timer prompt 归为 `imported`；
- `recordTurnStarted` 已从 primary prompt 取 origin，保持不变。

否则首次执行可能显示正确，重新同步历史后却会丢失 Timer 来源。

`timerOccurrenceId` 不是运行实体。它只是一个短的确定性来源标识，用于：

- 将同一次触发的多条 prompt 可靠分组；
- 在进程崩溃后的重试中去重；
- 让 `run-now` 的 HTTP 重试保持幂等。

不能用“相邻 createdAt”推断批次：用户可以重排队列，时间也可能相同。

`timerAutoRun` 是一个可恢复的执行意图，而不是状态机：新具象化且应由 Timer 自动驱动的 pending 条目为 `true`；开始 dispatch、用户接管或用户暂停后移除。服务异常退出后，只恢复仍为 pending 且值为 `true` 的条目。一个布尔量避免引入 TimerRun 文件，也避免把整组 prompt id 再复制进 Runtime。

### 3.2 TimerFile

~~~json
{
  "schemaVersion": 1,
  "updatedAt": "2026-08-27T02:05:00.000Z",
  "timers": [
    {
      "id": "timer-uuid",
      "title": "工作日代码审查",
      "threadId": "provider-thread-id",
      "enabled": true,
      "timeZone": "Asia/Singapore",
      "externalQueuePolicy": "after_running_queue",
      "schedule": {
        "kind": "weekly",
        "daysOfWeek": [1, 2, 3, 4, 5],
        "localTime": "09:00",
        "startDate": null,
        "endDate": null
      },
      "prompts": [
        { "id": "template-uuid", "text": "请检查未提交改动并列出高风险问题。" }
      ],
      "nextRunAt": "2026-08-28T01:00:00.000Z",
      "lastTrigger": {
        "occurrenceId": "toc_base64url",
        "source": "scheduled",
        "scheduledFor": "2026-08-28T01:00:00.000Z",
        "triggeredAt": "2026-08-28T01:00:08.000Z",
        "status": "queued",
        "code": null
      },
      "createdAt": "2026-08-27T02:00:00.000Z",
      "updatedAt": "2026-08-27T02:05:00.000Z"
    }
  ]
}
~~~

`lastTrigger.status` 只描述触发是否被接纳：`queued | coalesced | blocked`。它不复制 prompt 的完成状态；执行完成、失败或中断以队列记录为准。

Timer 绑定创建/重绑时的 `threadId`，而不只绑定 tab。触发时当前 session 必须仍是该 thread；否则记 `blocked/SESSION_CHANGED`，防止用户在同一 tab 新建另一场对话后，旧 Timer 静默向错误会话发送。编辑器提供“绑定当前对话”，不增加可选 session policy。

其余规则形状：

~~~json
{ "kind": "once", "localDateTime": "2026-08-28T09:30" }
~~~

~~~json
{
  "kind": "interval",
  "every": 6,
  "unit": "hours",
  "anchorAt": "2026-08-27T01:00:00.000Z",
  "endAt": null
}
~~~

数组顺序就是显示与执行顺序，不存 `position`，避免移动一项时重写全部序号。

### 3.3 CommonPromptFile

~~~json
{
  "schemaVersion": 1,
  "updatedAt": "2026-08-27T02:00:00.000Z",
  "items": [
    {
      "id": "common-prompt-uuid",
      "title": "代码审查",
      "text": "请审查当前改动，重点关注安全性、兼容性和回归风险。"
    }
  ]
}
~~~

同样以数组顺序为准。条目不保存独立时间戳；文件级 `updatedAt` 已足够做诊断，ETag 负责并发控制。

两种文件的空默认值都使用 `updatedAt: null`，首次成功写入后才变成 ISO UTC 字符串。这样缺失文件在多次 GET 和服务重启之间仍有稳定 ETag；不得用每次读取时的 `isoNow()` 构造空值。

### 3.4 文件位置

~~~text
data/
├── common-prompts.json
└── tabs/
    └── <tabId>/
        ├── prompt-list.json
        ├── final-answers.json
        ├── timers.json
        └── ...
~~~

Timer 与 tab 同生命周期有四个直接收益：

- API 只读取当前 tab 的 Timer；
- Timer、Prompt 与 Runtime 可以复用同一个 `tab:<id>` 互斥锁；
- tab 移入 trash、恢复或备份时，Timer 自动同行；
- 不存在全局 Timer 锁与 tab 锁的交叉顺序，也就没有新增死锁面。

Timer 不进入 TabBundle。`readTab()`、tab window 与 bootstrap 都不读取 `timers.json`。

### 3.5 边界与限额

服务端统一用 Zod 校验，并设置明确上限：

- 每 tab 最多 50 个 Timer；
- 每个 Timer 最多 20 条模板；
- 标题 1–120 字符；
- 单条正文 UTF-8 最多 128 KiB；
- 单个 Timer 请求体最多 512 KiB；
- 单个 `timers.json` 与 `common-prompts.json` 最多 1 MiB；
- 常用 Prompt 最多 200 条。

同时限制单条和整文件，防止“条目数合法但总正文无限大”。超过上限返回 413/422，不截断正文。

### 3.6 时区约定

第一版不提供任意时区选择。一次与每周规则跟随 Promptor 宿主机时区：

- 启动时读取 `Intl.DateTimeFormat().resolvedOptions().timeZone`；
- `timeZone` 是保存时的宿主机时区快照，用于显示和诊断；
- 宿主机时区改变后，在下次服务启动时更新快照并重算 `nextRunAt`；
- 服务运行期间修改系统时区，需要重启 Promptor 才生效；
- 服务端用本地 `Date` 的兼容规则处理 DST：不存在的时间向前归一化，重复时间取第一次出现；
- interval 始终按 UTC 固定时长推进，不受时区影响。

这比在浏览器与服务端各实现一套 IANA wall-clock 转换更小、更不易漂移。未来确有“宿主机之外的任意时区”需求时，再在**服务端**引入 Temporal/polyfill；不得把它打进客户端包。

## 4. 服务端结构

### 4.1 StorageService 扩展

直接扩展现有 `StorageService`，不新建通用数据库层：

~~~text
timerPath(tabId)
readTimers(tabId)         # ENOENT -> 内存中的空 TimerFile，不立即写盘
writeTimers(tabId, file)  # Zod + writeFileAtomicWithRetry
readPromptsOnly(tabId)    # 启动恢复只读 prompt 文件，不连带载入 answers
readCommonPrompts()
writeCommonPrompts(file)
withCommonPromptLock(task)
~~~

所有 Timer API、scheduler 触发和 tab 内 prompt 变更都在 `withTabLock(tabId)` 内完成。常用 Prompt 使用独立 key `common-prompts`。

不要让新代码直接调用公开 `storage.mutex`；用命名 helper 固定锁作用域，便于以后更换实现。

### 4.2 TimerService

只新增一个定时服务模块和一个纯规则模块：

~~~text
src/server/timer-rules.ts   # schema 之外的纯时间计算
src/server/timer-service.ts # CRUD、内存索引、唤醒、触发、run-now
~~~

`TimerService` 启动时从 index 中列出的 tab 读取各自 `timers.json`，在内存维护 `Map<tabId, TimerFile>`。之后：

- API 写成功后同时替换内存快照并调用 `wake()`；
- scheduler tick 只扫描内存，不每 30 秒读取磁盘；
- 不支持进程运行期间手工编辑 JSON；手工修改在重启后读取；
- tab 新建时无需建空 Timer 文件；首次保存时创建；
- tab 删除/移入 trash 时从内存 Map 移除，目录内文件自然同行；
- timeout 调用 `unref()`，不阻止后端正常退出。

可以在 `createApp()` 时加载配置和开放 CRUD，但必须等 `restoreOpenSessions()` settled 后才 arm scheduler，避免恢复中的 session 被误判为不可用并提前消费到期点。`stop()` 先禁止新 tick、清除 timeout、等待当前短事务退出；`app.promptor.close()` 必须先 await 它，再关闭 runner、agent 与 PTY。

为恢复后台工作，TimerService 只对确实存在 `timers.json` 的 tab 在启动时额外读取一次 prompt 文件；从未使用 Timer 的安装不扫描历史 prompt。之后复用 StorageService 现有的内部 prompt-delta listener，维护非终态 timer prompt id 集合并更新 background hold，不增加磁盘轮询或网络事件。tab session 进入 ready 也复用现有 tab 状态 listener，触发该 tab 的待恢复批次检查。

tab 删除需要一个窄的 `timerService.detachTab(tabId)` 屏障：先把 tab 放入 detaching 集合，使新 Timer API/触发立即拒绝；再等待该 tab 已持有的锁退出、从 Map 移除，最后才执行现有目录 rename。否则 scheduler 可能在目录移入 trash 后又因原子写的 `mkdir` 重建同名 tab 目录。这里不引入全局 coordinator，只保护删除这一条生命周期边。

`timer-rules.ts` 接收注入的 `now`，导出纯函数：校验 draft、规范化规则、计算首次时间、计算触发后首个严格晚于 `now` 的时间。UI 不导入该模块。

### 4.3 唤醒策略

不用最小堆，也不用 `setInterval`：使用一个自重排的 `setTimeout`。

~~~text
没有 enabled Timer：不设置 timeout
存在 enabled Timer：delay = clamp(nearestNextRunAt - now, 0, 30s)
timeout 到期：扫描内存 -> 逐个 await 触发 -> 重新计算下一次 timeout
Timer CRUD：取消旧 timeout -> queueMicrotask(wake)
~~~

加 `checking` / `wakeRequested` 两个布尔量，防止 tick 与 CRUD 形成重入。30 秒上限避免超过 Node timeout 的约 24.8 天上限；电脑睡眠后，逾期 timeout 会在恢复时进入扫描。

空闲时没有 HTTP、WebSocket 或磁盘轮询。存在远期 Timer 时只有一个本机 timeout 和一次小数组扫描。

### 4.4 后端生命周期是必改项

当前 [main.ts](../src/server/main.ts) 在最后一个浏览器断开并经过 30 秒宽限期后退出整个 Promptor。若不修改这一点，“浏览器关闭后继续定时”实际上无法成立。

不要在 `main.ts` 写 Timer 特例；把 [ui-lifecycle.ts](../src/server/ui-lifecycle.ts) 小幅泛化为可复用的后台 hold：

~~~ts
setBackgroundHold(key: string, active: boolean): void
~~~

语义：

- 存在至少一个 enabled Timer，或仍有 `timerAutoRun=true` 的 pending / 正在 dispatching、running 的 timer prompt 时，TimerService 设置 hold，最后一个页面关闭也不触发 idle；
- 最后一项上述后台需求消失时释放 hold；若此时没有客户端，从头开始现有 30 秒宽限期；
- 浏览器重新连接仍按现有逻辑取消待退出计时；
- `CODEX_PROMPTOR_AUTO_EXIT=0` 的现有永久运行行为不变；
- 正常 SIGINT/SIGTERM 或显式关闭仍停止 TimerService、agent session 与 HTTP 服务；
- 电脑关机、休眠或进程被杀期间不可能执行；下次启动只按 coalesce 补一次。

这意味着“启用 Timer”或“立即运行 Timer”是用户对相关工作的后台运行授权，agent session 也会在最后一个页面关闭 30 秒后继续保留。若仍希望原来的自动退出行为，应停用所有 Timer，并暂停或完成尚在自动执行的定时条目。系统级计划任务自动拉起 Promptor 会引入凭据、session 恢复和多实例仲裁，不属于轻量第一版。

## 5. 触发、幂等与队列复用

### 5.1 自动触发流程

对于到期 Timer，先保存 `scheduledFor = timer.nextRunAt`，然后在 `withTabLock(tabId)` 中重新读取 TimerFile 与 TabBundle，确认该 Timer 仍启用且仍是同一个到期点。

~~~text
session/provider 不可执行，或当前 threadId 与 Timer 绑定不符
  -> 不写 prompt
  -> lastTrigger = blocked
  -> once 停用；周期规则推进到 now 之后

同一 Timer 有非终态 timer prompt
  -> 不写 prompt
  -> lastTrigger = coalesced
  -> once 停用；周期规则推进到 now 之后

可以执行
  -> 生成 occurrenceId 与确定性 prompt ids
  -> 只补入缺失的 PromptRecord(threadId=Timer.threadId, timerAutoRun=true)
  -> writePrompts
  -> 写 lastTrigger，并推进/停用 Timer
  -> writeTimers
  -> 释放锁后调用 QueueRunner.runOneShotBatch(ids)
~~~

非终态指 `pending | dispatching | running`。overlap 检查只统计相同 `timerId` 且属于 Timer 当前绑定 thread 的条目；失败、完成、中断或旧 thread 的遗留条目不阻止新周期。

错过多个周期只补一次。推进函数直接计算首个 `nextRunAt > now`，不循环创建历史实例。

### 5.2 确定性 occurrence 与 prompt id

自动触发：

~~~text
occurrenceId = "toc_" + base64url(sha256(timerId + NUL + scheduledFor))
promptId     = "tpr_" + base64url(sha256(occurrenceId + NUL + templateId))
~~~

手动触发把 `scheduledFor` 换成 `"manual:" + Idempotency-Key`。使用 Node 内置 `crypto`，不增加依赖。

如果同 id 的 PromptRecord 已存在，无论其当前状态如何，都保留原记录，不覆盖正文、时间或答案。由于 `prompt-list.json` 是原子整文件写，不存在只写入半个模板批次的正常状态。

### 5.3 为什么先写 prompts，再写 timer

两个 JSON 无法组成真正的文件系统事务。采用“确定性 id + prompt 先写”的顺序可做到可重试且不丢触发：

| 崩溃位置 | 重启结果 |
| --- | --- |
| 写 prompt 前 | Timer 仍到期，正常重试 |
| prompt 已写、Timer 未推进 | 相同 occurrence/prompt id 被识别并保留，只补写 Timer 状态 |
| Timer 已写 | 本次已完成声明，不会再次到期 |

若顺序相反，Timer 已推进而 prompt 尚未写时会永久丢失本次触发。因此不得交换顺序，也不得仅靠 `lastTrigger` 做幂等。

只有两个文件都写成功后，TimerService 才主动启动一次性批次。若滚动中的 QueueRunner 在极短窗口内已经看见新 prompt 并开始执行，确定性 id 仍保证重启后不重复。

### 5.4 QueueRunner 的窄接口

不要让 TimerService 改写 `pauseAfterPromptId`。给 `QueueRunner` 增加一个可复用方法：

~~~ts
runOneShotBatch(promptIds: readonly string[]): Promise<void>
~~~

该 Promise 只等待执行意图注册和循环被唤醒，不等待整批 provider turn 完成；HTTP `run-now` 不得因此挂到长对话结束。

内部将现有字段扩展为 `oneShotPromptIds: Set<string>`。这个 Set 仍是进程内加速结构，可恢复意图以 PromptRecord 的 `timerAutoRun` 为准：

- 无论是否 rolling 都把 ids 合并进集合；
- `desiredState === "running"` 时不按集合过滤，队列继续按实际顺序运行；
- `paused/armed` 时启动现有循环，选下一条只从集合内 pending 项中选择；
- 多个不同 Timer 同时到期：集合合并，执行顺序仍由 prompt 文件顺序决定；
- prompt 被删除、跳过或已终态：从集合忽略；集合无可执行项时自然收敛；
- `prepareDispatch` 与手动 steer 的 reservation 都在同一次 prompt 写入中移除所选条目的 `timerAutoRun`；
- `start()`、`pause()`、`interruptCurrent()` 和需要暂停的失败会清空集合，并在一次 tab 写入中移除剩余条目的 `timerAutoRun`；
- 条目已不属于当前 thread、已删除或不可执行时，收敛路径也移除其遗留 `timerAutoRun`，避免无效后台 hold；
- 批次正常结束只更新瞬态 `runner.state`，不改 `desiredState`；失败时补齐并使用 `queueConfig.onFailure`，`pause` 策略可以按其既有含义把队列停下。

TimerService 不调用 `insertNow()`：该方法在 active turn 时会 steer，而定时器明确只等待当前 turn。

服务启动时先执行现有孤儿恢复，再恢复 session；之后按 tab 扫描 pending 且 `timerAutoRun=true` 的条目并调用 `runOneShotBatch()`。某个 session 启动时恢复失败，则保留标记；该 tab 后来再次进入 ready 时再扫描一次。全程由状态事件触发，不增加轮询。

正在运行的 timer prompt 会被 `recoverTerminalRuntime` 标为 interrupted。若同一 occurrence 还有未开始条目：`queueConfig.onFailure="continue"` 才保留标记并恢复；`pause` 则移除剩余标记、保留 pending，等待用户处理。这样服务重启也服从已有失败策略。

### 5.5 手动“立即运行”

浏览器每次点击生成一个 UUID，作为 `Idempotency-Key` 请求头。连接超时重试必须复用同一个值；再次点击则生成新值。服务端要求合法 UUID，缺失或非法返回 400，不把原始 key 写入文件或日志。

- 同一 occurrence 已存在时返回相同 prompt ids，不重复写入；
- 同一 Timer 已有其他非终态批次时返回 409 `TIMER_ALREADY_ACTIVE`；
- session 不可用或 thread 已改变时返回 409；
- disabled Timer 允许手动运行，便于测试；
- 不改变 `enabled` 或周期 `nextRunAt`，但更新 `lastTrigger.source="manual"`。

## 6. API 与并发控制

### 6.1 路由

沿用现有认证、`/api` 前缀与 `{ data }` 响应包装。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/tabs/:tabId/timers` | 当前 tab 全部 Timer，ETag |
| POST | `/api/tabs/:tabId/timers` | 新建整份 Timer，`If-Match` |
| PUT | `/api/tabs/:tabId/timers/:timerId` | 更新整份 Timer，`If-Match` |
| DELETE | `/api/tabs/:tabId/timers/:timerId` | 删除未来配置，`If-Match` |
| POST | `/api/tabs/:tabId/timers/:timerId/run-now` | 幂等手动触发 |
| GET | `/api/common-prompts` | 全部常用 Prompt，ETag |
| PUT | `/api/common-prompts` | 整份小列表保存，`If-Match` |

常用 Prompt 使用一个整体 PUT，是有意的取舍：保存只发生在用户编辑时，文件有 1 MiB 硬上限；它复用同一个 schema 和原子写，省去 create/update/delete/order 四套请求模型。数组顺序天然保存拖动结果。

成功的 Timer 配置写返回服务端规范化后的 Timer 与新 ETag；DELETE 返回 204 与新 ETag；常用 Prompt PUT 返回文件 `updatedAt` 与新 ETag。客户端据本地 draft 更新列表，不额外 GET。`run-now` 在批次登记后立即返回 202，并同时返回 Timer、prompt ids 和 TimerFile 的新 ETag，避免等待长 turn，也避免当前对话框下一次保存立即得到 412。

所有命令式接口（尤其 `run-now`）返回 `Cache-Control: no-store`。

### 6.2 ETag

GET 复用 `sendRevalidatable`：

- `Cache-Control: private, no-cache, max-age=0, must-revalidate`；
- 首次返回正文和 ETag；
- 再次打开由浏览器带 `If-None-Match`，未变返回 304；
- 304 是**正文零传输**，不是网络请求为零。

浏览器不会替写请求自动添加 `If-Match`。两个对话框控制器必须只保存当前 ETag 字符串，并在 POST/PUT/DELETE 时显式发送；正文仍交给浏览器 HTTP 缓存，不另建 body cache。

服务端在拿到对应锁后重新计算 ETag，再校验 `If-Match`。缺失前置条件返回 428 `PRECONDITION_REQUIRED`，不匹配返回 412 `PRECONDITION_FAILED`，两者都不写文件；客户端保留 draft，条件 GET 最新数据后让用户重试。不要自动覆盖或静默合并正文。

在 [http-cache.ts](../src/server/http-cache.ts) 增加并测试 `ifMatchSatisfied()`，复用现有 content-coding tag 规范化。所有 Timer 配置写都要求 `If-Match`，包括创建，因此超时重试不会产生重复 Timer。

## 7. WebSocket 与数据传输

### 7.1 不新增事件或 bootstrap 字段

第一版新增 WebSocket 事件数：**0**；新增 bootstrap 字段数：**0**。

- Timer 配置只在用户打开对话框时条件 GET；
- Timer 到期产生普通 `prompts.changed`；
- 运行状态与答案继续走已有 prompt/answer delta；
- Common Prompt 只在打开对话框时 GET；
- 其他浏览器的配置修改在下次打开时发现；打开期间的并发写由 412 阻止；
- TimerDialog 提供手动刷新，不做焦点轮询、倒计时请求或 scheduler tick 广播。

如果 TimerDialog 正打开并收到当前 tab 中 `origin="timer"` 的 prompt upsert，可选择做一次 250 ms 去抖的条件 GET，以刷新 `nextRunAt`；这只复用已有事件，并且对话框关闭时完全不请求。第一版也可只保留手动刷新。

现有 `PromptDelta` 的 upsert 是一条完整 PromptRecord，而不是字段级 patch。本文只承诺“不重传整个队列”，不错误宣称状态变化只传几个字段。

### 7.2 传输账单

| 场景 | 上行 | 下行 | 频率 |
| --- | --- | --- | --- |
| 无 Timer | 无 | 无 | 0 |
| 有远期 Timer | 无网络；本机 timeout | 无 | 最多每 30 秒一次内存扫描 |
| 首次打开 TimerDialog | GET | 当前 tab 的 Timer，压缩 | 用户点击时 |
| 未变时再次打开 | 条件 GET | 304，无正文 | 用户点击时 |
| 保存 Timer | 一份 Timer | 规范化 Timer + ETag | 用户提交时 |
| Timer 到期 | 无 | 已连接客户端收到 prompt delta | 每次触发 |
| Timer 状态变化 | 无 | 现有完整单条 PromptRecord upsert | 每条数次 |
| 打开常用 Prompt | 条件 GET | 小列表或 304 | 用户点击时 |
| 编辑常用 Prompt | 小列表 PUT | 时间戳 + ETag | 用户提交时 |
| 点击插入 | 无 | 无 | 纯前端 |

任何 Timer/CommonPrompt 操作都不得触发完整 TabBundle、terminal snapshot 或历史答案重载。

用现有 `/api/diagnostics/traffic` 与 `traffic-ledger.ts` 验收，而不是估算：

- 对话框关闭且没有触发时，新功能 HTTP/WS 字节为 0；
- 未变列表重复打开的响应正文为 0；
- Timer 到期只出现已有 prompt/answer delta 类别；
- terminal snapshot 计数不因 Timer CRUD 增加。

## 8. 安全与故障处理

- 所有路由复用现有认证；tabId 必须来自 index，路径继续由 StorageService 构造；
- Prompt 正文不进入 URL、错误字符串、诊断账本或普通日志；日志只记 id、数量、长度、状态和错误代码；
- 模板只是 provider 输入，不执行 JavaScript、PowerShell、shell、网络回调或变量替换；
- 服务端时钟是唯一到期依据，不接受浏览器提供的“当前时间”；
- session/provider 不可用时不自动切换 tab 或 provider；
- 删除 Timer 只删除未来配置，已具象化的 Prompt/Answer 保留；
- 浏览器断线不取消本机已经启动的 turn；
- `timers.json` 损坏只停用该 tab 的 Timer 功能并报告路径，不影响普通队列；
- `common-prompts.json` 损坏只停用常用 Prompt 库；两者均不得自动写空文件覆盖损坏数据。

## 9. 代码结构与实施顺序

~~~text
src/shared/
└── schemas.ts                    # TimerFile/CommonPromptFile；Origin + timer provenance

src/server/
├── timer-rules.ts                # 服务端纯时间规则
├── timer-service.ts              # CRUD、调度、幂等触发
├── storage.ts                    # 两类文件的命名读写 helper
├── queue.ts                      # 单 id 一次性机制扩展为 id 集合
├── history.ts                    # timer origin 在同步/修复中保持不变
├── http-cache.ts                 # + If-Match helper
├── ui-lifecycle.ts               # 可复用 background hold
├── main.ts                       # hold 释放后沿用 30 秒退出
└── app.ts                        # 7 个接口操作

src/client/
├── modal-shell.tsx               # 两个新对话框共用焦点/关闭壳
├── timer-dialog.tsx
├── common-prompt-dialog.tsx
└── App.tsx                       # 两个入口与草稿插入回调
~~~

`ModalShell` 只抽取 overlay、Escape、焦点返回和标题区域，不建立通用表单框架。两个图标留在 App 当前添加区，避免为了十几行标记再建 `compose-tools.tsx`。

推荐顺序：

1. schema、稳定空默认值、StorageService helper 与 ETag `If-Match` 测试；
2. `queue.ts` / `history.ts` 的 timer origin 传播与 `onFailure` 既有缺口；
3. `timer-rules.ts` 纯函数与时区/DST 测试；
4. `QueueRunner.runOneShotBatch()` 与现有 insert-now 回归；
5. TimerService 的 `run-now`、确定性 id 与崩溃点测试；
6. 自动唤醒、逾期 coalesce、session/thread 校验与后台 hold；
7. Timer API；
8. Common Prompt API 与受控 textarea 插入 helper；
9. Modal、两个对话框、i18n、窄屏布局；
10. 传输账本、完整 typecheck/test/build。

## 10. 测试与验收

### 10.1 时间规则

- once 未来/过去；weekly 单日、多日、跨周、起止日期；
- interval hours/days、锚点、结束时间；
- DST 春季不存在时间与秋季重复时间；
- 宿主机时区快照变化后的重算；
- 多次错过只补一次，结果严格晚于 `now`；
- 注入 fake clock，测试不依赖真实等待。

### 10.2 存储与幂等

- 缺失 Timer 文件返回空值且不立即创建；
- 损坏文件不被空文件覆盖；
- 同一 `timerId + scheduledFor` 生成稳定 occurrence id；
- 同一 occurrence/template 生成稳定 prompt id；
- 在 prompt 写前、prompt 写后、Timer 写后三个故障点注入异常，重启后分别无丢失、无重复；
- Timer 已推进但 runner 尚未启动时崩溃，`timerAutoRun` 能恢复批次；
- 并发 scheduler/API 操作由同一 tab lock 串行；
- tab 删除与到期触发并发时，detach 屏障等待旧写入且不会重建已移走目录；
- tab 进入 trash 时 Timer 文件同行。

### 10.3 QueueRunner

- paused/armed 上只运行批次 id，用户积压仍 pending；
- rolling queue 按实际顺序自然执行，不启动第二循环；
- priority 与 after-running-queue 的插入位置；
- 两个批次合并后按文件顺序执行；
- 批次前、中、后 `desiredState` 不变；
- prompt 被删、跳过、失败或中断时集合正确收敛；
- start/pause/interrupt 的用户交接；
- `queueConfig.onFailure` 的 pause/continue；
- dispatch 清除当前条目标记，pause 清除剩余标记；重启后 continue 恢复而 pause 不恢复；
- 旧 thread 的 pending timer prompt 不执行、不阻塞已重绑 Timer，也不留下后台 hold；
- Timer 不调用 active-turn steer。

另外验证 Attempt、运行中 Answer、完成 Answer 和重新同步历史后的 Answer 都保持 `origin="timer"`，不会变回 `queue` 或 `imported`。

### 10.4 API 与前端

- 认证、body limit、schema 错误与 tab/provider 校验；
- GET 304；缺失 `If-Match` 返回 428，错误值返回 412，且都不写入；
- `run-now` 同一 Idempotency-Key 返回相同 ids；
- Common Prompt 整体 PUT 保存顺序；
- 选区替换、光标插入、失效选区、草稿版本变化；
- 点击“插入”不产生请求、不创建 PromptRecord；
- modal 打开不停止 PTY，但键盘输入不穿透；
- 中英文文案、键盘与移动端操作。

生命周期测试覆盖：有 hold 时最后页面关闭不会 idle；释放最后一个 hold 后重新开始完整宽限期；宽限期内重连可取消；进程 shutdown 会清理 scheduler timeout。

### 10.5 必跑命令

~~~powershell
npm run typecheck
npm test
npm run build
git diff --check
~~~

## 11. 迁移

- 旧 tab 无 `timers.json` 时按空列表读取，首次保存才创建文件；不批量触碰所有 tab；
- 首次打开常用 Prompt 时，缺失文件按空列表读取，首次保存才创建；
- 不修改旧 Prompt/Answer，不把旧队列自动转成 Timer 或 CommonPrompt；
- `OriginSchema` 增加 `timer` 对旧记录向后兼容；
- 文件 wrapper 保留 `schemaVersion`，但单条记录不重复保存版本号；
- 新功能初始化失败时普通对话、终端、队列与远程访问仍可用。

## 12. 第一版明确不做

- 浏览器 scheduler、浏览器后台通知或每个客户端各自触发；
- 秒级或 cron 表达式；
- 任意时区编辑；
- 错过 N 次就重放 N 批；
- 当前 turn 的自动 interrupt/steer；
- 独立 TimerRun 表、运行目录、运行 API 或运行 WebSocket；
- Timer 活跃徽标、bootstrap 计数或每秒倒计时；
- Common Prompt 标签、目录、变量、脚本或自动发送；
- Timer 配置模板或 CommonPrompt 库正文进入 TabBundle（触发后形成的普通 PromptRecord 除外）；
- 为小文件分页、分片或新建客户端正文缓存；
- 跨设备云同步与多用户共享。

只有实际数据达到下列量级时再升级：单 tab Timer 文件或 CommonPrompt 文件接近 1 MiB、诊断账本显示对话框正文传输成为主要流量，或产品确实需要独立取消/审计一次 occurrence。升级前不预建分片、运行实体和同步协议。

按本方案实现后，新增常驻成本只有服务端一个受控 timeout；配置正文按需条件获取；一次触发复用现有 Prompt/Answer 数据链路；定时器随 tab 一起保存和清理；跨文件崩溃窗口由确定性 id 消除。功能新增面集中在两个服务端模块、两个小对话框，以及对 StorageService、QueueRunner 和 HTTP cache 的窄扩展。

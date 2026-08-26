# 低带宽远程终端投影与交互实施计划

> 状态：规划，尚未实施
>
> 更新时间：2026-08-26
>
> 适用范围：Windows PowerShell、`node-pty`、ConPTY，以及在 PTY 中运行的 Codex / Claude Code / Cursor CLI 原生 TUI

## 1. 结论与首要场景

本项目可以在保持 PowerShell/TUI 完整输入交互的同时，将远程终端下行数据降低为“固定帧率的底部 20 行屏幕投影”。

### 1.0 首要场景：远程操作 TUI，而不是远程围观输出

这一点决定了后面所有的优先级，必须先写清楚。

远程用终端要做的事，绝大多数是**交互控制**：

- 在 Codex 里 `/model` 切换模型，方向键选，Enter 确认；
- 计划/选项菜单里挑一项，或者 Esc 取消；
- 看一眼底部状态栏——现在在跑什么、卡在哪、要不要审批；
- 补一句说明、按 Ctrl+C 中断。

这类操作有两个共同特征：

1. **上行字节量极小。** 一次按键几个字节，一次菜单选择也就十几次按键。输入通道从来不是带宽问题，现有的 `terminal.input` 原样转发已经足够，不需要为它做任何优化。
2. **屏幕改动也很小。** 菜单高亮移动一行、状态栏刷新几个字符——脏行通常只有一到三行，投影帧本身几十到几百字节。

真正吃带宽的是另一类场景：agent 流式输出、编译日志、大规模全屏重绘。而这类场景远程用户往往**只需要知道"在跑、没卡住"**，并不需要逐字读完——完整内容在本机、在最终回答面板里都有。

由此得出的优先级，与直觉相反但很重要：

| | 交互控制（首要） | 流式输出（次要） |
| --- | --- | --- |
| 瓶颈 | **回显延迟**（见 §4.4） | 带宽 |
| 每帧字节 | 很小，几十～几百字节 | 大，接近满屏 |
| 做不好的后果 | 功能不可用，没人开 | 画面滞后，但仍可判断"在跑" |
| 对策 | 交互突发帧率 + 光标行即时帧 | 滚动操作码 + 降帧率 + token bucket |

**结论：延迟优先于带宽。** 一个 2 FPS、省到 0.5 KB/s 但按键要等半秒才回显的实现是失败的；一个交互时短暂冲到 20 FPS、流式输出时降到 1 FPS 并允许画面滞后的实现才是对的。带宽预算应该花在人正在操作的那几百毫秒里，而不是均匀摊给持续输出。

核心原则是：

1. PowerShell 和 CLI 仍在本机 PTY 中完整运行。
2. 服务端在本机还原完整的 VT/ANSI 终端画面。
3. 远程端只接收底部若干个屏幕行的差异、光标和必要的终端状态。
4. 键盘输入仍通过现有 `terminal.input` 通道立即转发，不按帧率排队。

不能直接截取 PTY 原始字符串的最后 20 行。原始输出包含光标移动、清屏、备用屏幕、滚动区域、换行、颜色和可能跨数据包的半截控制序列；直接截断会导致画面和光标状态损坏。

该方案只改变浏览器与本地服务之间的显示传输，不改变 provider 的会话、模型、队列或执行控制逻辑。

## 2. 当前实现与主要流量来源

### 2.1 当前终端数据流

```text
PowerShell / CLI TUI
        │
        │ ConPTY / node-pty
        ▼
PtyManager.onData(raw VT bytes)
        │
        ├── 内存终端字节缓冲
        └── app.ts WebSocket terminal.output
                         │
                         ▼
                   浏览器 xterm.js
```

当前 PTY 使用 `xterm-256color`、ConPTY 和 PowerShell；原始数据在 [`src/server/pty.ts`](../src/server/pty.ts) 的 `child.onData` 中接收，并由 [`src/server/app.ts`](../src/server/app.ts) 转发。

输入流已经是独立的双向路径：

```text
浏览器键盘 / IME
        │
        ▼
terminal.input + Base64
        │
        ▼
pty.write(data)
        │
        ▼
PowerShell / CLI TUI
```

现有输入实现位于 [`src/client/App.tsx`](../src/client/App.tsx) 的 `term.onData`，服务端在 [`src/server/app.ts`](../src/server/app.ts) 中解码后调用 `pty.write`。因此 `/model`、方向键、Enter、Esc、Ctrl+C、计划选择和补充说明不需要新增 provider 专用解析器。

### 2.2 目前需要先消除的额外流量

| 问题 | 当前行为 | 影响 |
| --- | --- | --- |
| **全局 WebSocket 订阅范围过大（已核实，P0）** | 全局连接以 `tabIds = 索引中的全部 tab` 订阅；`emit()` 只按 `subscriptions.has(tabId)` 过滤，`terminal.output` 也走 `emit()` | 全局连接会收到**每一个 tab 的完整原始 VT 字节流**，而它的 `onmessage` 根本没有 `terminal.output` 分支，收到即丢弃。当前 tab 的流还会被额外发一份给 TerminalPanel 自己的连接。N 个已打开会话时下行终端字节约为必要量的 **N+1 倍** |
| 索引全量广播 | 本次会话新增的 `index.changed` 在每次索引写入后推送**整份** `index.json`（全部 tab + 分组 + ui） | 单次不大，但会话状态变化（连接、关闭、线程切换）都会触发；tab 多时应改为增量或按需拉取 |
| 首次加载重复快照 | `TabView` 先通过 REST 获取完整 `TabBundle`，终端 WebSocket 连接后又默认请求快照 | 同一 tab 的 prompt、answer、runtime 被重复传输 |
| 状态事件触发整包重载 | `runner.changed`、`answer.changed`、`terminal.state` 等事件最终调用完整 `load()` | 小状态变化会重新发送整个 prompt/answer 历史 |
| 历史没有服务端分页 | `TabBundle` 包含当前 tab 的全部 prompt 和 answer | 对话积累后，低带宽终端之外的数据仍可能成为主要流量 |
| JSON + Base64 终端格式 | 原始终端数据先 Base64，再嵌入 JSON | 有额外编码膨胀，且不利于结构化差异传输 |
| **发送端没有慢连接背压（已核实，P0）** | `emit()` 只检查 `readyState` 后直接 `socket.send()`，没有检查 `bufferedAmount`，也没有“只保留最新投影”的覆盖策略 | 弱网或手机休眠时，Node 进程可能持续积压已经过时的终端帧；恢复后既浪费流量又长时间追赶旧画面 |
| **终端查询应答目前发生在浏览器（正确性前置条件）** | 浏览器 xterm 既通过 `onData` 回传终端自动应答，又显式处理 OSC 10/11 和 CSI `?996n`；projection 若不再把原始 VT 喂给浏览器，这些应答会消失 | TUI 可能错误判断颜色主题、终端能力或光标状态；若服务端和 raw 浏览器同时应答，又会产生重复输入 |

关于 N+1 倍的说明：这条不是理论推测。全局连接的订阅列表来自 `tabIdsKey`（索引里全部 tab 的 id），而 `emit()` 对终端输出不做任何额外的「是否为终端订阅者」判断。也就是说，你在手机上打开 Promptor、后台留着三个正在跑的会话，这三份原始终端流会**全部**经隧道推到手机上，然后被前端静默丢掉。

**这条应当先单独修掉并重新测量**，再决定投影协议是否还有必要——它可能就是远程流量的主要来源，而修复只需要把终端订阅与状态订阅分开，不涉及任何新协议。

另外两条属于正确性而不仅是流量优化：

- 慢连接不能靠无限排队保证“一个字节也不丢”。raw 流可以在超过高水位后主动断开并用已有 offset/snapshot 重连；projection 流应直接丢弃未发送的中间画面，只保留最新状态，待队列恢复后发一帧完整 snapshot。
- projection 模式必须指定唯一的“终端协议应答者”。否则服务端 headless terminal、raw 浏览器 xterm 和 projection 浏览器之间可能出现零个或多个应答者。具体策略见 §4.5。

相关位置包括：

- PTY 原始数据：[`src/server/pty.ts`](../src/server/pty.ts#L92)
- WebSocket 广播：[`src/server/app.ts`](../src/server/app.ts#L96)
- 终端订阅和快照：[`src/server/app.ts`](../src/server/app.ts#L1222)
- PTY 输出转发：[`src/server/app.ts`](../src/server/app.ts#L1287)
- 浏览器终端输入：[`src/client/App.tsx`](../src/client/App.tsx#L1070)
- 浏览器终端连接：[`src/client/App.tsx`](../src/client/App.tsx#L1167)

## 3. 目标与非目标

### 3.1 目标

- 默认只显示当前活动 tab 的底部 20 个终端屏幕行。
- 支持 1、2、5 FPS 等可配置帧率。
- 只发送变化的行或样式片段，不重复发送未变化内容。
- 保留光标位置、光标可见性、颜色、粗体、反色、下划线和备用屏幕状态。
- 保留 PowerShell、Codex、Claude Code、Cursor CLI 的原始按键交互。
- 支持断线重连、序号检测和完整投影快照恢复。
- 对慢连接实施有界背压，浏览器从后台恢复后直接追上最新画面，而不是回放过时帧。
- 保证终端能力/颜色/状态查询始终恰好由一个组件应答。
- 保留现有高带宽原始 xterm 模式，便于本机调试和临时展开终端。
- 在空闲或普通交互场景下，将远程显示流量控制在约 1 KB/s 的平均目标内。
- **按键到看见回显的时间保持在 150 ms 以内（本机往返之外的附加延迟）**，否则低带宽模式在交互上不可用。

### 3.2 非目标

- 不通过屏幕文本猜测 `/model`、计划选择或 provider 状态。
- 不替换 Codex App Server、Claude Code hook 或 Cursor CLI 的现有控制方式。
- 不把低带宽投影协议变成新的自动提交或队列协议。
- 不承诺在全屏动画、持续流式输出或大规模 TUI 重绘时严格不超过 1 KB/s。
- 第一阶段不解决多个浏览器同时要求不同 PTY 尺寸的问题。
- 不把完整终端屏幕持久化到历史 JSON；终端屏幕仍属于运行时状态。

## 4. 推荐架构

### 4.1 双显示模式

| 模式 | 下行内容 | 使用场景 |
| --- | --- | --- |
| `raw` | 现有原始 VT 增量 + xterm.js | 本机、高带宽、调试、临时全屏 |
| `projection` | 结构化的底部 20 行差异 | 远程、移动网络、低带宽 |

两种模式共享同一个 PTY 和输入通道。切换显示模式不能重启 PowerShell 或 provider 进程。

与既有「终端同步中」遮罩的关系：raw 模式下有一层遮罩，用来在大快照或长会话重排期间盖住 TUI 的中间帧（`terminal-settling`，且只对 Codex 生效）。**投影模式不需要也不应该使用它**——投影本来就只发送合并后的稳定屏幕状态，中间帧在服务端就被帧窗口吸收了。实现时要确保切到投影模式后该遮罩被禁用，否则会出现「已经有稳定画面却被遮住」的情况。

### 4.2 服务端组件

新增或拆分以下组件：

1. `TerminalScreenModel`

   - 接收 `node-pty.onData` 给出的字符串数据块；不要先假定它仍是操作系统层面的原始字节流。
   - 解析 UTF-8、ANSI/VT 控制序列、光标移动、清屏、滚动、备用屏幕和样式。
   - 保存完整的主屏幕和备用屏幕网格。
   - 维护 `generation`、`parsedRevision`、光标和行哈希。
   - 把 `write()`、`resize()` 和快照读取放进每个 tab 独立的串行队列。只有 headless terminal 的 `write(..., callback)` 完成后才能递增 `parsedRevision` 并生成快照，避免读取到半解析画面。

2. `TerminalProjectionScheduler`

   - 在 PTY 数据到达时立即更新 screen model，但不立即发送每个字节。
   - 按客户端请求的 FPS 合并 dirty rows。
   - 对每个客户端记录最近发送的投影版本或行哈希。
   - 优先发送输入确认、错误和连接状态；屏幕帧可以合并或延迟。
   - 每个客户端最多保留一份“下一帧候选状态”，新状态覆盖旧状态；不得把每一帧都排进 WebSocket 写队列。
   - 检查 `socket.bufferedAmount` 的高/低水位；超过高水位时停止增量帧，恢复到低水位后发送 `full: true` 快照。

3. `TerminalSubscriptionRegistry`

   - 将普通状态订阅和终端数据订阅分开。
   - 全局状态 WebSocket 不再自动接收终端输出。
   - 只有明确请求某个 tab 的客户端才收到该 tab 的 raw 或 projection 数据。

4. `TerminalProtocolResponder`

   - 统一管理 DA/DSR、OSC 10/11、颜色方案等由终端模拟器产生的应答权，并把应答写回 PTY。
   - projection-only 时由服务端 headless terminal 应答；存在健康的可写 raw 客户端时，首版可让唯一的 raw input owner 继续应答，同时暂停服务端自动应答。其他 raw 客户端不得转发 xterm `onData`。
   - 不把 OSC 52 剪贴板、窗口标题、通知等具有浏览器副作用的控制序列重新下发给结构化渲染器。

5. 现有 raw buffer 保留

   - raw 模式和调试仍需要它。
   - projection 模式不能依赖 raw buffer 来做“最后 20 行”截取。
   - `generation` 变化或 PTY 重启时，screen model 和客户端投影都必须重置。

### 4.3 浏览器组件

低带宽模式不能把被截断的 ANSI 字节继续喂给 xterm.js，因为 xterm.js 不知道被截断部分之前的光标和屏幕状态。

推荐分两步实现：

1. 第一阶段继续使用 xterm.js 的 `onData` 捕获输入；显示端将服务端的结构化行片段转换为本地安全的 20 行 ANSI 更新，或使用 20 行结构化网格渲染器。
2. 第二阶段可将显示端改为原生 cell/span 渲染器，减少浏览器端重绘和 ANSI 转换；但仍应保留 xterm 的 textarea/input helper 作为键盘、IME、粘贴和移动端输入控制器，除非另行实现并完整测试这些能力。

投影模式下应关闭或限制客户端 scrollback，避免把不存在于网络投影中的历史内容误显示为当前屏幕。

input helper 还必须同步服务端声明的 `inputModes`。例如 TUI 开启 DECCKM 或 bracketed paste 后，方向键与粘贴编码会改变；projection 客户端看不到原始 DECSET，若只画 cell 而不同步 mode，`/model` 菜单和多行粘贴会悄悄失效。第一阶段可以把协议中的 mode 映射为一组 allowlist 内的本地 DECSET/DECRST 喂给 input xterm，或改为向服务端发送语义按键再由服务端编码；不能让客户端自行猜测。

无论选择哪种显示端，都只能根据服务端提供的字符和样式 allowlist 渲染：文本使用 DOM text node/React 转义，样式只映射为受控 CSS；不得把原始 OSC、HTML、URL 或任意 ANSI 片段直接拼回 DOM。若转换为本地 ANSI，也只能生成 SGR、定位和清行等已知安全序列。

### 4.4 输入回显延迟（原方案最大的缺口）

原方案只保证了**上行**输入不排队。但用户感知到的是**下行回显**：按一个键之后，字符要等 PTY 回显 → screen model 更新 → 下一个帧窗口才出现在屏幕上。

在 2 FPS 下这意味着每次按键最多等 **500 ms**，平均 250 ms，再加上隧道往返。这不是「稍慢」——连续打字时字符会成串地跳出来，退格看不到反馈，方向键在菜单里选到哪一项要等半秒才知道。**这一条不解决，整个功能不会有人用。**

而 §1.0 已经说明，远程终端的首要用途正是交互控制——菜单、切模型、看状态。**回显延迟直接决定这个首要场景可不可用**，所以它是本方案中优先级最高的一条，高于任何带宽指标。

三种对策，建议同时采用前两种：

1. **交互突发帧率（必须做，成本低）**

   收到 `terminal.input` 之后的一小段时间内（建议 600～1000 ms）把该客户端的帧率临时提到 15～30 FPS，安静后再退回 1～2 FPS。打字是断续的，突发窗口内的字节量很小（只有被修改的那一两行），但交互感完全不同。这在带宽上几乎是免费的：真正贵的是流式输出的持续满屏刷新，而不是人的击键。

2. **只对光标所在行做即时帧（必须做，成本低）**

   突发窗口内不必发整个视口。绝大多数击键只改变光标所在的一行加光标位置，几十字节即可。把「光标行 + 光标位置」作为最高优先级的最小帧，其余脏行仍按正常帧率合并。

3. **本地预测回显（可选，成本高）**

   mosh 式的推测回显：客户端在本地立即画出预期字符，并在服务端确认帧到达后校正。效果最好，但需要处理预测错误的回滚、IME 组词、以及 TUI 把按键解释成命令（方向键、Esc）而不是字符的情况。**建议第一阶段不做**，先用前两条把延迟压到可接受，实测后再判断是否值得。

验收上应把「按键到回显」作为独立指标测量，而不是笼统的「输入延迟」——上行延迟和回显延迟是两个数。

### 4.5 终端协议应答权与解析屏障

这是 projection 模式能否正确运行原生 TUI 的前置条件。当前 raw 模式中，浏览器 xterm 不只是“画屏幕”：它还会因收到终端查询而通过 `onData` 产生应答；项目又为 OSC 10/11 和 CSI `?996n` 注册了显式处理器。projection 模式若只传结构化 cell，浏览器根本看不到这些查询。

服务端 headless terminal 应始终是屏幕状态权威，但“应答者”需要一份明确租约。原因是 xterm 的 `onData` 同时承载用户输入和模拟器自动应答，现有 raw 客户端无法仅靠公开事件可靠拆开两者。首版建议：

1. `TerminalSubscriptionRegistry` 为每个 tab 分配一个带 epoch 的 `responderLease`。
2. 存在健康、可写且前台活跃的 raw 客户端时，它可以继续作为唯一 raw input owner；服务端仍解析画面，但不把 headless `onData`/`onBinary` 自动应答写回 PTY。其他 raw 客户端为只读，不转发 xterm `onData`。
3. 没有健康 raw owner 时（projection-only、raw 断线或租约超时），应答权切到服务端 headless terminal。其应答通过带 `source = emulator-response` 的内部路径写回 PTY，不能被当作用户输入触发队列或 provider 观察逻辑。
4. raw owner 的输入消息携带 lease epoch；租约撤销后到达的旧输入全部拒绝，防止浏览器从后台恢复时补发迟到的终端应答。projection 客户端只接收安全的结构化/合成画面，不会看到原始查询，因此其 input helper 只产生用户键盘/IME输入。
5. 长期若要让多个 raw 客户端都可同时输入，应先把“用户输入捕获”从显示 xterm 中分离，再把协议应答权永久集中到服务端；不能通过猜测 Esc 前缀来区分方向键和自动应答。
6. 主题变化由服务端保存的 tab 主题驱动 OSC 10/11 与颜色方案应答，不能取决于哪个浏览器恰好在线。
7. `node-pty.onData` → headless `write()` → snapshot 是一条异步流水线。收到 compact、切换模式或请求 snapshot 时，必须先等待已提交的 write callback 全部完成，再在同一 `parsedRevision` 上原子读取网格与光标。
8. resize 也必须进入同一串行队列：先把 headless terminal 调整到即将生效的尺寸，再调用 PTY resize，并用尺寸 epoch 丢弃旧尺寸下迟到的快照。

如果 `@xterm/headless` 对某类查询没有内建应答，则在它的 parser API 上注册最小的通用处理器；不能退回到 provider 文本识别。

## 5. 终端屏幕模型

### 5.1 必须支持的状态

每个 tab 至少维护：

```text
generation
parsedRevision
sizeEpoch
cols / rows
main screen
alternate screen
active screen
cursor row / col / visible
scroll region
current style
wrap mode
insert mode
application cursor keys mode
application keypad mode
bracketed paste mode
mouse tracking mode
send focus mode
dirty rows
```

`parsedRevision` 只在一次 headless `write()` 完整解析后递增；它不能等同于 PTY `onData` 次数。`sizeEpoch` 在终端尺寸真正变化时递增，用于阻止旧尺寸下异步完成的解析结果覆盖新画面。

每个 cell 至少需要：

```text
字符或空格
显示宽度（普通字符、宽字符、组合字符）
前景色
背景色
粗体、暗色、下划线、反色等 flags
```

不需要将每个 cell 单独序列化。发送时应把连续相同样式的 cell 合并为 styled runs，并省略行尾空格，同时保留清除到行尾的语义。

### 5.2 “最后 20 行”的定义

这里的 20 行必须是当前终端屏幕的物理行，而不是原始输出中按换行符分割出的 20 条日志。

```text
当前屏幕总高度：40 行
投影窗口：第 20～39 行
```

这样 TUI 固定绘制在最底部的状态栏通常会被包含。若应用切换到备用屏幕，投影窗口应从备用屏幕读取。

使用 xterm buffer API 时必须明确坐标换算，不能直接取 `buffer.length - 20`：

```text
screenRow       = 0 .. terminal.rows - 1
bufferLineIndex = activeBuffer.baseY + screenRow
viewportTop     = max(0, terminal.rows - requestedRows)
cursorScreenRow = activeBuffer.cursorY
cursorViewRow   = cursorScreenRow - viewportTop
```

主屏幕的 `activeBuffer.length` 可能包含 scrollback，而本方案默认投影的是**当前物理屏幕**，不是 scrollback 尾部。headless 实例建议设置 `scrollback: 0`（或很小的诊断值），既减少内存，也避免把网络投影误做成历史浏览。备用屏幕通常没有 scrollback，但仍使用同一套相对屏幕坐标。

### 5.3 菜单和弹窗

仅传 20 行时，超过 20 行的模型菜单、计划选项或弹窗可能看不完整。建议采用自适应策略：

- 正常输入：20 行，默认 1～2 FPS。
- 光标位于投影区域之外：自动请求 40 或 60 行。
- 检测到备用屏幕、全屏重绘或短时间大量 dirty rows：临时提升为 40/60 行并提高帧率。
- 提供“展开终端”按钮，按需切换到 raw 模式或完整 projection 快照。
- 一段时间没有交互后，自动恢复为 20 行低带宽模式。

这里的“检测”只应基于通用终端状态，如备用屏幕、光标位置和重绘规模，不应针对某个 provider 编写 `/model` 文本规则。

## 6. WebSocket 协议设计

### 6.1 订阅请求

在现有 `subscribe` 消息上扩展终端配置。服务端应在 REST bootstrap 或 WebSocket 首条消息中公布 `terminalProtocolVersion` 与支持的 modes；客户端不认识该版本时只使用现有 raw 模式。

协议中必须把两种订阅写成不同概念：

- `tabIds`：runner、answer、service、terminal state 等轻量 tab 状态事件。
- `terminals`：真正的终端显示流；没有列在这里的 tab 不得收到 `terminal.output` 或 `terminal.screen`。

当前客户端的 per-tab socket 已经会发送 `terminals[tabId]`，而全局 socket只发送 `tabIds + snapshots:false`，因此可以平滑迁移：缺少 `mode` 的既有 `terminals[tabId]` 按 raw 解释；完全没有 `terminals` 则表示只订阅状态。不要再用同一个 `subscriptions` Set 同时决定状态和终端字节广播。

建议请求：

```json
{
  "type": "subscribe",
  "terminalProtocolVersion": 1,
  "tabIds": ["tab-1"],
  "snapshots": false,
  "index": true,
  "terminals": {
    "tab-1": {
      "mode": "projection",
      "viewportRows": 20,
      "fps": 2,
      "generation": "gen-7",
      "revision": 381,
      "sizeEpoch": 4
    }
  }
}
```

raw 模式继续使用现有的 byte cursor：

```json
{
  "terminals": {
    "tab-1": {
      "mode": "raw",
      "generation": "gen-7",
      "nextOffset": 18420
    }
  }
}
```

### 6.2 投影帧

建议使用“行 + 样式 run”而不是每个 cell 一个 JSON 对象：

```json
{
  "type": "terminal.screen",
  "tabId": "tab-1",
  "generation": "gen-7",
  "streamId": "9b80f3d2",
  "sequence": 1042,
  "revision": 381,
  "full": false,
  "cols": 120,
  "totalRows": 40,
  "viewportTop": 20,
  "viewportRows": 20,
  "alternateScreen": true,
  "sizeEpoch": 4,
  "inputModes": {
    "applicationCursorKeys": true,
    "applicationKeypad": false,
    "bracketedPaste": true,
    "mouseTracking": "none",
    "sendFocus": false
  },
  "cursor": {
    "row": 19,
    "col": 32,
    "visible": true
  },
  "rows": [
    {
      "row": 19,
      "clearToEnd": true,
      "runs": [
        { "style": 0, "text": "model: default   ready" },
        { "style": 2, "text": "  [status]" }
      ]
    }
  ],
  "styles": [
    { "id": 0, "fg": "default", "bg": "default", "flags": [] },
    { "id": 2, "fg": "#8be9fd", "bg": "default", "flags": ["bold"] }
  ]
}
```

约定：

- `full: true` 表示客户端应清空当前投影并重建全部 20 行。
- `full: false` 只更新列出的 dirty rows。
- `generation` 变化时，客户端不得继续应用旧帧。
- `streamId` 标识本次 terminal subscription；重连、切换 mode 或改变 viewport 后生成新值并从完整帧开始。
- `sequence` 是**该 stream 实际发出的 frame** 的连续编号；被 scheduler 合并、尚未发送就被覆盖的候选画面不占用编号。
- `revision` 表示 screen model 版本，用于重连时请求最近状态。
- `clearToEnd` 防止上一帧较长文本残留。
- 宽字符、组合字符和行尾空格由服务端 screen model 统一决定，不由客户端猜测。
- `rows[].row`、`cursor.row` 和 `scroll.top/bottom` 都是投影视口内的相对行号 `0 .. viewportRows - 1`；其物理屏幕行等于 `viewportTop + row`。改变 viewport 必须发 `full: true`，不得把两套坐标混用。
- `inputModes` 来自 headless terminal 的公开 modes 状态。projection input helper 必须在处理后续用户按键前原子应用它；至少覆盖 application cursor keys、application keypad、bracketed paste、mouse tracking 和 focus reporting。
- `inputModes` 变化即使没有任何 cell 变化也必须产生高优先级 frame；否则下一次方向键或粘贴可能在画面完全静止时使用旧编码。

样式 ID 在同一 `generation` 内保持稳定。完整帧携带其使用到的全部样式；增量帧必须附带客户端尚未见过的新样式定义。若不准备维护样式字典确认状态，宁可让每个 dirty row 自包含样式定义，也不要让丢帧后出现“文字正确但颜色引用失效”。

#### 6.2.1 滚动操作码（流式输出的关键优化）

逐行 diff 有一个致命的退化场景：**屏幕整屏上滚时，20 行全部都是脏行**。流式 agent 输出、`npm install`、编译日志都是这样。此时「只发脏行」等于每帧发全屏，2 FPS 就是约 4 KB/s，投影相对 raw 几乎没有节省。

解法是在帧里加一个滚动操作码，让客户端自己搬运已有的行：

```json
{
  "type": "terminal.screen",
  "generation": "gen-7",
  "streamId": "9b80f3d2",
  "sizeEpoch": 4,
  "sequence": 1043,
  "revision": 402,
  "full": false,
  "scroll": { "top": 0, "bottom": 19, "lines": 3 },
  "rows": [
    { "row": 17, "runs": [{ "style": 0, "text": "  compiled 12 modules" }] },
    { "row": 18, "runs": [{ "style": 0, "text": "  compiled 13 modules" }] },
    { "row": 19, "runs": [{ "style": 0, "text": "  compiled 14 modules" }] }
  ]
}
```

约定：

- `scroll.lines > 0` 表示视口内容上移该行数（新内容从底部进入），`< 0` 为下移。
- 客户端**先**应用 `scroll`，**再**应用 `rows`。
- 服务端只在能确定是整块滚动时才发 `scroll`；不确定就退回逐行 diff，正确性优先。
- 滚动区域（DECSTBM）存在时，`top`/`bottom` 必须是投影视口内的相对行号。

识别整块滚动的方式：screen model 为每行维护一个内容哈希（含样式），比较前后两帧的哈希序列，若新序列是旧序列平移 N 行的结果，即为滚动。哈希本身也让逐行 diff 更便宜——不必逐 cell 比较。

收益量级：满屏滚动从「20 行 × 约 100 字符」降到「1 个 op + N 行新内容」，流式输出场景下的下行量降低约一个数量级。**这一条对达成 1 KB/s 目标的贡献大于帧率调低**，因为降帧率只会让画面变卡，不会让每帧变小。

按 §1.0 的优先级，这条服务的是**次要场景**（流式输出）。它可以晚于 §4.4 的交互对策实现——但如果最终要在弱网下看输出，就绕不开它：没有滚动操作码时，投影模式在流式场景下相对 raw 基本没有节省。

### 6.3 同步和恢复

新增按需同步消息：

```json
{
  "type": "terminal.screen.snapshot.request",
  "tabId": "tab-1",
  "generation": "gen-7",
  "streamId": "9b80f3d2",
  "revision": 381,
  "sizeEpoch": 4,
  "viewportRows": 20
}
```

下列情况必须返回 `full: true` 的 projection frame：

- 首次 projection 订阅。
- WebSocket 重连。
- raw/projection 模式切换或 viewport 行数改变。
- `generation` 不匹配。
- 客户端发现 `sequence` 间隙。
- 客户端 revision 与当前状态不同，且服务端没有可直接应用的精确增量（第一版默认不保存 dirty-row 历史）。
- PTY 重启、退出或重新绑定会话。

四个版本/流字段不能混用：

| 字段 | 作用域 | 是否允许跳号 | 用途 |
| --- | --- | --- | --- |
| `generation` | 一次 PTY/screen model 生命周期 | 变化即彻底重置 | 防止把旧进程画面应用到新进程 |
| `sizeEpoch` | 同一 generation 内的一次有效尺寸 | 变化时首帧必须完整 | 防止 resize 前后的行网格、光标和 input modes 混在一起 |
| `streamId + sequence` | 一次客户端 terminal subscription | `sequence` 不允许跳号 | 检测该连接实际发送帧的缺口；其他 runner/answer 事件不得占号 |
| `revision` | tab 的已解析屏幕状态 | 允许跳号 | scheduler 合并中间状态后，说明当前帧来自哪个 screen model 版本 |

WebSocket 本身有序可靠，正常情况下不会天然丢帧；这里的 sequence 主要用于发现应用层主动丢弃、错误复用旧订阅或实现缺陷。第一版不必保存 dirty-row 历史：重连与序号异常直接返回很小的完整 projection snapshot，通常比维护可补发历史更简单可靠。

### 6.4 输入协议保持不变

以下消息不应被帧率调度器延迟：

```json
{
  "type": "terminal.input",
  "tabId": "tab-1",
  "dataBase64": "..."
}
```

输入只需经过认证、大小限制和 PTY 写入，不需要等待下一帧。服务端可以增加轻量的 `terminal.input.ack`，用于显示网络延迟，但不能把 ack 与屏幕帧绑定。

输入端还必须满足：

- 连接已显式订阅该 tab 的 terminal，且具备写权限；不能只凭任意 `tabId` 写入一个未订阅会话。
- Base64 解码前后都有大小上限（建议首版单条 64 KiB）并限制异常突发速率；粘贴大文本应分块，而不是放宽到无限消息。
- ack 包含客户端生成的 `inputId`，只表示“服务端已验证并写入 PTY”，不表示画面已经回显或 provider 已处理。
- 用户输入、终端模拟器自动应答和队列注入在服务端使用不同的内部来源标记，避免自动应答被误认为用户操作。

### 6.5 模式切换与原子快照

raw/projection 切换不能只修改一个布尔值后继续发送，否则切换瞬间到达的 PTY 输出可能既丢失又重复。服务端应按以下顺序建立新 stream：

1. 停止向旧 terminal subscription 排入新帧，但不停止 PTY。
2. 等待当前 headless write 队列排空，取得同一时刻的 `generation + revision + raw nextOffset` 屏障。
3. projection 目标发送该 revision 的完整屏幕；raw 目标执行现有 reset/snapshot，并从屏障 offset 之后继续增量。
4. 客户端确认应用首帧后，服务端销毁旧 stream 状态。

当前 raw buffer 只有最近 1 MB，未必包含构建终端全状态所需的最早控制序列，因此“展开为 raw”仍可能依赖现有 xterm 重放的近似恢复。若实测不准确，可由 screen model 生成一份受控的可见屏幕 ANSI reset 作为 raw 首帧，再从屏障 offset 续接；这比扩大 raw buffer 到无限更可控。

## 7. 帧调度、差异和带宽控制

### 7.1 调度算法

```text
PTY onData(data)
    ├─ 立即 feed 到 TerminalScreenModel
    ├─ 标记发生变化的行
    └─ 唤醒 scheduler

scheduler 每个客户端独立运行
    ├─ 合并当前时间窗口内的 dirty rows
    ├─ 与该客户端上一帧比较
    ├─ 构造 terminal.screen
    ├─ 通过 token bucket 控制平均速率
    ├─ 检查 WebSocket bufferedAmount
    └─ 发送最新状态，或覆盖尚未发送的旧候选状态
```

推荐默认值：

| 参数 | 默认值 | 说明 |
| --- | ---: | --- |
| `viewportRows` | 20 | 正常低带宽窗口 |
| `fps` | 2 | 可选 1、2、5 |
| 合并窗口 | 100～250 ms | 期间只保留最新行状态 |
| 最大短时突发 | 4～8 KB | 菜单、重绘和重连允许短时突发 |
| 空闲心跳 | 10～30 s | 只发送连接或状态信息，不重发屏幕 |
| 输入优先级 | 最高 | 不受屏幕速率限制 |

raw 的 50 ms 合并窗口也应自适应：收到该客户端输入后的 600～1000 ms 内缩短为约 8～16 ms 或立即 flush 一次，以免“廉价优化”反而给回显固定增加 50 ms；持续流式输出时再恢复 50～100 ms 合并。

### 7.1.1 慢连接背压与最新状态原则

token bucket 只能限制“准备发送多少”，不能阻止操作系统/WebSocket 已经排队的数据继续膨胀。每个 terminal stream 还需要显式高低水位，例如首版可从 `high = 256 KiB`、`low = 64 KiB` 起测：

- projection：超过 high 后不再调用 `send()`，持续更新内存中的**一份**最新候选快照；降到 low 后丢弃旧增量，发送最新的 `full: true` 帧。projection 是状态同步，不需要可靠回放每个中间屏幕。
- raw：字节流不可任意丢弃，否则 VT parser 会失步。超过 high 后停止继续排队并关闭该 terminal stream（使用可识别 close code），客户端重连后依据 generation/offset 请求 snapshot；不要拖垮全局状态连接或 Node 进程。
- 控制事件：terminal state、错误和连接状态继续走独立的全局/状态 WebSocket，不能只排在已经拥塞的 terminal stream 后面，也不能被屏幕候选帧覆盖。
- 输入上行：仍立即处理；但若整个连接已失去活性，应明确显示 disconnected，而不是在本地假装输入成功。

高低水位必须通过弱网实测调整，并记录命中次数、峰值 `bufferedAmount`、因背压丢弃的候选 projection 帧数和 raw 重连次数。

### 7.2 带宽预算

文档统一区分：

- `1 KB/s` 约等于 `8 kb/s`。
- `1 kb/s` 只有约 `125 B/s`，两者相差八倍。

20 行 × 100 列的完整纯文本画面约 2,000 个字符；如果每秒发送两次全量画面，仅文本就可能达到约 4 KB/s，尚未计入样式、JSON、Base64、TLS 和 WebSocket 开销。

因此目标应按 §1.0 的两类场景分别定义，而不是给一个统一的硬指标：

- 空闲终端：尽量低于 0.2 KB/s。
- **交互控制（首要场景）**：菜单移动、切模型、看状态。脏行少，即使交互突发窗口内冲到 20～30 FPS，平均仍应在 1 KB/s 以内——因为每帧只有几十到几百字节。**这一档要保的是延迟不是带宽。**
- 菜单打开、流式输出、全屏重绘：允许短时突发，并通过 token bucket 限制长期平均值。
- 若设置绝对硬上限，画面可能滞后；不应为了满足硬上限丢弃原始 PTY 字节，因为 projection 客户端本来就只接收结构化屏幕状态。

优化项按「收益 ÷ 成本」重新排序（原方案的顺序把最贵的排在了最前面）：

| 优先级 | 优化 | 预估收益 | 成本 |
| --- | --- | --- | --- |
| 1 | 修复全局订阅重复推送（§2.2） | N+1 → 1 倍 | 极低，无新协议 |
| 2 | WebSocket per-message deflate | 终端文本通常可显著压缩，比例以实测为准 | 低到中，需要压缩协商与 CPU/RSS 基准 |
| 3 | 原始输出按交互/流式状态自适应合并 | 去掉每块的 JSON/WS 帧头开销 | 低，raw 模式即可受益 |
| 4 | 滚动操作码（§6.2.1） | 流式场景约 10 倍 | 中，需要行哈希 |
| 5 | 只发 dirty rows + 合并 style runs + `clearToEnd` | 静态画面接近 0 | 中，属于投影协议本体 |
| 6 | 二进制帧替代 JSON + Base64 | 去掉 33% Base64 膨胀 + JSON 转义 | 中高 |
| 7 | prompt/answer 历史分页与增量 | 与终端无关，但会话长了之后是大头 | 高 |

关于第 2 项：`@fastify/websocket` 会把 `opts.options` 传给 `ws` 的 `WebSocketServer`，但“能用一段配置开启”不等于“零成本的一行优化”。`ws` 服务端默认关闭 per-message deflate，原因是它会增加 CPU、内存与 zlib 并发压力；而且 `threshold` 只有在相应方向禁用 context takeover 时才真正用于跳过小消息。建议把下面配置作为**实验起点**，而不是未经测量的最终值：

```ts
await app.register(fastifyWebsocket, {
  options: {
    perMessageDeflate: {
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      concurrencyLimit: 4,
      threshold: 1024,
      zlibDeflateOptions: { level: 3, memLevel: 7 },
    },
  },
});
```

终端输出通常高度冗余，压缩潜力很大，但实际收益受消息大小、是否批处理和隧道实现影响。必须同时测 CPU、RSS、事件循环延迟、压缩协商结果和真实链路字节；本机连接也可能协商压缩，因此不能只测弱网流量。**这一项必须在动手写 screen model 之前测完**——第 1、2、3 项加起来可能已经把远程流量降到可接受，那样投影协议就只是锦上添花而不是必需品。

token bucket 默认按序列化后的未压缩 UTF-8 字节计量，便于实现且较保守；它不等于 TLS/隧道后的真实网络流量。阶段 0 应同时保存应用 payload 指标，并通过浏览器网络面板、代理/隧道指标或受控网络抓包采集 wire bytes。所有计数使用 `Buffer.byteLength(json, "utf8")`，不能用 JavaScript 字符串 `.length`。

## 8. 分阶段实施计划

### 阶段 0：基线测量，不改变行为

任务：

- 给每个 WebSocket 连接记录下行字节数、终端字节数、状态字节数、完整快照次数和重连次数。
- 分别统计 raw PTY 流、TabBundle、answer、prompt 和 index 的占比。
- 记录每个 tab 的终端输出峰值和平均值。
- 记录 `bufferedAmount` 峰值/持续时间、事件循环延迟、进程 RSS/CPU、消息合并前后数量和 parser write 队列深度。
- 区分应用层未压缩 UTF-8 payload、WebSocket 压缩后估算/实测字节和隧道外侧 wire bytes；三者不能混写成一个“流量”。
- 增加开发模式日志，不记录 prompt 内容，只记录大小、类型和时间。

验收：

- 能回答一次 tab 打开、一次 prompt、一次答案完成分别传输了多少字节。
- 能区分全局 WebSocket 和当前 tab WebSocket 的终端流量。
- 能在模拟慢连接下证明发送队列有界，且计量本身不记录终端/prompt/answer 内容。

### 阶段 1：先消除现有重复传输

修改范围：

- [`src/server/app.ts`](../src/server/app.ts)：把普通订阅与终端订阅分开。
- [`src/client/App.tsx`](../src/client/App.tsx)：全局连接只订阅 index、runner、answer 和 service 状态，不订阅 terminal output。
- [`src/client/App.tsx`](../src/client/App.tsx)：REST 初次加载与 WebSocket 初次快照二选一，不能重复。
- [`src/server/app.ts`](../src/server/app.ts)：状态事件先发送小型 delta；过渡期间至少避免每个事件都调用完整 `load()`。
- 为 WebSocket send 封装统一的计量和 `bufferedAmount` 保护；即使 projection 尚未实现，也不能让 raw 慢连接无限积压。

验收：

- 非当前 tab 的终端字节不会进入全局连接。
- 连接一个 tab 时，`TabBundle` 不会在 REST 和 WS 各发送一次。
- 更新 runner 状态不会重新传输全部历史。
- 现有 raw 模式的显示和输入行为不变。
- 弱网测试中 WebSocket 待发送量有明确上限；raw 超限会可恢复地重连，而不是拖慢其他 tab。

### 阶段 1.5：先榨干廉价传输优化，然后停下来决策

这一阶段刻意排在 screen model 之前，因为它可能让后面的工作变得不必要。

任务：

- 启用并调参 WebSocket per-message deflate，确认隧道与移动端浏览器均协商成功，同时比较开启前后的 CPU、RSS 与事件循环延迟。
- 把 `terminal.output` 自适应合并成批再发送：交互突发期约 8～16 ms/立即 flush，持续输出期约 50～100 ms。合并只影响传输，不改变字节顺序与 offset 语义。
- 用阶段 0 的仪表重测：空闲、打字、流式输出三种场景。

**决策闸门（必须显式回答后再往下做）：**

- 修完阶段 1 与 1.5 之后，远程实测流量是多少？
- 如果空闲已低于 0.2 KB/s、普通交互低于 1 KB/s，那么**投影协议应当降级为可选项**，把预算投到历史分页（阶段 5）上——那才是长会话真正的大头。
- 只有当流式输出仍然明显超预算、且用户确实需要在弱网下看输出时，才继续阶段 2～4。

写清这道闸门的意义在于：screen model + 投影协议是本方案里最贵、最容易出正确性问题的部分（VT 解析、宽字符、备用屏幕、滚动区域）。不该在没有实测证据的情况下先付这笔成本。

### 阶段 2：实现终端 screen model

建议新增：

```text
src/server/terminal-screen.ts
src/server/terminal-screen.test.ts
```

任务：

- **依赖已确定：`@xterm/headless@5.5.0`**（MIT，"A headless terminal component that runs in Node.js"），计划与当前已安装的 `@xterm/xterm@5.5.0` 锁定为同版本，并共享同源解析与网格语义。

  选它而不是自研或换别的库，理由是两端使用同源 VT 解析与 buffer 语义，可显著降低宽字符、组合字符、备用屏幕、滚动区域和 DECSTBM 的分歧风险；但这不是无条件的“结构性保证”。必须把 `@xterm/xterm` 与 `@xterm/headless` **精确锁定为同一版本**（当前 `package.json` 的 `^5.3.0` 会解析到已安装的 5.5.0，实施时应改为 exact pin），并保持 cols/rows、Unicode 版本、`convertEol`、Windows 兼容选项和自定义 parser handler 一致。
  - 读屏用 `term.buffer.active`：`.length`、`.baseY`、`.cursorX/cursorY`、`getLine(i).translateToString()` 与逐 cell 的 `getCell(x)`（拿前景色/背景色/flags/宽度）。
  - `node-pty.onData` 当前返回 JS string，screen model 应优先把该 string 原样交给 `term.write(data, cb)`；现有 raw offset 可以继续按 `Buffer.from(data, "utf8")` 的长度计算。必须用 fixture 覆盖 Unicode/控制序列跨 chunk，不能假定在进入 Node 前仍持有原始 ConPTY bytes。
  - `term.write()` 是异步入队 API；实现必须等待 callback 后再开放 snapshot，并把 resize 放入同一 per-tab 串行管线。
  - 需要在 `PtyManager` 层为每个 tab 建实例并在 generation 变化时 `dispose()`；projection 不需要历史 scrollback，建议 `scrollback: 0`，以把常驻内存限制在当前屏幕量级。
- 在 `PtyManager` 中为每个 tab 创建 screen model。
- 每个 `onData` 数据块同时写入现有 raw buffer 和 screen model。
- 保证 UTF-8 和 ANSI 控制序列跨 chunk 时不会被错误拆分。
- 保存主屏幕、备用屏幕、光标、滚动区域、样式和 dirty rows。
- 从 headless terminal 公开的 modes 读取并投影 application cursor keys、application keypad、bracketed paste、mouse tracking 和 focus reporting 状态。
- 注册终端协议应答租约，覆盖现有浏览器中的自动应答、OSC 10/11 和 CSI `?996n`，并验证 raw/projection 同时连接时也只有一个应答者。
- PTY 重启或退出时递增 generation，并清理旧 screen model。

必须覆盖的测试输入：

- 普通 PowerShell 提示符和回车换行。
- `\r` 覆盖当前行。
- 清屏、清行和光标移动。
- 备用屏幕切换。
- 滚动区域和底部状态栏。
- ANSI 颜色、粗体、反色和下划线。
- 宽字符、emoji、组合字符和长行折行。
- 分拆在两个 `onData` chunk 中的控制序列。
- write 尚未完成时请求 snapshot，以及 write 与 resize 交错的顺序测试。
- DA/DSR、OSC 10/11、颜色方案查询只应答一次；OSC 52 等副作用序列不进入 projection DOM。
- DECCKM/DECNKM/bracketed paste/focus/mouse mode 在 snapshot 和增量帧中正确同步。

验收：

- screen model 的 20 行投影在固定版本、相同 options/modes 的测试 fixture 中与浏览器 xterm.js 一致；此项是持续回归防线，不能因“同源引擎”而省略。
- 仍可在 raw 模式直接把原始 VT 数据交给浏览器。

### 阶段 3：增加 projection WebSocket 协议

修改范围：

- [`src/shared/schemas.ts`](../src/shared/schemas.ts)：增加 projection subscribe、screen frame、snapshot request 和错误类型。
- [`src/server/app.ts`](../src/server/app.ts)：解析 projection 订阅，禁止把 projection 客户端当作 raw 客户端发送 `terminal.output`。
- [`src/server/pty.ts`](../src/server/pty.ts)：暴露当前屏幕快照、dirty rows、generation 和 revision。
- 新增 `TerminalProjectionScheduler`，实现 FPS、合并窗口、行差异和 token bucket。
- 实现 `streamId + per-stream sequence + revision`，并加入 `bufferedAmount` 高低水位与“恢复后发 full snapshot”策略。
- compact 触发的终端重同步必须经过 terminal registry：raw 客户端收到 raw reset/snapshot，projection 客户端收到完整 screen frame，不能继续通过通用 `emit()` 把 raw buffer 广播给所有订阅者。

验收：

- projection 客户端永远不会收到完整 raw PTY 流。
- 首帧是完整的 20 行投影，后续只包含变化行。
- 丢帧、断线和 generation 变化可以恢复完整投影。
- raw 客户端和 projection 客户端可以同时连接同一 tab，互不影响。
- 慢 projection 客户端不会积压中间帧；其恢复后看到的是最新完整画面。

### 阶段 4：浏览器 projection 显示与交互

修改范围：

- [`src/client/App.tsx`](../src/client/App.tsx)：增加 raw/projection 显示模式和订阅参数。
- 保留现有 `term.onData` 输入路径。
- projection 模式下不把原始 `terminal.output` 写入 xterm。
- 增加 20 行结构化渲染或把 screen frame 转换为本地 ANSI 更新。
- 原子应用 `inputModes`，验证 application cursor keys 与 bracketed paste 不因投影模式改变编码。
- 显示光标、状态栏、颜色、备用屏幕标识和连接状态。
- 增加“展开终端”操作，切换到 40/60 行或 raw 模式。
- 遵守 responder lease：只有 raw input owner 可以转发显示 xterm 的 `onData`；projection input helper 只收到安全合成画面，因此只负责真实键盘/IME输入。

交互验收：

- 在 PowerShell 提示符中输入、删除、移动光标和粘贴文本。
- 在 Codex 中执行 `/model` 并选择模型。
- 打开计划/选项菜单，使用方向键、Enter、Esc 选择或取消。
- 输入补充说明并提交。
- 执行 Ctrl+C、中断和重新连接。
- 输入**发送**不等待下一次 screen frame；输入后的可见反馈通过交互突发帧满足回显延迟指标。

### 阶段 5：减少非终端数据

任务：

- 将完整 `TabBundle` 拆为 runtime、最近 prompt/answer 和分页历史。
- 事件只发送 tabId、记录 ID、状态、revision 和必要摘要。
- 只有用户打开历史页时才读取较早的 prompt/answer。
- 增加 `since` 或 revision API，避免状态变化触发整包读取。
- JSON API 启用 Brotli/Gzip；WebSocket 视兼容性启用压缩。

验收：

- 普通状态更新不会带上完整历史。
- 历史增长不会导致每次终端连接的首包无限增大。
- 刷新页面后仍能正确恢复当前 tab 的运行状态和最近记录。

### 阶段 6：灰度、配置和回退

建议配置：

```text
terminal.transportMode = raw | projection | auto
terminal.protocolVersion = 1
terminal.projectionRows = 20
terminal.projectionFps = 2
terminal.projectionInteractiveFps = 20
terminal.projectionInteractiveWindowMs = 800
terminal.projectionMaxBurstBytes = 8192
terminal.projectionExpandedRows = 60
terminal.projectionIdleHeartbeatSeconds = 20
terminal.websocketHighWaterBytes = 262144
terminal.websocketLowWaterBytes = 65536
terminal.maxInputMessageBytes = 65536
terminal.rawBatchIdleMs = 50
terminal.rawBatchInteractiveMs = 12
```

灰度顺序：

1. 开发环境手动启用 projection。
2. 只对当前活动 tab 启用。
3. 发生协议错误、screen model 错误或恢复失败时，回退到 raw 模式。
4. 观察实际流量和交互延迟后再调整默认 FPS、突发上限和展开策略。

回退必须只切换浏览器传输模式，不重启 PTY、不清除 prompt/answer、不改变 provider 会话。

`auto` 不应仅依赖 `navigator.connection`（浏览器支持并不一致）。首版建议把用户手动选择作为权威并持久化；自动模式只把远程 host、测得 RTT/吞吐与最近背压命中作为提示，使用滞回阈值，且不要在用户正在输入或菜单打开时突然切换模式。

## 9. 多客户端和终端尺寸策略

一个 PTY 同时只有一个 `cols/rows` 尺寸。多个浏览器分别要求不同尺寸时，TUI 的布局可能互相影响。

**核心原则：投影客户端完全不驱动 PTY 尺寸。**

原方案里「必要时将 PTY 高度固定为 20 或 24」会直接连累本机——PTY 只有一份，远端把它压到 20 行，坐在电脑前的人也只剩 20 行。正确的模型是把两件事拆开：

| 概念 | 归属 | 说明 |
| --- | --- | --- |
| PTY 的 `cols/rows` | 只由 **raw 客户端**驱动；没有 raw 客户端时沿用持久化的上次尺寸 | TUI 按这个尺寸排版换行 |
| 投影 `viewportRows` | 每个投影客户端自己的 | 只是「看这块完整屏幕的哪 20 行」，是一个**窗口**，不是终端高度 |

这样 20 行投影就是从一块 40 行屏幕里取底部 20 行，远端不改变任何人的布局，也不会引起 TUI 重排。多个投影客户端各自取不同窗口也互不干扰，§9 原本担心的多客户端冲突自然消失。

需要注意的配套约束：

- **宽度不能这样切窗口。** 行宽由 PTY 决定，投影只能整行传输；远端屏幕更窄时由客户端自己截断或横向滚动显示，不得反过来去改 PTY 宽度。
- 这条与本机的既有不变量一致：raw 模式下「模拟器尺寸 == PTY 尺寸」（见 `TerminalResizeScheduler.effectiveSize`）。投影客户端不参与该不变量，因为它根本不声称自己是那个终端。
- 若某个 tab 当前**只有**投影客户端（本机页面已关闭），PTY 保持最后一次持久化尺寸不变，不做任何 resize。

后续若需要多客户端：

- PTY 采用稳定的逻辑尺寸，不跟随每个浏览器的高度变化。
- 每个客户端只拥有自己的 projection viewport。
- 宽度变化应谨慎处理，因为宽度会影响 TUI 折行和布局；必要时只允许固定宽度档位。

## 10. 安全、隐私和合规边界

- projection 只减少浏览器链路传输量，不会减少 provider 在本机收到的真实会话内容。
- 终端显示可能包含 prompt、代码、路径、错误和状态栏，仍应使用现有认证、TLS/隧道和访问控制。
- WebSocket 握手必须校验现有 token/可信 Origin；远程部署优先使用隧道侧身份认证。URL query token 可能进入代理或诊断日志，后续应迁移为短期、可撤销且至少按实例限定的凭据，并确保日志脱敏。
- `terminal.input`/resize/snapshot request 只能作用于该连接已经获权并明确订阅的 tab；所有消息都通过共享 schema 校验，限制 tab 数量、viewport、FPS、Base64 长度和数值范围。
- 可选增加只读 projection 权限；查看状态不应天然获得向 PTY 写任意按键的能力。
- 不应将 screen frame 写入长期历史 JSON，除非用户明确开启终端录制。
- 结构化渲染器必须用文本节点和样式 allowlist。OSC 8 链接只作为普通文本或经过协议/域名校验的显式链接；OSC 52 剪贴板、通知、标题和其他副作用控制默认丢弃。
- 输入通道仍是用户可见终端的按键转发；本计划不新增后台模拟用户或绕过 provider 官方控制面的机制。
- 低带宽投影本身不能改变 provider 对自动化、账户共享、远程控制或队列使用的规则判断；合规性仍取决于整体调用方式、账号条款和实际使用场景。

## 11. 测试计划

### 11.1 单元测试

- VT/ANSI 解析与跨 chunk 解码。
- 主屏幕和备用屏幕切换。
- 20 行 viewport 计算。
- dirty row 和 styled run 合并。
- 光标位置、宽字符和清行。
- generation/revision/sequence 间隙。
- `streamId` 重建、viewport/mode 切换和 sequence 不被非终端事件占号。
- token bucket 和帧合并。
- `bufferedAmount` 高低水位、候选帧覆盖、恢复后的 full snapshot，以及 raw 超限重连。
- projection 与 raw 订阅隔离。
- headless write callback、snapshot 和 resize 的串行顺序。
- projection `inputModes` 与 input helper 的 DECCKM、DECNKM、bracketed paste、focus/mouse 状态同步。
- DA/DSR、OSC 10/11、CSI `?996n` 在 raw/projection/双客户端下都恰好应答一次。

### 11.2 集成测试

- PowerShell 启动、输入、回显和退出。
- Codex、Claude Code、Cursor CLI 各自的 native TUI。
- `/model`、计划选择、补充说明、Esc、Ctrl+C。
- 状态栏固定在底部的场景。
- 超过 20 行的菜单和弹窗自动展开。
- 多次 tab 切换、浏览器刷新和 WebSocket 重连。
- PTY 在 screen frame 发送期间退出或重启。
- 一个 tab 同时 raw/projection 连接。
- Codex compact 期间继续输出，projection 收到完整屏幕重同步而非 raw buffer。
- 手机进入后台后制造慢连接，再恢复到前台；确认不会追赶数分钟旧画面。
- per-message deflate 在本机、隧道和目标移动端实际完成协商；关闭压缩仍能兼容。

### 11.3 带宽测试

至少记录以下指标：

```text
连接时长
终端 raw 字节数
projection payload 字节数
JSON/压缩后字节数
frame 数量和实际 FPS
全量 frame 数量
dirty row 平均数量
输入发送到 PTY 的延迟（上行）
按键到回显出现的延迟（下行，与上行分开记）
滚动操作码命中率（整块滚动被识别的比例）
交互突发窗口内的额外字节数
重连恢复耗时
WebSocket bufferedAmount 峰值与高水位持续时间
因背压被覆盖的 projection 候选帧数
raw 背压断开/恢复次数
headless parser write 队列深度与快照等待时间
服务端 CPU、RSS 与事件循环延迟
```

测试场景：

1. 空闲 PowerShell 提示符。
2. 连续输入和删除。
3. 流式 agent 输出。
4. `/model` 菜单。
5. 计划选择菜单。
6. 大量全屏刷新。
7. 20、40、60 行 projection。
8. 人为延迟、丢包和断线后恢复。
9. 手机/浏览器后台冻结 30～120 秒后恢复。
10. compact、resize 与高频输出同时发生。

### 11.4 必须运行的项目检查

```powershell
npm run typecheck
npm test
npm run build
```

## 12. 最终验收标准

- [ ] 远程 projection 默认只发送当前 tab 的底部 20 个屏幕行。
- [ ] 状态栏和光标正常显示。
- [ ] `/model`、计划选择、补充说明、方向键、Enter、Esc、Ctrl+C 可用，且操作手感与本机无明显差别（首要验收项）。
- [ ] 输入不等待下一次画面帧，也不因 1～2 FPS 被丢弃。
- [ ] projection 客户端不接收 raw PTY 字节。
- [ ] 全局状态 WebSocket 不接收非当前 tab 的终端流。
- [ ] 首次加载不会重复发送完整 `TabBundle`。
- [ ] 普通状态更新不会反复传输全部历史。
- [ ] 断线、丢序号、PTY 重启可以恢复，不需要重启 provider。
- [ ] 慢连接的发送队列有界；projection 恢复后直接显示最新状态，raw 可通过 snapshot 重连恢复。
- [ ] terminal screen snapshot 总是在 headless write 完成后生成，resize/compact 不会产生混合尺寸或半解析帧。
- [ ] DA/DSR、颜色和主题查询在 raw、projection 及两者并存时均恰好应答一次。
- [ ] projection 渲染不会执行 OSC 52、任意 URL、HTML 或其他终端副作用。
- [ ] 空闲和普通交互达到约 1 KB/s 平均目标；全屏重绘允许短时突发并有明确统计。
- [ ] **按键到回显的附加延迟 ≤ 150 ms**（与上行延迟分别测量、分别记录）。
- [ ] **流式输出场景下投影字节数显著低于 raw**；若滚动操作码未生效导致两者接近，视为未达标。
- [ ] 投影客户端不改变 PTY 尺寸；本机 raw 客户端的行列数不受远端连接影响。
- [ ] raw 模式保持现有功能，projection 出错时可以回退。
- [ ] `npm run typecheck`、`npm test` 和 `npm run build` 全部通过。

## 13. 推荐的首个可交付版本

原方案把 screen model 放进了「首个版本」。改为**两个可独立交付的版本**，中间隔一道实测闸门——因为第一个版本有可能就够了。

**交付物 A：不引入任何新协议（建议先只做这个）**

1. 修复全局 WebSocket 的终端流量误订阅（把终端订阅与状态订阅分开）。
2. 为 send 增加计量和 `bufferedAmount` 高低水位；raw 超限可恢复重连，不能无限积压。
3. 启用并基准测试 WebSocket per-message deflate。
4. `terminal.output` 自适应合并：交互期 8～16 ms/立即 flush，持续输出期 50～100 ms。
5. 加上阶段 0 的应用 payload、wire bytes、CPU/RSS 与队列计量，测出空闲 / 打字 / 流式三种场景的实际值。

相较投影协议，这一交付物工作量和风险都较小，且不改变 PTY/provider 或终端显示语义；但 batching、压缩与 raw 背压重连仍需单独灰度和回退开关，不能把它们视为“行为完全不变”。测完之后回答决策闸门的问题：**还需要投影吗？**

**交付物 B：投影模式（仅当 A 的实测结果证明有必要）**

1. `@xterm/headless@5.5.0` screen model + 20 行完整 snapshot。
2. 终端协议应答租约 + per-tab write/resize/snapshot 串行屏障（§4.5）。
3. **交互突发帧率 + 光标行即时帧**（§4.4）——首要场景的成败在这一条，应当先于其余投影优化完成。
4. 2 FPS dirty-row 更新，**含滚动操作码**（§6.2.1）——服务流式输出这个次要场景；没有它投影在该场景下相对 raw 基本没有收益。
5. `terminal.input` 立即转发，但与模拟器自动应答分来源标记并校验订阅权限。
6. `streamId`、原子首帧和有界背压；慢客户端恢复后发最新 full snapshot。
7. 投影客户端不驱动 PTY 尺寸（§9）。
8. 「展开终端」按屏障切换到 raw 模式。
9. 完成 PowerShell、`/model`、计划选择、补充说明、compact、弱网恢复和重连测试。

第 2、3、4 条都是交付物 B 的**必需项**：少了第 2 条，原生 TUI 的终端查询和异步快照可能不正确；少了第 3 条，投影交互延迟会高到难用；少了第 4 条，流式场景省不下带宽。若时间有限，应先完成第 2 条的正确性基础，再按 §1.0 优先实现第 3 条，最后补第 4 条。

两个交付物都完成后，再实施历史分页、增量 TabBundle、二进制帧和多客户端尺寸管理。

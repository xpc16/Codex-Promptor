# 最终回答文档链接查看器实施方案

> 状态：实现规格，已完成轻量化/低传输审阅，待开发
>
> 适用范围：Promptor 最终回答中的本地文档链接、Windows 默认应用打开、远程 PowerShell/Terminal 文档查看
>
> 当前代码基线：[src/client/App.tsx](../src/client/App.tsx)、[src/server/app.ts](../src/server/app.ts)、[src/server/pty.ts](../src/server/pty.ts)、[src/server/http-cache.ts](../src/server/http-cache.ts)、[src/client/terminal-cache.ts](../src/client/terminal-cache.ts)
>
> 编写日期：2026-08-27
>
> 审阅修订：2026-08-27。修正本地/远程判定、POST 缓存、Markdown 分块、固定块寻址、终端退订竞态和请求取消等实现细节。

本文规定以下功能：

- 最终回答中的 Markdown 文档链接可以提取真实路径并点击打开；
- 本地访问时由 Windows 默认关联应用打开文件，支持任意能够被系统打开的文件格式；
- 远程访问时不在远程客户端启动文件，而是在当前 PowerShell/Terminal 窗口内切换到文档视图；
- 远程文档视图支持 TXT 和 MD，MD 使用与最终回答相近的简单渲染；
- 打开文档后暂停当前客户端的终端刷新，不再向该连接发送终端输出/屏幕更新；
- 文档内容按块读取、按需加载、由浏览器 HTTP 缓存复用；
- 空闲时不轮询、不发送完整文件、不重新加载完整对话；
- 关闭文档后只发送一次当前屏幕同步，不回放暂停期间的全部终端数据。

贯穿全文的约束只有四条：**正文不进入 WebSocket/TabBundle、每次只取一个固定块、空闲零轮询、关闭立即取消**。任何后续增强若破坏其中一条，应另立功能而不是塞进第一版。

## 1. 核心结论

### 1.1 两种打开模式

| 连接模式 | 点击文档链接后的行为 | 文件格式 | 是否传输正文 |
| --- | --- | --- | --- |
| 本地 | 服务端调用 Windows 默认文件关联应用打开 | 任意系统可打开格式 | 不传输 |
| 远程 | 当前 tab 的 PowerShell/Terminal 面板进入 DocumentView | TXT、MD | 只传输用户实际读取的块 |

本地模式的"打开"不是在浏览器中预览，也不是下载文件，而是调用操作系统默认应用。TXT 打开记事本，MD 打开 VS Code、Typora 或系统默认程序，PDF、图片和其他格式也交给系统关联应用。

远程模式不能让服务端调用默认应用——那会在运行 Promptor 的主机上弹窗，远程用户看不到。远程模式在浏览器内复用当前显示 PowerShell 的 Terminal 面板：视觉上仍然是那个 PowerShell 窗口，内容暂时由受控的文档视图渲染。

### 1.2 "暂停 PowerShell 刷新"的精确定义

打开远程文档时：

- 不暂停或杀死 PowerShell 进程；
- 不暂停 Claude、Codex、Cursor 或其他 provider；
- 不暂停 Prompt Queue 和 Timer scheduler；
- 不向当前客户端发送新的 raw output 或 projection screen；
- 不把暂停期间积累的全部终端输出重新传输；
- 关闭文档后发送一次当前屏幕同步，而不是整段历史。

暂停是**当前客户端的显示订阅暂停**，不是全局暂停。另一台浏览器同时连接同一 tab 时，它仍然继续收到终端更新。

`terminal.state`（进程启动/退出/出错）是低频小消息，且暂停期间仍需要让终端标题保持真实，因此**不在暂停范围内**。

### 1.3 文档链接的范围

只拦截最终回答中明确的 Markdown 链接，不扫描正文中的所有路径。这样可以避免把命令、代码、Windows 路径或随机字符串误判为可打开文件。

~~~markdown
[打开说明](file:///D:/Claude_convers/tools/codex_promptor/docs/README.md)
[查看实现文档](./docs/IMPLEMENTATION_SPEC.md)
[打开文本](D:/work/notes/today.txt)
~~~

普通 HTTPS 链接仍按原逻辑打开外部网页，不进入本地文档查看流程。

## 2. 与现有实现的接合点

本功能最大的实现风险不是写不出来，而是**重造已经存在的东西**。下表是本仓库已有能力与本功能的对应关系，每一条都应当直接复用，而不是新建平行机制。

| 需求 | 已有能力 | 结论 |
| --- | --- | --- |
| 分块内容不重复传输 | 现有 GET 已依赖浏览器 HTTP cache；`http-cache.ts` 提供 ETag/Vary 写法 | chunk 改用 revision URL + `immutable`，**不要写 IndexedDB**，见 §6.3 |
| 文本响应压缩 | `@fastify/compress` 已全局注册（br/gzip，`threshold: 512`） | 无需任何新增配置 |
| 暂停/恢复终端显示 | `subscribe` 消息**整体替换** `client.terminalSubscriptions`（`src/server/app.ts`），空 `terminals` 即退订 | **不要新增 pause/resume 协议**，见 §7 |
| 恢复时只要当前屏幕 | projection 订阅建立时即发一帧完整屏幕；raw 订阅按 `cursor` 增量 | 恢复=重新订阅，见 §7.2 |
| 客户端记得读到哪里 | `src/client/terminal-cache.ts` 已跨视图卸载保存 `{generation, nextOffset}` 与字节 | 恢复时直接复用该游标 |
| 本地/远程判定 | `location.hostname`、`isLocalHost` / `isTrustedBrowserRequest`（服务端） | 不新增 connectionMode 握手，但不能把 raw/projection 偏好当身份，见 §4.1 |
| 安全地调用外部程序 | `src/server/directory-picker.ts` 使用 `execFile` + 参数数组，不拼 shell 字符串 | 照抄该模式 |
| 不重复下发对话数据 | 最终回答窗口化到 3 条 + delta 广播 + ETag 重校验 | 打开文档天然不会触发整包重载，见 §10 |

终端侧只缺一个窄能力：**强制 raw 恢复时的一次性 screen bootstrap + 竞态补发限幅**（§7.3）。它复用现有 `TerminalScreenModel`，不是第二条持续 stream。其余能力都是组合已有零件。

不要把文档正文加入 TabBundle、AnswerRecord 或 terminal screen frame。最终回答只保留原始 Markdown，链接点击时再按需处理。

## 3. 文档链接识别

### 3.1 放在 shared，不放 client

新增 `src/shared/document-link.ts`。

理由与 `src/shared/prompt-order.ts` 相同：**服务端必须重新做一遍分类**（客户端算出的路径不可信），如果两侧各写一份，判定规则迟早会漂移。共享一个纯函数，两侧按构造一致。

### 3.2 分类顺序

1. 空 href：普通无效链接；
2. 片段链接 `#section`：页面内跳转；
3. `http` / `https`：外部网页；
4. `mailto` / `tel`：保持原行为；
5. `javascript` / `data` / `vbscript`：明确标记为 `blocked`，不导航也不发请求；
6. `file:` URI：本地文档候选；
7. Windows 绝对路径 `D:/work/a.md` 或 `D:\work\a.md`：本地文档候选；
8. 以 `/D:/` 开头的应用内部绝对路径：转换为 Windows 路径候选；
9. `./` 或 `../` 相对路径：本地文档候选，基准由服务端决定；
10. 其他未知协议：不拦截，但仍交给安全 URL transform；不得原样赋给 DOM。

**不要把所有以斜杠开头的字符串当成绝对路径。** `/api`、`/settings`、`/#section` 必须保持普通链接行为，只有识别出 Windows 盘符或明确的 file URI 才进入文档流程。

### 3.3 输出

~~~text
DocumentTarget {
  kind: "local-file" | "external" | "fragment" | "blocked" | "unknown",
  rawHref: string,
  path: string | null,           // 未规范化候选，仅供客户端显示/分类；请求仍传 rawHref
  fragment: string | null,       // 文档内锚点，不属于磁盘路径
  displayName: string | null
}
~~~

客户端只负责初步分类和显示名称。**最终路径必须由服务端重新解析、规范化和检查**（§8）。

### 3.4 相对路径基准

相对路径的基准不能由浏览器提交一个任意 `baseDirectory`。这样既重复发送绝对路径，也把一个安全决定交给了客户端。服务端按以下顺序自行取得基准：

1. 文档内部链接携带 `parentDocId`：用 memo 中已授权文档的父目录；
2. 最终回答链接携带 `answerId`：若该回答的 `metadata.documentBasePath` 存在则使用它；
3. 否则用目标 tab 的 `session.workingDirectory`；
4. 都没有时提示"无法确定文档位置"，**不**使用浏览器 URL，也不退回到进程 cwd。

`documentBasePath` 由服务端在记录回答时写入 `AnswerRecord.metadata`，客户端不能覆盖。它是 server-only 元数据：所有 AnswerRecord REST/WS 输出经统一 `toClientAnswer` 去掉该键，点击只回传 answerId，由服务端查原记录，因此既能稳定解析 thread switch 前的相对链接，也不在每次回答窗口中重复传路径。绝对 href 的点击请求可省略 answerId。

第一版不从外部 HTTPS 页面解析相对路径，也不跟随远程网页跳到本机文件。

### 3.5 生成链接时的约定

应用内部生成文档链接时：

- workspace 内文件用相对 `./`、`../`；
- 绝对文件用 `file:///D:/...`；
- 路径含空格、`#`、`%`、`?` 时先按 URI 编码；
- 显示文本用文件名或说明，真实路径放 href；
- 不把 token、密码或 session id 放进 href。

### 3.6 ReactMarkdown 接入

把默认 anchor 换成 `DocumentAwareLink`，`remarkPlugins` / `rehypePlugins` 保持与最终回答一致。

这里不能只写"让 `rehype-sanitize` 放行 file"。当前 `react-markdown@10` 的默认 `urlTransform` 也会清空 `file:`，而 `D:/...` 会被 sanitizer 当成未知协议。实现顺序固定为：

1. 一个很小的 remark 插件只处理 Markdown `link` 节点，把已识别的 Windows 绝对路径规范成 `file:///D:/...`，不处理 image；
2. 从 `rehype-sanitize` 的 `defaultSchema` 派生 schema，只在 anchor 的 `href` 协议中增加 `file`；
3. 自定义 `urlTransform` 仅对 `node.tagName === "a"` 且分类为 `local-file` 的 href 保留原值，其他值调用 `react-markdown` 的 `defaultUrlTransform`；
4. `DocumentAwareLink` 在 click 中阻止 `file:` 默认导航并调用应用流程。

这样不会为了本地文件链接放宽图片、iframe 或其他 URL 属性。相关配置放进一个共享的 `SafeMarkdown` 组件，最终回答和远程 MD 视图复用，避免两套安全规则漂移。

`DocumentAwareLink` 的动作：

- 调用 `extractDocumentTarget`；
- `external` / `fragment` / `unknown` 走安全的原有 anchor 行为，`blocked` 只给出不可打开提示；
- `local-file` 阻止默认导航，按连接模式分流；
- 最终回答传给服务端的是**原始 href + tabId**，仅相对路径再附 `answerId`；文档内部相对链接改附 `parentDocId`。两者都不传客户端计算的绝对路径；
- 打开期间置 loading，防止双击开两次。

不得放行 script、iframe、object、embed、远程/本地 image、`data:`、`javascript:`。URI 只解码一次；`#fragment` 与路径分开保存，query 对本地文件一律拒绝（文件名中的 `?` 必须编码且 Windows 本身也不允许该字符）。

## 4. 本地打开

### 4.1 模式判定：只看浏览器 host，不看终端偏好

不新增 bootstrap 字段或环境变量，但也**不能**直接复用 `resolveTerminalTransportPreference(pref, location.hostname)`。该函数在用户手动选择 `raw` 时无条件返回 raw；raw/projection 是终端传输偏好，不等于本地/远程身份。否则远程用户切到 raw 后会错误尝试 `open-local`。

新增共享纯函数 `isLoopbackHostname(location.hostname)`，只接受 `localhost`、`127.0.0.1`、`::1`：

- 客户端 loopback → 请求 `open-local`；非 loopback → 请求远程 `open`；
- 服务端 `open-local` 同时检查 Host、Origin/Referer 的 hostname 均为 loopback；有反向代理时不能只看 Host，因为代理可能把远程请求转发成 `Host: 127.0.0.1`；
- `isTrustedBrowserRequest` 仍用于通常的 API 认证，但**不能单独作为本机副作用的授权条件**。

即：**客户端判定只决定发哪个请求，服务端重新判定能否执行本机副作用。** 远程请求即使有合法 Promptor token，也只能读取允许的 TXT/MD，不能让服务器桌面弹出应用。

### 4.2 流程

~~~text
点击链接 → extractDocumentTarget → 识别为 local-file
        → POST /api/documents/open-local { href, tabId, answerId? }
        → 服务端重新解析并校验路径（§8）
        → 普通文件 → Windows 默认关联应用打开
        → active 文件 → confirmationToken → 用户确认后再打开
        → 客户端显示"已请求系统打开"，不读取正文
~~~

响应只返回成功/失败和显示名称，**不返回文件内容**。点击大型 PDF、图片、压缩包也不产生任何正文传输。

### 4.3 调用默认应用

照抄 `src/server/directory-picker.ts` 的模式：参数数组，不拼 shell 字符串。

~~~text
execFile("explorer.exe", [validatedAbsolutePath], { windowsHide: true })
~~~

要求：

- 只传已解析和校验过的绝对路径；
- 不用 `cmd /c start` 加字符串拼接；
- 不把用户输入放进 PowerShell 命令；
- 目标必须存在且是普通文件；
- 不等待默认应用退出；
- `explorer.exe` 的退出码不代表打开成功，只据此区分"调用失败"与"已交给系统"。

模型输出本身不可信。`.exe`、`.com`、`.bat`、`.cmd`、`.ps1`、`.msi`、`.reg`、`.lnk`、`.url` 等可执行/脚本/快捷方式仍可按“任意格式”交给系统，但服务端第一次返回 `DOCUMENT_CONFIRMATION_REQUIRED`，界面显示规范化后的**文件名和类型**并要求再次确认；第二次请求带短期 `confirmationToken`。该 token 用 HMAC 绑定 canonicalPath + revision + 过期时间，服务端重新校验后才打开，因此不需要 nonce Map，也不能靠客户端布尔值绕过。普通 TXT/MD/PDF/图片不增加请求。

将来支持 Linux/macOS 时再加平台适配器，不要在 Windows 路径逻辑里混入多套 shell 规则。

### 4.4 本地也要限制路径

"支持任意格式"只表示交给系统默认应用，**不表示允许打开任意服务器路径**。允许的 root：

- 当前 tab 的 workingDirectory；
- 用户显式配置的 document roots；
- 应用自身的 docs 目录。

不要默认把整个 Promptor root 加入允许列表：它通常同时包含 `data/`、配置和源码。若 tab 的 workingDirectory 本身就是项目根，它已经自然获准；否则只额外开放 `docs/`。`CODEX_PROMPTOR_DOCUMENT_ROOTS` 中的每一项启动时 realpath、去重并记录配置错误，不能在每个 chunk 请求重新解析环境变量。

~~~text
CODEX_PROMPTOR_DOCUMENT_ROOTS=D:\Claude_convers\tools\codex_promptor;D:\work\docs
~~~

## 5. 远程文档视图

### 5.1 位置

~~~text
terminal-card
├── terminal-heading
└── terminal-body
    ├── xterm terminal        （文档关闭时显示）
    └── document-view         （文档打开时显示）
        ├── document-toolbar
        └── document-scroll
~~~

DocumentView 在现有 Terminal 面板内部：不新开浏览器标签，不建第三个终端，**不把 Markdown 转成 ANSI 写回 PTY**。用浏览器 DOM 渲染，链接、标题、代码块和滚动都比塞进 PowerShell 屏幕可靠得多，而位置仍在用户正在看的那块区域。

与 xterm 的切换用同尺寸绝对叠层 + `visibility`，不用 `display: none`——把终端折叠到零尺寸会让 ResizeObserver 触发 PTY 几何重协商，代价远大于收益（手机分页布局已经因为同样的原因这么做，见 `styles.css` 的移动端注释）。文档打开时 `scheduleSize` 直接 no-op，避免不可见 xterm 仍发送 `terminal.resize`；终端层同时设 `pointer-events: none` 和 `aria-hidden`。

### 5.2 工具栏

只需要：文件名、类型、`已加载 X / 总计 Y`、关闭按钮、加载更多/已完成状态、错误状态。

**不要**显示实时下载速度、倒计时或 scheduler 状态——这些都是每秒重绘和额外状态。

~~~text
┌─────────────────────────────────────────────────────────┐
│ 文档：README.md     MD    已加载 8 KB / 42 KB    关闭  │
├─────────────────────────────────────────────────────────┤
│ # 标题                                                  │
│ 文档内容……                                             │
│                 [加载更多]                              │
└─────────────────────────────────────────────────────────┘
~~~

### 5.3 TXT

保留换行的纯文本：等宽字体、不执行 ANSI、不当作 HTML、不做高亮。分块追加时保持滚动位置，默认定位到开头，滚动到接近底部才允许取下一块。

客户端保存 `string[]` 解码片段，不在每块到达时做 `text = text + next`；后者会反复复制不断增长的字符串。React 可直接渲染稳定 key 的文本片段，关闭时一次释放数组。

### 5.4 MD：按顶层完整块渲染，不重复解析前缀

原方案是"把已收到的文本前缀整体交给 ReactMarkdown，下一块到达后重新渲染"。这有两个问题：**每来一块就重新解析整个前缀，是 O(n²)**；块边界处未闭合的代码围栏或列表会短暂渲染成错误结构再跳回来。手机上两者都明显。

不能简单找“最后一个空行”：fenced code、带空行的列表/引用、表格延续都可能跨过空行。改为一个不生成 AST 的**行级状态机**：

1. `MarkdownBlockAssembler` 保存未完成尾巴及 fenced-code marker（反引号/波浪线与长度）、list/blockquote continuation、table header 状态；
2. 只有位于顶层、围栏外且下一行不再延续 list/blockquote/table 的空行才可提交块；
3. 已提交块各自用 `<ReactMarkdown>` + `memo` 渲染，永不重新解析；
4. 未完成尾巴暂以纯文本占位；文件读完时才把尾巴作为最后块提交；
5. 未闭合围栏可能很长，尾巴超过 64 KiB 后继续以分段纯文本显示，直到遇到闭合围栏，不能为了等待“完整 Markdown”无限隐藏或复制内容。

这仍是一个纯函数/小状态机，不引入第二个 Markdown parser。每块只解析一次，解析总量保持 O(n)。为避免跨独立 ReactMarkdown 块的语义错误，远程第一版不支持跨块 reference-style link definition 和 footnote；普通 inline link、GFM 表格、围栏代码均支持。块容器增加 `content-visibility: auto`，长文档在屏幕外不参与布局和绘制。

渲染配置复用 §3.6 的 `SafeMarkdown`：允许标题、段落、强调、列表、引用、fenced code、表格、安全的相对链接；禁用 HTML、脚本、iframe、object、embed 和远程/本地图片。

服务端**不实现第二套 Markdown 解析器**，只返回原始 UTF-8 字节。

### 5.5 文档内部链接

MD 文档内的链接同样经过 `DocumentAwareLink`：相对的 TXT/MD 链接可以打开新的 DocumentView（先关旧的）；外部 HTTPS 明确标记后可新标签打开；不允许绕过服务端 root 校验。`SafeMarkdown` 给 heading 生成确定性、无脚本的 slug，供同文档 `#fragment` 定位；重复标题的 suffix 按已提交块顺序预计算，不能在 React render 中递增全局计数（StrictMode 会重复调用）。

fragment 不得成为隐式“下载全文”开关：目标已在加载块中就滚动；尚未出现时提示“锚点尚未加载”，由用户点击“加载至锚点”后才顺序取更多块，仍遵守单请求在途与 4 MiB 上限。

第一版不做文档历史栈——需要返回时关闭当前文档，从最终回答重新点上一个链接。少维护一套状态和缓存索引。

### 5.6 打开顺序

远程点击的顺序固定为：先 POST `open`；授权/元数据成功后立即设置新的 documentEpoch、切到 DocumentView 并发送 `terminals: {}`；随后才请求 chunk 0。open 失败时终端从未退订；首块失败时在 DocumentView 内显示错误和关闭/重试，不偷偷恢复终端。这样既避免无效链接引起订阅抖动，也让慢首块期间不继续消耗终端带宽。

从设置 documentEpoch 起，迟到 terminal frame 不再写 xterm；关闭则先 abort，再恢复订阅。所有动作都在现有 per-tab socket 上完成，不等待额外 pause ack。

## 6. 文档寻址与分块

### 6.1 稳定路径 id + 文件修订版本，不创建文档会话

原方案为每次打开创建带过期时间的 session，配套 POST/HEAD/DELETE、过期与引用计数。这里不需要。需要区分两个概念：

~~~text
docId    = base64url(HMAC-SHA256(documentKey, canonicalAbsolutePath)).slice(0, 22)
revision = base64url(HMAC-SHA256(documentKey,
           docId + dev + ino + size + mtimeNs + ctimeNs)).slice(0, 22)
~~~

公式中的字段实际用固定顺序的 length-prefixed tuple（或含键的稳定 JSON）序列化，不能直接无分隔拼接字符串。

- `docId` 是**路径标识**，不是内容 hash；真实路径不出现在 URL；
- `revision` 是廉价文件修订标识。它避免为打开 8 KiB 首块而先读取并 hash 整个 4 MiB 文件；
- 同一路径未修改时二者稳定，修改/替换后 revision 变化，chunk URL 自然进入新缓存分支；
- `documentKey` 必须跨进程稳定，否则 Promptor 每次 30 秒自动退出再启动都会让浏览器缓存失效。首次启动生成 32 随机字节到 gitignored 的 `data/private/document-key`，不写日志、不下发客户端；
- 这不是严格的内容寻址。极端情况下外部程序伪造全部 stat 字段可能复用旧 revision；本地工具为避免整文件预读接受这一权衡，并在“强一致 hash”与“低传输/低磁盘读取”之间明确选择后者。

服务端维护有界 `Map<docId, canonicalPath>`（建议最多 256 项，LRU）。它只是路径 memo：没有 TTL、引用计数或正文。`open` 每次都写入/刷新；memo 丢失返回 `DOCUMENT_ID_UNKNOWN`，客户端最多自动重新 open 一次。

**每个实际到达服务端的 chunk 请求仍重新执行 §8 的 root、类型、大小和 revision 校验。** 浏览器已命中的旧 revision 块不会到达服务器，但它只会继续显示客户端曾经取得的同一旧版本，不会混入新版本。

### 6.2 接口：固定块编号，不接受任意 offset/length

| 方法 | 路径 | 作用 | 返回 |
| --- | --- | --- | --- |
| POST | `/api/documents/open-local` | 本地默认应用打开 | 成功/失败，无正文 |
| POST | `/api/documents/open` | 解析、授权、stat 并写入 memo | 元数据，无正文 |
| GET | `/api/documents/:docId/chunks/:index?rev=<revision>` | 读取一个固定块 | 原始 UTF-8 字节 |

固定 `index` 比客户端提交 `offset + length` 更轻也更安全：URL 唯一、不会因重叠 range 产生多份缓存、服务端读长有硬上限，请求也更短。共享常量放在 `src/shared/document-protocol.ts`：

~~~text
DOCUMENT_FIRST_CHUNK_BYTES = 8192
DOCUMENT_CHUNK_BYTES = 16384

index 0: start = 0,    max = 8192
index n: start = 8192 + (n - 1) * 16384, max = 16384
~~~

`/api/documents/open` 的 POST body 只允许 `{ href, tabId, answerId? }` 或 `{ href, tabId, parentDocId }`，设置较小 body limit；响应设置 `Cache-Control: no-store`：

~~~json
{
  "docId": "5f3a9c1b7e2d4086ab19cd",
  "name": "README.md",
  "kind": "markdown",
  "size": 43008,
  "revision": "dKf7Q54x6B0s8aR0YdP2_g",
  "encoding": "utf-8"
}
~~~

chunk 响应示例：

~~~text
GET /api/documents/5f3a9c1b7e2d4086ab19cd/chunks/0?rev=dKf7Q54x6B0s8aR0YdP2_g

200 OK
Content-Type: text/plain; charset=utf-8
Cache-Control: private, max-age=31536000, immutable
ETag: W/"5f3a9c1b7e2d4086ab19cd.dKf7Q54x6B0s8aR0YdP2_g.0"
Vary: x-codex-promptor-token, accept-encoding
~~~

不要手工写 `Content-Length`；`@fastify/compress` 可能把文本压成 br/gzip，Fastify 应按实际编码生成长度。正文**不用 JSON、不用 Base64**。客户端为它写独立 `fetchDocumentChunk`，不能复用当前强制 `response.json()` 的 `api()` helper。

只有成功的 200 chunk 可以带长缓存；所有文档 4xx/5xx 都显式 `Cache-Control: no-store`，尤其不能把 `DOCUMENT_CHANGED`、`DOCUMENT_ID_UNKNOWN` 或临时读取失败缓存到 immutable URL。loader 先检查 `response.ok`，失败时才读取小型 JSON error。

### 6.3 缓存：只用浏览器 HTTP cache

不实现 IndexedDB、Cache Storage 或自建正文 LRU。带 revision 的固定 chunk URL 在该版本内不变，可安全使用 `immutable`：

- 文件没变 → URL 不变 → 浏览器直接命中，正文**零网络字节**；
- 文件变了 → revision/URL 变化 → 新版本单独读取，旧版本由浏览器按自身容量淘汰；
- 跨 tab、刷新以及 documentKey、origin、有效 token header 都稳定时的服务重启可复用。

`POST /api/documents/open` **不能假设浏览器会像 GET 那样自动缓存并发送 If-None-Match**。因此每次点击都执行一次很小的 POST + stat + 元数据响应；这是重新授权和取得当前 revision 的必要成本，不实现一套客户端元数据缓存只为省约 300 B。已有 `sendRevalidatable` 仍供 GET JSON 接口使用，不直接套在这个 POST 上。

chunk 响应使用 `Vary: x-codex-promptor-token, accept-encoding`，与现有认证及压缩方式一致。客户端只保留当前至多两个 retained TabView 的已解码片段；视图被关闭/淘汰即释放，持久复用完全交给 HTTP cache。

### 6.4 分块与加载策略

- 首块 8192 字节，后续固定 16384 字节；
- 同一文档同时只允许一个 chunk 请求在途；
- 用户点“加载更多”或滚动到距底部约 200 px 才取下一块；
- 累计加载达到 512 KiB 后关闭滚动自动取块，只保留显式“加载更多”，防止手机惯性滚动意外拉完整个 4 MiB 文件；
- 不在打开时预取第二块，不并行，不允许跳号或重复 index；
- 服务端校验 `docId`/revision 均为固定长度 base64url、index 为安全整数且不超过按 size 算出的最后块；
- href 最大 8192 字节、memo 256 项、远程文件 4 MiB，避免通过绕过 UI 构造无界请求。

高延迟环境若以后确需 32 KiB 块，应升级协议常量/版本并保持同一 URL 对应同一边界；不能让客户端任意选择 length，否则缓存会碎片化。

### 6.5 UTF-8 跨块

按字节切分必然会切断多字节字符。每次打开创建一个 `TextDecoder("utf-8", { fatal: true })`，严格按 index 顺序流式解码：

~~~text
decoder.decode(chunkBytes, { stream: !isLastChunk })
~~~

decoder 生命周期只属于当前 `documentEpoch`；关闭/换文档后丢弃，不能把旧文档残留字节带进新文档。仅仅切到另一个 tab 时可以 abort 在途 fetch，但 retained TabView 必须保留 decoder——上一成功块末尾可能还有未完成 UTF-8 字节。最后一块以 `stream: false` 收尾。解码失败返回/显示 `DOCUMENT_ENCODING_UNSUPPORTED`，不以替换字符悄悄损坏内容。

BOM：open 只读取最多 4 个字节识别编码；UTF-8 BOM 在首块解码时正常去除。UTF-16/UTF-32 第一版拒绝远程预览，支持它们会增加分支和测试却不改善低带宽目标。

### 6.6 文件在查看期间被修改

`open` 每次 fresh stat 并返回当前 revision。实际读取一个 chunk 时：打开文件 handle → `fstat` 比 revision → 定位读取固定范围 → 再 `fstat`；任一不符就丢弃该块并返回 `DOCUMENT_CHANGED`。这避免一次读取中混入被替换文件的字节。

- 已由浏览器缓存命中的旧 revision 块可继续组成一致的旧视图；
- 某个未缓存块到达服务端时若文件已变，停止追加并提示重新打开；
- 重新 open 得到新 revision，创建全新的 URL/decoder/块列表；
- 不轮询 mtime，不做实时 tail，不在后台主动刷新。

### 6.7 请求取消与迟到响应

每个 viewer 只保留一个 `AbortController`、递增 `documentEpoch` 和 `fetchAttempt`：打开新文档/关闭/TabView 被淘汰时 abort 并递增 documentEpoch；普通切走只 abort 当前 fetch、保留 epoch/decoder/nextChunkIndex，返回后重试同一块。任何响应落地前同时检查 signal、documentEpoch 与 attempt。这样极慢链路下关闭立即生效，旧首块也不会在新文档中“复活”，同时不会丢掉跨块 UTF-8 尾字节。

滚动事件用一次 requestAnimationFrame 合并，并先检查 `nearBottom && !inFlight && !complete`；不要用 debounce timer 周期探测。中间块失败只重试同一 index，失败期间不推进 decoder。

### 6.8 不做服务端正文缓存

不加 4–16 MiB 服务端正文 LRU。重复读取由浏览器 cache 在到达服务端前消化，剩余读由操作系统页缓存承担。服务端只有 256 项路径 memo 和最多 4 字节 BOM 探测，不保留文件 body。

### 6.9 远程格式与大小

远程预览只支持 `.txt`、`.text`、`.md`、`.markdown`，且 BOM/严格解码必须确认是 UTF-8。其他格式不创建读取通道，返回 `DOCUMENT_REMOTE_FORMAT_UNSUPPORTED`。

远程上限 4 MiB，超过直接拒绝。低带宽优先时不提供“确认后继续传完整大文件”。4 MiB 只是防护上限，不是自动读取量；正常用户只取首块和实际滚到的部分。

## 7. 终端显示暂停

### 7.1 复用 subscribe，不新增协议

不新增 `terminal.display.pause/paused/resume/resumed`。`src/server/app.ts` 的 `subscribe` 处理**整体替换** `client.terminalSubscriptions`，而当前每个 `TerminalPanel` 使用独立 WebSocket、只订阅一个 tab：

~~~ts
client.terminalSubscriptions = parseTerminalSubscriptions(message.terminals);
~~~

于是：

| 动作 | 客户端发送 |
| --- | --- |
| 暂停 | `{ type: "subscribe", tabIds: [tabId], terminals: {}, snapshots: false, details: true }` |
| 恢复 | `{ type: "subscribe", tabIds: [tabId], terminals: { [tabId]: stream }, snapshots: false, details: true }` |

`terminals: {}` 之后：`projectionScheduler.unsubscribeClient` 被调用，`sendRawTerminal` 因找不到该 tab 的订阅而返回 false。服务端不再产生该连接的新 terminal output/screen。若以后把多个终端合并到一个 socket，必须发送“完整原订阅 map 减去当前 tab”，不能继续用空对象误退订其他 tab。

`snapshots: false` 保证暂停和恢复都不会顺带重发 TabBundle。

`tabIds` 必须保留——state 订阅不受影响，队列、答案和 `terminal.state` 照常更新（§1.2）。全局导航 socket 与此 per-tab socket 是两条既有连接，不做任何修改。

### 7.2 恢复时只要当前屏幕

- **projection 模式**：重新订阅时 `projectionScheduler.subscribe` 建立新 stream 并发一帧完整屏幕，恢复代价固定为一屏，与暂停时长无关。
- **raw 模式**：始终用 §7.3 的一次性 screen bootstrap 重建当前屏幕，再从 snapshot 的 raw offset 接续。不要先猜缺口大小，也不能把“最后 64 KiB raw 字节 + term.reset()”冒充当前屏幕；任意 tail 可能从半个 ANSI 序列或相对光标操作开始。

远程 auto 默认是 projection，因此绝大多数场景不走 raw bootstrap。这里保留 raw 的正确退路，是为了用户手动选 raw 时仍满足“只恢复当前屏幕，不重放长历史”。

### 7.3 raw 恢复只增加一次性 screen bootstrap

现有服务端已经维护 `TerminalScreenModel`，无需再建屏幕解析器。只补齐一个低频、一次性的桥接能力：

1. `TerminalScreenModel.write` 同时记录本批输出的 `rawNextOffset`，完整 snapshot 携带该 offset；
2. 文档关闭且原模式为 raw 时，客户端在**仍未订阅 terminal stream**时请求一次 `terminal.screen.snapshot.request { oneShot: true }`；
3. 服务端只允许已订阅该 tab state 的连接请求，返回一帧完整 screen + `rawNextOffset`，不注册持续 projection scheduler；
4. 客户端用已有 `projectionScreenToAnsi` 重建 xterm，然后订阅 raw `{ generation, nextOffset: rawNextOffset, maxCatchUpBytes: 65536 }`；快照响应与新订阅之间产生的少量输出按正常 raw 增量补齐。

`maxCatchUpBytes` 仍在 `parseTerminalSubscriptions` 限幅，并只约束“one-shot 响应到 raw 订阅建立之间”的竞态增量。若这段罕见缺口仍超过 64 KiB，客户端丢弃 tail、最多重取一次 one-shot；再次失败就保留旧屏并提示切换 projection，不下载 1 MiB 历史兜底。

这一补丁只在**关闭文档 + 强制 raw + 长缺口**时发生；projection 路径没有额外消息，文档打开期间也没有新 stream。

### 7.4 输入处理

DocumentView 打开时：

- 键盘输入不得再发往 PowerShell（终端已退订，但客户端也必须显式停止发送 `terminal.input`，否则会写进一个用户看不见的窗口）；
- `terminal.resize` 与 xterm focus 同样停止；
- Escape、PageUp/PageDown、Home/End 由文档视图处理；
- 关闭按钮和 Escape 触发恢复；
- 收到恢复后的首帧再把焦点交还 xterm；
- "加载更多"和滚动键不转换成 `terminal.input`。

### 7.5 需要处理的竞态

用 subscribe 之后没有文档 session 过期竞态，仍必须覆盖以下边界：

- **退订成功但首块请求失败**：文档视图显示错误，仍可关闭并恢复；
- **退订前已经入 socket 队列的 terminal 帧迟到**：viewer epoch 生效后不写 xterm；可以更新内存 cursor/cache，但不得触发可见刷新。验收允许至多一个已在途帧，之后必须为零；
- **WebSocket 在暂停期间断开**：重连时客户端按自己的状态决定重新订阅什么。若文档仍打开，就带 `terminals: {}` 重连；若已关闭，按正常路径带游标重连。这条**必须显式实现**——重连逻辑默认会重新订阅终端；
- **切换 tab**：当前实现 inactive `TerminalPanel` 会关闭自己的 socket，所以切走时只 abort 在途 chunk，**不要先恢复终端再立刻断开**。返回时若文档仍打开，连接 state-only；若文档已关闭，才按常规订阅 terminal；
- **关闭/删除 tab**：abort、释放文档内存并走既有 tab 清理，不把内容或迟到响应显示到另一个 tab；
- **快速“打开 A → 关闭 → 打开 B”**：只有最新 documentEpoch/fetchAttempt 可提交状态或改变订阅。

## 8. 路径安全

### 8.1 规范化流程

~~~text
raw href
  → 限长并按 URI 语法拆出 scheme/path/fragment（本地 query 拒绝）
  → percent-decode 一次；拒绝 NUL、非法转义与二次编码逃逸
  → 判断 file URI / Windows path / relative path
  → 从 tab/answer/parentDocId 取得服务端 base
  → path.resolve + normalize
  → realpath（解开符号链接）
  → 检查是否位于允许 root
  → 检查是普通文件
  → open FileHandle + fstat
  → 检查扩展名、BOM 与大小
  → 返回 canonicalPath + file identity/revision
~~~

**root containment 必须用路径分段比较，不能用字符串 `startsWith`** ——否则 `D:\work\docs2` 会被误判为 `D:\work\docs` 的子目录。比较前统一分隔符并按 Windows 规则忽略大小写。

必须拒绝：`..` 逃逸、设备路径、UNC（除非显式配置该 UNC root）、NTFS 备用数据流（盘符后的第二个冒号）、最终指向 root 外的符号链接/reparse point、目录、不存在的文件、非法/双重编码、`javascript:`/`data:`/`vbscript:`、把 URL query 当路径。`file://host/path` 不能悄悄降级成本地路径。

realpath 与 open 之间存在 TOCTOU，因此 chunk 读取使用已经打开的 handle，并在读取前后 `fstat` 校验 revision；不要校验路径后再用另一次按路径的 `readFile`。远程错误只返回 displayName，canonicalPath 仅进入本机日志且不得附正文。

### 8.2 认证

所有文档接口走现有 API 认证。`open-local` 额外使用 §4.1 的 loopback Origin/Host 检查；合法 token 或 trusted host 本身都不足以触发桌面应用。chunk 请求逐次重新校验 root（§6.1），`docId` 不可猜测也不构成授权。

### 8.3 最小权限

远程只读取用户点击的 TXT/MD，不提供目录列表、文件搜索、整包下载或任意磁盘读取。文档 key、canonicalPath、root 清单不进 bootstrap/URL/遥测；日志只记错误类别、docId 前缀和本机路径，不能记 token 或正文。

## 9. 前端结构

~~~text
src/shared/
├── document-link.ts          # href 分类与 loopback hostname（两侧共用）
└── document-protocol.ts      # 固定块常量、元数据类型、请求上限

src/client/
├── document-viewer.tsx       # TXT/MD 视图与工具栏
├── document-loader.ts        # open + 顺序取块 + 流式解码
├── markdown-blocks.ts        # §5.4 的顶层块状态机（纯函数）
└── safe-markdown.tsx         # AnswerHistory 与 viewer 共用的安全渲染
~~~

不创建 `document-cache.ts`（浏览器 HTTP cache 已承担）或 `terminal-display-mode.ts`（状态留在现有 TerminalPanel，订阅用 subscribe 切换）。服务端建议集中到一个 `src/server/documents.ts`，由 `app.ts` 只注册路由，避免继续膨胀单文件。

状态（按 tab 保存）：

~~~text
DocumentViewerState {
  status: "closed" | "opening" | "open" | "loading" | "error",
  documentEpoch: number,
  docId, name, kind, revision,
  textSegments: string[],        // TXT
  markdownBlocks: string[],      // MD 已提交块
  pendingMarkdown: string,
  loadedBytes: number, totalBytes: number,
  nextChunkIndex: number,
  complete: boolean,
  error: string | null
}
~~~

`AbortController`、`fetchAttempt`、`TextDecoder`、block assembler 和 in-flight promise 放 ref/loader 对象，不进 React state，避免每个字节块引起无关渲染。

规则：tab 切换不复制文档状态；inactive 时 abort 当前请求但可保留已完成块；现有 `MAX_RETAINED_TAB_VIEWS = 2` 构成内存硬上界；close/淘汰时释放正文；opening 期间禁止重复打开；loading 期间允许关闭；正文、绝对路径和滚动位置不写入 URL/localStorage。

用户点关闭时**立即关闭视图并发出恢复**，不等待在途 chunk 完成——极慢链路下等待会让关闭按钮看起来失灵。

## 10. 低带宽账单

### 10.1 远程点击一次的最小通信

| 步骤 | 传输 | 首次打开 | 再次打开（未改动） |
| --- | --- | --- | --- |
| `POST /api/documents/open` | 重新授权 + 元数据 | 约 0.3–1 KiB | 约 0.3–1 KiB（POST 不依赖 304） |
| `subscribe`（退订终端） | 控制消息 | ~120 B | ~120 B |
| 首块 | 最多 8 KiB 原文 | 压缩后通常更少 | **0 正文字节**（浏览器缓存命中时） |
| 后续块 | 每块最多 16 KiB 原文 | 用户读到才取 | **0 正文字节**（已缓存块） |
| `subscribe`（带游标恢复） | 控制消息 | ~180 B | ~180 B |
| 恢复首帧 | 一屏 projection | 一帧 | 一帧 |
| raw one-shot bootstrap | 仅强制 raw | 一屏 | 一屏 |

**再次打开同一未改动文档时，已经读过的正文传输为零；仍有一次小型 open 授权/元数据交换。** 这是稳定 docId + revision URL + `immutable` 的结果。这里区分“正文为零”和“网络绝对为零”，不做无法兑现的 POST 304 承诺。

### 10.2 不会发生

- 重新 GET 完整 AnswerHistory 或 TabBundle（`snapshots: false`，且这两者本来就是窗口化+delta 的）；
- 重新加载全部终端滚动历史（§7.2/§7.3）；
- 定时轮询文件状态或文档进度；
- 把正文经 WebSocket 广播给所有客户端；
- 把文本 Base64 后放进 JSON。

### 10.3 空闲流量

文档视图空闲时不轮询 chunk、不轮询 mtime、不上报滚动位置、不发进度、不收 terminal output/screen。既有低频 `terminal.state`/队列/答案事件仍可到达；本功能不新增应用层心跳。

### 10.4 优先级

1. 少传数据；
2. 不重复传输；
3. 不影响 PowerShell 和队列；
4. 用户需要更多内容时再加载；
5. **最后**才是首屏速度。

普通 README/TXT/短 MD 通常一个首块就够；长文档由用户继续操作再取。

## 11. 错误码

| 错误码 | 含义 | 用户动作 |
| --- | --- | --- |
| `DOCUMENT_LINK_INVALID` | href 无法识别 | 检查链接 |
| `DOCUMENT_NOT_FOUND` | 文件不存在 | 确认路径 |
| `DOCUMENT_ACCESS_DENIED` | 不在允许目录 | 本机打开或调整 root |
| `DOCUMENT_IS_DIRECTORY` | 目标是目录 | 选择文件 |
| `DOCUMENT_REMOTE_FORMAT_UNSUPPORTED` | 远程不支持该格式 | 本机默认应用打开 |
| `DOCUMENT_ENCODING_UNSUPPORTED` | 不是严格 UTF-8 或 BOM 不支持 | 本机默认应用打开 |
| `DOCUMENT_TOO_LARGE` | 超出远程预览上限 | 本机打开 |
| `DOCUMENT_CHANGED` | 查看期间文件被修改 | 重新打开 |
| `DOCUMENT_ID_UNKNOWN` | docId 已被 LRU 淘汰或服务重启 | 客户端自动重新 open |
| `DOCUMENT_CHUNK_OUT_OF_RANGE` | 块编号非法/超界 | 不重试并记录客户端错误 |
| `DOCUMENT_CHUNK_FAILED` | 某块读取失败 | 重试该块 |
| `DOCUMENT_LOCAL_ONLY` | 远程请求了 open-local | 改用远程预览 |
| `DOCUMENT_CONFIRMATION_REQUIRED` | 本地目标可能执行代码 | 显示文件名/类型并再次确认 |

错误消息不得包含 token、密码、完整服务器绝对路径、原始堆栈或文件正文。

## 12. 测试计划

### 12.1 链接分类 `src/shared/document-link.test.ts`

file URI；Windows 盘符正/反斜杠并转成安全 file URI；`/D:/` 内部路径；`./` 与 `../`；URL 编码空格；路径 fragment 分离；http/https；`javascript:`/`data:`/`vbscript:` 分类为 blocked；`/api` 不被误判；未知协议仍经 defaultUrlTransform；file 只允许 anchor、不允许 image。

### 12.2 路径策略（服务端）

root 内允许；root 外拒绝；**同名前缀兄弟目录（`docs` vs `docs2`）不误放行**；`..`、双重编码、NUL、ADS 穿越拒绝；realpath 后越权的符号链接/reparse point 拒绝；目录拒绝；不存在拒绝；客户端伪造 `baseDirectory` 不生效；answerId/parentDocId 只能在所属 tab 内取基准；server-only documentBasePath 在 snapshot/delta/分页回答中均被剥离；TXT/MD UTF-8 允许、PDF/图片/UTF-16 远程拒绝；文件名含空格/中文/括号；UNC 与设备路径按配置处理；读取前后 fstat 变化丢弃整块。

### 12.3 本地打开

`open-local` 不返回正文；使用参数数组而非 shell 字符串；loopback Host + loopback Origin 允许；远程 Origin 即使代理 Host 是 127.0.0.1 仍拒绝；合法 token 不能绕过；可执行/脚本第一次只返回 HMAC confirmationToken，token 过期/错路径/错 revision 拒绝；普通文档单请求；文件被删除后错误可解释。

### 12.4 分块与解码 `document-loader.test.ts`

index→offset 固定映射；首块/后续块上限；负数、巨大、越界 index 拒绝；不并发、不跳号；重复点击不重复请求；512 KiB 后滚动不再自动加载但手动按钮可用；**UTF-8 多字节跨块用严格流式 TextDecoder 不乱码**；切 tab abort 后保留 decoder 尾字节并重试同块；非法 UTF-8 明确失败；最后一块 flush 并 complete；中间块失败只重试同 index；关闭/换文档后迟到响应因 epoch/attempt 被忽略；revision 不符返回 `DOCUMENT_CHANGED`；`DOCUMENT_ID_UNKNOWN` 最多自动重开一次。

### 12.5 缓存（HTTP 层，非 IndexedDB）

open POST 带 `no-store` 且每次 fresh stat；**全部失败响应 no-store**；成功 chunk 带 `private`、`immutable`、长 `max-age`；revision 变化时 URL 变化；同一 index URL 唯一；`Vary` 含访问令牌与 accept-encoding；br/gzip 下不写错误的手工 Content-Length；缓存命中不调用 route（浏览器集成/手工验证），未命中 route 逐次授权。

### 12.6 终端暂停 `terminal-display-pause.test.ts`

空 `terminals` 订阅后不再收到新的 `terminal.output`/`terminal.screen`（允许退订边界前已排队一帧）；**`terminal.state` 仍收到**；PTY、QueueRunner、Timer、另一客户端不受影响；文档打开时 input/resize 不发送；projection 恢复只收一帧完整屏；raw 恢复收一次 one-shot screen（含 rawNextOffset）再接有界小增量，不收 1 MiB；maxCatchUp 限幅；one-shot 失败不下载历史；断线重连/重新激活时文档仍打开则 state-only；切走不做“先恢复再断开”。

### 12.7 Markdown 块切分 `markdown-blocks.test.ts`

只在顶层安全空行切分；fence marker 字符/长度正确；不在 fenced code、松散列表、引用、表格中间切；尾巴不完整时纯文本占位；未闭合 fence 超过 64 KiB 不无限隐藏；收尾并入最后块；重复调用边界稳定；reference definition/footnote 跨块按“不支持”规则稳定降级。

### 12.8 UI

链接可点击并显示加载状态；手动 raw 不会被误判本地；本地模式不出现远程视图；远程模式进入当前 tab 的 Terminal 面板；TXT 保留换行；MD 支持标题/列表/引用/代码块/表格；heading slug 稳定，未加载 fragment 不自动下载后续块；危险 HTML/URL/图片不执行或加载；Escape/关闭在慢请求中立即生效；文档打开时终端不刷新；关闭后终端恢复；快速 A→关闭→B 不串响应；tab 切换不串文档且 retained 上限仍为 2；外部 HTTPS 行为不变。

### 12.9 低带宽指标

分别记录 open 请求/响应、未压缩正文、实际 wire body（br/gzip）、首块与用户继续阅读的块；**再次打开同一未改动文档的已读正文字节应为 0，但 open 元数据仍存在**；退订确认后 terminal output/screen 为 0；关闭时 projection 一屏或 raw one-shot+小增量均有硬上限；AnswerHistory/TabBundle 完整重载为 0。不得把文件名、路径或正文放入遥测。

## 13. 分阶段实施

**Phase 1 — 链接识别与本地打开。** `document-link.ts` + `SafeMarkdown` + 自定义 anchor + 服务端基准/路径策略 + loopback 检查 + `open-local` 确认。先补链接安全测试，不涉及正文传输。

**Phase 2 — 远程元数据与首块。** gitignored 持久 documentKey + docId/revision + 固定 index chunk + `no-store`/`immutable` 头 + 严格 TextDecoder + AbortController/epoch + 最小 DocumentView。此阶段结束即可用。

**Phase 3 — 终端暂停。** 客户端 subscribe 切换 + input/resize 屏蔽 + 重连/切 tab 处理；projection 先完成，再加 raw one-shot screen + `maxCatchUpBytes`。两种模式独立测流量上限。

**Phase 4 — 阅读体验。** 加载更多 + rAF 滚动触发 + `MarkdownBlockAssembler` + `content-visibility` + 文件变化处理 + parentDocId 内部链接。

**Phase 5 — 收尾。** 移动端布局、i18n、错误提示、Cloudflare 远程实测、全量测试与构建。

每个 Phase 单独提交并通过 typecheck、相关单测和 build；不要把未完成的 raw bootstrap 与可用的 projection 路径绑在一个大提交。IndexedDB/正文服务端缓存不属于任何 Phase。

## 14. 验收标准

**本地**：TXT/MD/PDF/图片链接可点击并由默认应用打开；不读取或传输正文；active 文件需二次确认；远程/代理请求不能触发；路径越权被拒；不拼 shell 字符串；不影响 PowerShell、队列和 Timer。

**远程**：UTF-8 TXT 可在当前 Terminal 面板内查看；MD 有安全的增量渲染；打开后当前客户端不再收到新终端刷新帧；PowerShell、队列、Timer 继续；关闭后 projection 一屏、raw 一屏加有界小增量；不回放长历史；不支持格式/BOM/大文件不创建正文通道；关闭慢请求立即生效且迟到响应无效。

**传输**：不因打开文档重载 AnswerHistory/TabBundle；不创建第二条持续 terminal stream；不轮询；固定 chunk 不用 JSON/Base64；空闲无正文和 terminal screen/output；**再次打开未改动文档的已读正文字节为 0（保留一次小 open 元数据）**；低速链路下可关闭、重试和恢复；每条路径都有明确字节上限。

## 15. 明确不做

- 浏览器端跑 scheduler；
- 把文档正文写入 PTY，或把 Markdown 转 ANSI 发到终端；
- 远程预览 PDF、Office、图片、压缩包；
- 自动下载整个文件；
- 允许客户端自选 offset/length 或并行预取；
- 实时 tail 日志；
- 全文搜索索引；
- 文档编辑与保存；
- 文档历史栈；
- 从普通正文猜测文件路径；
- 把服务端绝对路径写进 URL；
- 接受客户端提交的 baseDirectory 作为授权基准；
- 为生成“强内容 hash”而在首屏前读取整个文件；
- 假设 POST `/open` 会被浏览器自动 304；
- 暂停期间无限缓存 raw PTY 输出；
- 为文档功能另建一套高频 WebSocket 推送；
- **自己实现内容缓存层**（浏览器已有，见 §6.3）；
- **自己实现暂停/恢复协议**（subscribe 已有，见 §7.1）；
- **自己实现文档会话生命周期**（稳定路径 id + revision 已消除它，见 §6.1）。

最终行为：本机点击只做路径校验并调用默认应用，普通文档无正文传输；远程点击只在当前 Terminal 区域显示 UTF-8 TXT/MD，固定块按需取、浏览器缓存复用，空闲零轮询；关闭时 projection 恢复一屏，强制 raw 也只是一屏加有界增量。新增面保持为一个服务端 documents 模块、四个小型前端/shared 模块、3 个 HTTP 接口和一个低频 one-shot screen 分支，不引入数据库、文档 session、第二条持续 terminal stream 或正文缓存服务。

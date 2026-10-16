# Promptor 多设备统一入口与对话聚合：完整实现方案

> 日期：2026-10-16。状态：待实现设计，不代表当前程序已有这些能力。
>
> 目标：多台电脑分别运行 Promptor，通过同一个公网域名使用；打开任一电脑的本地页面，也能查看和操作其他已加入设备的对话。控制栏按设备分区，本端置顶，只有一端时保持现有界面。
>
> 第一版面向同一使用者的少量受信设备，建议上限 10 台。不引入云端对话数据库、消息队列、P2P、自动迁移、分布式队列或计费系统。

## 1. 确定方案与适用边界

采用 **一个固定入口 Hub + 各设备主动建立的出站连接 + 前端按设备聚合**。

- 选一台常在线电脑作为 Hub；在它现有的 Promptor 进程中启用 Hub 模块，不另装一个业务服务。
- 同一个公网子域名，例如 `promptor.example.com`，只指向这个 Hub。
- 其他设备的 Promptor 主动连接 `wss://promptor.example.com/federation/link`，无需各自配置入站端口或 Cloudflare Tunnel。
- Hub 维护设备目录，并把请求准确送到所属设备。对话、文件、PTY、agent CLI、队列和定时器仍由所属设备独立管理。
- 浏览器聚合各设备的导航列表；进入一个对话时，复用现有对话页和业务接口。
- 从本地页面访问本机对话走原本的本地路径；访问其他设备才经过 Hub。

这里的“多端同步”是**远程访问同一份设备数据**：在 A 上修改 B 的队列，写入 B，并通知正在查看 B 的所有页面。不是把 B 的目录复制到 A，也不是让同一个 agent 会话在两台机器同时执行。

此方案的明确代价是 Hub 是统一入口的单点：Hub 离线时跨设备访问暂时不可用，各设备的本地页面、PTY、队列和定时器继续工作。要消除这一单点，需要另一个常在线部署位置和共享路由状态，不属于第一版。优先把 Hub 放在现有常在线主机；未来可沿用协议迁到专用网关。

本文件补充小规模自托管方案，不覆盖或撤销 [大规模远程访问 V2](./SCALABLE_REMOTE_ACCESS_ARCHITECTURE_V2.md) 和 [云端网关路线图](./REMOTE_GATEWAY_ROADMAP.md) 的 SaaS 规划。

## 2. 为什么不能把多个独立 Promptor 直接接入同一个 Tunnel

Cloudflare 的同一 Tunnel 多 connector 是副本/容灾机制，不是设备发现或应用层会话路由。官方明确说明副本不提供按哈希等方式的请求定向，故障切换时也不能保证选择哪个副本。[官方副本说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/)

如果 A、B 使用同一 Tunnel token，且都将域名转发到各自的 `127.0.0.1:4317`，就可能发生：

1. 浏览器从 A 读到标签列表。
2. 下一次 HTTP 请求或 WebSocket 重连落到 B。
3. B 找不到该标签，或者操作了独立数据集中的同名/同 ID 条目。

因此部署规则固定为：**一个域名 → 一个 Hub → 按 `deviceId` 找到设备连接**。即使日后运行多个 cloudflared 副本，它们也必须能到达同一个 Hub，不能分别指向独立 Promptor。共享域名和加入工作区是两件事；必须先登记设备身份。

## 3. 拓扑、角色和请求路径

```text
互联网浏览器 ─ HTTPS/WSS ─ Cloudflare Access + Tunnel ─ Hub A
                                                       │
                       A 的本机执行端 ─── 进程内适配器 ──┤
                                                       │
                          B Promptor ─ 出站 WSS ───────┤
                          C Promptor ─ 出站 WSS ───────┘

B 本地浏览器 ─ loopback ─ B Promptor
                         ├─ 操作 B：本地处理
                         └─ 操作 A/C：已有出站连接 → Hub → 目标设备
```

角色仅三种：

| 模式 | 行为 |
| --- | --- |
| `off`（默认） | 当前单机行为；不建联、不增加后台传输 |
| `hub` | 当前实例也是一个执行设备，另维护工作区目录与路由 |
| `member` | 保留完整本机功能，增加到一个 Hub 的出站连接 |

第一版一个实例只加入一个工作区，不做网状发现或多 Hub 级联。Hub 转发时直接定位目标连接；目标收到的业务请求只能在本机执行，禁止再次转发，以免产生环路。

“设备”准确地指一个 Promptor 数据目录对应的实例。浏览器、手机只是访问端，不因打开网页就自动成为执行设备；不承诺把 Windows PTY/CLI 原样运行到手机上。跨操作系统支持仍由现有 provider/终端适配能力决定，本方案只要求协议与资源隔离不依赖操作系统。

## 4. 本端判定与控制栏交互

### 4.1 哪一个算本端

- 用户通过某实例的真实回环页面打开时，服务端提供 `localDeviceId`。该设备固定置顶。
- 用户通过公网域名打开时，`localDeviceId = null`。不能把 Hub、上次访问的设备，或从 URL 读到的 ID 冒充成本端。
- 即使浏览器恰好运行在设备 B 上，从公网域名打开也无法可靠判定它就是 B；第一版不尝试探测浏览器的 localhost。公网页面记忆最近选中设备，并允许设一个“置顶设备”，但不显示“本端”。
- 对浏览器本端的判断不由 `?device=...`、设备名或浏览器声称的 header 决定。

### 4.2 分区与排序

```text
▾ 工作电脑 · 本端                 ● 在线
    ▾ 项目 A
        :: 对话 1
        :: 对话 2
    ▾ 未分组
        :: 对话 3

▾ 家用电脑                       ● 在线
    ▾ 项目 B
        :: 对话 4

▸ 笔记本                         ○ 离线
```

设备分区不是现有的对话分组，不写入 `index.groups`。分区下继续使用原来的分组、未分组、重命名、删除、拖动与 agent 颜色规则。

排序规则：本端优先；其次浏览器置顶设备；其余按该浏览器保存的设备顺序，新设备追加在末尾。离线时保留位置，不因心跳来回跳动。

设备分区是否显示，按工作区内**已登记且未撤销的设备数**判定，而非当前在线数：

- 只有一个设备：不显示设备分区头或额外嵌套，界面与现有单机一致。
- 多个设备：显示设备分区，包括离线设备。远端掉线不应使整栏突然取消分区。
- Hub 断联时，用本地保留的设备目录维持布局，并明确显示目录离线；不把旧在线状态当作当前事实。

### 4.3 操作归属

- 选中 B 的对话后，新建对话默认建在 B，继续放在当前对话同组、下一项；名称输入处注明目标设备。
- 未选中对话时，本地页面默认选本端；公网页面选上次设备，首次则选 Hub 设备。目标离线时禁用创建，不偷偷改到别的设备。
- 创建分组、重命名、删除、组内折叠、条目排序，都只修改目标设备自己的索引。
- 禁止把标签或组跨设备拖动；这不是移动文件夹就能完成的操作。显示“暂不支持跨设备移动对话”，原条目留在原位。
- 设备分区折叠和排序只保存在浏览器；设备内部的组折叠继续按现有规则在所属设备保存。
- 设备名由 Hub 统一保存，重命名不改变 `deviceId`；设备撤销仅断开访问关系，不删除任何设备的对话文件。
- 完成提示声和 30 秒完成图标按复合对话身份去重；重连快照不重新播放过去的提示声。

### 4.4 离线、未解锁、版本不兼容

设备连接状态与对话运行状态分开表达：

- 设备离线：保留本页面已经加载的标签列表，显示“离线，最后更新于 …”，禁用写操作与终端输入。
- 从未加载过该设备：只显示设备名称与状态，不伪造历史标签。
- 加密未解锁：只锁该设备分区，其他设备正常使用。
- 版本不兼容：保留设备头，显示升级提示，不显示成“正在加载”。
- 恢复连接后先校准订阅与当前对话状态，再恢复写操作。

设备离线不能把已运行的 prompt 标成“已中断”，也不能继续把过时的呼吸灯表示为“目前正在运行”；显示离线/状态未知，重连后由所属设备给出事实。

## 5. 身份、持久化与数据归属

### 5.1 标识符

```ts
type DeviceRef = { workspaceId: string; deviceId: string };
type TabRef = DeviceRef & { tabId: string };
type GroupRef = DeviceRef & { groupId: string };
```

- `deviceId`：本机首次启用时生成 UUID 并持久保存；不要用主机名、IP、域名或端口。
- `workspaceId`：Hub 首次启用时生成 UUID；域名改变不改变工作区身份。
- `bootId`：每个 Promptor 进程启动生成，不落盘，用于区分进程重启。
- `connectionId`：Hub 每次接受设备连接时生成，仅绑定该连接；旧连接的消息不能复用。
- 业务层原有 `tabId/groupId/promptId` 不改。浏览器跨设备引用必须带上工作区和设备 ID，即使 UUID 理论上很少碰撞也不能省略。

复制完整数据目录到另一台机器时，必须提供“作为新设备加入”，重新生成 `deviceId` 并重新登记；原有 tabId 可保留，因为有设备命名空间。同一数据目录不能被两个进程同时写。相同身份的两个不同 `bootId` 同时在线时拒绝后来者，提示身份冲突，不让它们互相顶掉。

### 5.2 新增文件，保持原业务文件不变

```text
data/
  index.json                         # 仍只含本机的分组、对话
  tabs/<tabId>/...                    # 原文件结构保持不变
  common-prompts.json                 # 仍属于本机
  private/
    device-identity.json             # deviceId、schemaVersion
    federation.json                  # 模式、Hub 地址、工作区、设备凭证、Access 凭证
    federation-devices.json          # 仅 Hub：设备目录、凭证摘要、目录 revision
    federation-command-receipts.json # 所属设备：最近写操作回执，见第 10 节
  cache/
    federation-directory.json        # 仅目录缓存，无对话正文和凭证
```

继续使用现有 `StorageService` 的锁、schema 校验及原子写习惯，不为第一版新增数据库。新增私密文件应进入 `.gitignore`，限制操作系统读取权限，诊断导出中不包含凭证。Hub 持久保存的凭证只需高熵随机 token 的摘要，不保存其他设备的 E2EE 密钥。

Hub 不建立另一份 `tabs/`，不落盘缓存其他设备的 prompt、回答、终端输出或文档。设备目录包含名称、登记顺序、启用状态；在线状态是内存事实，Hub 重启后一律从 offline/connecting 开始，收到认证连接才在线。

目录缓存保存 `workspaceId` 与目录 revision，只用于 Hub 不可用时维持 UI；不是授权依据。切换工作区时清除旧目录视图，不把两个目录合并。

### 5.3 配置示例

下列是配置形状；凭证实际只通过本机设置页录入，不能放进 URL、版本库或页面响应。

```json
{
  "schemaVersion": 1,
  "mode": "member",
  "workspaceId": "<workspace UUID>",
  "hubUrl": "https://promptor.example.com",
  "deviceToken": "<per-device random secret>",
  "accessClientId": "<Cloudflare Access service token id>",
  "accessClientSecret": "<Cloudflare Access service token secret>"
}
```

Hub 配置包含 `mode: hub`、`workspaceId`、`publicOrigin` 以及 Access 的团队 issuer、浏览器应用 AUD、连接器应用 AUD。协议、心跳、限额使用代码默认常量，第一版不做大量设置项。

## 6. 加入、鉴权与撤销

### 6.1 最简加入流程

1. 在 A 的本机设置中开启 Hub，生成 `workspaceId`，自动把 A 登记为本机执行设备。
2. 在 B 的本机设置中生成并显示 `deviceId`，填写设备名。
3. 在 A 的本机“添加设备”中录入 B 的 ID，生成 32 字节随机设备 token；Hub 保存摘要，只向管理员展示一次原文。
4. 在 B 的本机设置填写 Hub 地址、工作区 ID、设备 token 和 Access 服务凭证，保存后主动建联。
5. Hub 校验身份成功，分配 `connectionId`，推送目录变化；B 的本地浏览器和公网浏览器都出现新增分区。

第一版不用自动发现、临时邀请码、扫码、在线账户注册。设备登记、凭证变更、撤销仅由 Hub 本机管理；其他设备只能修改自己的接入配置。

### 6.2 两类访问不能混用登录方式

| 访问 | Cloudflare 层 | Promptor 层 |
| --- | --- | --- |
| 公网浏览器页面、HTTP、业务 WS | Access 用户登录 | 校验 Access JWT、允许的用户、同源/CSRF；随后检查设备路由与 E2EE |
| 设备后台 `/federation/link` | 单独的路径级 Access 应用，Service Auth 策略 | 每设备 token 校验，绑定工作区与设备身份 |
| 本机浏览器 | 不走 Cloudflare | 原本的回环/同源验证；管理接口额外拒绝代理来源 |

后台设备不能完成邮箱验证码登录。连接器用服务凭证的 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 请求头，Promptor 设备 token 用 `Authorization: Bearer ...`，均只存在于后端。建议每设备独立服务凭证，便于单独撤销。[Access 服务凭证](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

Hub 校验 `Cf-Access-Jwt-Assertion` 的签名、issuer、有效期和对应路由的 AUD，并缓存官方 JWKS；不能仅相信某个 header 存在或 `Host` 在白名单中。可使用成熟 JWT 库完成，不自行实现签名验证。用户身份与 Service Auth 身份不能相互替代。[Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

原有 `CODEX_PROMPTOR_TRUSTED_HOSTS` 只承担原有同源校验，不等于上述新增认证。机器请求携带显式凭证，不伪造浏览器 Origin 来通过本地认证。

### 6.3 信任范围

第一版一个工作区视为同一拥有者的一组受信实例：已登记设备上的合法本机页面可以操作该工作区的其他设备。这意味着加入一台不受信电脑会扩大终端控制权，不应把本方案当作多用户权限隔离产品。

设备凭证只能宣称自己的 `deviceId`，不能伪造别的设备上线；Hub 从已认证连接确定来源 ID，忽略消息中自称的来源。目标 ID 必须在同一工作区已登记且未撤销。

撤销时先持久更新目录，再关闭目标设备连接以及以该设备作为来源或目标的逻辑通道，拒绝新请求。已经送达并开始执行的本机任务不会因撤销自动被杀掉。想终止任务，应在撤销之前明确中断该对话。

## 7. HTTP 与 WebSocket 接入：复用业务，不做任意端口代理

### 7.1 浏览器侧统一传输对象

新增 `DeviceTransport`，页面组件获取一个固定目标的对象，而不是读取可随时变化的全局“当前设备”：

```ts
interface DeviceTransport {
  ref: DeviceRef;
  capabilities: DeviceCapabilities;
  request<T>(logicalPath: string, init?: RequestInit): Promise<T>;
  openSocket(): DeviceSocket;
}
```

组件创建操作时就捕获 `DeviceRef/TabRef`；切换页面后晚到的响应只能更新原目标缓存，不能落到新设备的对话页。AbortController 用于取消读请求；取消网络请求不等于撤销已经提交的写操作。

路由约定：

| 地址 | 用途 |
| --- | --- |
| `GET /api/federation/bootstrap` | 当前页面的 localDeviceId、workspaceId、设备目录、能力；无凭证和对话正文 |
| `WS /federation/events` | 浏览器订阅设备目录/在线状态；只发变化，不发各设备对话正文 |
| `WS /federation/link` | member 到 Hub 的认证出站连接，仅机器身份 |
| `/d/:deviceId/api/...` | 目标设备的 HTTP 接口，logicalPath 仍是 `/api/...` |
| `/d/:deviceId/ws` | 目标设备的业务 WS，保持现有消息语义 |
| `/api/federation/admin/...` | 本机管理入口，永不向 federation 转发 |

在 member 的本地页面，上述 `/d/...` 请求由本机后端通过已有设备连接转给 Hub；浏览器无需跨域 fetch、跨站 cookie，也不直接携带机器凭证访问 Hub。在 Hub 上由 Hub 直接路由。在本端自己的真实回环页面，可将本机目标映射到原 `/api/...` 和 `/ws`，避免多走一圈。

同源静态资源始终由页面入口提供一份，不从每台设备下载前端 bundle。`?device=<id>&tab=<id>` 只定位界面，不构成授权；未知设备不可自动回落为本机同 ID 标签。

关闭 federation 时，bootstrap 仍可返回一个仅含本机的目录，但不建立 federation 事件流或出站连接。加入状态尚未建立、或 Hub 离线时，本地 bootstrap 必须先返回本机与缓存目录，不能等待远端完成后才让整页可用。

### 7.2 所属设备的业务适配器

不要把 relay 实现成“收到一个 URL，就请求任意 localhost 地址”。抽取现有 HTTP handler 的共用服务调用，建立显式的 `(method, route template) → handler` 注册表；原 HTTP 路由和 federation 调用共用它。

允许的资源包括：

- 分组、标签、导航顺序、读取对话与分页历史。
- 会话创建/恢复、关闭/重新打开、同步历史。
- prompt 增删改、排序、立即插入、retry/skip；队列 start/pause/interrupt/config。
- 当前设备的定时器、常用 prompt、设备内 A2A 状态与已有控制动作。
- 现有轻量文档查看 `/api/documents/open` 和指定 `docId/rev/chunk` 的读取。
- 只读诊断，按目标设备统计；无全局诊断清空权限。

永不转发：

- `/hooks/*`、agent 本机回调 `/a2a/*`、federation 管理/接入路由。
- 本机文件夹弹窗、调用桌面应用打开文件、当前仅本机可用的导出对话。
- ChatGPT 本机 profile 刷新/前台窗口操作、E2EE 开关与口令修改等本机管理动作。
- 任意主机、端口、URL、文件路径代理或未登记的新接口。

`/api/preferences` 不整包透传：设备内“未分组折叠”等字段允许，页面主题、语言、分栏尺寸和设备排序由当前浏览器负责，不能因切换到 B 就覆盖 A 的页面设置。新增接口必须显式决定是否 federation 可用，默认拒绝。

输入验证、返回值、错误码沿用当前服务；不要写第二套队列控制器、StorageService 或 provider 会话管理器。

设备 ID、路由参数和查询参数使用 schema 校验；禁止绝对 URL、`..`、反斜杠、编码分隔符及二次解码绕过。路由匹配和 E2EE AAD 使用同一份规范化后的路径/查询串，不能一处按原始文本鉴权、另一处再次解码后执行。

### 7.3 请求上下文是必要改造

当前代码用 socket 地址和 Host 区分 local/tunnel。新增进程内 relay 不能因此被误判为本地。应引入由受信适配器构造、不能由公网 header 声称的上下文：

```ts
type RequestContext = {
  transport: "loopback" | "tunnel" | "federation";
  principal: "local-browser" | "remote-user" | "workspace-device";
  workspaceId?: string;
  targetDeviceId: string;
  canUseNativeUi: boolean;
};
```

跨设备请求始终是 `federation`，`canUseNativeUi=false`；通过公网域名访问 Hub 自己的对话也不能成为 loopback。拒绝通过 `x-local: true`、替换 Host 或带入本地 token 实现绕过。

相同上下文必须用于：鉴权、E2EE、口令字段剥离、目录弹窗、文档打开、导出、终端模式、流量记录。可复用 `classifyNetworkScope` 处理原直连路径，但它不能作为所有新路径的唯一权限判据。

## 8. 出站连接协议

### 8.1 物理连接与逻辑通道

每个 member 到 Hub **一条**长期出站 WSS。Hub 本机设备走同样的适配器，但无需连接自己。

一条连接内多路复用 HTTP 请求和浏览器业务 WS：

- HTTP：一个短生命周期逻辑流，响应结束就释放。
- 业务 WS：一个持续逻辑流，承载一个浏览器到某个设备的原有 WS；握手、消息顺序、二进制类型和 close code 必须保留。
- 一个浏览器对一个设备的导航 socket 与终端 socket，保持不同逻辑流，不能拼到一套 E2EE 计数器里。
- Hub 维护 `来源连接/流 ID → 目标连接/流 ID` 的双向映射；回包只能回到原来源，不按客户端任意提供的来源 ID 投递。

最小控制消息：`hello / welcome / open / opened / result / end / close / error / directory`。没有离线命令、广播执行、任意 TCP 转发消息。

```json
{
  "type": "open",
  "streamId": 17,
  "kind": "http",
  "targetDeviceId": "<UUID>",
  "method": "POST",
  "path": "/api/tabs/<tabId>/prompts",
  "headers": { "content-type": "application/octet-stream" }
}
```

`hello` 携带协议版本、workspaceId、deviceId、bootId、应用版本与能力，token 只放连接认证头。`welcome` 确认工作区、connectionId、目录版本和限制。设备在收到 welcome 之前不接受业务流。

流 ID 为连接内 uint32；发起双方分别使用奇数/偶数，活动流不得重号，整条连接重建后不复用旧映射。逻辑流绑定打开时的 connectionId，迟到结果不得污染新连接。

### 8.2 数据帧与大小限制

JSON 仅承载短控制头。HTTP body 和原 WS 消息用二进制传输，禁止把整块正文 base64 再包 JSON。

建议固定 5 字节头：`streamId:uint32 big-endian + flags:uint8`。flags 中定义消息类型（HTTP body / WS text / WS binary）及末片标记，剩余位必须为零。随后是原字节。

- 单片最多 64 KiB，同一个流的消息按序分片/组装；流之间可交错。
- text 按 UTF-8 还原，binary 原样保留；禁止把密文转字符串再编码。
- 只允许与流 kind 相符的消息类型；未知流、越界片段、未完成消息超时必须关闭对应流。
- 一条逻辑 WS 消息必须完整还原后才交给现有 E2EE/业务处理器。不能在密文中间丢片。

初始限额集中定义，随实测调整：

| 项目 | 默认 |
| --- | --- |
| 工作区设备数 | 10 |
| 每设备活动流 / HTTP 并发 | 64 / 8 |
| JSON 控制帧 | 16 KiB |
| HTTP 请求体 | 原接口限制；外层容纳密文开销，最大 1 MiB + 64 KiB |
| 单次读取响应 / 逻辑 WS 消息 | 4 MiB 硬上限；大量历史必须分页 |
| 未完成消息组装时间 | 15 秒 |
| 链路待发送数据高水位 | 1 MiB，并保留小型控制消息额度 |
| 链路组装总预算 / 进程组装总预算 | 8 MiB / 64 MiB，超限拒绝新流或关闭过慢流 |
| HTTP 普通响应超时 | 20 秒 |

JSON、解密后正文、解压后正文分别执行上限校验。现有上限包括 prompt 128 KiB、定时器请求 512 KiB、常用 prompt 文件 1 MiB，不能因外层只允许 64 KiB 单片而误拒合法请求。

转发 headers 使用白名单：Content-Type、Content-Encoding、ETag、If-None-Match、Cache-Control、现有 E2EE header、请求关联字段。过滤 Host、Authorization、Cookie、Origin、代理/连接 headers，设备身份从连接上下文取得。状态码包括 202、304、409、413 必须原样保留，304 不生成假 JSON body。不缓存设备 API 响应到 CDN。

带 Content-Encoding 的 HTTP body 必须连同编码原样转发，禁止自动解压后仍携带原长度/编码。外层 WSS 可复用无上下文保留的 deflate；对已压缩 HTTP body、E2EE 密文按帧跳过压缩，保留未加密业务的现有压缩收益。

### 8.3 背压与连接恢复

控制/按键优先于大响应；大响应分片轮转发送，不能让历史下载阻塞所有设备输入。待发送数据到达上限后暂停该流生产；未解密的密文不可随意删帧，持续拥塞则关闭该逻辑流，让客户端重新订阅快照。只在所属设备、加密前复用现有 projection 合并策略。

30 秒无流量时进行 ping/pong，连续约 90 秒无有效回应判为断线。使用指数退避并加抖动重连，初始约 1 秒、上限 30 秒；成功稳定一段时间后重置退避。401/403、身份冲突、版本不兼容不能无限快速重试，显示可操作错误。

Cloudflare 维护和空闲回收都可能终止 WS，所以重连是正常路径，而不是异常补丁。[Cloudflare WebSocket 说明](https://developers.cloudflare.com/network/websockets/)

连接断开时：释放流和待响应请求；通知查看者；重连后重新鉴权、重建逻辑 WS、重新 E2EE 握手，按每设备 revision/终端 generation 与 offset 补齐。**不重放原始按键、旧密文帧或未确认写命令，不重建 PTY，不恢复或关闭 provider 会话。**

同一 `bootId` 的正常重连可取代旧连接；旧连接的 close 回调只能清理仍指向它的映射，不能误删新连接。不同 bootId 的活跃身份冲突需用户处理；原连接明确失活后才接受新进程。

## 9. 端到端加密兼容

不能为了复用本地接口而让跨设备流量跳过现有 E2EE。加密开启时，逻辑端点是**浏览器与所属设备**：浏览器 A → 本机 A 中转 → Hub → 设备 B，A 中转与 Hub 均只搬运密文，不解密 B 的内容。

当前前端 `e2ee-gate.ts` 是整个页面一份全局 state/key，这在多设备下会串密钥。必须改为每 `DeviceRef` 一个 E2EE context；内部每个逻辑 WS 再保留独立握手、方向密钥和计数器。可以继续复用现有加解密、压缩字典与握手代码，不能共享一份计数器。

要求：

1. `GET /d/:deviceId/api/bootstrap` 到达所属设备时，以 federation 上下文返回设备能力和 E2EE 的 on/required/fingerprint/salt/iterations；不把当前 `/api/bootstrap` 中的 index/activities 原样明文转发。原本本机直连 bootstrap 保持兼容。
2. 索引与活动摘要通过鉴权后的导航 socket 获取；启用 E2EE 的设备必须解锁后才获得这些内容。
3. `DeviceTransport` 在加密判断时使用 `/api/...` logicalPath，在发送网络请求时才加 `/d/:deviceId` 前缀。否则现有 `bodyNeedsEncryption(url.startsWith('/api/'))` 会被绕过。
4. HTTP、WS、文档正文两个方向都保持 E2EE；Hub 不可在解密后聚合数据。
5. federation 协议版本绑定工作区/设备身份：复用现有 KDF/AES-GCM，在派生上下文中加入 `federation-v1 + workspaceId + deviceId`；HTTP AAD 绑定 method、规范化 logicalPath 和请求/操作 ID，响应也绑定对应请求。不要仅靠同名口令区分设备，或自行设计新的加密算法。
6. 单机旧协议保留；federation 声明新的能力版本，缺少绑定能力时拒绝 federation E2EE 接入，不降级成明文。
7. 密钥缓存按 `workspaceId/deviceId/fingerprint` 分区，延续现有记忆策略，不新增长期明文持久化。设备 B 的密钥轮换只清理 B 的缓存和连接。
8. 未开启 E2EE 的设备仍可按现有规则远程使用，依赖 TLS 和已授权 Hub；此时必须承认 Hub 能看到业务内容。设备名称、在线状态及路由 ID 本身是可见元数据。

本机浏览器读取本机对话继续使用原来的 loopback 行为。外部网页访问即使目标恰好是 Hub 本机，也适用远程规则。由入口提供的前端 JS 仍是信任边界，E2EE 不承诺防御已被替换的页面代码。

## 10. 写操作、超时和并发

### 10.1 操作唯一执行点

仅所属设备执行写入与调度；Hub 不是队列执行者，也不决定 prompt 是否完成。本机与远端共同操作时仍使用现有 StorageService 锁和 Runner 状态机。

每次用户写操作生成 `operationId`，同一操作所有重试保持同 ID；另用 `requestId` 关联单次传输尝试。按设备保存简短操作回执：

```ts
type CommandReceipt = {
  operationId: string;
  requestHash: string; // 对规范化 method/path/解密参数计算，不能只比较 ID
  status: "pending" | "completed" | "failed" | "unknown";
  createdAt: string;
  updatedAt: string;
  resource?: { tabId?: string; promptId?: string; revision?: number };
  errorCode?: string;
};
```

所属设备在调用 handler 前原子保存 pending；完成后记录结果身份与 revision，不在回执重复保存正文、密钥或整份 TabBundle。相同 ID、不同 requestHash 返回 409；相同 pending 不再次调用 handler；已完成返回结果引用，前端按需重读现有资源。

进程重启留下的 pending 不能直接重跑：能通过预分配资源 ID 查到已完成写入的就对账，否则置为 unknown。对于新增 prompt/标签/定时器等，预分配的资源 ID 必须在执行前进入回执并写入目标记录，便于崩溃后识别。PTY 输入、session 启动等无法跨文件/进程事务保证“恰好一次”，不能宣称已经解决。

回执仅保留最近完成记录（建议 24 小时、最多 4096 条）；pending/unknown 不自动丢弃，达到上限则拒绝新增远程写并提示处理。查询找不到旧回执只代表无法确认，**不代表未执行**。重复防护只保证保留窗口内；前端永不自动重发未知或过期操作。

### 10.2 具体交互语义

- 写请求断线/超时：显示“结果尚未确认”，禁用该操作的重复提交，重连查询所属设备回执并刷新相应资源。
- `GET /api/federation/commands/:operationId` 是所属设备的只读、鉴权/E2EE 接口，可经设备路由访问；只能查询当前工作区发起的操作。
- 创建/恢复会话、重新打开、同步历史可能较慢：federation 适配器在持久接收后返回 `202 + operationId`，继续调用原服务逻辑。前端只对该在途操作低频查询（1、2、4 秒，之后最多每 10 秒），完成/失败即停止；不让 HTTP 长连接一直占到 Cloudflare 超时。
- 普通短写操作仍返回原结果；不为所有接口新增后台任务系统。
- `pause/start` 按目标状态处理；`interrupt` 针对确定的 activeTurnId，不能重试时打断已经开始的下一轮。
- 立即插入、run-now、reopen 等有副作用的动作同样走操作 ID，不能遗漏。
- 原始终端按键只在已连接、完成握手的 WS 中发送；断线时输入按钮禁用。按键不存盘、不进入操作回执、不离线排队，重连不自动敲回去。
- 离线期间可保留输入框中的浏览器内存草稿，但不能把它显示成已经保存到远端的 prompt；恢复后由用户明确添加。

### 10.3 同时编辑

需要避免覆盖的对象（prompt 正文、排序、常用 prompt、定时器）携带现有 revision/ETag 作为 expectedRevision。所属设备在同一写锁内比较并更新；冲突返回 409，前端刷新、保留草稿并提示再次确认，不静默覆盖。不要只在 Hub 比较版本。

多人/多页面同时敲同一终端仍共用一份 PTY，不增加控制租约或主从锁。该交互与目前本机/手机同时输入一致。

## 11. 订阅、缓存和低传输量

### 11.1 初次加载

1. 先读当前入口的 federation bootstrap，并立即显示可访问的本机内容。
2. 获取设备目录；为每个可用且已解锁的设备建立一个轻量导航订阅。
3. 沿用现有 `allTabs: true, index: true, snapshots: false, details: false, terminals: {}`，携带该设备 indexRevision。
4. 只有当前可见对话订阅详情与终端；其他设备不推全部 prompt、回答或终端历史。
5. 首次全量索引后只推 index/runtime/activity 增量；设备目录也按 revision 更新。

第一版每页面对每设备一个导航逻辑 socket，换取最小前端改造；物理设备出站连接始终只有一条。不要为所有设备/所有标签各建一条原始终端流，也不要为了减少逻辑流在 Hub 解密并合并索引。

需补一个轻量 `activity.snapshot`：每次新订阅/重连只发该设备所有标签的当前运行灯所需字段和最后完成时间，随后发增量。当前初始 activities 来自 `/api/bootstrap`，而 federation bootstrap 不再携带这些明文数据；若只复用 `snapshots:false` 而不补初始摘要，静止的标签会一直没有正确状态。该快照经同一个已解锁导航流发送，不包含 prompt/回答正文，完成时间只用于显示、不回放提示声。

### 11.2 缓存必须完整分区

以下 key 至少包含 `workspaceId/deviceId`，对话相关再包含 `tabId`：

- TabBundle、index revision、runtime delta、活动灯、完成提示去重。
- 终端 raw generation/offset、projection sequence、xterm checkpoint。
- prompt 输入草稿、编辑草稿、定时器编辑缓存。
- 文档 docId/revision/chunk、ETag、进行中的请求。
- E2EE key/fingerprint/握手状态。

禁止保留 `Map<tabId, ...>` 作为跨设备公共缓存。维持现有终端缓存容量限制，作为整个页面总预算，不要乘以设备数。设备撤销/换工作区时清掉对应缓存；设备短暂断线时可以保留最后可见结果并标注过期。

切换设备不重启原 PTY；优先恢复该复合身份的终端 checkpoint，之后按 generation/offset 增量追上。旧 generation 的数据不能拼接到新终端。后台页面不保持全部终端画面刷新。

### 11.3 自动终端模式

当前 `terminal-preference.ts` 仅根据 `location.hostname` 决定 raw/projection，在本地页面查看远端时会误选 raw，必须改为根据传输能力：

```text
真实本地页面 + 目标为本端 + 直接 loopback → raw
其他情况，包括 localhost 页面查看 B         → projection
```

继续复用现有投影差异帧、限流、分页、ETag、字典压缩与 xterm checkpoint。压缩在加密前执行；relay 不对密文重复压缩。继承“远端调整视口不改变本机 PTY 尺寸”的规则，不通过修改远端 PTY 高度实现滚动。

### 11.4 流量口径

扩展现有 `GET /api/diagnostics/traffic?hours=24`，保留旧字段，新增 federation 传输标签及设备维度。设备端统计实际出站连接的线字节；Hub 单列转发入/出字节；业务逻辑字节另计，不能把两个统计相加当成用户净下载量。

空闲目标：设备只有心跳，无变化不发送对话数据；无浏览器订阅时不向 Hub上传导航索引或终端。打开设备目录不批量同步历史；“同步历史”只对当前 `TabRef` 生效。具体带宽验收使用改造前后同一场景实测，不沿用旧文档的单用户速率作为保证。

## 12. 现有附属功能的设备语义

| 功能 | 规则 |
| --- | --- |
| 工作路径、Session ID | 始终解释为所属设备的路径和会话；不在当前浏览器所在机器查找 |
| 选择文件夹 | 仅真正本端直连允许原生对话框，其他情况只输入/浏览目标设备允许提供的路径 |
| 文档链接 | 以当前 TabRef 向所属设备申请 docId，再复用现有分块查看器；docId 不跨设备复用 |
| 导出对话、打开桌面应用 | 保持目前“仅本机”的限制；本地页面查看其他设备也不算本机 |
| 定时器 | 在所属设备执行，时区以所属设备为准；远端编辑标明设备时区，UTC 时间用于传输 |
| 常用 prompt | 归属于当前目标设备，第一版不做多副本共享库 |
| 加密设置 | 只在所属设备真实本机页面设置，不可经 Hub 关闭远端加密 |
| 恢复已开启对话 | 各实例按自己的持久记录恢复；Hub 不给其他实例再次发送 reopen |
| A2A | 维持设备内原有功能；跨设备 agent 链与任务迁移另立功能，不因标签聚合自动开启 |
| 中文/英文、主题、分栏宽度 | 当前访问页面的偏好，跨设备切换保持；不向每台设备重复写入 |

## 13. 后端生命周期和故障行为

加入 federation 的实例必须保持后台在线，不能沿用“最后一个页面关闭 30 秒后退出进程”：

- `mode=hub/member` 时关闭浏览器不退出实例；在配置加载时明确禁用 auto-exit，并在设置页显示“已启用多设备后台运行”。
- 连接器心跳不伪装成用户打开页面；退出规则由模式决定，避免依赖某条 WS 恰好一直存在。
- 用户明确退出服务，仍按既有流程记录打开状态、释放 agent/PTY；下次启动按本机记录恢复。
- mode=off 保留当前关闭页面后退出的行为。

| 故障 | 用户看到的结果 | 恢复规则 |
| --- | --- | --- |
| B 断网 | B 离线，已加载内容标为过期，A/C 可用 | B 本机继续运行，网络恢复后重新订阅 |
| Hub 重启 | 跨端暂不可用，本机对话仍能操作 | member 退避重连，不启动第二份 agent |
| 1033 / Cloudflared 断线 | 公网和经公网到 Hub 的链路断开 | 复用现有 Cloudflared 守护；不重启 Promptor 来“修复网络” |
| 写入完成但回包丢失 | 操作结果待确认 | 查询目标回执/资源，不重复提交 |
| 所属设备在执行请求时崩溃 | pending 进入对账/unknown | 不把未确认操作自动重跑 |
| 某设备的解密失败 | 只锁定该设备 | 重新解锁，其他设备不重建 |
| 目录 revision 不匹配 | 暂留旧目录 | 单次拉取全量目录，不刷新所有历史 |
| 终端 delta 出现缺口 | 当前终端短暂恢复中 | 请求所属设备该终端 snapshot，不全局重载 |
| 设备版本不兼容 | 明确显示不兼容 | 升级该端，不无限转圈 |

Hub 的在线判定依赖已认证连接和心跳，不调用 provider 状态推断网络健康。对话的运行灯只采信所属设备的现有运行判定。

## 14. 代码落点与改动顺序

以下以当前仓库代码为依据；不以旧设计文档的行号作为实现事实。

| 位置 | 改动 |
| --- | --- |
| `src/server/main.ts` | 按模式启动 federation；后台生命周期；在 shutdown 清理连接但不把网络重连等同应用重启 |
| `src/server/app.ts` | 抽出受控业务 dispatcher/WS 会话适配器；注入 RequestContext；保留原 HTTP/WS 入口 |
| `src/server/storage.ts` | 复用原子写/锁；增加身份、目录与回执的小文件存取；不合并各端 index |
| 新 `src/server/federation/` | config、registry、hub、connector、relay、route-policy、command-receipts；每项职责清晰，可按体量合并文件 |
| 新 `src/shared/federation-protocol.ts` | 协议版本、schema、帧格式、大小限制和复合身份 |
| 新 `src/client/device-transport.ts` | 目标绑定的 HTTP/WS 传输、能力、入口 URL；本地和远端共用组件 |
| `src/client/api-client.ts` | 从模块全局状态改为接收 transport/E2EE context；保留原单机默认适配 |
| `src/client/App.tsx` | 按设备维护 index/activity，设备分区；对话页和事件处理使用 TabRef |
| `src/client/e2ee-gate.ts`、`e2ee-client.ts` | 每设备独立上下文、密钥缓存和路由绑定 |
| `src/client/terminal-preference.ts` | 根据目标是否真本地决定默认模式 |
| `src/client/tab-cache.ts`、`terminal-cache.ts`、`prompt-draft.ts` | 复合身份隔离；继续保留现有容量和页面缓存规则 |
| `document-loader.ts`、`document-viewer.tsx`、timer/common-prompt 对话框 | 显式传入目标 transport；不读取全局“当前设备” |
| `src/server/traffic-scope.ts`、`traffic-ledger.ts` | 区分原直连与 federation 业务、链路字节；不把 scope 当权限 |
| `src/client/i18n.ts`、`styles.css` | 设备分区、离线/解锁/不兼容状态，中英文与手机布局 |

当前 `api-client.ts` 的 token/E2EE、`e2ee-gate.ts` 的全页面密钥、`App.tsx` 的单一 index 和 `location.host` WS 地址，以及按 tabId 缓存，是必须实际拆开的点。只在控制栏多加一层分组不能完成本功能。

实现阶段，每个阶段独立可回退：

1. **单机兼容基础**：DeviceRef、DeviceTransport、按设备缓存和 E2EE context；默认仍只有一个本机设备，旧功能回归通过。
2. **只读双端**：本机两个隔离数据目录启动 A/B，建立认证出站连接、目录和导航订阅；不开放远端写。
3. **真实对话页**：按需详情、终端输入/输出、历史分页、文档；验证 E2EE 与 backpressure。
4. **写入可靠性**：路由白名单、RequestContext、回执、revision 冲突、长操作 202；覆盖队列/会话/定时器/常用 prompt。
5. **界面与生命周期**：分区、本端置顶、离线和未解锁处理、手机布局、auto-exit 调整。
6. **真实 Tunnel 验收**：至少两台电脑与手机，完成下节全部核心场景，再启用到日常工作区。

每阶段运行受影响测试、类型检查和构建。协议阶段使用 fake provider/PTY，不消耗真实模型调用；最后保留少量真实 provider 冒烟。无需为纯文档修改运行应用测试。

## 15. 部署、维护与回退

### 15.1 新增 B，不改变现有单域名入口

1. Hub A 与成员 B 更新到支持同一 federation major 的版本。
2. A 启用 Hub，保持现有 `127.0.0.1:4317` 服务与域名 → A 的 Tunnel 路由。
3. 为 `/federation/link` 配置更具体的 Access Service Auth 应用；其余路径继续用户 Access 登录。Hub 配置分别对应的 AUD。
4. 按第 6 节登记 B，在 B 填好配置。**不把 A 的 Tunnel token 安装到 B。**
5. 从 A 本地、B 本地、公网手机分别确认两设备的标签可见且操作目标正确。
6. 重启 Hub、断开/恢复 B 的网络，确认会话不重建、队列不重复执行。

所有正常远程数据通过已有域名访问，不额外开放机器入站端口。B 的公网出站目标是 Hub 的 HTTPS/WSS 443；Cloudflared 到 Cloudflare 的连接仍由现有 Tunnel 配置维护，不在本功能中改 QUIC/HTTP2。

### 15.2 升级和兼容

hello 协商 `federationProtocolVersion` 与能力（provider 列表、终端协议、projection、文档、定时器、E2EE binding）。不要仅按应用版本字符串猜兼容。

第一版只接受相同 major，未知可选字段可忽略，不认识的动作明确拒绝。各设备可以提供不同 agent CLI；前端以目标能力显示选项，不能因为 Hub 安装了 Codex 就宣称所有设备都支持。

升级 Hub 造成连接重建，但不能修改远端会话。新的浏览器静态资源与旧设备不兼容时，给明确设备级提示，不关闭其他兼容设备。

### 15.3 关闭多设备模式

在 member 关闭 federation 后停止出站连接与远程订阅，本机 data/index/tabs 不变；在 Hub 撤销设备后更新所有已连接页面目录。关闭整个 Hub 模式前说明公网聚合将不可用，但仍不删除任何业务数据。

保留私密配置备份便于恢复；换 Hub 可通过备份恢复 workspaceId/registry，成员更换 hubUrl 与 Access 凭证。第一版不实现自动主备选举，也不复用另一台机器的 token 来“接管同名设备”。

## 16. 验收清单

| 场景 | 必须满足 |
| --- | --- |
| 仅一端/未开启 federation | 无设备隔离装饰，原功能及流量行为保持 |
| A/B 两端本地页面 | 各自本端置顶，均能看到并操作另一端 |
| 公网手机页面 | 两端分区可见，不错误标 Hub 为本端，状态与目标一致 |
| A/B 人工构造相同 tabId/groupId | 列表、编辑、删除、草稿、终端缓存均不串端 |
| A 编辑 B，B 本地同时观看 | 只写 B 的文件，双方收到一致更新 |
| 切换到 C 后 B 的请求才返回 | 不改 C 页面、按钮状态或缓存 |
| 创建对话/分组、组内排序 | 写到当前目标设备，保持当前分组位置规则 |
| 跨设备拖动 | 明确拒绝，无文件移动、无隐式复制 |
| 本地页查看远端 | projection，不弹远端桌面窗口，不获得本机专有接口 |
| 切换、调整远端视口 | 不重启 PTY、不改变本机终端尺寸、不从头重放全部输出 |
| A/B 不同 E2EE 密钥，B 轮换 | 各自解锁；A 不受 B 密钥变化影响；中转不可读 B 的正文 |
| localhost A 查看加密 B | 仍加密并要求 B 的密钥，不能因 A 是回环而免密 |
| 白名单、越权、重放、伪造上下文 | 拒绝未知 route、跨工作区目标、旧连接、假来源与假本地标记 |
| 写入成功后断链、相同 operationId 重试 | 不重复插入 prompt、不重复 run-now/reopen；返回可核对状态 |
| 提交中所属设备崩溃 | 对账或 unknown；不把未确认命令自动重放 |
| 离线敲键/发送 prompt | 禁止发送；页面草稿保留；恢复后不自动回放 |
| Hub 失联和 B 恢复 | A/B 的本地功能独立可用，重连不重复创建 agent 或 writer |
| 多页面冲突修改 | 409 + 保留草稿，不静默覆盖 |
| 两设备同名文档/同 docId | 只读取当前设备授权的文档，路径与分块不串端 |
| 定时器时区、常用 prompt | 按所属设备执行/保存，不在 Hub 触发另一份任务 |
| 关闭所有网页 | 已启用 federation 的实例继续在线；单机模式保持旧行为 |
| 慢客户端、粘贴大文本、大历史 | 有界内存，按键不被长响应无限阻塞；合法请求不被单片限制误拒 |
| 跨版本与错误返回 | 不兼容、Access 登录失效、E2EE 错误、离线有各自明确提示 |
| 目录/历史刷新 | 目录修复只拉目录；同步历史只作用当前 TabRef |
| 撤销、重新加入、目录复制 | 撤销不删历史，重复身份被识别，新设备不会冒领旧设备连接 |
| 空闲/带宽 | 无订阅不上传正文；无变化只有心跳；现有分页/ETag/投影限制继续有效 |

最小自动化环境：A/B 两个独立临时数据目录、可控制断线的本地 relay、fake provider、两个浏览器上下文。覆盖真实链路断开前/写入中/写入后回包前这三个时点，不只测试正常返回。

交付应包括协议测试、双实例集成测试、浏览器分区与串端回归、部署说明和回退路径；新配置默认关闭，用户启用后才建立任何 federation 出站连接。

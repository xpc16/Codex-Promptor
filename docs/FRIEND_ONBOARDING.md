# Codex Promptor 远程使用指南

把这个工具装在**你自己的 Windows 电脑**上，然后从手机或另一台电脑，通过一个专属子域名远程操作它。域名和门禁由朋友（域名所有者）在 Cloudflare 侧配好，你只需要跑一条命令接上隧道。

它用标签页管理 **Codex / Claude Code / Cursor CLI** 的对话，也可以只开一个干净的 PowerShell。核心是**排队**：把要做的事一条条写进队列，它按顺序喂给同一个会话，人不用守着。

> **它能在你的电脑上执行任意命令。**

不需要公网 IP，不需要在路由器开端口——隧道是你的电脑主动拨出去的。

---

## 1. 装应用

需要 **Node.js 22～24** 和 git；三个 agent CLI 一个都不装也能用。

```powershell
cd D:\
git clone https://github.com/xpc16/Codex-Promptor.git codex_promptor
cd codex_promptor
npm ci
.\start.ps1
```

浏览器会打开 `http://127.0.0.1:4317/`，看到界面后 `Ctrl+C` 停掉。

---

## 2. 装 cloudflared，接上隧道

下载 Windows 版：<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>

**管理员身份**打开 PowerShell，粘贴朋友给你的那条命令：

```powershell
cloudflared.exe service install eyJhIjoiXXXX....
```

`eyJ...` 那串是这条隧道的凭证。一条命令做完三件事：注册成 Windows 服务、开机自启、立刻连上。你不需要 Cloudflare 账号。

常用命令：

```powershell
Get-Service cloudflared            # Running 就对了
net stop cloudflared               # 停（远程立刻断开，本机 127.0.0.1 不受影响）
net start cloudflared
cloudflared.exe service uninstall  # 彻底卸掉
```

---

## 3. 第一次远程登录

打开 `https://friend.example.com` → 跳到 Cloudflare 登录页 → 填你的邮箱 → 收 6 位验证码（10 分钟有效）→ 进入。

- 收不到邮件：看垃圾箱；确认邮箱拼写和朋友放行的一致；企业邮箱把 `noreply@notify.cloudflare.com` 加白名单。
- **页面打开了但终端一直空白**：环境变量还没设，跳到第 6 节。

---

## 4. 找回旧对话：导出会话清单

想 `/resume` 一个几周前的对话，但不记得 session id 时：

```powershell
.\scripts\export-agent-sessions.ps1
```

在 `docs/` 下生成两份表格（Codex 一份、Claude Code 一份），每行是：**最近活动日期 · 对话所在路径 · Session ID · 开头 3 条 prompt**。靠前 3 条 prompt 认出是哪个对话，再把 Session ID 填进「继续旧对话」。

纯 PowerShell，无依赖。可选参数：`-PromptCount 5`（多显示几条）、`-MaxLength 0`（不截断长 prompt）。

---

## 5. 端到端加密

**只能在本机设置，远端改不了。** 本机打开 `http://127.0.0.1:4317/` → 新建对话 → 右下角下拉框选**「端到端加密」** → 「加密密钥」框里打一句只有你知道的话（**中文可以**，或点「生成」拿随机的）→ 「确定并打开」。

标签会自动改名成 `E2EE`，并显示一个**密钥指纹**，形如 `K7M2-9QXF`。

远端下次打开页面会先弹「需要加密密钥」，把口令输进去；**对一下指纹**，应该和本机一模一样。输错会当场提示「密钥不正确」。密钥只存在那个浏览器里，换设备要重新输。

| 操作 | 结果 |
|---|---|
| 开第二个加密对话 | **不允许**，提示先关掉现有的 |
| 在同一标签里重填口令 | 换密钥，已配对设备要重新输 |
| **关闭**这个标签 | 加密关闭，**口令留着**，「重新打开」用同一把密钥恢复 |
| **删除**这个标签 | 加密关闭，**口令也没了** |
| 以上任一操作 | 已连接的远端**立刻断开** |

走子域名（https）才有效；用局域网 IP（`http://192.168.x.x`）直连时加密不工作。

---

## 6. 让应用一直跑着

按 `Win+R`，输入 `shell:startup`，回车。在弹出的文件夹里新建一个文本文件，改名成 `promptor.cmd`，内容如下——**只需要改两处**：

```bat
@echo off
set CODEX_PROMPTOR_TRUSTED_HOSTS=friend.example.com
set CODEX_PROMPTOR_AUTO_EXIT=0
set CODEX_PROMPTOR_OPEN=0
cd /d D:\codex_promptor
node dist\server\main.js
```

1. 第 2 行的 `friend.example.com` → 换成朋友给你的子域名（**不带 `https://`，一字不差**）
2. 第 5 行的 `D:\codex_promptor` → 换成你 clone 的实际路径

保存后**双击它**，应用就跑起来了；以后每次开机自动跑。想停就关掉那个黑窗口。

> 这三行 `set` 一行都不能省，因为它们的失败方式都不像报错：
> 第一行不设 → 远程页面**能打开，但终端永远空白**；
> 第二行不设 → 手机切后台或断网 30 秒，它会**杀掉自己和所有正在跑的会话**；
> 第三行不设 → 每次开机弹一个浏览器窗口。

**更新代码后**：`git pull` → `npm ci` → 关掉黑窗口 → 重新双击 `promptor.cmd`。

---

## 7. 出问题怎么办

**先用本机 `http://127.0.0.1:4317/` 区分是应用的问题还是隧道的问题——它永远不受隧道影响。**

| 现象 | 先查 |
|---|---|
| 域名转圈或 502 | `Get-Service cloudflared` 是否 Running；本机 4317 能否打开 |
| 页面出来了但终端一直空白 | 八成是 `CODEX_PROMPTOR_TRUSTED_HOSTS` 没设或拼错 |
| 用着用着整个应用没了 | `CODEX_PROMPTOR_AUTO_EXIT` 没设成 `0` |
| 提示要密钥但你没设过 | 本机看看是不是有个叫 `E2EE` 的标签，删掉即关闭加密 |
| 本机 4317 也打不开 | `npm ci` 跑过没；Node 版本是不是 22～24 |

想单方面切断远程访问：`net stop cloudflared`。域名所有者也能随时关掉你的访问。

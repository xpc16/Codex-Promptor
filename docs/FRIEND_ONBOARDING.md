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

> **报「因为在此系统上禁止运行脚本」** —— Windows 默认不允许运行任何 `.ps1`。放开一次即可，不需要管理员：
>
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```
>
> 如果你是**下载 ZIP** 而不是 `git clone` 的，文件还带着「来自网络」标记，放开之后仍会报「未经数字签名」。再跑一次这个解掉：
>
> ```powershell
> Get-ChildItem -Recurse | Unblock-File
> ```
>
> 不想改系统设置也行，每次都写全：`powershell -ExecutionPolicy Bypass -File .\start.ps1`。

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

### 3.1 先授权你的域名

应用默认只信任 `127.0.0.1`。第 1 步跑过一次之后 `data\private\` 已经建好了，在里面新建 `remote-access.json`：

```json
{
  "trustedHosts": ["friend.example.com"]
}
```

换成朋友给你的子域名，**不带 `https://`，一字不差**。改完要重启应用才生效。

不配的话，远端页面会停在一个「!」的错误屏：**当前访问地址未获 Promptor 授权**。本机 `127.0.0.1` 不受影响，照常能用。

### 3.2 登录

打开 `https://friend.example.com` → 跳到 Cloudflare 登录页 → 填你的邮箱 → 收 6 位验证码（10 分钟有效）→ 进入。

- **提示「This One-Time PIN has already been used」（第一次填经常撞上）**：邮件里那个「登录」按钮和这 6 位码**是同一个凭证**，谁先用掉算谁的。邮箱的反钓鱼扫描、链接预览会替你先点开它，等你把码填进去时已经作废了。点 **Request new code** 拿一个新的，通常第二次就过。
- **每请求一次新码，上一个立刻失效** —— 收件箱里堆了几封时，只有最新那封的码是有效的。
- 老是撞上，或者根本收不到邮件：看垃圾箱；确认邮箱拼写和朋友放行的一致；把 `noreply@notify.cloudflare.com` 加进邮箱安全工具的白名单（企业邮箱尤其需要）。

---

## 4. 端到端加密

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

## 5. 找回旧对话：导出会话清单

想 `/resume` 一个几周前的对话，但不记得 session id 时。**第一次跑 `.\start.ps1` 时已经自动生成过一份**，之后想刷新就手动跑：

```powershell
.\scripts\export-agent-sessions.ps1
```

在 `docs/` 下生成两份表格（Codex 一份、Claude Code 一份），每行是：**最近活动日期 · 对话所在路径 · Session ID · 开头 3 条 prompt**。靠前 3 条 prompt 认出是哪个对话，再把 Session ID 填进「继续旧对话」。

纯 PowerShell，无依赖。可选参数：`-PromptCount 5`（多显示几条）、`-MaxLength 0`（不截断长 prompt）。

---

## 6. 让应用一直跑着

按 `Win+R`，输入 `shell:startup`，回车。在弹出的文件夹里新建一个文本文件，改名成 `promptor.cmd`：

```bat
@echo off
set CODEX_PROMPTOR_AUTO_EXIT=0
set CODEX_PROMPTOR_OPEN=0
cd /d D:\codex_promptor
node dist\server\main.js
```

把 `D:\codex_promptor` 换成你 clone 的实际路径。保存后**双击它**，应用就跑起来了；以后每次开机自动跑。想停就关掉那个黑窗口。

> `CODEX_PROMPTOR_AUTO_EXIT=0` 不能省：默认最后一个页面关闭 30 秒后会退出整个进程，远程时手机切后台或断网就会被判成「页面关了」，然后**杀掉自己和所有正在跑的会话**。`OPEN=0` 只是让它别每次开机弹浏览器。

**更新代码后**：`git pull` → `npm ci` → 关掉黑窗口 → 重新双击 `promptor.cmd`。

---

## 7. 出问题怎么办

**先用本机 `http://127.0.0.1:4317/` 区分是应用的问题还是隧道的问题——它永远不受隧道影响。**

| 现象 | 先查 |
|---|---|
| 域名转圈或 502 | `Get-Service cloudflared` 是否 Running；本机 4317 能否打开 |
| 远端停在「未获 Promptor 授权」 | `data\private\remote-access.json` 里的域名对不对；改完重启了没 |
| 打开 Codex 对话报 `CODEX_NATIVE_EXECUTABLE_NOT_FOUND` | `codex` 不在 PATH 上。见下方 |
| 用着用着整个应用没了 | `CODEX_PROMPTOR_AUTO_EXIT` 没设成 `0` |
| 提示要密钥但你没设过 | 本机看看是不是有个叫 `E2EE` 的标签，删掉即关闭加密 |
| 本机 4317 也打不开 | `npm ci` 跑过没；Node 版本是不是 22～24 |

### `CODEX_NATIVE_EXECUTABLE_NOT_FOUND`

打开一个 Codex 对话时报这个，意思只有一个：**应用没能在 PATH 上找到 `codex`**。它启动前会执行 `where.exe codex`，找不到就停在这里。

自己先跑一遍同一条命令，看它说什么：

```powershell
where.exe codex
```

- **什么都没输出，但你确实装过** —— npm 的全局目录不在 PATH 上。应用会自己去 `%APPDATA%
pm` 和 `npm prefix -g` 说的位置找，所以**先关掉重开应用试一次**，多半就好了。
- **什么都没输出，也确实没装** —— 装上 `codex` 再重开应用；只想用 Claude Code 或终端对话的话，这个对话打不开，不影响其他对话。
- **有输出，但应用仍然报错** —— 进程的 PATH 在启动那一刻就定死了，后装的东西它看不见。关掉重开应用即可。
- **装在了别处** —— 应用会自己找 npm 的全局目录和官方安装器的 `%LOCALAPPDATA%\OpenAI\Codexin\`，所以先**重开一次应用**。还不行再往下：先找出真实位置：

  ```powershell
  Get-ChildItem -Path $env:APPDATA, $env:LOCALAPPDATA -Recurse -Filter codex.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
  ```

  把找到的路径写进 `promptor.cmd`，放在 `node` 那行**之前**：

  ```bat
  set CODEX_PROMPTOR_CODEX_EXECUTABLE=C:\完整\路径\codex.exe
  ```

  > **`set X=Y` 是 cmd 的写法，只在 `.cmd` 文件里有效。** 在 PowerShell 里敲它不会设置环境变量，也不会报错——`set` 在那里是 `Set-Variable` 的别名，做的是完全不同的事。PowerShell 里要写 `$env:CODEX_PROMPTOR_CODEX_EXECUTABLE = "C:\完整\路径\codex.exe"`，而且**只对当前这个窗口有效**，应用必须从同一个窗口启动。

报错信息里会列出它**实际找过的位置**，对照一下就知道差在哪。

顺带一提：这些 Codex 对话是应用第一次启动时从你自己的 `~/.codex` 里自动导入的，所以能看到历史记录是正常的——**看历史不需要装 codex，继续对话才需要**。

---

想单方面切断远程访问：`net stop cloudflared`。域名所有者也能随时关掉你的访问。

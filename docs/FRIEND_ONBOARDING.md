# Codex Promptor 远程使用指南

> 给你的：把这个工具装在**你自己的 Windows 电脑**上，然后从手机或另一台电脑，通过一个专属子域名远程操作它。
>
> 域名和门禁由朋友（域名所有者）在 Cloudflare 侧配好，你只需要跑一条命令把隧道接上。

---

## 0. 这东西是什么

一个本地网页应用，用标签页管理 **Codex / Claude Code / Cursor CLI** 的对话，也可以只开一个干净的 **PowerShell 终端**。

它的价值在于：**排队。** 你把要做的事情一条条写进队列，它按顺序喂给同一个会话，跑完一条记一条最终回答。人不用守着。

远程访问的意义就在这里——你在公司或路上，看一眼手机就知道家里那台机器跑到哪了，也可以随时插一条新任务。

**它能在你的电脑上执行任意命令。** 这是它的工作方式，不是漏洞。装之前想清楚这一点。

---

## 1. 需要准备

| | 说明 |
|---|---|
| Windows | Windows 10/11 |
| Node.js | **22～24**。`node --version` 确认。25 及以上不行 |
| git | 用来拉代码 |
| cloudflared | 第 4 节会装 |
| 至少一种 CLI（可选） | `codex` / `claude` / `agent`（Cursor）。**一个都没有也能用**——「终端」类型的对话只是个 PowerShell |

不需要公网 IP，不需要在路由器上开端口。隧道是你的电脑**主动拨出去**的。

---

## 2. 装应用

```powershell
cd D:\            # 换成你想放的位置
git clone https://github.com/xpc16/Codex-Promptor.git codex_promptor
cd codex_promptor
npm ci
npm run build
```

> `setup.ps1` 会**强制检查 `codex` 存在且版本正好是 `codex-cli 0.147.0`**，没装 codex 会直接报错退出。
> 所以上面直接用 `npm ci` + `npm run build`，绕开这个检查。装了 codex 且版本对得上的话，跑 `.\setup.ps1` 也一样。

跑起来看看：

```powershell
.\start.ps1
```

浏览器会自动打开 `http://127.0.0.1:4317/`。看到界面就说明本机这部分成了，先按 `Ctrl+C` 停掉，继续下一步。

---

## 3. 两个必须设置的环境变量

远程访问下这两个**不设会出事**：

```powershell
# 换成朋友给你的那个子域名，不带 https://
$env:CODEX_PROMPTOR_TRUSTED_HOSTS = "friend.example.com"

# 关掉「最后一个页面关闭 30 秒后自动退出」
$env:CODEX_PROMPTOR_AUTO_EXIT = "0"
```

- **`CODEX_PROMPTOR_TRUSTED_HOSTS`**：应用默认只信任 `127.0.0.1`。不加这一条，通过域名进来的请求会被它自己拒掉。必须和子域名**完全一致**。
- **`CODEX_PROMPTOR_AUTO_EXIT=0`**：默认行为是最后一个页面关闭 30 秒后**退出整个进程**。本机用没问题，但远程时手机切后台、地铁断网、笔记本合盖都可能被判成「页面关了」——然后 30 秒后它会杀掉自己和里面所有正在跑的会话。**远程用一定要关掉。**

上面两行只在当前 PowerShell 窗口有效。要永久生效：

```powershell
[Environment]::SetEnvironmentVariable("CODEX_PROMPTOR_TRUSTED_HOSTS", "friend.example.com", "User")
[Environment]::SetEnvironmentVariable("CODEX_PROMPTOR_AUTO_EXIT", "0", "User")
```

设完**关掉再重开** PowerShell 才会读到。验证：

```powershell
$env:CODEX_PROMPTOR_TRUSTED_HOSTS
```

---

## 4. 装 cloudflared 并接上隧道

### 4.1 装

下载 Windows 版：<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>

`.msi` 装完确认：

```powershell
cloudflared --version
```

### 4.2 接上

用**管理员身份**打开 PowerShell，粘贴朋友给你的那条命令：

```powershell
cloudflared.exe service install eyJhIjoiXXXX....
```

这一条命令做了三件事：注册成 Windows 服务、开机自启、立刻连上。

> **`eyJ...` 那一长串是凭证，别外传、别截图发群里。**
> 你不需要 `cloudflared tunnel login`，也不需要 Cloudflare 账号——那些都在朋友那边。

### 4.3 常用命令

```powershell
Get-Service cloudflared                  # 看状态，Running 就对了
net stop cloudflared                     # 停（远程立刻断开，本机 127.0.0.1 不受影响）
net start cloudflared                    # 起
cloudflared.exe service uninstall        # 彻底卸掉
```

日志在 `C:\Windows\System32\config\systemprofile\.cloudflared\` 下，或者用：

```powershell
Get-EventLog -LogName Application -Source cloudflared -Newest 20
```

---

## 5. 让应用也一直跑着

隧道是服务，会开机自启；应用如果只是手动 `.\start.ps1`，关掉窗口就没了。

### 简单做法：开机自动起一个窗口

`Win+R` 输入 `shell:startup`，在打开的文件夹里新建 `promptor.cmd`：

```bat
@echo off
set CODEX_PROMPTOR_TRUSTED_HOSTS=friend.example.com
set CODEX_PROMPTOR_AUTO_EXIT=0
set CODEX_PROMPTOR_OPEN=0
cd /d D:\codex_promptor
node dist\server\main.js
```

`CODEX_PROMPTOR_OPEN=0` 让它别每次开机都弹浏览器。

### 更稳的做法：注册成服务

用 [NSSM](https://nssm.cc/)，管理员 PowerShell：

```powershell
nssm install CodexPromptor "C:\Program Files\nodejs\node.exe" "D:\codex_promptor\dist\server\main.js"
nssm set CodexPromptor AppDirectory "D:\codex_promptor"
nssm set CodexPromptor AppEnvironmentExtra CODEX_PROMPTOR_TRUSTED_HOSTS=friend.example.com CODEX_PROMPTOR_AUTO_EXIT=0 CODEX_PROMPTOR_OPEN=0
nssm start CodexPromptor
```

代价：服务账号跑起来的 CLI 登录状态可能和你桌面账号不同。**如果 codex/claude 提示未登录，就用上面的开机自启方式。**

### 改了代码或更新之后

```powershell
cd D:\codex_promptor
git pull
npm ci
npm run build
# 然后重启：nssm restart CodexPromptor  或者关掉窗口重新跑
```

---

## 6. 第一次远程登录

1. 手机或另一台电脑打开 `https://friend.example.com`
2. 跳到 Cloudflare 登录页 → 填**你的邮箱**（朋友放行的那一个）
3. 收 6 位验证码（**10 分钟内有效**），填进去
4. 通过后看到应用界面

收不到邮件：
- 先看垃圾箱
- 确认邮箱拼写和朋友放行的那个一致
- 企业邮箱有网关的话，把 `noreply@notify.cloudflare.com` 加白名单

页面打开了但一直空白 / 终端不刷新 → 见第 9 节。

---

## 7. 端到端加密（E2EE）：建议开

### 为什么是你需要，而不是可选项

流量路径是：**你的电脑 → Cloudflare → 你的手机**。中间那一段，内容对两方是可见的：

1. **Cloudflare**——TLS 在它那里终止，它看得到明文。
2. **域名所有者（你朋友）**——他控制 Access 策略。**他随时可以把自己的邮箱加进放行名单，然后打开这个页面，看到你的终端画面、对话内容和最终回答。你不会收到任何提示。**

第 2 条不是猜测，是这套架构的必然结果。他不这么做只是因为他选择不这么做。

**打开 E2EE，用一句他不知道的口令，这件事就变成做不到。** 他仍然能打开页面，但看到的是一个要求输入密钥的框；即使强行绕过，服务端发过去的也是密文。

代价：他没法再帮你远程排查问题了。这是个取舍，你自己定。

### 怎么开（在**本机**操作，远程改不了）

1. 本机打开 `http://127.0.0.1:4317/`
2. 新建对话 → 右下角下拉框选 **「端到端加密」**（在「终端」下面）
3. 「加密密钥」输入框里打一句只有你知道的话——**中文可以**；或者点「生成」拿一串随机的
4. 点「确定并打开」

标签会自动改名成 **`E2EE`**，页面上会显示一个**密钥指纹**，形如 `K7M2-9QXF`。

> 加密**只能在本机设置**。远端发这个请求会被拒绝——让远端来定密钥等于没有密钥。

### 远端怎么用

下次打开 `https://friend.example.com`，会先弹出「需要加密密钥」：

- 把口令输进去（**中文能输**——这个框故意不是密码框，因为系统在密码框里不允许输入法。想遮住就点「隐藏」，但那样中文就打不了了）
- 输对了框就消失；输错了会明确告诉你「密钥不正确」，**当场就说，不会让你用着用着才发现**
- 密钥只存在这个浏览器里（IndexedDB），换设备要重新输一次
- **对一下指纹**：远端显示的应该和本机那个 `K7M2-9QXF` 一模一样。不一样就说明中间有人换了东西

### 几条规则

| 操作 | 结果 |
|---|---|
| 同一时间开第二个加密对话 | **不允许**，会提示先关掉现有的 |
| 在同一个 E2EE 标签里重新填口令 | 换密钥。已配对的设备要重新输 |
| **关闭**这个标签（「关闭对话」） | 加密关闭，**口令留着**。点「重新打开」用同一把密钥恢复，设备不用重新输 |
| **删除**这个标签 | 加密关闭，**口令也没了**。下次是全新的密钥 |
| 换密钥 / 关闭 / 删除 | 已连接的远端**立刻断开**，会重新问你要密钥 |

### 一个前提

E2EE 依赖浏览器的 WebCrypto，**只在 `https://` 或 `http://127.0.0.1` 下可用**。通过子域名访问就是 https，没问题；但如果你哪天用局域网 IP（`http://192.168.x.x`）直连，加密是不工作的。

### 它挡不住什么

诚实说清楚：

- **元数据仍然可见**——什么时候连的、连了多久、传了多少字节、多频繁。加密不改变通信模式。
- **按键节奏可见**——终端输入一次按键一帧，观察者能看到你打字的节奏。
- **你自己电脑上的文件是明文**——`data/tabs/` 下的提示词和回答没有加密。那是 BitLocker 的活。
- **页面的 JS 是从服务端下载的**——也就是从你自己的电脑。这一环是安全的前提是你的电脑没被入侵。

---

## 8. 日常使用

- **左侧栏**：对话列表，可以分组、拖动排序、重命名。底部有主题（月亮/太阳）和语言（中/En）切换。
- **新建对话**：右下角下拉框选提供商 → 填工作路径 → 「确定并打开」。选「终端」的话路径可以留空（落在用户主目录），标签会自动改名成「终端」。
- **执行队列**：写好一条条 prompt，它按顺序提交。空队列加第一条会自动开始；队列已暂停时继续添加只会排队。
- **立即插入**：把某一条插进正在跑的那一轮。
- **最终回答**：每轮的开始时间、结束时间和回答正文。中断的会原样标成「已中断」，**不会伪造一个回答出来**。
- **手机上**：底部有四个页签切换「控制台 / 对话 / 队列 / 终端」；最终回答在「对话」页里，跟在会话面板下面。

关掉浏览器不影响后台——队列继续跑。回来刷新页面就能看到进度。

---

## 9. 出问题怎么办

| 现象 | 先查 |
|---|---|
| 域名打不开，转圈或 502 | `Get-Service cloudflared` 是不是 Running；应用是不是在跑（本机开 `http://127.0.0.1:4317/` 试） |
| 登录页正常，登录后 502 | 应用没起来，或者端口不是 4317 |
| 页面出来了但终端一直空白 | 八成是 `CODEX_PROMPTOR_TRUSTED_HOSTS` 没设或拼错了。`$env:CODEX_PROMPTOR_TRUSTED_HOSTS` 看一眼 |
| 用着用着整个应用没了 | `CODEX_PROMPTOR_AUTO_EXIT` 没设成 `0`。见第 3 节 |
| 收不到验证码 | 垃圾箱；邮箱拼写；`noreply@notify.cloudflare.com` 加白名单 |
| 提示「需要加密密钥」但你没设过 | 本机看一下是不是有个叫 `E2EE` 的标签。删掉它就关闭加密了 |
| 本机 127.0.0.1 也打不开 | `npm run build` 有没有跑过；Node 版本对不对（22～24） |

**本机 `http://127.0.0.1:4317/` 永远不受隧道影响。** 排查时先用它区分「是应用的问题」还是「是隧道的问题」。

---

## 10. 你随时可以单方面切断

```powershell
net stop cloudflared
```

远程立刻不可达，本机照常。想彻底断就 `cloudflared.exe service uninstall`。

反过来，域名所有者那边也能随时关掉你的访问（改 Access 策略或删隧道）——这是双向的。

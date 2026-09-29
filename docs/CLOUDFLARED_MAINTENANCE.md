# 本机 Cloudflared 稳定性维护

独立于 Promptor 的 Windows PowerShell 5.1 脚本，不增加应用依赖，也不改变隧道协议、路由、Access 或 token。默认适用于名为 `Cloudflared`、通过 `tunnel ... run --token-file ...` 启动的现有 Windows 服务。

## 安装

在本仓库的**管理员 PowerShell** 中执行：

```powershell
.\scripts\cloudflared-maintenance.ps1 -Mode Install
```

默认把服务使用的程序统一到 `C:\Program Files (x86)\cloudflared\cloudflared.exe`（可用 `-Executable` 指定）。安装前检查新旧程序 SHA-256 相同，避免路径整理顺带更换版本。原程序保留，不删除。既有的开机自启、20 秒崩溃恢复策略保持原状。

安装目录是 `C:\ProgramData\cloudflared\maintenance`。脚本复制到此处运行，SYSTEM/管理员可写、普通用户只读，仓库更新不会直接改变以 SYSTEM 运行的任务。修改脚本后重新执行安装。

安装会短暂重启 Cloudflared；远端 WebSocket 需要重连，Promptor 和 agent 进程不会因此被脚本停止。第一次安装保存原服务命令和电源设置至 `backup.json`。

## 生效行为

- 计划任务 `Cloudflared Health Watchdog`：开机触发，并每分钟执行一次；每次检查结束即退出，无额外常驻程序。任务在电池模式也执行，重复运行不重叠。
- 仅请求 `http://127.0.0.1:20241/ready`，5 秒超时，无外网探测流量。
- 服务处于 Running 且 ready 返回有效连接才视为可用；少于 4 条但至少 1 条时只记录 degraded，不重启。
- 连续 3 次失败后只恢复 Cloudflared；恢复尝试之间至少间隔 5 分钟。服务新进程有 2 分钟启动宽限，丢失状态文件时保守等待 5 分钟；检查间隔超过 150 秒时重置连续失败计数。
- 在尝试恢复**前**记录冷却时间，恢复操作失败也不会形成快速重启循环。服务已 Disabled 时不恢复。
- 隧道日志：`maintenance\logs\cloudflared.log`，级别 info，使用 Cloudflared 自带 `--log-directory` 轮转（当前版本每份 1 MB，最多 5 份备份）。不设置无上限增长的 `--logfile`。
- 守护日志：`maintenance\watchdog.log`，只记录状态变化、恢复操作和异常，256 KB 轮转，保留 1 份备份；最近检查结果写入 `state.json`。
- 当前电源计划的插电/电池自动睡眠、自动休眠设为“从不”；不改熄屏、手动睡眠、合盖动作或低电量保护。电脑仍需供电且联网；切换其他电源计划后需检查其设置。

1033 表示 Cloudflare 没有可用的隧道连接。`/ready` 只检查连接到 Cloudflare，不代表 Promptor 本身可用；后端停止导致的 502 不应触发隧道重启。断网、手动睡眠、关机期间，守护任务不能保证远端可用。

## 查看、更新和回退

```powershell
# 只读状态（普通 PowerShell 即可）
.\scripts\cloudflared-maintenance.ps1 -Mode Status

# 手动更新：管理员执行，自动读取服务实际使用的 exe 路径
# 暂停守护任务，调用官方 updater，更新成功后重启隧道并恢复任务。
# 不安排自动升级，避免在远端使用过程中因升级断线。
.\scripts\cloudflared-maintenance.ps1 -Mode Update

# 手动维护/停用隧道前先暂停守护，避免停掉后又被拉起
Disable-ScheduledTask -TaskName 'Cloudflared Health Watchdog'
Stop-ScheduledTask -TaskName 'Cloudflared Health Watchdog'
Stop-Service Cloudflared

# 维护完成
Start-Service Cloudflared
Enable-ScheduledTask -TaskName 'Cloudflared Health Watchdog'

# 恢复初次安装前的服务命令、电源设置，注销本守护任务
# 留存日志和备份文件；不会删除 token、Cloudflared 或 Promptor 数据
.\scripts\cloudflared-maintenance.ps1 -Mode Restore
```

Windows 的 Cloudflared 不会自动升级。统一服务路径后，使用这里的 `Update` 入口，避免更新了另一份 exe。若官方 updater 提示由包管理器安装，则按其提示使用对应包管理器升级，之后重新启动 Cloudflared；不要把退出码 0 一概理解为已经安装了新版本。

## 验证

```powershell
powershell -NoProfile -File .\scripts\cloudflared-maintenance.test.ps1
Get-ScheduledTaskInfo -TaskName 'Cloudflared Health Watchdog'
Invoke-RestMethod http://127.0.0.1:20241/ready
```

无依赖测试覆盖失败阈值、恢复清零、部分连接可用、冷却、启动宽限、睡眠/时钟变化、关闭服务及参数保留。实际安装后检查计划任务结果为 0、ready 至少一条连接、日志持续产生。不要为测试而中断正在使用的公网链路。

参考：[Cloudflare 可观测性与日志](https://developers.cloudflare.com/tunnel/observability/)、[Cloudflared 更新](https://developers.cloudflare.com/tunnel/guides/update-cloudflared/)。

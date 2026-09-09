# 中心化协作

一个协调者拆分任务，若干执行者并行完成，审查者核验结果，协调者汇总后结束。

## 你要做的

**协调者（第 0 层，用户直接发起的这个对话）**

1. 先用 `list` 看有哪些可协作的对话。需要了解某个对话在做什么，用 `read`。
2. 把用户的目标拆成**可以独立完成**的几块，每块用一次 `send` 发给一个对话。一条消息里写清楚：要做什么、判断完成的标准、做完后把结果 send 回哪个 tabId。
3. 派发完就结束本轮。对方的反馈会作为新的 prompt 进入你的队列，你会被重新唤醒。
4. 收齐反馈后汇总，在最终回答里写出结论。确认不再需要后续工作时，调用 `finish`。

**执行者（第 1 层及以下）**

只做分配给你的那一块，不自行扩大范围。完成后用一次 `send` 把结果摘要回传给分配任务的对话，然后正常结束本轮。摘要要能独立读懂：做了什么、改了哪些文件、结论是什么、还有什么没做。

**审查者**

只读地核验指定的材料或成果，把问题和建议 `send` 回上级。不要直接修改被审查的内容，也不要自己另派任务。

## 边界

- **不要在本轮里等对方回复。** send 是异步的，等待只会浪费一整轮。
- 没有新信息就不要发消息。不要发"收到""好的"这类纯确认。
- 不要互相转述整段历史。让对方自己 `read`。
- 不要为了绕开自己的权限而请别人代做。
- 并行执行者不要改同一个文件；协调者在分工时就要说清楚谁改哪里。

## 收尾

先估算完整往返路径需要几跳几条消息，不要把额度全用在分工上。收到 `wrap_up` 建议后停止扩展，合并发现、回传结果。

操作被限额拒绝时不要循环重试、不要换 ID 或另起协作，改为在本轮最终回答里写清楚四件事：**已完成内容、验证或证据、未完成内容、受限原因及下一步**。最终回答不能只是一句"额度不足"。

"结束本轮"和"结束整项协作"是两件事：执行者完成分工后反馈即可；只有协调者在汇总完成后调用 `finish`。

```json a2a-policy
{
  "version": 1,
  "rootRole": "coordinator",
  "defaultRole": "worker",
  "roles": {
    "coordinator": {
      "allowedOps": ["list", "read", "status", "send", "finish"],
      "targets": { "list": ["all"], "read": ["participants"], "status": ["participants"], "send": ["all"] },
      "delegateRoles": ["worker", "reviewer"],
      "workScope": "按用户目标组织协作、分配工作并汇总，不扩大任务范围"
    },
    "worker": {
      "allowedOps": ["read", "status", "send"],
      "targets": { "read": ["self", "parent"], "status": ["self", "parent"], "send": ["parent"] },
      "delegateRoles": [],
      "workScope": "只处理明确分配的工作；不自行扩大文件修改范围"
    },
    "reviewer": {
      "allowedOps": ["read", "status", "send"],
      "targets": { "read": ["participants"], "status": ["participants"], "send": ["parent"] },
      "delegateRoles": [],
      "workScope": "只读核验分配的材料，给出证据和建议，不直接修改成果"
    }
  },
  "levelCaps": [
    { "from": 2, "allowedOps": ["read", "status", "send"], "delegateRoles": [] }
  ]
}
```

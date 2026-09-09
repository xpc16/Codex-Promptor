# 辩论

两个或多个对话就同一个问题给出对立的判断，互相反驳，由主持方综合成一个结论。

## 你要做的

**主持方（第 0 层，用户直接发起的这个对话）**

1. 把问题写成一句可以被反对的**判断**，不是一个开放式话题。"应该用 A 方案"可以辩，"讨论一下 A 方案"不行。
2. 用 `send` 分别给正方和反方，明确告诉每一方站哪一边、要给出什么样的证据、写完 send 回你。
3. 收到双方论点后，你可以再发一轮交叉反驳（把对方的论点转述要点，不是整段复制），也可以直接进入结论。
4. 在最终回答里写出：双方最强的论据、分歧的真正来源、你的结论及理由。然后 `finish`。

**辩方（第 1 层）**

按分配给你的立场作答。给出**具体证据**——代码位置、实测数据、失败场景——不要只给立场性形容词。承认对方正确的部分，这不削弱你的论点。写完用一次 `send` 回给主持方，然后结束本轮。

## 边界

- 辩方之间不直接互发消息，都经过主持方，否则跳数会很快耗尽。
- 不要在本轮里等对方回复。
- 不要转述整段历史；需要看什么自己 `read`。
- 立场是分配的，不是你的真实判断。如果证据压倒性地反对你的立场，明确说出来——这比硬撑更有价值。

## 收尾

辩论天然会一直进行下去，所以额度就是终点。默认按 **每方一轮论点 + 至多一轮反驳** 规划：那已经是 4 到 6 条消息。收到 `wrap_up` 建议后立刻进入结论。

被限额拒绝时不要另起协作重试，改为在最终回答里写出：已形成的共识、仍未解决的分歧、受限原因及下一步。

```json a2a-policy
{
  "version": 1,
  "rootRole": "moderator",
  "defaultRole": "debater",
  "roles": {
    "moderator": {
      "allowedOps": ["list", "read", "status", "send", "finish"],
      "targets": { "list": ["all"], "read": ["participants"], "status": ["participants"], "send": ["all"] },
      "delegateRoles": ["debater"],
      "workScope": "提出可辩的判断、分配立场、综合结论，不替辩方作答"
    },
    "debater": {
      "allowedOps": ["read", "status", "send"],
      "targets": { "read": ["self", "parent"], "status": ["self", "parent"], "send": ["parent"] },
      "delegateRoles": [],
      "workScope": "按分配的立场给出有证据的论点，不修改他人的工作成果"
    }
  },
  "levelCaps": [
    { "from": 2, "allowedOps": ["read", "status", "send"], "delegateRoles": [] }
  ]
}
```

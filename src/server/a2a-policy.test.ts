import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { A2aSkillError, parseSkillDocument, resolveRolePolicy } from "./a2a-policy.js";
import { a2aAdvice, a2aBudget, DEFAULT_A2A_LIMITS } from "../shared/a2a.js";
import { editedPromptPrefix, parsePromptPrefix } from "../shared/a2a-prefix.js";
import { buildA2aPreamble, unsafePreambleCharacters } from "./a2a-preamble.js";
import { DEFAULT_A2A_LIMITS as LIMITS } from "../shared/a2a.js";

/**
 * The permission list and the prose that explains it live in one file, so the
 * parser is what stops the two from drifting. Everything here is a pure
 * function: no session, no CLI, no model call.
 */

const SKILLS_DIR = path.join(fileURLToPath(new URL("../../", import.meta.url)), "a2a", "skills");

const policyBlock = (json: string) => `# t\n\nprose\n\n\`\`\`json a2a-policy\n${json}\n\`\`\`\n`;

const MINIMAL = policyBlock(JSON.stringify({
  version: 1,
  rootRole: "coordinator",
  defaultRole: "worker",
  roles: {
    coordinator: { allowedOps: ["list", "read", "send", "finish"], targets: { send: ["all"], read: ["participants"] }, delegateRoles: ["worker"], workScope: "组织协作" },
    worker: { allowedOps: ["read", "send"], targets: { send: ["parent"] }, delegateRoles: [] },
  },
  levelCaps: [{ from: 2, allowedOps: ["read"], delegateRoles: [] }],
}, null, 2));

describe("collaboration skills", () => {
  it("keeps the policy out of the text an agent is shown", () => {
    const skill = parseSkillDocument("central", MINIMAL);
    expect(skill.body).toContain("prose");
    expect(skill.body).not.toContain("allowedOps");
    expect(skill.policy.rootRole).toBe("coordinator");
  });

  it("refuses a file with no policy rather than allowing everything", () => {
    expect(() => parseSkillDocument("central", "# only prose\n")).toThrow(A2aSkillError);
  });

  it("refuses a role that is named but never declared", () => {
    const broken = policyBlock(JSON.stringify({
      version: 1,
      rootRole: "coordinator",
      defaultRole: "ghost",
      roles: { coordinator: { allowedOps: ["send"] } },
    }));
    expect(() => parseSkillDocument("x", broken)).toThrow(/ghost/);
  });

  it("refuses a scope written for an operation the role cannot call", () => {
    const broken = policyBlock(JSON.stringify({
      version: 1,
      rootRole: "a",
      defaultRole: "a",
      roles: { a: { allowedOps: ["read"], targets: { send: ["all"] } } },
    }));
    expect(() => parseSkillDocument("x", broken)).toThrow(/TARGET_ORPHAN|scopes send/);
  });

  it("changes its version when the file changes, so a running root can pin one", () => {
    const first = parseSkillDocument("central", MINIMAL);
    const second = parseSkillDocument("central", `${MINIMAL}\nextra\n`);
    expect(second.version).not.toBe(first.version);
  });

  it("narrows a role by every level cap that applies, and never widens it", () => {
    const { policy } = parseSkillDocument("central", MINIMAL);
    expect(resolveRolePolicy(policy, "coordinator", 0).allowedOps).toContain("finish");
    // The cap at level 2 leaves read alone, and takes delegation away.
    const deep = resolveRolePolicy(policy, "coordinator", 3);
    expect(deep.allowedOps).toEqual(["read"]);
    expect(deep.delegateRoles).toEqual([]);
    // A scope for an operation that is no longer allowed is dropped with it.
    expect(deep.targets.send).toBeUndefined();
  });

  it("ships three modes that all parse, and they differ only in the template", async () => {
    for (const name of ["central", "debate", "explore"]) {
      const skill = parseSkillDocument(name, await fs.readFile(path.join(SKILLS_DIR, `${name}.md`), "utf8"));
      expect(skill.policy.version).toBe(1);
      // Every mode must leave a way to report back, or a participant could be
      // given work it has no way to return.
      const root = resolveRolePolicy(skill.policy, skill.policy.rootRole, 0);
      expect(root.allowedOps).toContain("finish");
      const worker = resolveRolePolicy(skill.policy, skill.policy.defaultRole, 1);
      expect(worker.allowedOps).toContain("send");
    }
  });
});

describe("the @@ prefix", () => {
  it("takes the default mode when none is named", () => {
    expect(parsePromptPrefix("@@ 拆一下这个任务")).toEqual({ kind: "a2a", skill: "central", text: "拆一下这个任务" });
  });

  it("takes a named mode", () => {
    expect(parsePromptPrefix("@@debate 应该用 A 方案")).toEqual({ kind: "a2a", skill: "debate", text: "应该用 A 方案" });
  });

  it("does not treat a non-ASCII word as a mode name", () => {
    expect(parsePromptPrefix("@@把这件事分给两个人")).toEqual({ kind: "a2a", skill: "central", text: "把这件事分给两个人" });
  });

  it("leaves an ordinary prompt entirely alone", () => {
    expect(parsePromptPrefix("看看 @@ 这个符号")).toEqual({ kind: "plain", text: "看看 @@ 这个符号" });
  });

  it("lets a prompt start with a literal @@", () => {
    expect(parsePromptPrefix("\\@@ 这是正文")).toEqual({ kind: "plain", text: "@@ 这是正文" });
  });

  it("refuses an empty collaboration", () => {
    expect(() => parsePromptPrefix("@@   ")).toThrow(/协作完成的事/);
  });

});

describe("editing a prompt that is already in the queue", () => {
  // The row sends what its textarea holds and nothing else, so every one of
  // these is decided from the stored prompt alone. A page left open across an
  // upgrade cannot change the answer.
  it("lets a person turn a queued prompt into a collaboration by typing @@ in front of it", () => {
    expect(editedPromptPrefix({ text: "帮我看看这个方案" }, "@@ 帮我看看这个方案"))
      .toEqual({ kind: "a2a", skill: "central", text: "帮我看看这个方案" });
  });

  it("keeps a collaboration a collaboration when its body is edited", () => {
    const stored = { text: "旧正文", a2a: { rootId: "r", skill: "debate", depth: 0, fromTabId: null, fromPromptId: null } };
    expect(editedPromptPrefix(stored, "新正文")).toEqual({ kind: "a2a", skill: "debate", text: "新正文" });
  });

  it("lets a prefix name a different mode on a collaboration that has not started", () => {
    const stored = { text: "正文", a2a: { rootId: "r", skill: "central", depth: 0, fromTabId: null, fromPromptId: null } };
    expect(editedPromptPrefix(stored, "@@debate 正文")).toEqual({ kind: "a2a", skill: "debate", text: "正文" });
  });

  it("keeps a stored literal @@ literal, however it is edited", () => {
    // It was written as `\\@@` on purpose when it was created.
    const stored = { text: "@@ 不是协作" };
    expect(editedPromptPrefix(stored, "@@ 不是协作了")).toEqual({ kind: "plain", text: "@@ 不是协作了" });
  });

  it("still honours an explicit escape typed into an ordinary prompt", () => {
    expect(editedPromptPrefix({ text: "普通" }, "\\@@ 这是正文")).toEqual({ kind: "plain", text: "@@ 这是正文" });
  });
});

describe("what the preamble may contain", () => {
  /**
   * A single U+2192 in the generated text was dropped between the PTY and the
   * Codex transcript. The submitted text no longer equalled what the CLI
   * recorded, submission was never confirmed, and the queue sat in
   * `dispatching` with the answer already written above it. Nothing about that
   * failure is visible, so it is caught here instead.
   */
  const preambleFor = (skillBody: string, role: string, policy: ReturnType<typeof parseSkillDocument>["policy"]) => buildA2aPreamble({
    contextId: "attempt-1",
    skillName: "central",
    skillBody,
    role,
    level: 0,
    permissionMode: "soft",
    effective: resolveRolePolicy(policy, role, 0),
    snapshot: { limits: LIMITS, budget: { revision: 1, usedMessages: 1, remainingMessages: 19, currentDepth: 0, remainingHops: 3, remainingSpawns: 3 }, advice: "continue" },
    helperCommand: 'node "C:\app\scripts\a2a.mjs"',
    selfTabId: "tab-1",
    selfTabName: "协调者",
    from: { tabId: "tab-2", tabName: "执行者", promptId: "p-1" },
  });

  it("flags a character that may not survive the trip", () => {
    expect(unsafePreambleCharacters("可作用范围：list→all")).toEqual(["→"]);
    expect(unsafePreambleCharacters("普通正文，list: all（含中文标点）")).toEqual([]);
  });

  it("generates nothing unsafe for any mode this app ships", async () => {
    for (const name of ["central", "debate", "explore"]) {
      const skill = parseSkillDocument(name, await fs.readFile(path.join(SKILLS_DIR, `${name}.md`), "utf8"));
      for (const role of Object.keys(skill.policy.roles)) {
        const offending = unsafePreambleCharacters(preambleFor(skill.body, role, skill.policy));
        expect(offending, `${name}/${role} would submit ${JSON.stringify(offending)}`).toEqual([]);
      }
    }
  });
});

describe("the budget", () => {
  const root = { limits: DEFAULT_A2A_LIMITS, usedMessages: 1, usedSpawns: 0, revision: 3 };

  it("counts hops from the message being executed, not from the root", () => {
    expect(a2aBudget(root, 2).remainingHops).toBe(1);
    expect(a2aBudget(root, 0).remainingHops).toBe(3);
  });

  it("advises wrapping up before the wall, not at it", () => {
    expect(a2aAdvice(DEFAULT_A2A_LIMITS, a2aBudget(root, 0))).toBe("continue");
    // 20 messages, 20% is 4: at 16 used the advice changes.
    expect(a2aAdvice(DEFAULT_A2A_LIMITS, a2aBudget({ ...root, usedMessages: 16 }, 0))).toBe("wrap_up");
    // One hop left is also a reason to converge, whatever the message count says.
    expect(a2aAdvice(DEFAULT_A2A_LIMITS, a2aBudget(root, 2))).toBe("wrap_up");
  });

  it("says to finish locally once either budget is gone", () => {
    expect(a2aAdvice(DEFAULT_A2A_LIMITS, a2aBudget({ ...root, usedMessages: 20 }, 0))).toBe("finalize_locally");
    expect(a2aAdvice(DEFAULT_A2A_LIMITS, a2aBudget(root, 3))).toBe("finalize_locally");
  });

  it("never reports a negative remainder when a limit was lowered under a running root", () => {
    expect(a2aBudget({ ...root, usedMessages: 40 }, 9).remainingMessages).toBe(0);
    expect(a2aBudget({ ...root, usedMessages: 40 }, 9).remainingHops).toBe(0);
  });
});

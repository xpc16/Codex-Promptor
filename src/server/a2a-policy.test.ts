import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { A2aSkillError, parseSkillDocument, resolveRolePolicy } from "./a2a-policy.js";
import { a2aAdvice, a2aBudget, DEFAULT_A2A_LIMITS } from "../shared/a2a.js";
import { parsePromptPrefix, restorePromptPrefix } from "../shared/a2a-prefix.js";

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

  it("round-trips: what the composer shows back parses to the same thing", () => {
    const parsed = parsePromptPrefix("@@debate 应该用 A 方案");
    const shown = restorePromptPrefix(parsed.text, { rootId: "r", skill: "debate", depth: 0, fromTabId: null, fromPromptId: null });
    expect(parsePromptPrefix(shown)).toEqual(parsed);
  });

  it("re-escapes a plain prompt that happens to begin with @@", () => {
    expect(parsePromptPrefix(restorePromptPrefix("@@ 不是协作", null))).toEqual({ kind: "plain", text: "@@ 不是协作" });
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

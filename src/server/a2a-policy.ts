import { createHash } from "node:crypto";
import { z } from "zod";
import { A2A_SKILL_NAME_PATTERN } from "../shared/a2a.js";

/**
 * A collaboration skill is one Markdown file. Its prose is the method; a
 * single fenced `json a2a-policy` block inside it is the permission list, so
 * there is never a second hand-written copy to drift from the text a reader
 * is looking at (docs/AGENT_TO_AGENT.md §4.3).
 */

export const A2A_OPS = ["list", "read", "status", "send", "spawn", "pause", "resume", "interrupt", "finish"] as const;
export type A2aOp = (typeof A2A_OPS)[number];

/** Scopes the server can resolve from its own membership records. Not a query language. */
export const A2A_SCOPES = ["self", "parent", "participants", "all"] as const;
export type A2aScope = (typeof A2A_SCOPES)[number];

const OpSchema = z.enum(A2A_OPS);

const RolePolicySchema = z.object({
  allowedOps: z.array(OpSchema),
  // Zod 4 makes an enum-keyed record exhaustive; the keys are checked below instead.
  targets: z.record(z.string(), z.array(z.enum(A2A_SCOPES))).default({}),
  delegateRoles: z.array(z.string()).default([]),
  workScope: z.string().default(""),
});
export type A2aRolePolicy = Omit<z.infer<typeof RolePolicySchema>, "targets"> & { targets: Partial<Record<A2aOp, A2aScope[]>> };

const LevelCapSchema = z.object({
  from: z.number().int().nonnegative(),
  allowedOps: z.array(OpSchema).optional(),
  delegateRoles: z.array(z.string()).optional(),
});

export const A2aPolicySchema = z.object({
  version: z.literal(1),
  rootRole: z.string(),
  defaultRole: z.string(),
  roles: z.record(z.string(), RolePolicySchema),
  levelCaps: z.array(LevelCapSchema).default([]),
});
export type A2aPolicy = z.infer<typeof A2aPolicySchema>;

export type A2aSkill = {
  name: string;
  /** The whole file minus the policy block: what an agent is actually shown. */
  body: string;
  policy: A2aPolicy;
  /** Content hash, frozen onto the root so a later edit cannot change a running collaboration. */
  version: string;
};

export class A2aSkillError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "A2aSkillError";
  }
}

const POLICY_FENCE = /^```json a2a-policy[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m;

/**
 * Parse and validate one skill file.
 *
 * A malformed policy is an error at load time, never a silent "allow
 * everything": a file a reader believes narrows an agent must not widen it by
 * failing to parse.
 */
export function parseSkillDocument(name: string, markdown: string): A2aSkill {
  if (!A2A_SKILL_NAME_PATTERN.test(name)) throw new A2aSkillError("A2A_SKILL_NAME_INVALID", `Skill name ${name} is not [a-z0-9_-]+.`);
  const match = POLICY_FENCE.exec(markdown);
  if (!match) throw new A2aSkillError("A2A_POLICY_MISSING", `Skill ${name} has no \`json a2a-policy\` block.`);
  if (POLICY_FENCE.exec(markdown.slice(match.index + match[0].length))) {
    throw new A2aSkillError("A2A_POLICY_DUPLICATE", `Skill ${name} declares more than one policy block.`);
  }
  let raw: unknown;
  try { raw = JSON.parse(match[1]); }
  catch (error) { throw new A2aSkillError("A2A_POLICY_INVALID_JSON", `Skill ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  const parsed = A2aPolicySchema.safeParse(raw);
  if (!parsed.success) throw new A2aSkillError("A2A_POLICY_INVALID", `Skill ${name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  const policy = parsed.data;
  const roles = Object.keys(policy.roles);
  for (const role of [policy.rootRole, policy.defaultRole]) {
    if (!roles.includes(role)) throw new A2aSkillError("A2A_POLICY_ROLE_UNKNOWN", `Skill ${name}: role ${role} is not declared.`);
  }
  for (const [role, declared] of Object.entries(policy.roles)) {
    for (const delegate of declared.delegateRoles) {
      if (!roles.includes(delegate)) throw new A2aSkillError("A2A_POLICY_ROLE_UNKNOWN", `Skill ${name}: ${role} may delegate to undeclared role ${delegate}.`);
    }
    for (const op of Object.keys(declared.targets)) {
      if (!A2A_OPS.includes(op as A2aOp)) throw new A2aSkillError("A2A_POLICY_TARGET_UNKNOWN", `Skill ${name}: ${role} scopes unknown operation ${op}.`);
      if (!declared.allowedOps.includes(op as A2aOp)) throw new A2aSkillError("A2A_POLICY_TARGET_ORPHAN", `Skill ${name}: ${role} scopes ${op}, which it is not allowed to call.`);
    }
  }
  for (const cap of policy.levelCaps) {
    for (const delegate of cap.delegateRoles ?? []) {
      if (!roles.includes(delegate)) throw new A2aSkillError("A2A_POLICY_ROLE_UNKNOWN", `Skill ${name}: level cap delegates to undeclared role ${delegate}.`);
    }
  }
  const body = `${markdown.slice(0, match.index)}${markdown.slice(match.index + match[0].length)}`.replace(/\n{3,}/g, "\n\n").trim();
  return { name, body, policy, version: createHash("sha1").update(markdown).digest("hex").slice(0, 12) };
}

/**
 * The effective policy for one participant: its role, narrowed by every level
 * cap that applies to it. Caps intersect -- a deeper level can only ever be
 * allowed less than the role alone would allow, never more.
 */
export function resolveRolePolicy(policy: A2aPolicy, role: string, level: number): A2aRolePolicy {
  const declared = policy.roles[role];
  if (!declared) throw new A2aSkillError("A2A_ROLE_UNKNOWN", `Role ${role} is not declared by this skill.`);
  let allowedOps = [...declared.allowedOps];
  let delegateRoles = [...declared.delegateRoles];
  for (const cap of policy.levelCaps) {
    if (level < cap.from) continue;
    if (cap.allowedOps) allowedOps = allowedOps.filter((op) => cap.allowedOps!.includes(op));
    if (cap.delegateRoles) delegateRoles = delegateRoles.filter((candidate) => cap.delegateRoles!.includes(candidate));
  }
  const targets: A2aRolePolicy["targets"] = {};
  for (const op of allowedOps) {
    const scopes = declared.targets[op];
    if (scopes) targets[op] = scopes as A2aScope[];
  }
  return { allowedOps, targets, delegateRoles, workScope: declared.workScope };
}

/** The permission paragraph injected into a dispatch. Generated, never hand-maintained. */
export function describeRolePolicy(role: string, level: number, effective: A2aRolePolicy, mode: "soft" | "hard"): string {
  const targetLine = Object.entries(effective.targets)
    .map(([op, scopes]) => `${op}→${(scopes ?? []).join("/")}`)
    .join("，");
  return [
    `当前角色：${role}（第 ${level} 层，${mode === "soft" ? "软约束：服务端不因角色规则拒绝，请自行遵守" : "硬约束：越界会被服务端拒绝"}）`,
    `可用操作：${effective.allowedOps.join("、") || "（无）"}`,
    targetLine ? `可作用范围：${targetLine}` : "",
    effective.delegateRoles.length ? `可分配的下级角色：${effective.delegateRoles.join("、")}` : "不可继续委派。",
    effective.workScope ? `工作范围：${effective.workScope}` : "",
    "不得通过请求他人代为执行来绕过以上限制。",
  ].filter(Boolean).join("\n");
}

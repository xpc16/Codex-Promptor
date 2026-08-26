import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Reading Codex history from the rollout file instead of the App Server.
 *
 * `thread/read` does not read the rollout; it serves a SQLite projection that a
 * background pass builds from it, tracked by a per-thread byte cursor. When that
 * projection stalls -- observed after a turn is interrupted and left without a
 * terminal record -- the cursor parks and every later turn becomes invisible to
 * the API, including turns run outside Promptor. The rollout itself is the
 * append-only source of truth, so history sync falls back to it and unions in
 * whatever the projection has not caught up with.
 */
export type CodexRolloutTurn = {
  id: string;
  status: "completed" | "interrupted" | "running";
  startedAt: string | null;
  completedAt: string | null;
  items: Array<Record<string, unknown>>;
};

type Draft = {
  id: string;
  startedAt: string | null;
  completedAt: string | null;
  status: CodexRolloutTurn["status"];
  order: number;
  userTexts: string[];
  clientId: string | null;
  finalAnswer: string | null;
  lastAgentText: string | null;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (typeof part === "string" ? part : String(part?.text ?? "")))
    .join("")
    .trim();
}

/** Rollout timestamps are ISO strings; the event payloads carry epoch seconds or millis. */
function timeOf(...values: unknown[]): string | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "number") {
      const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
      continue;
    }
    const date = new Date(String(value));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

export function parseCodexRollout(contents: string, threadId: string): { id: string; sessionId: string; turns: CodexRolloutTurn[] } {
  const drafts = new Map<string, Draft>();
  let order = 0;
  const draftFor = (turnId: string): Draft => {
    const existing = drafts.get(turnId);
    if (existing) return existing;
    const created: Draft = {
      id: turnId,
      startedAt: null,
      completedAt: null,
      // A turn with no terminal event is still in flight; syncHistory leaves
      // running turns to the live path rather than importing a half answer.
      status: "running",
      order: order += 1,
      userTexts: [],
      clientId: null,
      finalAnswer: null,
      lastAgentText: null,
    };
    drafts.set(turnId, created);
    return created;
  };

  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record?.payload;
    const kind = String(payload?.type ?? "");
    const turnId = String(payload?.turn_id ?? payload?.turnId ?? "");
    if (!turnId) continue;

    if (kind === "task_started") {
      const draft = draftFor(turnId);
      draft.startedAt = timeOf(payload.started_at, payload.startedAt, record.timestamp) ?? draft.startedAt;
      continue;
    }
    if (kind === "task_complete") {
      const draft = draftFor(turnId);
      draft.status = "completed";
      draft.completedAt = timeOf(record.timestamp, payload.completed_at) ?? draft.completedAt;
      // The event carries the answer verbatim, which is more reliable than
      // guessing which of the turn's agent messages was the closing one.
      const answer = String(payload.last_agent_message ?? payload.lastAgentMessage ?? "").trim();
      if (answer) draft.finalAnswer = answer;
      continue;
    }
    if (kind === "turn_aborted" || kind === "turn_failed") {
      const draft = draftFor(turnId);
      draft.status = "interrupted";
      draft.completedAt = timeOf(record.timestamp) ?? draft.completedAt;
      continue;
    }
    if (kind !== "item_completed") continue;

    const item = payload?.item;
    const itemType = String(item?.type ?? "").toLowerCase();
    if (itemType === "usermessage") {
      const draft = draftFor(turnId);
      const text = textOf(item?.content);
      if (text) draft.userTexts.push(text);
      const clientId = String(item?.client_id ?? item?.clientId ?? "");
      if (clientId) draft.clientId = clientId;
      draft.startedAt = draft.startedAt ?? timeOf(payload.started_at_ms, record.timestamp);
      continue;
    }
    if (itemType === "agentmessage") {
      const draft = draftFor(turnId);
      const text = textOf(item?.content);
      if (text) draft.lastAgentText = text;
    }
  }

  const turns: CodexRolloutTurn[] = [];
  for (const draft of [...drafts.values()].sort((a, b) => a.order - b.order)) {
    if (!draft.userTexts.length) continue;
    const items: Array<Record<string, unknown>> = [{
      type: "userMessage",
      text: draft.userTexts.join("\n\n"),
      ...(draft.clientId ? { clientId: draft.clientId } : {}),
    }];
    // Only a completed turn gets a final answer. An interrupted turn keeps its
    // last commentary so the card shows what was produced, tagged as partial.
    if (draft.finalAnswer) items.push({ type: "agentMessage", phase: "final_answer", text: draft.finalAnswer });
    else if (draft.lastAgentText && draft.status !== "running") items.push({ type: "agentMessage", phase: "partial_answer", text: draft.lastAgentText });
    turns.push({ id: draft.id, status: draft.status, startedAt: draft.startedAt, completedAt: draft.completedAt, items });
  }
  return { id: threadId, sessionId: threadId, turns };
}

export async function locateCodexRollout(threadId: string, hintedPath?: string | null): Promise<string | null> {
  if (hintedPath) {
    try {
      const stat = await fs.stat(hintedPath);
      if (stat.isFile()) return path.resolve(hintedPath);
    } catch { /* fall through to the sessions search */ }
  }
  const sessionsRoot = path.join(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")), "sessions");
  const wanted = `${threadId}.jsonl`.toLowerCase();
  const stack = [sessionsRoot];
  while (stack.length) {
    const directory = stack.pop()!;
    let entries: Array<import("node:fs").Dirent>;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.name.toLowerCase().endsWith(wanted)) return candidate;
    }
  }
  return null;
}

/**
 * Union of what the App Server knows and what the rollout shows. The API result
 * stays authoritative for turns it does return -- it carries richer items -- and
 * the rollout only supplies turns the stalled projection never reached.
 */
export function mergeRolloutTurns(thread: any, rolloutTurns: CodexRolloutTurn[]): any {
  const known = new Set((Array.isArray(thread?.turns) ? thread.turns : []).map((turn: any) => String(turn?.id ?? turn?.turnId ?? "")));
  const missing = rolloutTurns.filter((turn) => turn.id && !known.has(turn.id));
  if (!missing.length) return thread;
  return { ...thread, turns: [...(Array.isArray(thread?.turns) ? thread.turns : []), ...missing] };
}

/**
 * Best effort by design: a rollout that cannot be found or read must never
 * break a sync that the App Server alone can already satisfy.
 */
export async function withCodexRolloutTurns(thread: any, threadId: string): Promise<any> {
  if (!threadId) return thread;
  try {
    const file = await locateCodexRollout(threadId, typeof thread?.path === "string" ? thread.path : null);
    if (!file) return thread;
    return mergeRolloutTurns(thread, parseCodexRollout(await fs.readFile(file, "utf8"), threadId).turns);
  } catch { return thread; }
}

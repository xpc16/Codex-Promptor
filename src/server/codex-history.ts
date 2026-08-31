import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { historyThreadFromResponse } from "./history.js";

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
export type CodexRolloutThread = { id: string; sessionId: string; turns: CodexRolloutTurn[] };

export type CodexRolloutTurn = {
  id: string;
  status: "completed" | "interrupted" | "running";
  startedAt: string | null;
  completedAt: string | null;
  items: Array<Record<string, unknown>>;
};

type Draft = {
  id: string;
  /** Byte offset of the line that first mentioned this turn, used as a resume point. */
  startOffset: number;
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

/**
 * Legacy/early Codex rollouts persist transport context as user-role messages
 * next to the actual prompt. Keep only human input; otherwise every imported
 * turn displays the same environment/plugin envelope instead of its prompt.
 */
function userTextOf(content: unknown): string {
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map((part: any) => typeof part === "string" ? part : String(part?.text ?? part?.input_text ?? ""))
    .map((text) => text.trim())
    .filter((text) => text && !isTransportUserEnvelope(text))
    .join("\n\n")
    .trim();
}

function isTransportUserEnvelope(text: string): boolean {
  return /^\s*<(?:recommended_plugins|environment_context|permissions_instructions|apps_instructions|plugins_instructions|skills_instructions)\b/i.test(text)
    || /^\s*\/compact(?:\s|$)/i.test(text);
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

type RolloutParser = {
  push(line: string, startOffset?: number): void;
  finish(): CodexRolloutThread;
  /**
   * Where a later read of the same rollout must resume so nothing that could
   * still change is missed: the first byte of the earliest turn without a
   * terminal event, or the end of what was read once every turn has finished.
   */
  resumeOffset(endOffset: number): number;
};

/**
 * Consumes a rollout one line at a time so it never has to exist in memory as a
 * whole. The largest rollouts on this machine are over 200MB, and holding one
 * as a string and again as the array it splits into costs far more than the
 * handful of fields this keeps.
 */
function createRolloutParser(threadId: string): RolloutParser {
  const drafts = new Map<string, Draft>();
  let order = 0;
  let lineOffset = 0;
  let activeTurnId: string | null = null;
  const draftFor = (turnId: string): Draft => {
    const existing = drafts.get(turnId);
    if (existing) return existing;
    const created: Draft = {
      id: turnId,
      startOffset: lineOffset,
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

  const push = (line: string, startOffset = 0): void => {
    lineOffset = startOffset;
    if (!line.trim()) return;
    let record: any;
    try { record = JSON.parse(line); } catch { return; }
    const payload = record?.payload;
    const kind = String(payload?.type ?? "");
    const turnId = String(payload?.turn_id ?? payload?.turnId ?? "");

    if (kind === "task_started") {
      if (!turnId) return;
      activeTurnId = turnId;
      const draft = draftFor(turnId);
      draft.startedAt = timeOf(payload.started_at, payload.startedAt, record.timestamp) ?? draft.startedAt;
      return;
    }
    if (kind === "task_complete") {
      if (!turnId) return;
      const draft = draftFor(turnId);
      draft.status = "completed";
      draft.completedAt = timeOf(record.timestamp, payload.completed_at) ?? draft.completedAt;
      // The event carries the answer verbatim, which is more reliable than
      // guessing which of the turn's agent messages was the closing one.
      const answer = String(payload.last_agent_message ?? payload.lastAgentMessage ?? "").trim();
      if (answer) draft.finalAnswer = answer;
      if (activeTurnId === turnId) activeTurnId = null;
      return;
    }
    if (kind === "turn_aborted" || kind === "turn_failed") {
      if (!turnId) return;
      const draft = draftFor(turnId);
      draft.status = "interrupted";
      draft.completedAt = timeOf(record.timestamp) ?? draft.completedAt;
      if (activeTurnId === turnId) activeTurnId = null;
      return;
    }

    // Before paginated history, turn content was written as response_item
    // messages. Their direct payload has no turn_id, but the passthrough
    // metadata does; activeTurnId is a fallback for still older samples.
    if (String(record?.type ?? "") === "response_item" && kind === "message") {
      const responseTurnId = String(
        payload?.internal_chat_message_metadata_passthrough?.turn_id
        ?? payload?.internalChatMessageMetadataPassthrough?.turnId
        ?? activeTurnId
        ?? "",
      );
      if (!responseTurnId) return;
      const role = String(payload?.role ?? "").toLowerCase();
      if (role === "user") {
        const text = userTextOf(payload?.content);
        if (!text) return;
        const draft = draftFor(responseTurnId);
        if (!draft.userTexts.includes(text)) draft.userTexts.push(text);
        draft.startedAt = draft.startedAt ?? timeOf(record.timestamp);
        return;
      }
      if (role === "assistant") {
        const text = textOf(payload?.content);
        if (!text) return;
        const draft = draftFor(responseTurnId);
        draft.lastAgentText = text;
        if (String(payload?.phase ?? "").toLowerCase() === "final_answer") draft.finalAnswer = text;
      }
      return;
    }

    if (!turnId) return;
    if (kind !== "item_completed") return;

    const item = payload?.item;
    const itemType = String(item?.type ?? "").toLowerCase();
    if (itemType === "usermessage") {
      const draft = draftFor(turnId);
      const text = textOf(item?.content);
      if (text && !draft.userTexts.includes(text)) draft.userTexts.push(text);
      const clientId = String(item?.client_id ?? item?.clientId ?? "");
      if (clientId) draft.clientId = clientId;
      draft.startedAt = draft.startedAt ?? timeOf(payload.started_at_ms, record.timestamp);
      return;
    }
    if (itemType === "agentmessage") {
      const draft = draftFor(turnId);
      const text = textOf(item?.content);
      if (text) draft.lastAgentText = text;
    }
  };

  const finish = (): CodexRolloutThread => {
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
  };

  const resumeOffset = (endOffset: number): number => {
    // A thread runs one turn at a time, so a turn still marked running with a
    // later turn already finished after it never got its terminal event and
    // never will. Without this an abandoned turn pins the resume point forever:
    // one conversation here re-read 61MB on every launch because of a turn
    // stranded 23 turns from the end. Nothing is lost by moving past it -- it
    // stays in the cache exactly as it is, and syncHistory does not import a
    // running turn anyway.
    let lastSettled = 0;
    for (const draft of drafts.values()) {
      if (draft.status !== "running" && draft.order > lastSettled) lastSettled = draft.order;
    }
    let earliest = endOffset;
    for (const draft of drafts.values()) {
      if (draft.status !== "running" || draft.order < lastSettled) continue;
      if (draft.startOffset < earliest) earliest = draft.startOffset;
    }
    return earliest;
  };

  return { push, finish, resumeOffset };
}

export function parseCodexRollout(contents: string, threadId: string): CodexRolloutThread {
  const parser = createRolloutParser(threadId);
  let offset = 0;
  for (const line of contents.split(/\r?\n/)) {
    parser.push(line, offset);
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return parser.finish();
}

/**
 * Feeds complete lines from a byte offset, reporting the offset just past the
 * last complete one.
 *
 * Lines are split on the newline byte rather than through readline because the
 * caller needs exact byte offsets to resume from and readline reports none. A
 * 0x0A byte cannot occur inside a multi-byte UTF-8 sequence, so splitting
 * before decoding is safe.
 *
 * A trailing line with no newline is still handed to the parser -- a rollout
 * whose last record has no newline yet is complete data, and dropping it would
 * lose the turn that settles a queue prompt -- but the returned offset stops
 * before it, so the next read sees it again once it is terminated.
 */
async function feedRolloutLines(
  file: string,
  from: number,
  to: number | null,
  push: (line: string, startOffset: number) => void,
): Promise<number> {
  if (to !== null && to <= from) return from;
  let buffer: Buffer = Buffer.alloc(0);
  let bufferStart = from;
  const stream = createReadStream(file, to === null ? { start: from } : { start: from, end: to - 1 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    let index = buffer.indexOf(0x0a);
    while (index !== -1) {
      const line = buffer.subarray(0, index).toString("utf8");
      push(line.endsWith("\r") ? line.slice(0, -1) : line, bufferStart);
      bufferStart += index + 1;
      buffer = buffer.subarray(index + 1);
      index = buffer.indexOf(0x0a);
    }
  }
  // Only an open-ended read may hand over a line with no newline yet: there it
  // is a record still being written and is real data. Inside a bound it is
  // whatever happened to straddle the cut, which belongs to the other side.
  if (buffer.length && to === null) {
    const line = buffer.toString("utf8");
    push(line.endsWith("\r") ? line.slice(0, -1) : line, bufferStart);
  }
  return bufferStart;
}

export type CodexRolloutSlice = {
  turns: CodexRolloutTurn[];
  /** Where the next read must start so no turn that could still change is missed. */
  resumeOffset: number;
  /** Offset just past the last complete line in the file. */
  endOffset: number;
};

/** The turns a rollout records between two byte offsets; `to` null means to the end. */
export async function readCodexRolloutSlice(
  file: string,
  threadId: string,
  from = 0,
  to: number | null = null,
): Promise<CodexRolloutSlice> {
  const parser = createRolloutParser(threadId);
  const endOffset = await feedRolloutLines(file, from, to, (line, startOffset) => parser.push(line, startOffset));
  return { turns: parser.finish().turns, resumeOffset: parser.resumeOffset(endOffset), endOffset };
}

/**
 * Where a forked thread's history came from.
 *
 * Rewinding a turn in the TUI does not edit the thread, it forks it: Codex
 * starts a new thread with a new id whose rollout begins empty apart from a
 * `session_meta` record naming the parent and the exact byte of the parent's
 * rollout the fork was taken at. Everything before that byte is this thread's
 * history and lives in the parent's file; reading only the fork's own rollout
 * finds no turns at all.
 */
export type RolloutHistoryBase = { threadId: string; endByteOffset: number };

/** How far in the opening record is looked for. Session metadata carries the whole system prompt. */
const SESSION_META_SCAN_BYTES = 8 * 1024 * 1024;

export async function readRolloutHistoryBase(file: string): Promise<RolloutHistoryBase | null> {
  let head: string | null = null;
  let buffer: Buffer = Buffer.alloc(0);
  const stream = createReadStream(file, { start: 0, end: SESSION_META_SCAN_BYTES - 1 });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      const index = buffer.indexOf(0x0a);
      if (index === -1) continue;
      head = buffer.subarray(0, index).toString("utf8");
      break;
    }
  } finally {
    stream.destroy();
  }
  if (head === null) return null;
  let record: any;
  try { record = JSON.parse(head); } catch { return null; }
  const base = record?.payload?.history_base ?? record?.payload?.historyBase;
  const threadId = String(base?.thread_id ?? base?.threadId ?? "");
  const endByteOffset = Number(base?.end_byte_offset ?? base?.endByteOffset);
  if (!threadId || !Number.isSafeInteger(endByteOffset) || endByteOffset <= 0) return null;
  return { threadId, endByteOffset };
}

/** The same parse, fed from disk, so file size bounds the time it takes and not the memory it needs. */
export async function readCodexRollout(file: string, threadId: string): Promise<CodexRolloutThread> {
  return { id: threadId, sessionId: threadId, turns: (await readCodexRolloutSlice(file, threadId, 0)).turns };
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

/** A thread's turns as its rollout records them, or null when no rollout has been written yet. */
export async function readCodexRolloutThread(threadId: string, hintedPath: string | null = null): Promise<CodexRolloutThread | null> {
  if (!threadId) return null;
  const file = await locateCodexRollout(threadId, hintedPath);
  if (!file) return null;
  return readCodexRollout(file, threadId);
}

/**
 * Best effort by design: a rollout that cannot be found or read must never
 * break a sync that the App Server alone can already satisfy.
 */
/**
 * How a rollout is turned into turns. The default reads the whole file, which
 * is the only thing a caller with nowhere to keep a cache can do; a caller that
 * owns a tab passes one that reads only the tail.
 */
export type RolloutReader = (file: string, threadId: string) => Promise<CodexRolloutThread>;

export async function withCodexRolloutTurns(
  thread: any,
  threadId: string,
  readRollout: RolloutReader = readCodexRollout,
): Promise<any> {
  if (!threadId) return thread;
  try {
    const file = await locateCodexRollout(threadId, typeof thread?.path === "string" ? thread.path : null);
    if (!file) return thread;
    return mergeRolloutTurns(thread, (await readRollout(file, threadId)).turns);
  } catch { return thread; }
}

export type CodexHistoryRpc = {
  readThread(threadId: string, timeoutMs?: number): Promise<any>;
  readThreadSummary(threadId: string, timeoutMs?: number): Promise<any>;
};

/**
 * History for a thread, taking the rollout first and the App Server only as a
 * fallback.
 *
 * `thread/read` with `includeTurns` returns the entire conversation in one
 * WebSocket frame, so its cost grows without bound while the fields syncHistory
 * actually uses -- the prompt text, its client id, and the final answer -- are
 * all recoverable from the rollout on disk. Asking for the summary instead
 * keeps that transfer flat, and the projection is still consulted for a thread
 * whose rollout has not been written yet, which is the one case the file cannot
 * answer.
 */
export async function readCodexThreadForHistory(
  rpc: CodexHistoryRpc,
  threadId: string,
  readRollout: RolloutReader = readCodexRollout,
): Promise<any> {
  const fromRollout = await withCodexRolloutTurns(historyThreadFromResponse(await rpc.readThreadSummary(threadId)), threadId, readRollout);
  if (Array.isArray(fromRollout?.turns) && fromRollout.turns.length) return fromRollout;
  return withCodexRolloutTurns(historyThreadFromResponse(await rpc.readThread(threadId)), threadId, readRollout);
}

import { promises as fs } from "node:fs";
import type { SubmitEvidence } from "./prompt-submit.js";
import { sameSubmittedPrompt } from "./prompt-submit.js";
import { readCodexRolloutSlice } from "./codex-history.js";

const MAX_INCREMENT_BYTES = 8 * 1024 * 1024;
const CLAUDE_END_REASONS = new Set(["end_turn", "stop_sequence", "refusal"]);

export type TranscriptCursor = {
  path: string | null;
  offset: number;
  /** Cursor JSON transcripts are rewritten documents, not append-only JSONL. */
  format?: "jsonl" | "json";
  recordCount?: number;
};
export type ReconciledTurn = {
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  startedAt: string | null;
  completedAt: string | null;
  answer: string;
};

export async function transcriptCursor(filePath: string | null | undefined): Promise<TranscriptCursor> {
  if (!filePath) return { path: null, offset: 0 };
  try {
    const stat = await fs.stat(filePath);
    if (/\.json$/i.test(filePath) && stat.size <= MAX_INCREMENT_BYTES) {
      const records = jsonDocumentRecords(await fs.readFile(filePath, "utf8"));
      if (records) return { path: filePath, offset: stat.size, format: "json", recordCount: records.length };
    }
    return { path: filePath, offset: await completeLineOffset(filePath, stat.size), format: "jsonl" };
  }
  catch { return { path: filePath, offset: 0 }; }
}

/**
 * Snapshot only through the last newline. Providers append JSONL in chunks;
 * starting a later read at a transient EOF inside a UTF-8/JSON record would
 * permanently turn its remainder into an unknown shape.
 */
async function completeLineOffset(filePath: string, size: number): Promise<number> {
  if (size <= 0) return 0;
  const handle = await fs.open(filePath, "r");
  try {
    const chunkSize = 64 * 1024;
    const maximum = Math.min(size, MAX_INCREMENT_BYTES);
    let searched = 0;
    while (searched < maximum) {
      const length = Math.min(chunkSize, maximum - searched);
      const start = size - searched - length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline !== -1) {
        const boundary = start + newline + 1;
        if (boundary === size) return size;
        const tail = Buffer.alloc(size - boundary);
        const result = await handle.read(tail, 0, tail.length, boundary);
        try {
          JSON.parse(tail.subarray(0, result.bytesRead).toString("utf8"));
          return size;
        } catch {
          return boundary;
        }
      }
      searched += length;
    }
    // A single unfinished record larger than the bounded scan is not safe to
    // classify. Re-reading from zero is conservative and remains locally
    // bounded by the reconciliation parser's 8 MiB guard.
    if (size <= MAX_INCREMENT_BYTES) {
      const whole = Buffer.alloc(size);
      const result = await handle.read(whole, 0, size, 0);
      try {
        JSON.parse(whole.subarray(0, result.bytesRead).toString("utf8"));
        return size;
      } catch { /* the only line is incomplete */ }
    }
    return 0;
  } finally {
    await handle.close();
  }
}

export async function inspectClaudeSubmission(
  cursor: TranscriptCursor,
  prompt: string,
): Promise<SubmitEvidence> {
  const read = await readIncrement(cursor);
  if (!read) return { state: "unknown", reason: "CLAUDE_TRANSCRIPT_UNAVAILABLE" };
  let sawRecognizedUser = false;
  for (const record of read.records) {
    const candidate = claudeHumanPrompt(record);
    if (!candidate) continue;
    sawRecognizedUser = true;
    if (!sameSubmittedPrompt(candidate.text, prompt)) continue;
    return { state: "accepted", turnId: candidate.turnId };
  }
  if (sawRecognizedUser) return { state: "unknown", reason: "CLAUDE_PROMPT_AMBIGUOUS" };
  return read.known ? { state: "not-submitted" } : { state: "unknown", reason: "CLAUDE_TRANSCRIPT_SHAPE_UNKNOWN" };
}

export async function inspectCodexSubmission(
  cursor: TranscriptCursor,
  prompt: string,
  threadId: string,
): Promise<SubmitEvidence> {
  if (!cursor.path) return { state: "unknown", reason: "CODEX_ROLLOUT_UNAVAILABLE" };
  let size: number;
  try { size = (await fs.stat(cursor.path)).size; }
  catch { return { state: "unknown", reason: "CODEX_ROLLOUT_UNAVAILABLE" }; }
  if (size < cursor.offset) return { state: "unknown", reason: "CODEX_ROLLOUT_REPLACED" };
  // No persistent evidence appeared, so retrying only Enter is safe: the text
  // remains in the TUI input and is never pasted a second time.
  if (size === cursor.offset) return { state: "not-submitted" };
  try {
    const slice = await readCodexRolloutSlice(cursor.path, threadId, cursor.offset);
    for (const turn of slice.turns) {
      const candidate = turnPrompt(turn.items);
      if (candidate && sameSubmittedPrompt(candidate, prompt)) {
        return { state: "accepted", turnId: turn.id, turn, items: turn.items };
      }
    }
    // Some bytes appeared but none formed the expected, versioned user-turn
    // shape. This is not evidence that submission failed; fail closed so an
    // unknown Codex upgrade can never cause a duplicate prompt.
    return { state: "unknown", reason: slice.turns.length ? "CODEX_PROMPT_AMBIGUOUS" : "CODEX_ROLLOUT_SHAPE_UNKNOWN" };
  } catch {
    return { state: "unknown", reason: "CODEX_ROLLOUT_READ_FAILED" };
  }
}

export async function reconcileCodexTurn(
  cursor: TranscriptCursor,
  threadId: string,
  turnId: string,
  prompt: string,
): Promise<ReconciledTurn | null> {
  if (!cursor.path) return null;
  try {
    const slice = await readCodexRolloutSlice(cursor.path, threadId, cursor.offset);
    const turn = slice.turns.find((candidate) => candidate.id === turnId)
      ?? slice.turns.find((candidate) => sameSubmittedPrompt(turnPrompt(candidate.items), prompt));
    if (!turn || turn.status === "running") return null;
    return {
      turnId: turn.id,
      status: turn.status === "completed" ? "completed" : "interrupted",
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      answer: turnAnswer(turn.items),
    };
  } catch { return null; }
}

export async function reconcileClaudeTurn(
  cursor: TranscriptCursor,
  turnId: string,
  prompt: string,
): Promise<ReconciledTurn | null> {
  const read = await readIncrement(cursor);
  if (!read) return null;
  let startedAt: string | null = null;
  const answers: string[] = [];
  let completedAt: string | null = null;
  let ended = false;
  for (const record of read.records) {
    const candidate = claudeHumanPrompt(record);
    if (candidate && (candidate.turnId === turnId || sameSubmittedPrompt(candidate.text, prompt))) {
      startedAt = isoTime(record?.timestamp) ?? startedAt;
      continue;
    }
    if (record?.type !== "assistant" || String(record?.message?.role ?? "assistant") !== "assistant") continue;
    const text = contentText(record?.message?.content ?? record?.content).trim();
    if (text && !answers.includes(text)) answers.push(text);
    if (CLAUDE_END_REASONS.has(String(record?.message?.stop_reason ?? record?.stop_reason ?? ""))) {
      ended = true;
      completedAt = isoTime(record?.timestamp) ?? completedAt;
    }
  }
  if (!ended) return null;
  return { turnId, status: "completed", startedAt, completedAt, answer: answers.join("") };
}

export async function inspectCursorSubmission(
  cursor: TranscriptCursor,
  prompt: string,
): Promise<SubmitEvidence> {
  const read = await readIncrement(cursor);
  if (!read) return { state: "unknown", reason: "CURSOR_TRANSCRIPT_UNAVAILABLE" };
  let sawRecognizedUser = false;
  for (const [index, record] of read.records.entries()) {
    const event = String(record?.hook_event_name ?? record?.type ?? "");
    const role = String(record?.message?.role ?? record?.role ?? "");
    if (event !== "beforeSubmitPrompt" && event !== "user" && role !== "user") continue;
    const candidate = String(record?.prompt ?? contentText(record?.message?.content ?? record?.content)).trim();
    if (!candidate || containsToolResult(record?.message?.content ?? record?.content)) continue;
    sawRecognizedUser = true;
    if (!sameSubmittedPrompt(candidate, prompt)) continue;
    const turnId = String(record?.generation_id ?? record?.generationId ?? record?.id ?? `cursor-turn-${cursor.offset + index}`);
    return { state: "accepted", turnId };
  }
  if (sawRecognizedUser) return { state: "unknown", reason: "CURSOR_PROMPT_AMBIGUOUS" };
  return read.known ? { state: "not-submitted" } : { state: "unknown", reason: "CURSOR_TRANSCRIPT_SHAPE_UNKNOWN" };
}

export async function reconcileCursorTurn(cursor: TranscriptCursor, turnId: string): Promise<ReconciledTurn | null> {
  const read = await readIncrement(cursor);
  if (!read) return null;
  let startedAt: string | null = null;
  let completedAt: string | null = null;
  let answer = "";
  let status: ReconciledTurn["status"] | null = null;
  for (const record of read.records) {
    const event = String(record?.hook_event_name ?? record?.type ?? "");
    const id = String(record?.generation_id ?? record?.generationId ?? "");
    if (id && id !== turnId) continue;
    if (event === "beforeSubmitPrompt") startedAt = isoTime(record?.timestamp ?? record?.created_at ?? record?.createdAt) ?? startedAt;
    if (event === "afterAgentResponse") answer += String(record?.text ?? "");
    if (event !== "stop") continue;
    const raw = String(record?.status ?? "completed").toLowerCase();
    status = raw === "aborted" ? "interrupted" : raw === "error" ? "failed" : "completed";
    completedAt = isoTime(record?.timestamp ?? record?.created_at ?? record?.createdAt) ?? completedAt;
  }
  return status ? { turnId, status, startedAt, completedAt, answer } : null;
}

type IncrementRead = { records: any[]; known: boolean };

async function readIncrement(cursor: TranscriptCursor): Promise<IncrementRead | null> {
  if (!cursor.path) return null;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const stat = await fs.stat(cursor.path);
    if (cursor.format === "json") {
      if (!stat.isFile() || stat.size > MAX_INCREMENT_BYTES) return { records: [], known: false };
      const records = jsonDocumentRecords(await fs.readFile(cursor.path, "utf8"));
      if (!records) return { records: [], known: false };
      const from = Math.max(0, cursor.recordCount ?? 0);
      return records.length >= from
        ? { records: records.slice(from), known: true }
        : { records: [], known: false };
    }
    if (!stat.isFile() || stat.size < cursor.offset) return null;
    const available = stat.size - cursor.offset;
    if (available === 0) return { records: [], known: true };
    if (available > MAX_INCREMENT_BYTES) return { records: [], known: false };
    handle = await fs.open(cursor.path, "r");
    const buffer = Buffer.alloc(available);
    const { bytesRead } = await handle.read(buffer, 0, available, cursor.offset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const records: any[] = [];
    let invalid = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); }
      catch { invalid += 1; }
    }
    // A malformed final line can simply be the provider's current append. It
    // therefore makes a negative result unknown; only a recognized full line
    // is allowed to authorize an Enter retry.
    return { records, known: invalid === 0 };
  } catch { return null; }
  finally { await handle?.close().catch(() => undefined); }
}

function jsonDocumentRecords(contents: string): any[] | null {
  try {
    const parsed = JSON.parse(contents);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.messages)) return parsed.messages;
    if (Array.isArray(parsed?.events)) return parsed.events;
  } catch { /* a provider may be midway through replacing the document */ }
  return null;
}

function claudeHumanPrompt(record: any): { text: string; turnId: string } | null {
  if (record?.type !== "user" || record?.isMeta || record?.isSidechain) return null;
  if (String(record?.message?.role ?? "user") !== "user") return null;
  const content = record?.message?.content ?? record?.content;
  if (containsToolResult(content) || record?.toolUseResult || record?.sourceToolAssistantUUID) return null;
  const origin = String(record?.origin?.kind ?? "").toLowerCase();
  const source = String(record?.promptSource ?? record?.prompt_source ?? "").toLowerCase();
  if ((origin && origin !== "human") || source === "system") return null;
  const text = contentText(content).trim();
  if (!text || /^\s*<(?:task-notification|system-reminder|local-command-(?:caveat|stdout|stderr))\b/i.test(text)) return null;
  if (/^\s*\/compact(?:\s|$)/i.test(text)) return null;
  return { text, turnId: String(record?.promptId ?? record?.prompt_id ?? record?.uuid ?? "") || `claude-turn-${record?.timestamp ?? Date.now()}` };
}

function contentText(value: any): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part : (String(part?.type ?? "") === "text" && typeof part?.text === "string" ? part.text : "")).join("");
}

function turnPrompt(items: Array<Record<string, unknown>>): string {
  const item: any = items.find((candidate: any) => String(candidate?.type ?? "").toLowerCase() === "usermessage");
  return String(item?.text ?? contentText(item?.content)).trim();
}

function turnAnswer(items: Array<Record<string, unknown>>): string {
  const messages = items.filter((candidate: any) => String(candidate?.type ?? "").toLowerCase() === "agentmessage") as any[];
  let final = messages.at(-1);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.phase ?? "").toLowerCase() === "final_answer") { final = messages[index]; break; }
  }
  return String(final?.text ?? contentText(final?.content)).trim();
}

function containsToolResult(value: any): boolean {
  return Array.isArray(value) && value.some((part) => String(part?.type ?? "").toLowerCase().includes("tool_result"));
}

function isoTime(value: unknown): string | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

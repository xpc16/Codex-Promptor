import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HistoryReport } from "./history.js";
import { syncHistory } from "./history.js";
import type { StorageService } from "./storage.js";

export type CursorHistoryThread = { id: string; sessionId: string; turns: any[]; transcriptPath: string };

export async function syncCursorHistory(
  storage: StorageService,
  tabId: string,
  sessionId: string,
  transcriptPath?: string | null,
): Promise<{ report: HistoryReport; thread: CursorHistoryThread }> {
  const thread = await readCursorHistoryThread(sessionId, transcriptPath);
  return { report: await syncHistory(storage, tabId, thread), thread };
}

export async function readCursorHistoryThread(sessionId: string, transcriptPath?: string | null): Promise<CursorHistoryThread> {
  const filePath = await locateCursorTranscript(sessionId, transcriptPath);
  if (!filePath) throw new Error(`CURSOR_TRANSCRIPT_NOT_FOUND:${sessionId}`);
  const contents = await fs.readFile(filePath, "utf8");
  return { ...parseCursorTranscript(contents, sessionId), transcriptPath: filePath };
}

export function parseCursorTranscript(contents: string, sessionId: string): Omit<CursorHistoryThread, "transcriptPath"> {
  const records = transcriptRecords(contents);
  const turns: any[] = [];
  let current: { id: string; prompt: string; startedAt: string | null; assistant: string[]; completedAt: string | null } | null = null;
  const flush = () => {
    if (!current) return;
    const answer = current.assistant.join("").trim();
    if (answer) {
      turns.push({
        id: current.id,
        status: "completed",
        startedAt: current.startedAt,
        completedAt: current.completedAt,
        items: [
          { type: "userMessage", text: current.prompt },
          { type: "agentMessage", phase: "final_answer", text: answer },
        ],
      });
    }
    current = null;
  };
  for (const [index, record] of records.entries()) {
    const event = String(record?.hook_event_name ?? record?.type ?? "");
    const role = String(record?.message?.role ?? record?.role ?? "");
    const isUser = event === "beforeSubmitPrompt" || event === "user" || role === "user";
    const isAssistant = event === "afterAgentResponse" || event === "assistant" || role === "assistant";
    if (isUser) {
      const prompt = String(record?.prompt ?? contentText(record?.message?.content ?? record?.content)).trim();
      if (!prompt || containsToolResult(record?.message?.content ?? record?.content)) continue;
      flush();
      current = {
        id: String(record?.generation_id ?? record?.generationId ?? record?.id ?? `cursor-turn-${index}`),
        prompt,
        startedAt: normalizedTime(record?.timestamp ?? record?.created_at ?? record?.createdAt),
        assistant: [],
        completedAt: null,
      };
      continue;
    }
    if (!isAssistant || !current) continue;
    const text = String(record?.text ?? contentText(record?.message?.content ?? record?.content));
    if (text) current.assistant.push(text);
    current.completedAt = normalizedTime(record?.timestamp ?? record?.created_at ?? record?.createdAt) ?? current.completedAt;
  }
  flush();
  return { id: sessionId, sessionId, turns };
}

export async function locateCursorTranscript(sessionId: string, hintedPath?: string | null): Promise<string | null> {
  if (hintedPath) {
    try { if ((await fs.stat(hintedPath)).isFile()) return path.resolve(hintedPath); }
    catch { /* fall through */ }
  }
  const root = path.resolve(process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor"));
  const candidates: Array<{ path: string; size: number }> = [];
  for (const searchRoot of [path.join(root, "chats"), path.join(root, "projects")]) {
    const stack = [searchRoot];
    while (stack.length) {
      const directory = stack.pop()!;
      let entries: Array<import("node:fs").Dirent>;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(candidate);
          continue;
        }
        if (!entry.isFile() || !candidate.toLowerCase().includes(sessionId.toLowerCase())) continue;
        if (!/\.(?:jsonl|json)$/i.test(entry.name) || /^meta\.json$/i.test(entry.name)) continue;
        try { candidates.push({ path: candidate, size: (await fs.stat(candidate)).size }); } catch { /* ignore races */ }
      }
    }
  }
  return candidates.sort((left, right) => right.size - left.size)[0]?.path ?? null;
}

function transcriptRecords(contents: string): any[] {
  const trimmed = contents.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.messages)) return parsed.messages;
    if (Array.isArray(parsed?.events)) return parsed.events;
  } catch { /* JSONL is expected for hook transcripts */ }
  const records: any[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* tolerate partial tail */ }
  }
  return records;
}

function contentText(value: any): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part : (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

function containsToolResult(value: any): boolean {
  return Array.isArray(value) && value.some((part) => String(part?.type ?? "").toLowerCase().includes("tool_result"));
}

function normalizedTime(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

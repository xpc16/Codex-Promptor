import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HistoryReport } from "./history.js";
import { syncHistory } from "./history.js";
import type { StorageService } from "./storage.js";

type TranscriptRecord = Record<string, any> & { __index: number };

export type ClaudeHistoryThread = {
  id: string;
  sessionId: string;
  turns: any[];
  transcriptPath: string;
};

export async function syncClaudeHistory(
  storage: StorageService,
  tabId: string,
  sessionId: string,
  transcriptPath?: string | null,
): Promise<{ report: HistoryReport; thread: ClaudeHistoryThread }> {
  const thread = await readClaudeHistoryThread(sessionId, transcriptPath);
  return { report: await syncHistory(storage, tabId, thread), thread };
}

export async function readClaudeHistoryThread(sessionId: string, transcriptPath?: string | null): Promise<ClaudeHistoryThread> {
  const filePath = await locateClaudeTranscript(sessionId, transcriptPath);
  if (!filePath) throw new Error(`CLAUDE_TRANSCRIPT_NOT_FOUND:${sessionId}`);
  const contents = await fs.readFile(filePath, "utf8");
  return { ...parseClaudeTranscript(contents, sessionId), transcriptPath: filePath };
}

export function parseClaudeTranscript(contents: string, sessionId: string): Omit<ClaudeHistoryThread, "transcriptPath"> {
  const records: TranscriptRecord[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !record.isSidechain) records.push({ ...record, __index: index });
    } catch { /* tolerate a partially written final JSONL line */ }
  }
  const lineage = activeLineage(records, sessionId);
  const prompts = humanPrompts(lineage);
  const turns: any[] = [];
  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index];
    const nextIndex = prompts[index + 1]?.__index ?? Number.POSITIVE_INFINITY;
    const window = lineage.filter((record) => record.__index > prompt.__index && record.__index < nextIndex);
    const final = finalAssistantMessage(window, index === prompts.length - 1);
    if (!final) continue;
    const turnId = String(prompt.promptId ?? prompt.prompt_id ?? prompt.uuid ?? `claude-turn-${prompt.__index}`);
    const startedAt = normalizedTime(prompt.timestamp);
    const completedAt = normalizedTime(final.timestamp);
    turns.push({
      id: turnId,
      // A turn still in flight must not be imported as a finished answer:
      // syncHistory leaves "running" turns to the live hook path, so the card
      // no longer flips to "did not finish" while the agent is mid-answer.
      status: final.completion === "pending" ? "running" : "completed",
      startedAt,
      completedAt,
      items: [
        { type: "userMessage", text: prompt.__promptText },
        // A turn that ended without a clean stop reason (interrupted mid-stream
        // or a denied permission) still has whatever Claude last said. Tag it
        // "partial_answer" instead of "final_answer" so syncHistory records it
        // as a real turn but marks the answer as a fallback capture rather than
        // dropping it outright.
        { type: "agentMessage", phase: final.completion === "complete" ? "final_answer" : "partial_answer", text: final.text },
      ],
    });
  }
  return { id: sessionId, sessionId, turns };
}

export async function locateClaudeTranscript(sessionId: string, hintedPath?: string | null): Promise<string | null> {
  if (hintedPath) {
    try {
      const stat = await fs.stat(hintedPath);
      if (stat.isFile()) return path.resolve(hintedPath);
    } catch { /* fall through to the projects search */ }
  }
  const configRoot = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  const projectsRoot = path.join(configRoot, "projects");
  const wanted = `${sessionId}.jsonl`.toLowerCase();
  const stack = [projectsRoot];
  while (stack.length) {
    const directory = stack.pop()!;
    let entries: Array<import("node:fs").Dirent>;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // Subagent transcripts reuse the parent session id but are not the
        // interactive conversation shown in Promptor.
        if (entry.name.toLowerCase() !== "subagents") stack.push(candidate);
      } else if (entry.isFile() && entry.name.toLowerCase() === wanted) {
        return candidate;
      }
    }
  }
  return null;
}

function activeLineage(records: TranscriptRecord[], sessionId: string): TranscriptRecord[] {
  const lastPrompt = [...records].reverse().find((record) => record.type === "last-prompt"
    && (!record.sessionId || String(record.sessionId) === sessionId));
  const leaf = String(lastPrompt?.leafUuid ?? lastPrompt?.leaf_uuid ?? "");
  if (!leaf) return records;
  // A logical Claude transcript node can be appended more than once as its
  // streamed message is enriched. Explore every parent edge for that UUID;
  // choosing only the last duplicate can jump across a compacted branch and
  // collapse a long conversation to a single turn.
  const byUuid = new Map<string, TranscriptRecord[]>();
  for (const record of records) {
    if (!record.uuid) continue;
    const key = String(record.uuid);
    const variants = byUuid.get(key) ?? [];
    variants.push(record);
    byUuid.set(key, variants);
  }
  const selected = new Set<string>();
  const pending = [leaf];
  while (pending.length) {
    const cursor = pending.pop()!;
    if (!cursor || selected.has(cursor)) continue;
    const variants = byUuid.get(cursor);
    if (!variants?.length) continue;
    selected.add(cursor);
    for (const record of variants) {
      // Claude starts a new physical parent chain after /compact. The compact
      // boundary reconnects that chain to the preceding conversation through
      // logicalParentUuid while parentUuid is deliberately null. Follow both
      // edges so active history includes the completed turns before compaction
      // without pulling in sibling/rewound branches.
      const parents = [
        record.parentUuid ?? record.parent_uuid,
        record.logicalParentUuid ?? record.logical_parent_uuid,
      ];
      for (const value of parents) {
        const parent = String(value ?? "");
        if (parent && !selected.has(parent)) pending.push(parent);
      }
    }
  }
  // Walking only upwards is not enough. "last-prompt" pins the branch tip as of
  // the moment a prompt was submitted, so everything the agent appends while
  // answering -- including the message that ends the turn -- is a *descendant*
  // of that leaf and gets filtered out. The newest finished turn then looks
  // unfinished until the next prompt moves the leaf forward. Extend forward
  // from the leaf as well, restricted to records appended after it so a branch
  // abandoned by an earlier rewind (always written before the current leaf)
  // stays excluded.
  const leafIndexes = (byUuid.get(leaf) ?? []).map((record) => record.__index);
  if (leafIndexes.length) {
    const leafIndex = Math.min(...leafIndexes);
    for (let grew = true; grew; ) {
      grew = false;
      for (const record of records) {
        if (!record.uuid || record.__index <= leafIndex) continue;
        const key = String(record.uuid);
        if (selected.has(key)) continue;
        const parents = [
          record.parentUuid ?? record.parent_uuid,
          record.logicalParentUuid ?? record.logical_parent_uuid,
        ];
        if (!parents.some((value) => value && selected.has(String(value)))) continue;
        selected.add(key);
        grew = true;
      }
    }
  }

  // An incomplete chain is less trustworthy than the append-only file order.
  if (selected.size < 2) return records;
  return records.filter((record) => !record.uuid || selected.has(String(record.uuid)));
}

function humanPrompts(records: TranscriptRecord[]): Array<TranscriptRecord & { __promptText: string }> {
  const candidates: Array<TranscriptRecord & { __promptText: string; __explicitHuman: boolean }> = records.flatMap((record) => {
    if (record.type !== "user" || record.isMeta || record.isSidechain) return [];
    if (String(record.message?.role ?? "user") !== "user") return [];
    const content = record.message?.content ?? record.content;
    if (Array.isArray(content) && content.some((part) => String(part?.type ?? "").toLowerCase().includes("tool_result"))) return [];
    if (record.toolUseResult || record.sourceToolAssistantUUID) return [];
    const text = normalizedHumanPrompt(record, content);
    if (!text) return [];
    const explicitHuman = record.origin?.kind === "human" || record.promptSource === "typed" || record.prompt_source === "typed";
    const hasPromptId = Boolean(record.promptId ?? record.prompt_id);
    // Older Claude transcripts do not have origin/promptSource. A plain string
    // user message is their human-input representation.
    if (!explicitHuman && !hasPromptId && typeof content !== "string") return [];
    return [{ ...record, __promptText: text, __explicitHuman: explicitHuman }] as Array<TranscriptRecord & { __promptText: string; __explicitHuman: boolean }>;
  });
  const byPromptId = new Map<string, typeof candidates[number]>();
  const unkeyed: typeof candidates = [];
  for (const candidate of candidates) {
    const promptId = String(candidate.promptId ?? candidate.prompt_id ?? "");
    if (!promptId) { unkeyed.push(candidate); continue; }
    const previous = byPromptId.get(promptId);
    if (!previous || (!previous.__explicitHuman && candidate.__explicitHuman)) byPromptId.set(promptId, candidate);
  }
  return [...byPromptId.values(), ...unkeyed].sort((left, right) => left.__index - right.__index);
}

function normalizedHumanPrompt(record: TranscriptRecord, content: any): string | null {
  const text = contentText(content).trim();
  if (!text) return null;
  const originKind = String(record.origin?.kind ?? "").trim().toLowerCase();
  const promptSource = String(record.promptSource ?? record.prompt_source ?? "").trim().toLowerCase();
  // Claude persists background-task notifications and other system injections
  // as user-role records. They can have prompt ids, but are not user prompts.
  if ((originKind && originKind !== "human") || promptSource === "system") return null;
  if (record.isCompactSummary
    || /^This session is being continued from a previous conversation that ran out of context\./i.test(text)) return null;
  if (/^\s*<(?:task-notification|system-reminder|local-command-(?:caveat|stdout|stderr))\b/i.test(text)) return null;
  if (/^\s*\/compact(?:\s|$)/i.test(text)) return null;

  // Slash commands are stored as an internal XML-like envelope. Reconstruct
  // the text the user entered instead of exposing Claude's transport markup.
  const commandName = xmlTagText(text, "command-name");
  const commandArgs = xmlTagText(text, "command-args");
  if (commandName !== null || commandArgs !== null) {
    if (commandName?.trim().toLowerCase() === "/compact") return null;
    return [commandName, commandArgs].filter((part) => Boolean(part?.trim())).join(" ").trim() || null;
  }
  return text;
}

function xmlTagText(value: string, tag: string): string | null {
  const match = value.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].trim() : null;
}

/**
 * Stop reasons that mean "the model finished this message on its own terms".
 * "tool_use" and "pause_turn" mean more is coming; "max_tokens" means the
 * message was cut off, which really is a partial answer.
 */
const TURN_ENDING_STOP_REASONS = new Set(["end_turn", "stop_sequence", "refusal"]);

type TurnCompletion = "complete" | "partial" | "pending";

function finalAssistantMessage(records: TranscriptRecord[], windowIsOpen: boolean): { text: string; timestamp: unknown; completion: TurnCompletion } | null {
  const groups = new Map<string, { texts: string[]; ended: boolean; timestamp: unknown; index: number }>();
  for (const record of records) {
    if (record.type !== "assistant" || String(record.message?.role ?? "assistant") !== "assistant") continue;
    const messageId = String(record.message?.id ?? record.uuid ?? `assistant-${record.__index}`);
    const group = groups.get(messageId) ?? { texts: [], ended: false, timestamp: null, index: record.__index };
    const text = contentText(record.message?.content ?? record.content).trim();
    if (text && !group.texts.includes(text)) group.texts.push(text);
    if (TURN_ENDING_STOP_REASONS.has(String(record.message?.stop_reason ?? record.stop_reason ?? ""))) group.ended = true;
    group.timestamp = record.timestamp ?? group.timestamp;
    group.index = Math.max(group.index, record.__index);
    groups.set(messageId, group);
  }
  const all = [...groups.values()].sort((a, b) => a.index - b.index);
  const finals = all.filter((group) => group.ended && group.texts.length);
  if (finals.length) {
    // A background task completion is persisted as a system-origin user record
    // followed by another assistant end_turn. Since the system record is not a
    // real prompt, retain both completed assistant messages under the preceding
    // human prompt instead of silently discarding its main answer.
    return {
      text: finals.map((group) => group.texts.join("")).join("\n\n---\n\n"),
      timestamp: finals.at(-1)!.timestamp,
      completion: "complete",
    };
  }
  // Nothing in this window reached a turn-ending stop reason. Fall back to the
  // last thing Claude said instead of dropping the turn outright -- but what
  // that means depends on whether the window is still open. The trailing window
  // runs to end-of-file, so an agent that is simply still working looks exactly
  // like one that was interrupted. Call it "pending" and let the live runner
  // own it; if the turn really did end there, the next prompt closes the window
  // and the same records import as "partial" on the following sync.
  const partials = all.filter((group) => group.texts.length);
  if (!partials.length) return null;
  const last = partials.at(-1)!;
  return { text: last.texts.join(""), timestamp: last.timestamp, completion: windowIsOpen ? "pending" : "partial" };
}

function contentText(value: any): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    return String(part?.type ?? "") === "text" && typeof part?.text === "string" ? part.text : "";
  }).join("");
}

function normalizedTime(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

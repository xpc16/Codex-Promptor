import { describe, expect, it } from "vitest";
import { extractFinalAnswer, extractUserInput, syncHistory } from "./history.js";
import { StorageService } from "./storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("history extraction", () => {
  it("joins user messages and preserves input items", () => {
    const result = extractUserInput([
      { type: "userMessage", text: "第一段" },
      { type: "user_message", content: [{ type: "text", text: "追加" }] },
    ]);
    expect(result?.text).toContain("第一段");
    expect(result?.text).toContain("追加");
    expect(result?.snapshot).toHaveLength(2);
  });

  it("prefers final-answer phase and falls back to the last agent message", () => {
    expect(extractFinalAnswer([{ type: "agentMessage", phase: "commentary", text: "过程" }, { type: "agentMessage", phase: "final_answer", text: "结论" }])).toEqual({ text: "结论", captureMode: "phase_final_answer" });
    expect(extractFinalAnswer([{ type: "agentMessage", text: "没有 phase" }])).toEqual({ text: "没有 phase", captureMode: "fallback_last_agent_message" });
  });
});

describe("history sync", () => {
  it("imports completed turns idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-history-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("测试");
      const thread = {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "completed",
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_010,
          items: [
            { type: "userMessage", clientId: "client-1", text: "请总结" },
            { type: "agentMessage", phase: "final_answer", text: "总结完成" },
          ],
        }],
      };
      expect((await syncHistory(storage, tab.id, thread)).imported).toBe(1);
      expect((await syncHistory(storage, tab.id, thread)).skipped).toBe(1);
      const bundle = await storage.readTab(tab.id);
      expect(bundle.prompts.prompts).toHaveLength(1);
      expect(bundle.prompts.prompts[0].status).toBe("completed");
      expect(bundle.answers.answers).toHaveLength(1);
      expect(bundle.answers.answers[0].finalAnswer).toBe("总结完成");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps completed turns without client ids as distinct prompts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-history-null-client-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("历史对话");
      const thread = {
        id: "thread-without-client-ids",
        turns: [
          {
            id: "turn-a",
            status: "completed",
            items: [
              { type: "userMessage", text: "第一条真实 prompt" },
              { type: "agentMessage", phase: "final_answer", text: "第一条回答" },
            ],
          },
          {
            id: "turn-b",
            status: "completed",
            items: [
              { type: "userMessage", text: "第二条真实 prompt" },
              { type: "agentMessage", phase: "final_answer", text: "第二条回答" },
            ],
          },
        ],
      };

      expect((await syncHistory(storage, tab.id, thread)).imported).toBe(2);
      const bundle = await storage.readTab(tab.id);
      expect(bundle.prompts.prompts.map((prompt) => prompt.text)).toEqual(["第一条真实 prompt", "第二条真实 prompt"]);
      expect(new Set(bundle.prompts.prompts.map((prompt) => prompt.id)).size).toBe(2);
      expect(bundle.answers.answers.map((answer) => answer.promptId)).toEqual(bundle.prompts.prompts.map((prompt) => prompt.id));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

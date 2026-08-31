import { describe, expect, it } from "vitest";
import { extractFinalAnswer, extractUserInput, recordTurn, syncHistory } from "./history.js";
import { StorageService } from "./storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newAttempt, newPrompt } from "../shared/schemas.js";

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

describe("steered prompt recording", () => {
  it("completes every queue prompt linked to one turn and records one combined answer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-history-steer-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("steering history");
      const bundle = await storage.readTab(tab.id);
      const primary = newPrompt("主 prompt", "queue");
      const primaryAttempt = newAttempt("queue");
      primaryAttempt.status = "running";
      primaryAttempt.delivery = "turn";
      primaryAttempt.codexTurnId = "turn-steered";
      primary.attempts.push(primaryAttempt);
      Object.assign(primary, { status: "running", threadId: "thread-steered", codexTurnId: "turn-steered" });
      const steered = newPrompt("追加 prompt", "queue");
      const steeredAttempt = newAttempt("queue");
      steeredAttempt.status = "running";
      steeredAttempt.delivery = "steer";
      steeredAttempt.codexTurnId = "turn-steered";
      steered.attempts.push(steeredAttempt);
      Object.assign(steered, { status: "running", threadId: "thread-steered", codexTurnId: "turn-steered" });
      bundle.prompts.prompts.push(primary, steered);
      await storage.writePrompts(tab.id, bundle.prompts);

      await recordTurn(storage, tab.id, {
        threadId: "thread-steered",
        turn: { id: "turn-steered", status: "completed", completedAt: "2026-08-24T05:00:00.000Z" },
        items: [
          { type: "userMessage", text: "主 prompt" },
          { type: "agentMessage", phase: "final_answer", text: "合并回答" },
        ],
        origin: "queue",
        promptId: primary.id,
        promptText: primary.text,
      });

      const recorded = await storage.readTab(tab.id);
      expect(recorded.prompts.prompts.map((item) => item.status)).toEqual(["completed", "completed"]);
      expect(recorded.prompts.prompts.map((item) => item.completedAt)).toEqual(["2026-08-24T05:00:00.000Z", "2026-08-24T05:00:00.000Z"]);
      expect(recorded.prompts.prompts.flatMap((item) => item.attempts).map((attempt) => attempt.status)).toEqual(["completed", "completed"]);
      expect(recorded.answers.answers).toHaveLength(1);
      expect(recorded.answers.answers[0].prompt).toContain("主 prompt\n\n--- 追加输入 ---\n\n追加 prompt");
      expect(recorded.answers.answers[0].metadata).toMatchObject({ promptIds: [primary.id, steered.id], steeredPromptIds: [steered.id] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a late completion from the previously selected session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-history-late-session-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("late provider event");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        session: { ...current.session, state: "ready", threadId: "session-new", sessionId: "session-new", workingDirectory: root },
      }));

      const result = await recordTurn(storage, tab.id, {
        threadId: "session-old",
        turn: { id: "turn-old", status: "completed" },
        items: [
          { type: "userMessage", text: "old prompt" },
          { type: "agentMessage", phase: "final_answer", text: "old answer" },
        ],
        origin: "manual",
      });

      expect(result).toEqual({ prompt: null, answer: null });
      const bundle = await storage.readTab(tab.id);
      expect(bundle.prompts.prompts).toEqual([]);
      expect(bundle.answers.answers).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("removes stale imported turns that disappear from authoritative provider history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-history-stale-import-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("stale imported history");
      const realTurn = {
        id: "real-turn",
        status: "completed",
        items: [
          { type: "userMessage", text: "/plan inspect the project" },
          { type: "agentMessage", phase: "final_answer", text: "real answer" },
        ],
      };
      const staleSystemTurn = {
        id: "stale-system-turn",
        status: "completed",
        items: [
          { type: "userMessage", text: "<task-notification>background task completed</task-notification>" },
          { type: "agentMessage", phase: "final_answer", text: "background update" },
        ],
      };

      await syncHistory(storage, tab.id, { id: "claude-thread", turns: [realTurn, staleSystemTurn] });
      expect((await storage.readTab(tab.id)).prompts.prompts).toHaveLength(2);

      await syncHistory(storage, tab.id, { id: "claude-thread", turns: [realTurn] });

      const synced = await storage.readTab(tab.id);
      expect(synced.prompts.prompts.map((prompt) => prompt.text)).toEqual(["/plan inspect the project"]);
      expect(synced.answers.answers.map((answer) => answer.finalAnswer)).toEqual(["real answer"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a queue attempt when history finishes before the runner observes its notification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-history-queue-repair-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("队列修复");
      const bundle = await storage.readTab(tab.id);
      const prompt = newPrompt("从队列发送");
      const attempt = newAttempt();
      prompt.status = "running";
      prompt.threadId = "thread-queue";
      prompt.codexTurnId = "turn-queue";
      prompt.clientUserMessageId = "client-queue";
      attempt.status = "running";
      attempt.codexTurnId = "turn-queue";
      attempt.clientUserMessageId = "client-queue";
      prompt.attempts.push(attempt);
      bundle.prompts.prompts.push(prompt);
      await storage.writePrompts(tab.id, bundle.prompts);

      await syncHistory(storage, tab.id, {
        id: "thread-queue",
        turns: [{
          id: "turn-queue",
          status: "completed",
          completedAt: 1_700_000_010,
          items: [
            { type: "userMessage", clientId: "client-queue", text: "从队列发送" },
            { type: "agentMessage", phase: "final_answer", text: "队列回答" },
          ],
        }],
      });

      const synced = await storage.readTab(tab.id);
      expect(synced.prompts.prompts[0]).toMatchObject({ status: "completed", origin: "queue" });
      expect(synced.prompts.prompts[0].attempts[0]).toMatchObject({ status: "completed", codexTurnId: "turn-queue", error: null });
      expect(synced.answers.answers[0]).toMatchObject({ origin: "queue", finalAnswer: "队列回答" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles an interrupted Codex turn and keeps it in history order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-history-interrupted-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("中断状态同步");
      const bundle = await storage.readTab(tab.id);
      const interrupted = newPrompt("重启时尚未收尾", "queue");
      const attempt = newAttempt();
      interrupted.status = "running";
      interrupted.threadId = "thread-interrupted";
      interrupted.codexTurnId = "turn-interrupted";
      interrupted.clientUserMessageId = "client-interrupted";
      attempt.status = "running";
      attempt.codexTurnId = "turn-interrupted";
      attempt.clientUserMessageId = "client-interrupted";
      interrupted.attempts.push(attempt);
      bundle.prompts.prompts.push(interrupted);
      await storage.writePrompts(tab.id, bundle.prompts);

      const report = await syncHistory(storage, tab.id, {
        id: "thread-interrupted",
        turns: [
          {
            id: "turn-interrupted",
            status: "interrupted",
            startedAt: 1_700_000_000,
            completedAt: null,
            items: [{ type: "userMessage", clientId: "client-interrupted", text: "重启时尚未收尾" }],
          },
          {
            id: "turn-after-restart",
            status: { type: "completed" },
            startedAt: 1_700_000_020,
            completedAt: 1_700_000_030,
            items: [
              { type: "userMessage", clientId: "client-after-restart", text: "重启后的下一条" },
              { type: "agentMessage", phase: "final_answer", text: "下一条完成" },
            ],
          },
        ],
      });

      const synced = await storage.readTab(tab.id);
      expect(report).toMatchObject({ imported: 1, repaired: 1 });
      expect(synced.prompts.prompts.map((prompt) => [prompt.text, prompt.status])).toEqual([
        ["重启时尚未收尾", "interrupted"],
        ["重启后的下一条", "completed"],
      ]);
      expect(synced.prompts.prompts[0]).toMatchObject({ error: { code: "TURN_INTERRUPTED" } });
      expect(synced.prompts.prompts[0].completedAt).not.toBeNull();
      expect(synced.prompts.prompts[0].attempts[0]).toMatchObject({ status: "interrupted", error: { code: "TURN_INTERRUPTED" } });
      expect(synced.answers.answers).toHaveLength(2);
      expect(synced.answers.answers[0]).toMatchObject({
        prompt: "重启时尚未收尾",
        status: "interrupted",
        finalAnswer: "",
        error: { code: "TURN_INTERRUPTED" },
      });
      expect(synced.answers.answers[0].completedAt).not.toBeNull();
      expect(synced.answers.answers[1]).toMatchObject({
        prompt: "重启后的下一条",
        status: "completed",
        finalAnswer: "下一条完成",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a partial agent message when a locally tracked turn is reconciled as interrupted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-history-partial-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("中断但有部分回答");
      const bundle = await storage.readTab(tab.id);
      const running = newPrompt("长任务中途被打断", "queue");
      const attempt = newAttempt();
      running.status = "running";
      running.threadId = "thread-partial";
      running.codexTurnId = "turn-partial";
      attempt.status = "running";
      attempt.codexTurnId = "turn-partial";
      running.attempts.push(attempt);
      bundle.prompts.prompts.push(running);
      await storage.writePrompts(tab.id, bundle.prompts);

      const report = await syncHistory(storage, tab.id, {
        id: "thread-partial",
        turns: [{
          id: "turn-partial",
          status: "interrupted",
          startedAt: 1_700_000_000,
          completedAt: null,
          items: [
            { type: "userMessage", text: "长任务中途被打断" },
            { type: "agentMessage", text: "已经检查了一部分文件" },
          ],
        }],
      });

      const synced = await storage.readTab(tab.id);
      expect(report).toMatchObject({ repaired: 1 });
      expect(synced.answers.answers[0]).toMatchObject({
        status: "interrupted",
        finalAnswer: "已经检查了一部分文件",
        captureMode: "fallback_last_agent_message",
        error: { code: "TURN_INTERRUPTED" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports a Claude-style turn tagged partial_answer as completed with a fallback captureMode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-history-claude-partial-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("Claude 未完成的回合");

      const report = await syncHistory(storage, tab.id, {
        id: "thread-claude-partial",
        turns: [{
          id: "turn-claude-partial",
          status: "completed",
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_010,
          items: [
            { type: "userMessage", text: "开始一个长任务" },
            { type: "agentMessage", phase: "partial_answer", text: "已经检查了这个文件" },
          ],
        }],
      });

      const synced = await storage.readTab(tab.id);
      expect(report).toMatchObject({ imported: 1 });
      expect(synced.answers.answers[0]).toMatchObject({
        status: "completed",
        finalAnswer: "已经检查了这个文件",
        captureMode: "fallback_partial_answer",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces another thread's history and appends unbound pending prompts in order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-history-scope-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("thread scope");
      const bundle = await storage.readTab(tab.id);
      const wrong = newPrompt("wrong other-thread prompt", "manual");
      wrong.status = "completed";
      wrong.codexTurnId = "wrong-turn";
      wrong.completedAt = "2026-08-20T00:00:00.000Z";
      const pendingOne = newPrompt("pending one");
      const pendingTwo = newPrompt("pending two");
      bundle.prompts.prompts = [wrong, pendingOne, pendingTwo];
      bundle.answers.answers = [{
        id: "wrong-answer",
        promptId: wrong.id,
        threadId: "other-thread",
        codexTurnId: "wrong-turn",
        origin: "manual",
        prompt: wrong.text,
        status: "completed",
        finalAnswer: "wrong other-thread answer",
        captureMode: "phase_final_answer",
        startedAt: null,
        completedAt: wrong.completedAt,
        recordedAt: wrong.completedAt,
        clientUserMessageId: null,
        error: null,
        metadata: {},
      }];
      await storage.writePrompts(tab.id, bundle.prompts);
      await storage.writeAnswers(tab.id, bundle.answers);

      await syncHistory(storage, tab.id, {
        id: "current-thread",
        turns: [{
          id: "current-turn",
          status: "completed",
          items: [
            { type: "userMessage", text: "current completed prompt" },
            { type: "agentMessage", phase: "final_answer", text: "current final answer" },
          ],
        }],
      });

      const synced = await storage.readTab(tab.id);
      expect(synced.prompts.prompts.map((prompt) => prompt.text)).toEqual([
        "current completed prompt",
        "pending one",
        "pending two",
      ]);
      expect(synced.prompts.prompts[0].threadId).toBe("current-thread");
      expect(synced.prompts.prompts.slice(1).map((prompt) => prompt.threadId)).toEqual([null, null]);
      expect(synced.answers.answers.map((answer) => [answer.threadId, answer.finalAnswer])).toEqual([
        ["current-thread", "current final answer"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merge mode imports evidence without deleting local or unparsed records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-history-merge-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("migration merge");
      const bundle = await storage.readTab(tab.id);
      const local = newPrompt("local completed prompt", "manual");
      Object.assign(local, { status: "completed", threadId: "thread-merge", codexTurnId: "local-turn", completedAt: "2026-08-20T00:00:00.000Z" });
      const pending = newPrompt("keep pending after history");
      bundle.prompts.prompts = [local, pending];
      bundle.answers.answers = [{
        id: "local-answer", promptId: local.id, threadId: "thread-merge", codexTurnId: "local-turn", origin: "manual",
        prompt: local.text, status: "completed", finalAnswer: "local answer", captureMode: "phase_final_answer",
        startedAt: null, completedAt: local.completedAt, recordedAt: local.completedAt!, clientUserMessageId: null, error: null, metadata: {},
      }];
      await storage.writePrompts(tab.id, bundle.prompts);
      await storage.writeAnswers(tab.id, bundle.answers);

      await syncHistory(storage, tab.id, {
        id: "thread-merge",
        turns: [{
          id: "imported-turn", status: "completed",
          items: [{ type: "userMessage", text: "imported history" }, { type: "agentMessage", phase: "final_answer", text: "imported answer" }],
        }],
      }, { mode: "merge" });

      const synced = await storage.readTab(tab.id);
      expect(synced.prompts.prompts.map((prompt) => prompt.text)).toEqual(["imported history", "local completed prompt", "keep pending after history"]);
      expect(synced.answers.answers.map((answer) => answer.finalAnswer)).toEqual(["local answer", "imported answer"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultAnswerFile,
  defaultPromptFile,
  defaultRuntime,
  newPrompt,
  type AnswerRecord,
  type PromptRecord,
  type TabBundle,
} from "../shared/schemas.js";
import { createApp, type PromptorApp } from "./app.js";
import { buildConversationMarkdown, conversationExportFilename } from "./conversation-export.js";

const NOW = "2026-09-03T08:09:10.000Z";

function completedPrompt(id: string, text: string, threadId = "thread-current"): PromptRecord {
  return {
    ...newPrompt(text),
    id,
    status: "completed",
    threadId,
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    codexTurnId: `turn-${id}`,
  };
}

function completedAnswer(prompt: PromptRecord, finalAnswer: string): AnswerRecord {
  return {
    id: `answer-${prompt.id}`,
    promptId: prompt.id,
    threadId: prompt.threadId!,
    codexTurnId: prompt.codexTurnId!,
    origin: prompt.origin,
    prompt: prompt.text,
    status: "completed",
    finalAnswer,
    captureMode: "phase_final_answer",
    startedAt: prompt.startedAt,
    completedAt: prompt.completedAt,
    recordedAt: NOW,
    clientUserMessageId: null,
    error: null,
    metadata: {},
  };
}

describe("conversation Markdown export", () => {
  const prompt = completedPrompt("prompt-1", "测试带有 ``` 围栏的 Prompt");
  const bundle: TabBundle = {
    tab: {
      id: "tab-1",
      name: "演示对话",
      groupId: null,
      order: 0,
      createdAt: NOW,
      updatedAt: NOW,
      session: {
        provider: "codex",
        state: "ready",
        reopenOnLaunch: true,
        workingDirectory: "D:\\work\\demo",
        threadId: "thread-current",
        sessionId: "session-1",
        createdAt: NOW,
        connectedAt: NOW,
        lastError: null,
        lastThreadSwitch: null,
      },
      layout: { leftWidthPercent: 42 },
    },
    prompts: { ...defaultPromptFile(), prompts: [prompt] },
    answers: { ...defaultAnswerFile(), answers: [completedAnswer(prompt, "完成，见 [说明](./README.md)。")] },
    runtime: defaultRuntime(),
  };

  it("writes the three requested sections and preserves answer Markdown", () => {
    const markdown = buildConversationMarkdown(bundle, "zh-CN", new Date(NOW));

    expect(markdown).toContain("## 对话信息");
    expect(markdown).toContain("## 执行队列");
    expect(markdown).toContain("## 最终回答");
    expect(markdown).toContain("D:\\work\\demo");
    expect(markdown).toContain("测试带有 ``` 围栏的 Prompt");
    expect(markdown).toContain("[说明](./README.md)");
    expect(markdown).toContain(`- 完成时间: \`${NOW}\``);
  });

  it("creates a Windows-safe, timestamped Markdown filename", () => {
    expect(conversationExportFilename("对话:测试?", new Date(NOW))).toBe("对话_测试_-2026-09-03T08-09-10Z.md");
  });
});

describe("conversation export HTTP boundary", () => {
  let app: PromptorApp | null = null;
  let root = "";

  afterEach(async () => {
    if (app) {
      await app.promptor.close();
      await app.close();
      app = null;
    }
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  });

  it("exports the complete current thread only from a loopback browser", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-export-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html>", "utf8");
    app = await createApp(root);
    await app.ready();

    const tab = await app.promptor.storage.createTab("导出/测试");
    const first = completedPrompt("first", "最早的当前对话 Prompt");
    const latest = completedPrompt("latest", "最后的当前对话 Prompt");
    const old = completedPrompt("old", "其他 thread 不应导出", "thread-old");
    tab.session = {
      ...tab.session,
      state: "closed",
      workingDirectory: root,
      threadId: "thread-current",
      sessionId: "session-current",
      createdAt: NOW,
      connectedAt: NOW,
    };
    await app.promptor.storage.writeTab(tab);
    await app.promptor.storage.writePrompts(tab.id, { ...defaultPromptFile(), prompts: [first, old, latest] });
    await app.promptor.storage.writeAnswers(tab.id, {
      ...defaultAnswerFile(),
      answers: [completedAnswer(first, "第一个回答"), completedAnswer(old, "旧 thread 回答"), completedAnswer(latest, "最后一个回答")],
    });

    const auth = { "x-codex-promptor-token": app.promptor.token };
    const local = await app.inject({
      method: "GET",
      url: `/api/tabs/${tab.id}/export.md?locale=zh-CN`,
      headers: { ...auth, host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" },
    });
    expect(local.statusCode).toBe(200);
    expect(local.headers["content-type"]).toContain("text/markdown");
    expect(local.headers["content-disposition"]).toContain("attachment");
    expect(local.body).toContain("最早的当前对话 Prompt");
    expect(local.body).toContain("最后一个回答");
    expect(local.body).not.toContain("其他 thread 不应导出");
    expect(local.body).not.toContain("旧 thread 回答");

    const remote = await app.inject({
      method: "GET",
      url: `/api/tabs/${tab.id}/export.md`,
      headers: { ...auth, host: "promptor.example.com", origin: "https://promptor.example.com" },
    });
    expect(remote.statusCode).toBe(403);
    expect(remote.json().error.code).toBe("CONVERSATION_EXPORT_LOCAL_ONLY");
  });
});

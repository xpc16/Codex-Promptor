import { describe, expect, it } from "vitest";
import { defaultRuntime, IndexFileSchema, SessionSchema } from "../shared/schemas.js";
import { createI18n, messages, promptStatusLabel, runnerLabel, terminalStateLabel } from "./i18n.js";

describe("interface localization", () => {
  it("keeps the Chinese and English dictionaries in lockstep", () => {
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages["zh-CN"]).sort());
  });

  it("translates interpolated copy, states, and known errors", () => {
    const zh = createI18n("zh-CN");
    const en = createI18n("en");
    const runtime = defaultRuntime();

    expect(en.t("dialog.deleteGroupMessage", { name: "Work", count: 2 })).toContain("2 conversation(s)");
    expect(zh.t("dialog.deleteGroupMessage", { name: "工作", count: 2 })).toContain("2 个对话");
    expect(runnerLabel(en, runtime)).toBe("Paused");
    expect(promptStatusLabel(en, "completed")).toBe("Completed");
    expect(terminalStateLabel(zh, "running")).toBe("运行中");
    expect(en.errorText({ code: "SESSION_NOT_READY", message: "请先连接或恢复一个编程代理对话。" })).toBe("Connect or resume a coding-agent conversation first.");
    expect(zh.errorText({ code: "UNMAPPED", message: "raw diagnostic" })).toBe("raw diagnostic");
  });
});

describe("locale preference schema", () => {
  it("defaults legacy indexes to Chinese and validates persisted English", () => {
    expect(IndexFileSchema.parse({}).ui.locale).toBe("zh-CN");
    expect(IndexFileSchema.parse({ ui: { locale: "en" } }).ui.locale).toBe("en");
    expect(() => IndexFileSchema.parse({ ui: { locale: "fr" } })).toThrow();
  });
});

describe("agent provider schema", () => {
  const legacySession = {
    state: "unconfigured",
    workingDirectory: null,
    threadId: null,
    sessionId: null,
    createdAt: null,
    connectedAt: null,
    lastError: null,
  };

  it("keeps legacy tabs on Codex and persists Cursor explicitly", () => {
    expect(SessionSchema.parse(legacySession).provider).toBe("codex");
    expect(SessionSchema.parse({ ...legacySession, provider: "cursor" }).provider).toBe("cursor");
    expect(() => SessionSchema.parse({ ...legacySession, provider: "unknown" })).toThrow();
  });
});

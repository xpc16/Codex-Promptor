import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isoNow, newAttempt, newPrompt } from "../shared/schemas.js";
import { answerEventType, codexConnectionModeFromEnv, isLocalHost, isTrustedBrowserOrigin, isTrustedBrowserRequest, isValidResumeId, recordOpenSessionsForNextLaunch, recoverTerminalRuntime, tabsToRestore } from "./app.js";
import { StorageService } from "./storage.js";

describe("provider resume id validation", () => {
  it("keeps UUID sessions for Codex and Claude while accepting Cursor chat IDs", () => {
    const uuid = "01a02a16-5acd-7623-a916-91e8fddcab0f";
    expect(isValidResumeId("codex", uuid)).toBe(true);
    expect(isValidResumeId("claude", uuid)).toBe(true);
    expect(isValidResumeId("codex", "project-chat-name")).toBe(false);
    expect(isValidResumeId("cursor", "project-chat-name")).toBe(true);
    expect(isValidResumeId("cursor", "chat\nname")).toBe(false);
    expect(isValidResumeId("cursor", "")).toBe(false);
  });
});

describe("Codex connection mode", () => {
  it("keeps App Server as the safe default and enables PTY/hooks explicitly", () => {
    // Hooks are the default; the App Server is the way back, and only an
    // exact request for it counts -- a typo must not silently change transport.
    expect(codexConnectionModeFromEnv(undefined)).toBe("pty-hooks");
    expect(codexConnectionModeFromEnv("unknown")).toBe("pty-hooks");
    expect(codexConnectionModeFromEnv("PTY-HOOKS")).toBe("pty-hooks");
    expect(codexConnectionModeFromEnv(" App-Server ")).toBe("app-server");
  });
});

describe("runtime recovery", () => {
  it("clears terminal states that cannot survive a service restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-recovery-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("恢复测试");
      const bundle = await storage.readTab(tab.id);
      bundle.runtime.terminal.state = "running";
      bundle.runtime.terminal.lastStartedAt = new Date().toISOString();
      await storage.writeRuntime(tab.id, bundle.runtime);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      const recovered = await storage.readTab(tab.id);
      expect(recovered.runtime.terminal.state).toBe("stopped");
      expect(recovered.runtime.terminal.lastStartedAt).not.toBeNull();
      expect(await recoverTerminalRuntime(storage)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not carry a dead runner's failure across a restart", async () => {
    // The runner that failed is gone with the process that hosted it. Keeping
    // its error made a healthy conversation report a failure from a previous
    // run, indefinitely -- nothing but starting the queue ever cleared it.
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-runner-error-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("旧错误");
      const bundle = await storage.readTab(tab.id);
      bundle.runtime.terminal.state = "running";
      bundle.runtime.runner.state = "error";
      bundle.runtime.runner.lastError = { code: "TURN_FAILED", message: "CLAUDE_TURN_NOT_FOUND:0e753900" };
      await storage.writeRuntime(tab.id, bundle.runtime);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      const recovered = await storage.readTab(tab.id);
      expect(recovered.runtime.runner.lastError).toBeNull();
      expect(recovered.runtime.runner.state).toBe("paused");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes sessions and pauses queues whose processes cannot survive restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-session-recovery-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("会话恢复测试");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        session: { ...current.session, state: "ready", reopenOnLaunch: true, workingDirectory: root, threadId: "thread-1", sessionId: "thread-1", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      const prompt = newPrompt("重启前正在执行");
      const attempt = newAttempt();
      const startedAt = isoNow();
      prompt.status = "running";
      prompt.threadId = "thread-1";
      prompt.codexTurnId = "turn-1";
      prompt.clientUserMessageId = "client-1";
      prompt.startedAt = startedAt;
      attempt.status = "running";
      attempt.startedAt = startedAt;
      attempt.codexTurnId = "turn-1";
      attempt.clientUserMessageId = "client-1";
      prompt.attempts.push(attempt);
      bundle.prompts.prompts.push(prompt);
      await storage.writePrompts(tab.id, bundle.prompts);
      bundle.runtime.runner.desiredState = "running";
      bundle.runtime.runner.state = "running";
      bundle.runtime.runner.activePromptId = prompt.id;
      bundle.runtime.runner.activeTurnId = "turn-1";
      await storage.writeRuntime(tab.id, bundle.runtime);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      const recovered = await storage.readTab(tab.id);
      expect(recovered.tab.session.state).toBe("closed");
      expect(recovered.tab.session.reopenOnLaunch).toBe(true);
      // A rolling queue cannot resume -- the loop and the turn are gone -- but
      // it settles where a run that ends on its own settles, not stopped.
      expect(recovered.runtime.runner).toMatchObject({ desiredState: "armed", state: "paused", activeTurnId: null, activePromptId: null });
      expect(recovered.prompts.prompts[0]).toMatchObject({ status: "interrupted", error: { code: "SERVICE_RESTARTED" } });
      expect(recovered.prompts.prompts[0].completedAt).not.toBeNull();
      expect(recovered.prompts.prompts[0].attempts[0]).toMatchObject({ status: "interrupted", error: { code: "SERVICE_RESTARTED" } });
      expect(recovered.prompts.prompts[0].attempts[0].completedAt).not.toBeNull();
      expect(recovered.answers.answers).toHaveLength(1);
      expect(recovered.answers.answers[0]).toMatchObject({
        promptId: prompt.id,
        threadId: "thread-1",
        codexTurnId: "turn-1",
        status: "interrupted",
        finalAnswer: "",
        startedAt,
        error: { code: "SERVICE_RESTARTED" },
      });
      expect(recovered.answers.answers[0].completedAt).not.toBeNull();
      expect(await recoverTerminalRuntime(storage)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("carries an idle queue's own setting across the restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-intent-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      // "armed" and "stopped" are both idle and both deliberate: nothing is in
      // flight behind either, so a restart has no business collapsing them.
      for (const desiredState of ["armed", "paused"] as const) {
        const tab = await storage.createTab(`意图-${desiredState}`);
        const bundle = await storage.readTab(tab.id);
        bundle.runtime.runner.desiredState = desiredState;
        bundle.runtime.terminal.state = "running";
        await storage.writeRuntime(tab.id, bundle.runtime);

        expect(await recoverTerminalRuntime(storage)).toBe(1);
        const recovered = await storage.readTab(tab.id);
        expect(recovered.runtime.runner.desiredState).toBe(desiredState);
        expect(recovered.runtime.terminal.state).toBe("stopped");
        await storage.deleteTab(tab.id);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves an already-idle armed queue alone instead of rewriting it every launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-idle-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("空闲队列");
      const bundle = await storage.readTab(tab.id);
      bundle.runtime.runner.desiredState = "armed";
      await storage.writeRuntime(tab.id, bundle.runtime);
      const revision = (await storage.readTab(tab.id)).runtime.revision;

      expect(await recoverTerminalRuntime(storage)).toBe(0);
      const after = await storage.readTab(tab.id);
      expect(after.runtime.revision).toBe(revision);
      expect(after.runtime.runner.desiredState).toBe("armed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs an orphaned running prompt even when runtime and session are already paused", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-prompt-recovery-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("孤立运行记录");
      const bundle = await storage.readTab(tab.id);
      const prompt = newPrompt("没有存活运行器的 prompt");
      prompt.status = "dispatching";
      bundle.prompts.prompts.push(prompt);
      await storage.writePrompts(tab.id, bundle.prompts);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      expect((await storage.readTab(tab.id)).prompts.prompts[0]).toMatchObject({
        status: "interrupted",
        error: { code: "SERVICE_RESTARTED" },
      });
      expect(await recoverTerminalRuntime(storage)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears a stale runner even when the conversation was already closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-closed-runner-recovery-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("已关闭但仍显示运行");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        session: { ...current.session, state: "closed", workingDirectory: root, threadId: "thread-stale", sessionId: "thread-stale" },
      }));
      const bundle = await storage.readTab(tab.id);
      bundle.runtime.runner.state = "pausing";
      bundle.runtime.runner.activePromptId = "prompt-stale";
      bundle.runtime.runner.activeTurnId = "turn-stale";
      await storage.writeRuntime(tab.id, bundle.runtime);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      expect((await storage.readTab(tab.id)).runtime.runner).toMatchObject({
        // The stale run is cleared; the queue's own setting is not the stale
        // part and survives, as it does everywhere else.
        desiredState: "armed",
        state: "paused",
        activePromptId: null,
        activeTurnId: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears persisted App Server ownership after restart recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-owner-recovery-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("进程归属恢复测试");
      const bundle = await storage.readTab(tab.id);
      bundle.runtime.terminal.appServer = {
        launcherPid: null,
        listenerPid: null,
        port: 65_534,
        startedAt: new Date(0).toISOString(),
      };
      await storage.writeRuntime(tab.id, bundle.runtime);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      expect((await storage.readTab(tab.id)).runtime.terminal.appServer).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // Recovery probes a real port to decide whether the recorded App Server is
    // still there, which takes about three seconds on its own. That leaves no
    // margin under the default timeout once the rest of the suite is competing
    // for the machine, and this failing intermittently would hide a real one.
  }, 20_000);
});

describe("slash command restart recovery", () => {
  it("settles stale command lifecycle records without creating an interrupted answer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-command-recovery-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("command recovery");
      const bundle = await storage.readTab(tab.id);
      const prompt = newPrompt("/status", "queue");
      const attempt = newAttempt("queue");
      Object.assign(attempt, { status: "running", codexTurnId: "turn-status", clientUserMessageId: "client-status" });
      Object.assign(prompt, {
        status: "running",
        threadId: "thread-status",
        codexTurnId: "turn-status",
        clientUserMessageId: "client-status",
        attempts: [attempt],
      });
      bundle.prompts.prompts = [prompt];
      bundle.answers.answers = [{
        id: "answer-status",
        promptId: prompt.id,
        threadId: "thread-status",
        codexTurnId: "turn-status",
        origin: "queue",
        prompt: "/status",
        status: "running",
        finalAnswer: "",
        captureMode: null,
        startedAt: null,
        completedAt: null,
        recordedAt: isoNow(),
        clientUserMessageId: "client-status",
        error: null,
        metadata: { promptIds: [prompt.id] },
      }];
      await storage.writePrompts(tab.id, bundle.prompts);
      await storage.writeAnswers(tab.id, bundle.answers);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      const recovered = await storage.readTab(tab.id);
      expect(recovered.prompts.prompts[0]).toMatchObject({ status: "completed", error: null });
      expect(recovered.prompts.prompts[0].attempts[0]).toMatchObject({ status: "completed", error: null });
      expect(recovered.answers.answers).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("answer WebSocket events", () => {
  it("reserves the audible event for completed answers", () => {
    expect(answerEventType({ status: "running" })).toBe("answer.changed");
    expect(answerEventType({ status: "interrupted" })).toBe("answer.changed");
    expect(answerEventType({ status: "failed" })).toBe("answer.changed");
    expect(answerEventType({ status: "completed" })).toBe("answer.added");
  });
});

describe("launch restoration state", () => {
  it("restores marked tabs, supports legacy ready tabs, and records the final open set", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-open-state-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const legacyReady = await storage.createTab("旧版开启状态");
      const markedClosed = await storage.createTab("等待自动恢复");
      const closed = await storage.createTab("手动关闭");
      await storage.updateTab(legacyReady.id, (current) => ({
        ...current,
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-ready", sessionId: "thread-ready" },
      }));
      await storage.updateTab(markedClosed.id, (current) => ({
        ...current,
        session: { ...current.session, state: "closed", reopenOnLaunch: true, workingDirectory: root, threadId: "thread-marked", sessionId: "thread-marked" },
      }));
      await storage.updateTab(closed.id, (current) => ({
        ...current,
        session: { ...current.session, state: "closed", workingDirectory: root, threadId: "thread-closed", sessionId: "thread-closed" },
      }));

      expect(new Set(tabsToRestore(await storage.listTabMeta()))).toEqual(new Set([legacyReady.id, markedClosed.id]));
      expect(await recordOpenSessionsForNextLaunch(storage)).toEqual([legacyReady.id]);
      expect((await storage.getTabMeta(legacyReady.id)).session.reopenOnLaunch).toBe(true);
      expect((await storage.getTabMeta(markedClosed.id)).session.reopenOnLaunch).toBe(false);
      expect((await storage.getTabMeta(closed.id)).session.reopenOnLaunch).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("local browser origin", () => {
  it("accepts the fixed loopback URL and rejects cross-site or rebound hosts", () => {
    expect(isTrustedBrowserOrigin("http://127.0.0.1:4317", "127.0.0.1:4317")).toBe(true);
    expect(isTrustedBrowserOrigin("http://localhost:4317", "localhost:4317")).toBe(true);
    expect(isTrustedBrowserOrigin("https://example.com", "127.0.0.1:4317")).toBe(false);
    expect(isTrustedBrowserOrigin("http://example.com:4317", "example.com:4317")).toBe(false);
    expect(isTrustedBrowserOrigin(undefined, "127.0.0.1:4317")).toBe(false);
    expect(isTrustedBrowserRequest({ referer: "http://127.0.0.1:4317/", host: "127.0.0.1:4317" })).toBe(true);
    expect(isTrustedBrowserRequest({ referer: "http://example.com/", host: "127.0.0.1:4317" })).toBe(false);
  });

  it("also trusts an operator-configured host (e.g. a Cloudflare Tunnel hostname) but never by default", () => {
    const trustedHosts = ["promptor.example.com"];
    expect(isTrustedBrowserOrigin("https://promptor.example.com", "promptor.example.com", trustedHosts)).toBe(true);
    // Without the allowlist, a non-loopback host is rejected exactly as before.
    expect(isTrustedBrowserOrigin("https://promptor.example.com", "promptor.example.com")).toBe(false);
    // The allowlist does not weaken the same-origin check itself.
    expect(isTrustedBrowserOrigin("https://evil.example.com", "promptor.example.com", trustedHosts)).toBe(false);
    expect(isTrustedBrowserOrigin("https://promptor.example.com", "other.example.com", trustedHosts)).toBe(false);
    expect(isTrustedBrowserRequest({ origin: "https://promptor.example.com", host: "promptor.example.com" }, trustedHosts)).toBe(true);
  });

  it("isLocalHost only accepts 127.0.0.1/localhost, with or without a port", () => {
    expect(isLocalHost("127.0.0.1")).toBe(true);
    expect(isLocalHost("127.0.0.1:4317")).toBe(true);
    expect(isLocalHost("localhost:4317")).toBe(true);
    expect(isLocalHost("promptor.example.com")).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
  });
});

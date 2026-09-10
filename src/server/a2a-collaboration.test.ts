import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isoNow, newAttempt } from "../shared/schemas.js";
import { createApp, type PromptorApp } from "./app.js";

/**
 * A collaboration end to end, without a CLI.
 *
 * Sessions are faked to "ready" because what is under test is the protocol,
 * not the terminal: who may call, how much they may spend, where a message
 * lands, and when the whole thing is allowed to be over. Nothing here starts
 * a model turn.
 */

const LOCAL = "127.0.0.1:4317";
const REMOTE = "promptor.example.com";

describe("agent to agent", () => {
  let app: PromptorApp;
  let root: string;

  beforeEach(async () => {
    // Nothing is set: A2A is on by default, and these tests exercise that.
    delete process.env.CODEX_PROMPTOR_A2A;
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-a2a-"));
    await mkdir(path.join(root, "dist", "client"), { recursive: true });
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>t</title>", "utf8");
    // The skills the app ships with, so a test root freezes a real policy.
    await mkdir(path.join(root, "a2a", "skills"), { recursive: true });
    for (const name of ["central", "debate", "explore"]) {
      const source = path.join(process.cwd(), "a2a", "skills", `${name}.md`);
      await writeFile(path.join(root, "a2a", "skills", `${name}.md`), await readFileUtf8(source), "utf8");
    }
    app = await createApp(root);
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.CODEX_PROMPTOR_A2A;
    await app.promptor.close();
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  const local = () => ({ "x-codex-promptor-token": app.promptor.token, host: LOCAL, origin: `http://${LOCAL}` });

  /**
   * A conversation that looks connected, without launching anything. Its queue
   * is paused unless a test asks otherwise, so the real runner does not race
   * the hand-driven turns below for a CLI that is not there.
   */
  const readyTab = async (name: string, provider: "codex" | "claude" = "codex", armed = false) => {
    const tab = await app.promptor.storage.createTab(name);
    await app.promptor.storage.updateTab(tab.id, (current) => ({
      ...current,
      session: { ...current.session, provider, state: "ready", threadId: `thread-${tab.id}`, sessionId: `session-${tab.id}`, workingDirectory: root, connectedAt: isoNow() },
    }));
    const runtime = await app.promptor.storage.readRuntime(tab.id);
    await app.promptor.storage.writeRuntime(tab.id, { ...runtime, runner: { ...runtime.runner, desiredState: armed ? "armed" : "paused" } });
    return tab.id;
  };

  const addPrompt = (tabId: string, text: string) => app.inject({
    method: "POST",
    url: `/api/tabs/${tabId}/prompts`,
    headers: local(),
    payload: { text } as never,
  });

  /**
   * Put a prompt into the state the queue would put it in just before it hands
   * text to the CLI, and take the context the dispatch hands back.
   */
  const beginTurn = async (tabId: string, promptId: string) => {
    const bundle = await app.promptor.storage.readTab(tabId);
    const prompt = bundle.prompts.prompts.find((item) => item.id === promptId)!;
    const attempt = newAttempt(prompt.origin);
    attempt.status = "dispatching";
    attempt.startedAt = isoNow();
    prompt.attempts.push(attempt);
    prompt.status = "running";
    prompt.threadId = bundle.tab.session.threadId;
    await app.promptor.storage.writePrompts(tabId, bundle.prompts);
    const prepared = await app.promptor.a2a.prepareDispatch({
      tab: bundle.tab,
      prompt,
      attemptId: attempt.attemptId,
      threadId: bundle.tab.session.threadId!,
    });
    // What QueueRunner does with the result, so the stored record matches a
    // real dispatch: the submitted text on the attempt, the collaboration on
    // the prompt.
    if (prepared) {
      if (prepared.submittedText !== prompt.text) attempt.submittedText = prepared.submittedText;
      if (prepared.a2a) prompt.a2a = prepared.a2a;
      await app.promptor.storage.writePrompts(tabId, bundle.prompts);
    }
    return { contextId: attempt.attemptId, submitted: prepared?.submittedText ?? null };
  };

  const settleTurn = async (tabId: string, promptId: string, status: "completed" | "interrupted" = "completed") => {
    const bundle = await app.promptor.storage.readTab(tabId);
    const prompt = bundle.prompts.prompts.find((item) => item.id === promptId)!;
    prompt.status = status;
    prompt.completedAt = isoNow();
    for (const attempt of prompt.attempts) attempt.status = status;
    await app.promptor.storage.writePrompts(tabId, bundle.prompts);
    await app.promptor.a2a.onQueueEvent(tabId);
  };

  const call = (tabId: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) => {
    return app.inject({
      method: "POST",
      url: `/a2a/codex/${tabId}/${leaseNonce(app, tabId)}`,
      headers: { authorization: `Bearer ${leaseSecret(app, tabId)}`, host: LOCAL, ...extraHeaders },
      payload: body as never,
    });
  };

  it("starts a root from @@, stores the clean prompt, and does not light up until it runs", async () => {
    const tabId = await readyTab("协调");
    const response = await addPrompt(tabId, "@@ 把这件事拆开做");
    expect(response.statusCode).toBe(200);
    const prompt = response.json().data.prompt;
    // The stored text is exactly what the reader wrote, prefix included.
    expect(prompt.text).toBe("@@ 把这件事拆开做");
    expect(prompt.a2a).toMatchObject({ rootId: prompt.id, skill: "central", depth: 0, fromTabId: null });

    const pending = await app.promptor.a2a.readRoot(prompt.id);
    expect(pending).toMatchObject({ status: "pending", startedAt: null, usedMessages: 1 });
    // Pending is not running: nothing has been dispatched, so no purple light.
    // A root with no dispatched turn has no participants yet, so nothing shows
    // a running light. The queued prompt still carries its own A2A badge.
    expect(await app.promptor.a2a.summaryForTab(tabId)).toBeUndefined();

    const { submitted } = await beginTurn(tabId, prompt.id);
    expect((await app.promptor.a2a.readRoot(prompt.id))!.status).toBe("running");
    expect((await app.promptor.a2a.summaryForTab(tabId))!.active).toBe(true);
    // The preamble goes to the CLI, and the reader's words are still the tail.
    expect(submitted).toContain("Promptor A2A 协作说明");
    expect(submitted).toContain("coordinator");
    expect(submitted!.endsWith("@@ 把这件事拆开做")).toBe(true);
  });

  it("starts a collaboration when @@ is typed in front of a prompt already in the queue", async () => {
    // The reported case: a prompt is queued as ordinary text, then edited to
    // begin with @@ and run. It has to become a real collaboration, not a
    // prompt whose text is literally "\\@@...".
    const tabId = await readyTab("协调");
    const queued = (await addPrompt(tabId, "帮我看看这个方案")).json().data.prompt;
    expect(queued.a2a).toBeUndefined();

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/tabs/${tabId}/prompts/${queued.id}`,
      headers: local(),
      payload: { text: "@@ 帮我看看这个方案" } as never,
    });
    expect(edited.statusCode).toBe(200);
    const prompt = edited.json().data.prompt;
    expect(prompt.text).toBe("@@ 帮我看看这个方案");
    expect(prompt.a2a).toMatchObject({ rootId: queued.id, skill: "central", depth: 0 });
    expect(await app.promptor.a2a.readRoot(queued.id)).toMatchObject({ status: "pending", skill: "central" });

    // And it lights up the moment it is dispatched, like any other root.
    await beginTurn(tabId, queued.id);
    expect((await app.promptor.a2a.summaryForTab(tabId))!.active).toBe(true);
  });

  it("keeps an escaped @@ out of a collaboration when it is first written", async () => {
    const tabId = await readyTab("协调");
    const queued = (await addPrompt(tabId, "\\@@ 这是正文")).json().data.prompt;
    expect(queued.text).toBe("@@ 这是正文");
    expect(queued.a2a).toBeUndefined();
    expect(await app.promptor.a2a.readRoot(queued.id)).toBeNull();
  });

  it("never lets an escaped @@ reach the CLI through insert-now", async () => {
    // This is how "\\@@..." became a prompt's own text: the replacement text on
    // this route was stored and submitted without ever being parsed.
    const tabId = await readyTab("协调");
    const queued = (await addPrompt(tabId, "\\@@ 这是正文")).json().data.prompt;

    const inserted = await app.inject({
      method: "POST",
      url: `/api/tabs/${tabId}/prompts/${queued.id}/insert-now`,
      headers: local(),
      payload: { text: "@@ 这是正文" } as never,
    });
    // Whatever the runner does with it, the text it was given is clean.
    const stored = (await app.promptor.storage.readTab(tabId)).prompts.prompts.find((item) => item.id === queued.id)!;
    expect(stored.text.startsWith("\\")).toBe(false);
    void inserted;
  });

  it("runs a collaboration now when nothing is in flight, rather than refusing", async () => {
    // The reported case: run-now on a collaboration prompt was refused even
    // with the queue idle. With no turn to steer into, this is an ordinary
    // start, which is exactly what a collaboration message needs.
    const tabId = await readyTab("协调");
    const queued = (await addPrompt(tabId, "帮我看看这个方案")).json().data.prompt;
    const inserted = await app.inject({
      method: "POST",
      url: `/api/tabs/${tabId}/prompts/${queued.id}/insert-now`,
      headers: local(),
      payload: { text: "@@ 帮我看看这个方案" } as never,
    });
    expect(inserted.statusCode).toBe(200);
    expect(inserted.json().data.mode).toBe("started");
    // The edit was applied on the way through, so it really is a collaboration.
    const stored = (await app.promptor.storage.readTab(tabId)).prompts.prompts.find((item) => item.id === queued.id)!;
    expect(stored.text).toBe("@@ 帮我看看这个方案");
    expect(stored.a2a).toMatchObject({ rootId: queued.id, skill: "central", depth: 0 });
    expect(await app.promptor.a2a.readRoot(queued.id)).toMatchObject({ skill: "central" });
  });

  it("refuses to steer a collaboration into a turn that is already running", async () => {
    const tabId = await readyTab("协调");
    const queued = (await addPrompt(tabId, "@@ 帮我看看这个方案")).json().data.prompt;
    // One turn in flight, which run-now would otherwise steer into.
    const active = (await addPrompt(tabId, "另一件事")).json().data.prompt;
    await beginTurn(tabId, active.id);
    const runtime = await app.promptor.storage.readRuntime(tabId);
    await app.promptor.storage.writeRuntime(tabId, {
      ...runtime,
      runner: { ...runtime.runner, state: "running", activePromptId: active.id, activeTurnId: "turn-1" },
    });
    const refused = await app.inject({
      method: "POST",
      url: `/api/tabs/${tabId}/prompts/${queued.id}/insert-now`,
      headers: local(),
    });
    // Either the runner had no live turn to report (started) or it refused to
    // steer -- what must never happen is the message being folded into it.
    expect([200, 409]).toContain(refused.statusCode);
    if (refused.statusCode === 200) expect(refused.json().data.mode).toBe("started");
    else expect(refused.json().error.code).toBe("A2A_INSERT_NOW_UNSUPPORTED");
  });

  it("keeps an ordinary prompt in the collaboration its conversation is already inside", async () => {
    // A reply the reader writes while the collaboration is still open belongs
    // to it, or that turn has nothing to call the endpoint with and no rules
    // to follow. It has to still be open: a collaboration with nothing left
    // running ends by itself, and a follow-up after that is ordinary text.
    const tabId = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(tabId, "@@ 把这件事拆开做")).json().data.prompt;
    const first = await beginTurn(tabId, rootPrompt.id);
    await call(tabId, { op: "send", contextId: first.contextId, requestId: "r1", to, text: "任务" });
    await settleTurn(tabId, rootPrompt.id);

    const answer = (await addPrompt(tabId, "确认")).json().data.prompt;
    // Nothing is claimed before it runs: joining happens at dispatch, when the
    // root is known to still be open.
    expect(answer.a2a).toBeUndefined();
    const { contextId, submitted } = await beginTurn(tabId, answer.id);
    expect(submitted).toContain("Promptor A2A 协作说明");
    expect(submitted!.endsWith("确认")).toBe(true);

    // It now shows as part of that collaboration, and can actually call it.
    const stored = (await app.promptor.storage.readTab(tabId)).prompts.prompts.find((item) => item.id === answer.id)!;
    expect(stored.text).toBe("确认");
    expect(stored.a2a).toMatchObject({ rootId: rootPrompt.id, skill: "central", depth: 0, fromTabId: null });
    const listed = await call(tabId, { op: "list", contextId });
    expect(listed.statusCode).toBe(200);
  });

  it("leaves an ordinary prompt alone once the collaboration has ended", async () => {
    const tabId = await readyTab("协调");
    const rootPrompt = (await addPrompt(tabId, "@@ 把这件事拆开做")).json().data.prompt;
    await beginTurn(tabId, rootPrompt.id);
    await settleTurn(tabId, rootPrompt.id);
    await app.inject({ method: "POST", url: `/api/a2a/roots/${rootPrompt.id}/stop`, headers: local() });

    const later = (await addPrompt(tabId, "另一件不相干的事")).json().data.prompt;
    const { submitted } = await beginTurn(tabId, later.id);
    expect(submitted).toBeNull();
    const stored = (await app.promptor.storage.readTab(tabId)).prompts.prompts.find((item) => item.id === later.id)!;
    expect(stored.a2a).toBeUndefined();
  });

  it("starts a new collaboration when a @@ prompt is run again after its own ended", async () => {
    // The reported case: an ended collaboration's prompt was edited and run
    // again. It kept pointing at the ended root, so it dispatched with the
    // badge still on and none of the behaviour -- no preamble, no context.
    const tabId = await readyTab("协调");
    const first = (await addPrompt(tabId, "@@ 让另一个对话算一道题")).json().data.prompt;
    await beginTurn(tabId, first.id);
    await settleTurn(tabId, first.id);
    // Nothing is left running, so it has already ended on its own.
    expect((await app.promptor.a2a.readRoot(first.id))!.status).toBe("completed");

    // Editing it and running it again is the reader starting over.
    await app.inject({
      method: "PATCH",
      url: `/api/tabs/${tabId}/prompts/${first.id}`,
      headers: local(),
      payload: { text: "@@ 让另一个对话算一道积分题" } as never,
    });
    const { contextId, submitted } = await beginTurn(tabId, first.id);
    expect(submitted).toContain("Promptor A2A 协作说明");

    const stored = (await app.promptor.storage.readTab(tabId)).prompts.prompts.find((item) => item.id === first.id)!;
    expect(stored.a2a!.rootId).not.toBe(first.id);
    const fresh = await app.promptor.a2a.readRoot(stored.a2a!.rootId);
    expect(fresh).toMatchObject({ status: "running", usedMessages: 1, originPromptId: first.id });
    // The ended one is still on disk, saying what happened to it.
    expect((await app.promptor.a2a.readRoot(first.id))!.status).toBe("completed");
    expect((await call(tabId, { op: "list", contextId })).statusCode).toBe(200);
  });

  it("does not resurrect a collaboration by re-running a message that arrived from elsewhere", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    const sent = await call(from, { op: "send", contextId, requestId: "r1", to, text: "任务" });
    const workerPromptId = sent.json().data.delivered.promptId;
    await settleTurn(from, rootPrompt.id);
    // Run it once so stopping cannot simply cancel it as unstarted work.
    await beginTurn(to, workerPromptId);
    await settleTurn(to, workerPromptId, "interrupted");
    await app.inject({ method: "POST", url: `/api/a2a/roots/${rootPrompt.id}/stop`, headers: local() });

    const { submitted } = await beginTurn(to, workerPromptId);
    expect(submitted).toBeNull();
    expect((await app.promptor.a2a.store.all()).filter((root) => root.originPromptId === workerPromptId)).toHaveLength(0);
  });

  it("refuses a mode that does not exist, before anything is stored", async () => {
    const tabId = await readyTab("协调");
    const response = await addPrompt(tabId, "@@nosuchmode 做点什么");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("A2A_SKILL_NOT_FOUND");
    expect((await app.promptor.storage.readTab(tabId)).prompts.prompts).toHaveLength(0);
  });

  it("leaves an ordinary prompt alone and starts no collaboration", async () => {
    const tabId = await readyTab("普通");
    const prompt = (await addPrompt(tabId, "看看 @@ 这个符号是什么")).json().data.prompt;
    expect(prompt.a2a).toBeUndefined();
    expect(await app.promptor.a2a.summaryForTab(tabId)).toBeUndefined();
  });

  it("delivers a send to the target queue, and only the target's queue holds the text", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行", "claude", true);
    const rootPrompt = (await addPrompt(from, "@@ 分给执行者")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);

    const sent = await call(from, { op: "send", contextId, requestId: "r1", to, text: "请检查 A 的边界条件" });
    expect(sent.statusCode).toBe(200);
    const data = sent.json().data;
    expect(data.delivered).toMatchObject({ tabId: to, delivery: "queued" });
    expect(data.budget).toMatchObject({ usedMessages: 2, remainingMessages: 18, currentDepth: 0, remainingHops: 3 });

    const target = await app.promptor.storage.readTab(to);
    expect(target.prompts.prompts).toHaveLength(1);
    expect(target.prompts.prompts[0].text).toBe("请检查 A 的边界条件");
    expect(target.prompts.prompts[0].a2a).toMatchObject({ rootId: rootPrompt.id, depth: 1, fromTabId: from, fromPromptId: rootPrompt.id });
    // The sender keeps a receipt, not a second copy of the message.
    expect((await app.promptor.storage.readTab(from)).prompts.prompts).toHaveLength(1);

    // Both conversations now show the same unfinished root.
    expect((await app.promptor.a2a.summaryForTab(to))!.active).toBe(true);
    expect((await app.promptor.a2a.summaryForTab(from))!.roots[0].participants).toBe(2);

    // And a page that simply opens the tab sees it, without waiting for a push.
    const fetched = await app.inject({ method: "GET", url: `/api/tabs/${to}`, headers: local() });
    expect(fetched.json().data.a2a).toMatchObject({ active: true });
    expect(fetched.json().data.a2a.roots[0]).toMatchObject({ skill: "central", role: "worker", level: 1, permissionMode: "soft" });
    // The projection carries the summary and nothing frozen or secret.
    expect(JSON.stringify(fetched.json().data.a2a)).not.toContain("allowedOps");
    expect(JSON.stringify(fetched.json().data)).not.toContain("submittedText");
  });

  it("treats a repeated requestId as the same request, and a changed one as a conflict", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);

    const first = await call(from, { op: "send", contextId, requestId: "same", to, text: "任务一" });
    const replay = await call(from, { op: "send", contextId, requestId: "same", to, text: "任务一" });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.replayed).toBe(true);
    expect(replay.json().data.delivered.promptId).toBe(first.json().data.delivered.promptId);
    // A replay must not enqueue a second copy or spend a second message.
    expect((await app.promptor.storage.readTab(to)).prompts.prompts).toHaveLength(1);
    expect((await app.promptor.a2a.readRoot(rootPrompt.id))!.usedMessages).toBe(2);

    const conflict = await call(from, { op: "send", contextId, requestId: "same", to, text: "换了一个任务" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("A2A_REQUEST_CONFLICT");
  });

  it("stops at the message limit without touching what is already queued", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    // Spend the budget directly: the point is the refusal, not 19 round trips.
    const store = app.promptor.a2a.store;
    await store.write({ ...(await store.read(rootPrompt.id))!, usedMessages: 20 });

    const refused = await call(from, { op: "send", contextId, requestId: "over", to, text: "再来一条" });
    expect(refused.statusCode).toBe(429);
    const error = refused.json().error;
    expect(error.code).toBe("A2A_MESSAGE_LIMIT");
    expect(error.retryable).toBe(false);
    // The refusal carries the numbers and the advice the agent needs to wrap up.
    expect(error.details.advice).toBe("finalize_locally");
    expect(error.details.budget.remainingMessages).toBe(0);
    // And nothing was delivered.
    expect((await app.promptor.storage.readTab(to)).prompts.prompts).toHaveLength(0);
  });

  it("counts a rejected delivery back, so a closed target does not cost a message", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    await app.promptor.storage.updateTab(to, (current) => ({ ...current, session: { ...current.session, state: "closed" } }));
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);

    const refused = await call(from, { op: "send", contextId, requestId: "r", to, text: "任务" });
    expect(refused.statusCode).toBe(423);
    expect(refused.json().error.code).toBe("A2A_TARGET_CLOSED");
    expect((await app.promptor.a2a.readRoot(rootPrompt.id))!.usedMessages).toBe(1);
  });

  it("saves a message for a paused queue without starting it", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const runtime = await app.promptor.storage.readRuntime(to);
    await app.promptor.storage.writeRuntime(to, { ...runtime, runner: { ...runtime.runner, desiredState: "paused" } });
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);

    const sent = await call(from, { op: "send", contextId, requestId: "r", to, text: "任务" });
    expect(sent.json().data.delivered.delivery).toBe("waitingForStart");
    expect((await app.promptor.storage.readRuntime(to)).runner.desiredState).toBe("paused");
    expect((await app.promptor.storage.readTab(to)).prompts.prompts).toHaveLength(1);
  });

  it("refuses a terminal conversation as a target", async () => {
    const from = await readyTab("协调");
    const shell = (await app.promptor.storage.createTab("终端")).id;
    await app.promptor.storage.updateTab(shell, (current) => ({
      ...current,
      session: { ...current.session, provider: "shell", state: "ready" },
    }));
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    const refused = await call(from, { op: "send", contextId, requestId: "r", to: shell, text: "任务" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe("A2A_TARGET_NOT_AGENT");
  });

  it("stops a context the moment its turn is no longer the one running", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    await settleTurn(from, rootPrompt.id);

    const refused = await call(from, { op: "send", contextId, requestId: "r", to, text: "本轮已经结束了" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("A2A_CONTEXT_EXPIRED");
  });

  it("refuses a lease that belongs to another conversation", async () => {
    const from = await readyTab("协调");
    const other = await readyTab("别人");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    // A valid lease for `other`, used with `from`'s context.
    const refused = await call(other, { op: "send", contextId, requestId: "r", to: from, text: "冒充" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("A2A_CONTEXT_INVALID");
  });

  it("refuses a request that arrived through a proxy, even from loopback", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);

    const forwarded = await call(from, { op: "send", contextId, requestId: "r", to, text: "x" }, { "cf-connecting-ip": "203.0.113.4" });
    expect(forwarded.statusCode).toBe(403);
    expect(forwarded.json().error.code).toBe("A2A_LOCAL_ONLY");

    const tunnelled = await app.inject({
      method: "POST",
      url: `/a2a/codex/${from}/${leaseNonce(app, from)}`,
      headers: { authorization: `Bearer ${leaseSecret(app, from)}`, host: REMOTE },
      payload: { op: "list", contextId } as never,
    });
    expect(tunnelled.statusCode).toBe(403);
  });

  it("does not end because a queue emptied, and ends only after the confirming turn lands", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const first = await beginTurn(from, rootPrompt.id);
    const sent = await call(from, { op: "send", contextId: first.contextId, requestId: "r1", to, text: "任务" });
    const workerPromptId = sent.json().data.delivered.promptId;
    await settleTurn(from, rootPrompt.id);

    // The origin's queue is empty and its turn is done -- and the root is not.
    expect((await app.promptor.a2a.readRoot(rootPrompt.id))!.status).toBe("running");
    expect((await app.promptor.a2a.summaryForTab(from))!.active).toBe(true);

    // The worker reports back, which is a send in the other direction.
    const worker = await beginTurn(to, workerPromptId);
    const back = await call(to, { op: "send", contextId: worker.contextId, requestId: "r2", to: from, text: "做完了：结论是 X" });
    expect(back.statusCode).toBe(200);
    expect(back.json().data.budget.currentDepth).toBe(1);
    await settleTurn(to, workerPromptId);

    // A worker cannot declare the whole thing over.
    const summaryPromptId = (await app.promptor.storage.readTab(from)).prompts.prompts.at(-1)!.id;
    const summary = await beginTurn(from, summaryPromptId);
    const workerFinish = await call(to, { op: "finish", contextId: worker.contextId, requestId: "f0" });
    expect(workerFinish.statusCode).toBe(409);

    const finished = await call(from, { op: "finish", contextId: summary.contextId, requestId: "f1" });
    expect(finished.statusCode).toBe(200);
    // Accepted, not done: the confirming turn has not landed yet.
    expect(finished.json().data.root.status).toBe("ending");
    expect((await app.promptor.a2a.summaryForTab(from))!.active).toBe(true);
    // And no new work is accepted while it is ending.
    const late = await call(from, { op: "send", contextId: summary.contextId, requestId: "r9", to, text: "再来一条" });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("A2A_ROOT_ENDING");

    await settleTurn(from, summaryPromptId);
    const done = await app.promptor.a2a.readRoot(rootPrompt.id);
    expect(done).toMatchObject({ status: "completed", endReason: "completed" });
    expect(done!.endedAt).toBeTruthy();
    expect((await app.promptor.a2a.summaryForTab(from))!.active).toBe(false);
  });

  it("withdraws a finish whose confirming turn was interrupted, rather than reporting it done", async () => {
    const from = await readyTab("协调");
    const rootPrompt = (await addPrompt(from, "@@ 一个人也能协作")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    expect((await call(from, { op: "finish", contextId, requestId: "f1" })).statusCode).toBe(200);
    await settleTurn(from, rootPrompt.id, "interrupted");
    const root = await app.promptor.a2a.readRoot(rootPrompt.id);
    expect(root).toMatchObject({ status: "running", endReason: "finish_confirmation_failed", endedAt: null });
  });

  it("refuses to finish while another branch is still working", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    await call(from, { op: "send", contextId, requestId: "r1", to, text: "任务" });
    const blocked = await call(from, { op: "finish", contextId, requestId: "f1" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("A2A_FINISH_BLOCKED");
    expect(blocked.json().error.details.outstanding).toHaveLength(1);
  });

  it("keeps the root, its members and its spend across a restart", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    await call(from, { op: "send", contextId, requestId: "r1", to, text: "任务" });

    await app.promptor.close();
    await app.close();
    app = await createApp(root);
    await app.ready();

    const restored = await app.promptor.a2a.readRoot(rootPrompt.id);
    expect(restored).toMatchObject({ status: "running", usedMessages: 2, skill: "central" });
    expect(restored!.members.map((member) => member.tabId).sort()).toEqual([from, to].sort());
    // Both participants still show the light without re-reading any CLI history.
    expect((await app.promptor.a2a.summaryForTab(to))!.active).toBe(true);
    // But the old context is gone: even a valid new lease cannot use it, so a
    // call left over from before the restart has no way to write.
    const stale = await call(from, { op: "send", contextId, requestId: "r2", to, text: "重启之后" });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe("A2A_CONTEXT_INVALID");
  });

  it("stops a collaboration whose queued work never started, without waiting on it", async () => {
    // The queued item is cancelled, so there is nothing left in flight and the
    // root settles at once. Binding the end to that item and then deleting it
    // left the root saying "ending" with nothing on the way.
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    await call(from, { op: "send", contextId, requestId: "r1", to, text: "任务" });
    await settleTurn(from, rootPrompt.id);
    expect((await app.promptor.storage.readTab(to)).prompts.prompts).toHaveLength(1);

    const stopped = await app.inject({ method: "POST", url: `/api/a2a/roots/${rootPrompt.id}/stop`, headers: local() });
    expect(stopped.json().data).toMatchObject({ status: "stopped", endReason: "stopped_by_user" });
    expect((await app.promptor.storage.readTab(to)).prompts.prompts).toHaveLength(0);
    expect((await app.promptor.a2a.summaryForTab(from))!.active).toBe(false);
  });

  it("lets a second stop end a root whose turn never reported", async () => {
    // A submission the CLI never confirms leaves its prompt in `dispatching`
    // for good. The first stop waits for it, as designed; the second must not
    // leave the person with no way out.
    const tabId = await readyTab("协调");
    const rootPrompt = (await addPrompt(tabId, "@@ 一直没有回执")).json().data.prompt;
    await beginTurn(tabId, rootPrompt.id);
    // beginTurn leaves the prompt running, which is what a wedged one looks like.
    const first = await app.inject({ method: "POST", url: `/api/a2a/roots/${rootPrompt.id}/stop`, headers: local() });
    expect(first.json().data.status).toBe("ending");
    expect((await app.promptor.a2a.summaryForTab(tabId))!.active).toBe(true);

    const second = await app.inject({ method: "POST", url: `/api/a2a/roots/${rootPrompt.id}/stop`, headers: local() });
    expect(second.json().data).toMatchObject({ status: "stopped", endReason: "stopped_by_user_unconfirmed" });
    expect((await app.promptor.a2a.summaryForTab(tabId))!.active).toBe(false);
  });

  it("settles a stop when its turn is interrupted rather than completed", async () => {
    const tabId = await readyTab("协调");
    const rootPrompt = (await addPrompt(tabId, "@@ 会被中断")).json().data.prompt;
    await beginTurn(tabId, rootPrompt.id);
    expect((await app.inject({ method: "POST", url: `/api/a2a/roots/${rootPrompt.id}/stop`, headers: local() })).json().data.status).toBe("ending");
    await settleTurn(tabId, rootPrompt.id, "interrupted");
    expect(await app.promptor.a2a.readRoot(rootPrompt.id)).toMatchObject({ status: "stopped", endReason: "stopped_by_user" });
  });

  it("ends on its own once nothing anywhere in it is still running", async () => {
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    const sent = await call(from, { op: "send", contextId, requestId: "r1", to, text: "任务" });
    await settleTurn(from, rootPrompt.id);
    // The worker still has it queued, so the collaboration is not over.
    expect((await app.promptor.a2a.readRoot(rootPrompt.id))!.status).toBe("running");
    expect((await app.promptor.a2a.summaryForTab(from))!.active).toBe(true);

    const workerPromptId = sent.json().data.delivered.promptId;
    await beginTurn(to, workerPromptId);
    await settleTurn(to, workerPromptId);
    expect(await app.promptor.a2a.readRoot(rootPrompt.id)).toMatchObject({ status: "completed", endReason: "completed_no_work" });
    expect((await app.promptor.a2a.summaryForTab(from))!.active).toBe(false);
    expect((await app.promptor.a2a.summaryForTab(to))!.active).toBe(false);
  });

  it("does not end while the turn that could still send is the one running", async () => {
    // The sending agent's own turn is the work that keeps its collaboration
    // open, so "nothing outstanding" can never be observed mid-exchange.
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    await app.promptor.a2a.onQueueEvent(from);
    expect((await app.promptor.a2a.readRoot(rootPrompt.id))!.status).toBe("running");
    // And it survives long enough for that turn to deliver.
    expect((await call(from, { op: "send", contextId, requestId: "r1", to, text: "任务" })).statusCode).toBe(200);
  });

  it("sweeps a collaboration that went quiet across a restart", async () => {
    const tabId = await readyTab("协调");
    const rootPrompt = (await addPrompt(tabId, "@@ 一个人也能协作")).json().data.prompt;
    await beginTurn(tabId, rootPrompt.id);
    // Settle the prompt without letting the sweep run, as a crash would.
    const bundle = await app.promptor.storage.readTab(tabId);
    const prompt = bundle.prompts.prompts.find((item) => item.id === rootPrompt.id)!;
    prompt.status = "completed";
    prompt.completedAt = isoNow();
    await app.promptor.storage.writePrompts(tabId, bundle.prompts);
    expect((await app.promptor.a2a.readRoot(rootPrompt.id))!.status).toBe("running");

    await app.promptor.a2a.settleQuietRootsOnLaunch();
    expect(await app.promptor.a2a.readRoot(rootPrompt.id)).toMatchObject({ status: "completed", endReason: "completed_no_work" });
  });

  it("lets a person stop a collaboration while its work is still queued", async () => {
    // Auto-completion covers the quiet case; stopping is for the one that is
    // still going and should not.
    const from = await readyTab("协调");
    const to = await readyTab("执行");
    const rootPrompt = (await addPrompt(from, "@@ 分工")).json().data.prompt;
    const { contextId } = await beginTurn(from, rootPrompt.id);
    await call(from, { op: "send", contextId, requestId: "r1", to, text: "任务" });
    await settleTurn(from, rootPrompt.id);
    expect((await app.promptor.a2a.readRoot(rootPrompt.id))!.status).toBe("running");

    const stopped = await app.inject({ method: "POST", url: `/api/a2a/roots/${rootPrompt.id}/stop`, headers: local() });
    expect(stopped.json().data).toMatchObject({ status: "stopped", endReason: "stopped_by_user" });
    expect((await app.promptor.storage.readTab(to)).prompts.prompts).toHaveLength(0);
    expect((await app.promptor.a2a.summaryForTab(from))!.active).toBe(false);
  });

  it("refuses @@ only when it has been turned off explicitly", async () => {
    const tabId = await readyTab("协调");
    // On by default -- every other test in this file relies on it.
    expect((await addPrompt(tabId, "@@ 分工")).statusCode).toBe(200);

    process.env.CODEX_PROMPTOR_A2A = "0";
    const restarted = await createApp(root);
    await restarted.ready();
    try {
      const response = await restarted.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/prompts`,
        headers: { "x-codex-promptor-token": restarted.promptor.token, host: LOCAL, origin: `http://${LOCAL}` },
        payload: { text: "@@ 再分一次" } as never,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("A2A_DISABLED");
    } finally {
      await restarted.promptor.close();
      await restarted.close();
    }
  });

  it("does not dispatch a collaboration message that was queued before it was turned off", async () => {
    // The switch has to hold on both sides: an already-accepted A2A prompt
    // must not quietly start collaborating after someone turns the feature off.
    const tabId = await readyTab("协调");
    const prompt = (await addPrompt(tabId, "@@ 分工")).json().data.prompt;

    process.env.CODEX_PROMPTOR_A2A = "0";
    const restarted = await createApp(root);
    await restarted.ready();
    try {
      const bundle = await restarted.promptor.storage.readTab(tabId);
      const queued = bundle.prompts.prompts.find((item) => item.id === prompt.id)!;
      const submitted = await restarted.promptor.a2a.prepareDispatch({
        tab: bundle.tab,
        prompt: queued,
        attemptId: "attempt-after-the-switch",
        threadId: bundle.tab.session.threadId!,
      });
      // Submitted unchanged: no preamble, and no context to call the endpoint with.
      expect(submitted).toBeNull();
      expect((await restarted.promptor.a2a.readRoot(prompt.id))!.status).toBe("pending");
    } finally {
      await restarted.promptor.close();
      await restarted.close();
    }
  });
});

async function readFileUtf8(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}

/** The lease a launched CLI would have been given, minted the same way. */
const leases = new WeakMap<PromptorApp, Map<string, { nonce: string; secret: string }>>();

function lease(app: PromptorApp, tabId: string): { nonce: string; secret: string } {
  let issued = leases.get(app);
  if (!issued) { issued = new Map(); leases.set(app, issued); }
  const existing = issued.get(tabId);
  if (existing) return existing;
  const fresh = app.promptor.issueHookLease("codex", tabId);
  issued.set(tabId, fresh);
  return fresh;
}

function leaseNonce(app: PromptorApp, tabId: string): string { return lease(app, tabId).nonce; }
function leaseSecret(app: PromptorApp, tabId: string): string { return lease(app, tabId).secret; }

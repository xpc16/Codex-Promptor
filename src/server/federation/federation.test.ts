import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type PromptorApp } from "../app.js";

/**
 * A hub and a member, both real, linked over loopback exactly as they would
 * be through Cloudflare -- minus Cloudflare. Everything a page would do to
 * reach the other machine is done here the way the page does it.
 */

type Instance = { app: PromptorApp; root: string; address: string };

const LOCAL = { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" };

async function startInstance(label: string): Promise<Instance> {
  const root = await mkdtemp(path.join(os.tmpdir(), `promptor-federation-${label}-`));
  await mkdir(path.join(root, "dist", "client"), { recursive: true });
  await writeFile(path.join(root, "dist", "client", "index.html"), `<!doctype html><title>${label}</title>`, "utf8");
  const app = await createApp(root);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, root, address };
}

async function stopInstance(instance: Instance | null): Promise<void> {
  if (!instance) return;
  await instance.app.promptor.close().catch(() => undefined);
  await instance.app.close().catch(() => undefined);
  await rm(instance.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
}

/** What this machine's own page sends. */
const local = (instance: Instance) => ({ ...LOCAL, "x-codex-promptor-token": instance.app.promptor.token });

async function admin(instance: Instance, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const response = await instance.app.inject({ method, url, headers: local(instance), ...(payload === undefined ? {} : { payload: payload as never }) });
  return { status: response.statusCode, body: response.json() as any };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    value = await read();
  }
  return value;
}

const view = async (instance: Instance) => (await instance.app.inject({ method: "GET", url: "/api/federation", headers: local(instance) })).json().data;

describe("two machines, one workspace", () => {
  let hub: Instance;
  let member: Instance;
  let extra: Instance | null = null;
  let hubId: string;
  let memberId: string;
  let joinCode: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    hub = await startInstance("hub");
    member = await startInstance("member");
    const enabled = await admin(hub, "POST", "/api/federation/admin/hub", { name: "工作电脑", publicUrl: hub.address });
    expect(enabled.status).toBe(200);
    hubId = enabled.body.data.deviceId;
    const added = await admin(hub, "POST", "/api/federation/admin/devices", { name: "家用电脑" });
    expect(added.status).toBe(200);
    joinCode = added.body.data.joinCode;
    const joined = await admin(member, "POST", "/api/federation/admin/join", { joinCode });
    expect(joined.status).toBe(200);
    memberId = joined.body.data.deviceId;
    await until(() => view(member), (current) => current.hubReachable === true);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) { try { socket.terminate(); } catch { /* gone */ } }
    await stopInstance(extra);
    extra = null;
    await stopInstance(member);
    await stopInstance(hub);
  });

  it("lists both machines on both sides, the hub first", async () => {
    const fromHub = await until(() => view(hub), (current) => current.devices.length === 2 && current.devices.every((device: any) => device.online));
    expect(fromHub).toMatchObject({ mode: "hub", selfId: hubId, hubReachable: true });
    expect(fromHub.devices.map((device: any) => device.name)).toEqual(["工作电脑", "家用电脑"]);
    const fromMember = await view(member);
    expect(fromMember).toMatchObject({ mode: "member", selfId: memberId, hubReachable: true });
    expect(fromMember.devices.map((device: any) => device.id)).toEqual([hubId, memberId]);
    // No credential in what a page is told.
    expect(JSON.stringify(fromMember)).not.toContain(joinCode.slice(4, 20));
  });

  it("lets the hub's page read and change the member's conversations", async () => {
    const tab = await member.app.promptor.storage.createTab("家里的对话");
    const read = await hub.app.inject({ method: "GET", url: `/d/${memberId}/api/tabs/${tab.id}`, headers: { "x-codex-promptor-token": hub.app.promptor.token } });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.tab.name).toBe("家里的对话");
    const renamed = await hub.app.inject({
      method: "PATCH",
      url: `/d/${memberId}/api/tabs/${tab.id}`,
      headers: { "x-codex-promptor-token": hub.app.promptor.token, "content-type": "application/json" },
      payload: JSON.stringify({ name: "改过名" }),
    });
    expect(renamed.statusCode).toBe(200);
    // Written where it lives, and nowhere else.
    expect((await member.app.promptor.storage.getTabMeta(tab.id)).name).toBe("改过名");
    expect((await hub.app.promptor.storage.listTabMeta()).some((meta) => meta.id === tab.id)).toBe(false);
  });

  it("lets the member's page reach the hub through ordinary HTTPS to the hub", async () => {
    const tab = await hub.app.promptor.storage.createTab("公司的对话");
    const read = await member.app.inject({ method: "GET", url: `/d/${hubId}/api/tabs/${tab.id}`, headers: { "x-codex-promptor-token": member.app.promptor.token } });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.tab.name).toBe("公司的对话");
  });

  it("treats a forwarded request as remote, however it is dressed", async () => {
    // Host and Origin of the machine's own page, copied onto a relayed call:
    // the far side rebuilds the headers, so the folder dialog still refuses.
    const response = await hub.app.inject({
      method: "POST",
      url: `/d/${memberId}/api/dialog/select-directory`,
      headers: { ...LOCAL, "x-codex-promptor-token": hub.app.promptor.token, "content-type": "application/json", "x-local": "true" },
      payload: JSON.stringify({ initialPath: "C:\\" }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("DIRECTORY_DIALOG_LOCAL_ONLY");
  });

  it("refuses paths outside /api/ and the federation settings", async () => {
    for (const url of [
      `/d/${memberId}/hooks/codex/x/y`,
      `/d/${memberId}/api/../hooks/x`,
      `/d/${memberId}/api/tabs%2fx`,
      `/d/${memberId}/api/federation/admin/leave`,
    ]) {
      const response = await hub.app.inject({ method: "POST", url, headers: { "x-codex-promptor-token": hub.app.promptor.token } });
      expect([400, 404], url).toContain(response.statusCode);
    }
  });

  it("requires a page to be authenticated before relaying anything", async () => {
    const response = await hub.app.inject({ method: "GET", url: `/d/${memberId}/api/tabs` });
    expect(response.statusCode).toBe(401);
  });

  it("carries a page's socket to the member's /ws", async () => {
    const tab = await member.app.promptor.storage.createTab("实时");
    const url = `${hub.address.replace(/^http/, "ws")}/d/${memberId}/ws?token=${encodeURIComponent(hub.app.promptor.token)}`;
    const socket = new WebSocket(url);
    sockets.push(socket);
    const messages: any[] = [];
    socket.on("message", (data, isBinary) => { if (!isBinary) messages.push(JSON.parse(data.toString())); });
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    // Sent at once; the member queues it until its own socket is open.
    socket.send(JSON.stringify({ type: "subscribe", allTabs: true, index: true, snapshots: false, details: false }));
    const index: any = await until(async () => messages.find((message) => message.type === "index.changed"), Boolean);
    expect(index.index.tabs.map((meta: any) => meta.id)).toContain(tab.id);
    // And events flow afterwards, from the machine that owns the conversation.
    await member.app.promptor.storage.updateIndex((current) => ({ ...current, tabs: current.tabs.map((meta) => meta.id === tab.id ? { ...meta, name: "实时改名" } : meta) }));
    const changed = await until(async () => messages.filter((message) => message.type === "index.changed").length, (count) => count >= 2);
    expect(changed).toBeGreaterThanOrEqual(2);
  });

  it("files a forwarded request as federation traffic on the machine that ran it", async () => {
    const tab = await member.app.promptor.storage.createTab("账本");
    await hub.app.inject({ method: "GET", url: `/d/${memberId}/api/tabs/${tab.id}`, headers: { "x-codex-promptor-token": hub.app.promptor.token } });
    const rollup = (await member.app.inject({ method: "GET", url: "/api/diagnostics/traffic", headers: local(member) })).json().data.rollup;
    expect(Object.keys(rollup.entries).some((key) => key.startsWith("out:http:federation:GET /api/tabs/:tabId"))).toBe(true);
  });

  it("keeps the member's encryption end to end: the hub relays bytes it cannot read", async () => {
    const switchTab = await member.app.promptor.storage.createTab("加密");
    const created = await member.app.inject({
      method: "POST",
      url: `/api/tabs/${switchTab.id}/session`,
      headers: local(member),
      payload: { provider: "e2ee", workingDirectory: "家里的口令 42" } as never,
    });
    expect(created.statusCode).toBe(200);
    const secret = await member.app.promptor.storage.createTab("不该被入口看到的名字");
    const read = await hub.app.inject({ method: "GET", url: `/d/${memberId}/api/tabs/${secret.id}`, headers: { "x-codex-promptor-token": hub.app.promptor.token } });
    expect(read.statusCode).toBe(200);
    expect(read.headers["x-promptor-e2ee"]).toBeTruthy();
    expect(read.rawPayload.toString("utf8")).not.toContain("不该被入口看到的名字");
    // And the cleartext bootstrap no longer lists conversation names.
    const bootstrap = await hub.app.inject({ method: "GET", url: `/d/${memberId}/api/bootstrap`, headers: { "x-codex-promptor-token": hub.app.promptor.token } });
    expect(bootstrap.json().data.e2ee.required).toBe(true);
    expect(bootstrap.json().data.index).toBeNull();
    expect(bootstrap.rawPayload.toString("utf8")).not.toContain("不该被入口看到的名字");
  });

  it("says a device is offline the moment its link goes, and never replays", async () => {
    await admin(member, "POST", "/api/federation/admin/leave");
    const fromHub = await until(() => view(hub), (current) => current.devices.find((device: any) => device.id === memberId)?.online === false);
    expect(fromHub.devices.find((device: any) => device.id === memberId)?.online).toBe(false);
    const response = await hub.app.inject({ method: "GET", url: `/d/${memberId}/api/tabs`, headers: { "x-codex-promptor-token": hub.app.promptor.token } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("DEVICE_OFFLINE");
    // The member is a single machine again; its own page works as before.
    expect((await view(member)).mode).toBe("off");
  });

  it("removes a device: link closed, join code dead, its conversations untouched", async () => {
    const tab = await member.app.promptor.storage.createTab("留在家里");
    const removed = await admin(hub, "DELETE", `/api/federation/admin/devices/${memberId}`);
    expect(removed.status).toBe(200);
    const memberSide = await until(() => admin(member, "GET", "/api/federation/admin"), (current) => current.body.data.link.state === "stopped");
    expect(memberSide.body.data.link.error.code).toBe("FEDERATION_TOKEN_INVALID");
    expect((await member.app.promptor.storage.getTabMeta(tab.id)).name).toBe("留在家里");
  });

  it("lets the newest copy of a device win, and the displaced one stop instead of fighting back", async () => {
    // Two machines running the same data folder: same id, same token.
    const copyRoot = await mkdtemp(path.join(os.tmpdir(), "promptor-federation-copy-"));
    await mkdir(path.join(copyRoot, "dist", "client"), { recursive: true });
    await mkdir(path.join(copyRoot, "data", "private"), { recursive: true });
    await writeFile(path.join(copyRoot, "dist", "client", "index.html"), "<!doctype html><title>copy</title>", "utf8");
    await cp(path.join(member.root, "data", "private", "federation.json"), path.join(copyRoot, "data", "private", "federation.json"));
    const copyApp = await createApp(copyRoot);
    extra = { app: copyApp, root: copyRoot, address: await copyApp.listen({ host: "127.0.0.1", port: 0 }) };
    await until(() => view(extra!), (current) => current.hubReachable === true);
    const displaced = await until(() => admin(member, "GET", "/api/federation/admin"), (current) => current.body.data.link.state === "stopped");
    expect(displaced.body.data.link.error.code).toBe("FEDERATION_IDENTITY_CONFLICT");
    // The copy stays connected; nothing flaps.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await view(extra)).hubReachable).toBe(true);
  });

  /**
   * The link dropping at each moment that matters for a write (§16): before
   * the request reaches the device, while the device runs it, and after it
   * ran but before the answer got back. The page hears that the device went
   * away every time; the write happens at most once, and nothing is replayed
   * once the link is back.
   */
  describe("a link that drops around a write", () => {
    /** The member's end of the link, ended the way a network failure would: no close handshake. */
    const cut = () => ((member.app.promptor.federation as any).member.socket as WebSocket).terminate();
    const addPrompt = (tabId: string, text: string) => hub.app.inject({
      method: "POST",
      url: `/d/${memberId}/api/tabs/${tabId}/prompts`,
      headers: { "x-codex-promptor-token": hub.app.promptor.token, "content-type": "application/json" },
      payload: JSON.stringify({ text }),
    });
    const promptsOn = async (tabId: string) => (await member.app.promptor.storage.readTab(tabId)).prompts.prompts.map((prompt) => prompt.text);
    const memberOnline = (online: boolean) => until(() => view(hub), (current) => current.devices.find((device: any) => device.id === memberId)?.online === online);
    /** Hands the next forwarded write on the member to `around`, which decides when the link drops. */
    const interceptWrite = (around: (run: () => Promise<unknown>) => Promise<unknown>) => {
      const original = member.app.inject.bind(member.app);
      let armed = true;
      (member.app as any).inject = (options: any) => {
        if (!armed || options?.headers?.host !== "federation.invalid" || options.method !== "POST") return original(options);
        armed = false;
        return around(() => original(options));
      };
    };
    /** Back online, and still exactly `expected` a moment later: nothing was resent. */
    const settlesAt = async (tabId: string, expected: string[]) => {
      await memberOnline(true);
      expect(await promptsOn(tabId)).toEqual(expected);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await promptsOn(tabId)).toEqual(expected);
    };

    it("before the request is sent: refused, nothing written", async () => {
      const tab = await member.app.promptor.storage.createTab("断在之前");
      cut();
      await memberOnline(false);
      const response = await addPrompt(tab.id, "不该出现");
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("DEVICE_OFFLINE");
      await settlesAt(tab.id, []);
    });

    it("while the device runs it: the page is told, and the write lands once", async () => {
      const tab = await member.app.promptor.storage.createTab("断在中间");
      interceptWrite(async (run) => { cut(); return run(); });
      const response = await addPrompt(tab.id, "写入中断线");
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("DEVICE_OFFLINE");
      await settlesAt(tab.id, ["写入中断线"]);
    });

    it("after it ran, before the answer: the page is told, and the write is not repeated", async () => {
      const tab = await member.app.promptor.storage.createTab("断在之后");
      interceptWrite(async (run) => { const result = await run(); cut(); return result; });
      const response = await addPrompt(tab.id, "回包前断线");
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("DEVICE_OFFLINE");
      await settlesAt(tab.id, ["回包前断线"]);
    });
  });

  it("rebuilds a link that stays backed up instead of letting it grow", async () => {
    const link = (member.app.promptor.federation as any).member;
    const socket = link.socket as WebSocket;
    Object.defineProperty(socket, "bufferedAmount", { get: () => 40 * 1024 * 1024 });
    const now = Date.now();
    link.checkLink(now);
    // One look is not "stays": a burst is allowed to drain.
    expect(socket.readyState).toBe(WebSocket.OPEN);
    link.checkLink(now + 31_000);
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
    // The ordinary reconnect brings up a fresh link.
    const back = await until(() => view(member), (current) => current.hubReachable === true && link.socket !== socket);
    expect(back.hubReachable).toBe(true);
  });
});

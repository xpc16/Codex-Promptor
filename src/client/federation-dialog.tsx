import { useCallback, useEffect, useState } from "react";
import { api, jsonBody } from "./api-client.js";
import { useI18n } from "./i18n.js";
import { ModalShell } from "./modal-shell.js";

/**
 * Multi-device settings (docs/MULTI_DEVICE_FEDERATION_IMPLEMENTATION.md §8).
 *
 * Only ever opened from this machine's own loopback page, and the server
 * refuses the same routes from anywhere else. A join code is a credential: it
 * is shown once, here, and the hub keeps only a digest of it.
 */

type AdminDevice = {
  key: string;
  deviceId: string | null;
  name: string;
  self: boolean;
  pending: boolean;
  online: boolean;
  version: string | null;
  addedAt: string;
};

type AdminView = {
  mode: "off" | "hub" | "member";
  deviceId: string;
  name: string;
  publicUrl: string | null;
  hubUrl: string | null;
  link: { state: "connecting" | "connected" | "stopped" | null; error: { code: string; message: string } | null };
  devices: AdminDevice[];
};

const RESETTABLE = new Set(["FEDERATION_IDENTITY_CONFLICT", "FEDERATION_DEVICE_ID_TAKEN"]);

export function FederationDialog({ open, onClose, onError }: { open: boolean; onClose: () => void; onError: (error: unknown) => void }) {
  const { locale } = useI18n();
  const c = locale === "zh-CN" ? zh : en;
  const [view, setView] = useState<AdminView | null>(null);
  const [busy, setBusy] = useState(false);
  const [hubName, setHubName] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [accessId, setAccessId] = useState("");
  const [accessSecret, setAccessSecret] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api<AdminView>("/api/federation/admin");
      setView(next);
      setHubName((current) => current || next.name);
    } catch (error) { onError(error); }
  }, [onError]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  // The link's state moves on its own (connecting, connected, refused), so
  // the dialog follows it while it is open.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  const act = async (task: () => Promise<AdminView | null>) => {
    setBusy(true);
    try {
      const next = await task();
      if (next) setView(next);
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };

  const close = () => { setIssued(null); setCopied(false); onClose(); };

  const enableHub = () => act(async () => api<AdminView>("/api/federation/admin/hub", jsonBody({ name: hubName, publicUrl })));
  const join = () => act(async () => {
    const next = await api<AdminView>("/api/federation/admin/join", jsonBody({ joinCode, name: hubName }));
    setJoinCode("");
    return next;
  });
  const leave = () => {
    if (!window.confirm(view?.mode === "hub" ? c.confirmCloseHub : c.confirmLeave)) return;
    void act(async () => api<AdminView>("/api/federation/admin/leave", jsonBody({})));
  };
  const resetIdentity = () => {
    if (!window.confirm(c.confirmReset)) return;
    void act(async () => api<AdminView>("/api/federation/admin/reset-identity", jsonBody({})));
  };
  const retry = () => act(async () => api<AdminView>("/api/federation/admin/retry", jsonBody({})));
  const addDevice = () => act(async () => {
    const result = await api<{ joinCode: string; view: AdminView }>("/api/federation/admin/devices", jsonBody({ name: deviceName, accessId, accessSecret }));
    setIssued(result.joinCode);
    setCopied(false);
    setDeviceName("");
    setAccessId("");
    setAccessSecret("");
    return result.view;
  });
  const rename = (device: AdminDevice) => {
    const name = window.prompt(c.renamePrompt, device.name);
    if (!name || name.trim() === device.name) return;
    void act(async () => api<AdminView>(`/api/federation/admin/devices/${encodeURIComponent(device.key)}`, { method: "PATCH", body: JSON.stringify({ name }) }));
  };
  const remove = (device: AdminDevice) => {
    if (!window.confirm(c.confirmRemove(device.name))) return;
    void act(async () => api<AdminView>(`/api/federation/admin/devices/${encodeURIComponent(device.key)}`, { method: "DELETE" }));
  };
  const copy = async () => {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued); setCopied(true); } catch { setCopied(false); }
  };

  const linkLabel = view?.link.state === "connected" ? c.linkConnected : view?.link.state === "stopped" ? c.linkStopped : c.linkConnecting;

  return <ModalShell open={open} title={c.title} closeLabel={c.close} onClose={close}>
    {!view ? <div className="modal-empty">{c.loading}</div> : <div className="federation-dialog">
      <p className="field-hint">{c.thisDevice(view.name, view.deviceId.slice(0, 8))} · {c.modes[view.mode]}</p>

      {view.mode === "off" && <>
        <section className="federation-block">
          <h3>{c.becomeHub}</h3>
          <p className="field-hint">{c.becomeHubHint}</p>
          <label className="field-label">{c.deviceName}<input value={hubName} onChange={(event) => setHubName(event.target.value)} maxLength={80} /></label>
          <label className="field-label">{c.publicUrl}<input value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} placeholder="https://promptor.example.com" spellCheck={false} /></label>
          <button className="primary" disabled={busy || !publicUrl.trim()} onClick={() => void enableHub()}>{c.becomeHubAction}</button>
        </section>
        <section className="federation-block">
          <h3>{c.join}</h3>
          <p className="field-hint">{c.joinHint}</p>
          <textarea value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="pj1.…" rows={3} spellCheck={false} />
          <button className="primary" disabled={busy || !joinCode.trim()} onClick={() => void join()}>{c.joinAction}</button>
        </section>
      </>}

      {view.mode === "hub" && <>
        <p className="field-hint">{c.publicUrl}: <code>{view.publicUrl}</code></p>
        <div className="federation-devices" role="table" aria-label={c.devices}>
          {view.devices.map((device) => <div className="federation-device" role="row" key={device.key}>
            <span role="cell" className="federation-device-name">{device.name}</span>
            <span role="cell" className={`federation-device-state ${device.online ? "online" : ""}`}>{device.self ? c.self : device.pending ? c.pending : device.online ? c.online : c.offline}</span>
            <span role="cell" className="federation-device-version">{device.version ?? ""}</span>
            <span role="cell" className="federation-device-actions">
              <button className="link-button" disabled={busy} onClick={() => rename(device)}>{c.rename}</button>
              {!device.self && <button className="link-button danger-action" disabled={busy} onClick={() => remove(device)}>{c.remove}</button>}
            </span>
          </div>)}
        </div>
        <section className="federation-block">
          <h3>{c.addDevice}</h3>
          <label className="field-label">{c.newDeviceName}<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} placeholder={c.deviceNamePlaceholder} /></label>
          <p className="field-hint">{c.accessHint}</p>
          <label className="field-label">{c.accessId}<input value={accessId} onChange={(event) => setAccessId(event.target.value)} spellCheck={false} autoComplete="off" /></label>
          <label className="field-label">{c.accessSecret}<input value={accessSecret} onChange={(event) => setAccessSecret(event.target.value)} spellCheck={false} autoComplete="off" /></label>
          <button className="primary" disabled={busy || !deviceName.trim()} onClick={() => void addDevice()}>{c.addDeviceAction}</button>
          {issued && <div className="federation-join-code">
            <p className="field-hint">{c.issuedHint}</p>
            <textarea readOnly value={issued} rows={3} onFocus={(event) => event.currentTarget.select()} />
            <button className="ghost" onClick={() => void copy()}>{copied ? c.copied : c.copy}</button>
          </div>}
        </section>
        <div className="modal-actions"><button className="danger-action" disabled={busy} onClick={leave}>{c.closeHub}</button></div>
      </>}

      {view.mode === "member" && <>
        <p className="field-hint">{c.hubUrl}: <code>{view.hubUrl}</code></p>
        <p className={`federation-link ${view.link.state ?? ""}`}><i className={`status-dot ${view.link.state === "connected" ? "ready" : view.link.state === "stopped" ? "error" : ""}`} />{linkLabel}</p>
        {view.link.error && <p className="inline-error">{view.link.error.message}</p>}
        <div className="modal-actions">
          {view.link.state !== "connected" && <button className="ghost" disabled={busy} onClick={() => void retry()}>{c.retry}</button>}
          {view.link.error && RESETTABLE.has(view.link.error.code) && <button className="ghost" disabled={busy} onClick={resetIdentity}>{c.resetIdentity}</button>}
          <button className="danger-action" disabled={busy} onClick={leave}>{c.leave}</button>
        </div>
      </>}

      <p className="field-hint">{c.footer}</p>
    </div>}
  </ModalShell>;
}

const zh = {
  title: "多设备",
  close: "关闭",
  loading: "加载中…",
  thisDevice: (name: string, id: string) => `本机：${name}（${id}）`,
  modes: { off: "未开启", hub: "入口", member: "成员" } as Record<AdminView["mode"], string>,
  becomeHub: "设为入口",
  becomeHubHint: "公网域名指向的那台常在线电脑。其他电脑加入它之后，从任一台的本机页面或公网页面都能看到并操作所有电脑的对话。",
  deviceName: "本机名称",
  newDeviceName: "设备名称",
  publicUrl: "公网地址",
  becomeHubAction: "设为入口",
  join: "加入入口",
  joinHint: "粘贴入口生成的加入码。本机不需要安装 cloudflared，也不开放端口。",
  joinAction: "加入",
  devices: "设备",
  self: "本机",
  pending: "等待加入",
  online: "在线",
  offline: "离线",
  rename: "改名",
  remove: "移除",
  renamePrompt: "设备名称",
  confirmRemove: (name: string) => `移除「${name}」？它的链路会立即断开，它自己的对话不受影响。别忘了到 Cloudflare 删掉它的 Service Token。`,
  addDevice: "添加设备",
  deviceNamePlaceholder: "例如：家用电脑",
  accessHint: "可选：为这台设备新建的 Cloudflare Access Service Token。填了会一并写进加入码，对方粘贴一次即可。",
  accessId: "Service Token ID",
  accessSecret: "Service Token Secret",
  addDeviceAction: "生成加入码",
  issuedHint: "加入码只显示这一次，里面含凭证。复制后到那台电脑的「多设备 → 加入」粘贴。",
  copy: "复制",
  copied: "已复制",
  closeHub: "关闭入口",
  confirmCloseHub: "关闭入口？所有成员会断开，公网聚合暂停；各台电脑的对话都不受影响。",
  hubUrl: "入口",
  linkConnected: "已连接入口",
  linkConnecting: "正在连接入口…",
  linkStopped: "已停止连接",
  retry: "重试",
  resetIdentity: "重置本机设备身份",
  confirmReset: "重置本机设备身份？会生成新的设备 ID 并退出多设备，需要用新的加入码重新加入。如果这份数据目录开过加密，也请重新设置一次口令。",
  leave: "退出多设备",
  confirmLeave: "退出多设备？本机的对话不受影响，只是不再出现在其他电脑上。",
  footer: "开启后，关闭所有页面也不会退出程序：其他电脑的页面还在用它。",
};

const en: typeof zh = {
  title: "Multiple devices",
  close: "Close",
  loading: "Loading…",
  thisDevice: (name: string, id: string) => `This device: ${name} (${id})`,
  modes: { off: "off", hub: "hub", member: "member" },
  becomeHub: "Make this the hub",
  becomeHubHint: "The always-on machine your public hostname points at. Once other machines join it, every machine's own page and the public page show and control all of their conversations.",
  deviceName: "Name of this device",
  newDeviceName: "Device name",
  publicUrl: "Public address",
  becomeHubAction: "Make hub",
  join: "Join a hub",
  joinHint: "Paste the join code the hub generated. This machine needs no cloudflared and opens no ports.",
  joinAction: "Join",
  devices: "Devices",
  self: "This device",
  pending: "Waiting to join",
  online: "Online",
  offline: "Offline",
  rename: "Rename",
  remove: "Remove",
  renamePrompt: "Device name",
  confirmRemove: (name: string) => `Remove "${name}"? Its link closes now; its own conversations are untouched. Also delete its Cloudflare service token.`,
  addDevice: "Add a device",
  deviceNamePlaceholder: "e.g. Home PC",
  accessHint: "Optional: a Cloudflare Access service token created for this device. It is put into the join code so the other machine pastes once.",
  accessId: "Service token ID",
  accessSecret: "Service token secret",
  addDeviceAction: "Create join code",
  issuedHint: "Shown this once; it contains a credential. Paste it into Multiple devices → Join on that machine.",
  copy: "Copy",
  copied: "Copied",
  closeHub: "Turn the hub off",
  confirmCloseHub: "Turn the hub off? Every member disconnects and the public view pauses; no conversation anywhere is affected.",
  hubUrl: "Hub",
  linkConnected: "Connected to the hub",
  linkConnecting: "Connecting to the hub…",
  linkStopped: "Stopped",
  retry: "Retry",
  resetIdentity: "Reset this device's identity",
  confirmReset: "Reset this device's identity? It gets a new device id and leaves the workspace; join again with a new code. If this data folder had encryption on, set the passphrase again too.",
  leave: "Leave",
  confirmLeave: "Leave the workspace? This machine's conversations stay; they just stop appearing on the other machines.",
  footer: "While this is on, closing every page does not stop the program: other machines' pages are using it.",
};

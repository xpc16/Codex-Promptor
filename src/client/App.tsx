import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
} from "react";
import type { AnswerRecord, Group, IndexFile, PromptRecord, RuntimeFile, TabBundle, TabMeta } from "../shared/schemas.js";
import { reorderPromptIds } from "../shared/prompt-order.js";
import { completionNoticeExpiresAt, tabVisualState, type TabActivitySummary } from "../shared/tab-activity.js";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  createI18n,
  I18nContext,
  PromptorApiError,
  promptStatusLabel,
  runnerLabel,
  serviceStateLabel,
  terminalStateLabel,
  useI18n,
  type Locale,
} from "./i18n.js";

const token = new URLSearchParams(location.search).get("token") ?? "";

async function api<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-codex-promptor-token", token);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new PromptorApiError(
    String(payload?.error?.code ?? "HTTP_ERROR"),
    String(payload?.error?.message ?? `HTTP ${response.status}`),
    response.status,
    Boolean(payload?.error?.retryable),
  );
  return payload.data as T;
}

function jsonBody(value: unknown): RequestInit { return { method: "POST", body: JSON.stringify(value) }; }

let promptCompletionAudioContext: AudioContext | null = null;

function getPromptCompletionAudioContext(): AudioContext | null {
  if (promptCompletionAudioContext) return promptCompletionAudioContext;
  const AudioContextConstructor = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  try { promptCompletionAudioContext = new AudioContextConstructor(); }
  catch { return null; }
  return promptCompletionAudioContext;
}

async function primePromptCompletionSound(): Promise<void> {
  const context = getPromptCompletionAudioContext();
  if (context?.state === "suspended") await context.resume().catch(() => undefined);
}

async function playPromptCompletionSound(): Promise<void> {
  const context = getPromptCompletionAudioContext();
  if (!context) return;
  if (context.state === "suspended") await context.resume().catch(() => undefined);
  if (context.state !== "running") return;
  const start = context.currentTime + .01;
  const tone = (frequency: number, offset: number, duration: number, volume: number) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start + offset);
    gain.gain.setValueAtTime(.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(volume, start + offset + .012);
    gain.gain.exponentialRampToValueAtTime(.0001, start + offset + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + duration + .02);
  };
  tone(784, 0, .09, .045);
  tone(1_046.5, .072, .15, .04);
}

type AppDialog =
  | { kind: "group" }
  | { kind: "rename-tab"; tabId: string; initialValue: string }
  | { kind: "rename-group"; groupId: string; initialValue: string }
  | { kind: "delete-tab"; tabId: string; name: string }
  | { kind: "delete-group"; groupId: string; name: string; tabCount: number };

export function App() {
  const [index, setIndex] = useState<IndexFile | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [service, setService] = useState<any>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [viewNonce, setViewNonce] = useState(0);
  const [consoleWidth, setConsoleWidth] = useState(300);
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [activities, setActivities] = useState<Record<string, TabActivitySummary>>({});
  const [recentCompletionExpiries, setRecentCompletionExpiries] = useState<Record<string, number>>({});
  const consoleDragging = useRef(false);
  const consoleWidthRef = useRef(300);
  const navigationBusy = useRef(false);
  const dragItem = useRef<{ type: "group" | "tab"; id: string } | null>(null);
  const completionTimers = useRef(new Map<string, number>());
  const completionExpiries = useRef(new Map<string, number>());
  const locale: Locale = index?.ui.locale ?? "zh-CN";
  const i18n = useMemo(() => createI18n(locale), [locale]);
  const { t } = i18n;

  const markRecentCompletion = useCallback((tabId: string, completedAt: string | null, audible: boolean) => {
    const expiresAt = completionNoticeExpiresAt(completedAt);
    if (audible) void playPromptCompletionSound();
    if (!expiresAt || expiresAt <= Date.now()) return;
    const effectiveExpiry = Math.max(expiresAt, completionExpiries.current.get(tabId) ?? 0);
    completionExpiries.current.set(tabId, effectiveExpiry);
    const oldTimer = completionTimers.current.get(tabId);
    if (oldTimer !== undefined) window.clearTimeout(oldTimer);
    setRecentCompletionExpiries((current) => ({ ...current, [tabId]: effectiveExpiry }));
    const timer = window.setTimeout(() => {
      if (completionExpiries.current.get(tabId) !== effectiveExpiry) return;
      completionExpiries.current.delete(tabId);
      completionTimers.current.delete(tabId);
      setRecentCompletionExpiries((current) => {
        if (current[tabId] !== effectiveExpiry) return current;
        const next = { ...current };
        delete next[tabId];
        return next;
      });
    }, Math.max(0, effectiveExpiry - Date.now()));
    completionTimers.current.set(tabId, timer);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ index: IndexFile; activities: Record<string, TabActivitySummary>; app: any }>("/api/bootstrap");
      setIndex(data.index);
      setActivities(data.activities);
      for (const [tabId, activity] of Object.entries(data.activities)) {
        markRecentCompletion(tabId, activity.lastQueueCompletedAt, false);
      }
      setService(data.app);
      if (!consoleDragging.current) {
        consoleWidthRef.current = data.index.ui.consoleWidth;
        setConsoleWidth(data.index.ui.consoleWidth);
      }
      setSelectedId((current) => current && data.index.tabs.some((tab) => tab.id === current) ? current : data.index.tabs[0]?.id ?? null);
      setError(null);
    } catch (reason) { setError(reason); }
  }, [markRecentCompletion]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (index) document.documentElement.dataset.theme = index.ui.theme; }, [index?.ui.theme]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  useEffect(() => {
    const prime = () => { void primePromptCompletionSound(); };
    document.addEventListener("pointerdown", prime, { once: true });
    document.addEventListener("keydown", prime, { once: true });
    return () => {
      document.removeEventListener("pointerdown", prime);
      document.removeEventListener("keydown", prime);
    };
  }, []);
  useEffect(() => () => {
    for (const timer of completionTimers.current.values()) window.clearTimeout(timer);
    completionTimers.current.clear();
    completionExpiries.current.clear();
  }, []);

  const tabIdsKey = useMemo(() => (index?.tabs ?? []).map((tab) => tab.id).sort().join(","), [index]);
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`${protocol}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      socket.onopen = () => socket?.send(JSON.stringify({
        type: "subscribe",
        tabIds: tabIdsKey ? tabIdsKey.split(",") : [],
        snapshots: false,
      }));
      socket.onmessage = (event) => {
        let message: any;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        const tabId = typeof message.tabId === "string" ? message.tabId : "";
        if (message.type === "runner.changed" && tabId && message.runner?.runner) {
          const runtime = message.runner as RuntimeFile;
          setActivities((current) => ({
            ...current,
            [tabId]: {
              runnerState: runtime.runner.state,
              desiredState: runtime.runner.desiredState,
              activePromptId: runtime.runner.activePromptId,
              lastQueueCompletedAt: current[tabId]?.lastQueueCompletedAt ?? null,
            },
          }));
        } else if (message.type === "answer.added" && tabId && message.answer?.origin === "queue") {
          const answer = message.answer as AnswerRecord;
          const completedAt = answer.completedAt ?? answer.recordedAt;
          setActivities((current) => ({
            ...current,
            [tabId]: {
              runnerState: current[tabId]?.runnerState ?? "paused",
              desiredState: current[tabId]?.desiredState ?? "paused",
              activePromptId: current[tabId]?.activePromptId ?? null,
              lastQueueCompletedAt: completedAt,
            },
          }));
          markRecentCompletion(tabId, completedAt, true);
        } else if (message.type === "service.changed") {
          setService((current: any) => ({ ...(current ?? {}), codex: message.codex }));
        }
      };
      socket.onclose = () => {
        socket = null;
        if (!disposed) retryTimer = window.setTimeout(connect, 1_000);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [markRecentCompletion, tabIdsKey]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const updatePreferences = useCallback(async (patch: Partial<IndexFile["ui"]>) => {
    setIndex((current) => current ? { ...current, ui: { ...current.ui, ...patch } } : current);
    try { setIndex(await api<IndexFile>("/api/preferences", { method: "PATCH", body: JSON.stringify(patch) })); }
    catch (reason) { setError(reason); await refresh(); }
  }, [refresh]);

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!consoleDragging.current) return;
      const nextWidth = Math.max(220, Math.min(520, Math.min(window.innerWidth * .46, event.clientX)));
      consoleWidthRef.current = nextWidth;
      setConsoleWidth(nextWidth);
    };
    const up = () => {
      if (!consoleDragging.current) return;
      consoleDragging.current = false;
      void updatePreferences({ consoleWidth: consoleWidthRef.current });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [updatePreferences]);

  const selected = index?.tabs.find((tab) => tab.id === selectedId) ?? null;
  const groups = useMemo(() => [...(index?.groups ?? [])].sort((a, b) => a.order - b.order), [index]);
  const ungrouped = index?.tabs.filter((tab) => !tab.groupId).sort((a, b) => a.order - b.order) ?? [];

  const createTab = async () => {
    try { const tab = await api<TabMeta>("/api/tabs", jsonBody({ name: t("dialog.defaultConversationName") })); await refresh(); setSelectedId(tab.id); }
    catch (reason) { setError(reason); }
  };

  const submitDialog = async (value: string) => {
    if (!dialog) return;
    if (dialog.kind === "delete-tab" || dialog.kind === "delete-group") return;
    try {
      if (dialog.kind === "group") await api("/api/groups", jsonBody({ name: value }));
      else if (dialog.kind === "rename-tab" && value !== dialog.initialValue) await api(`/api/tabs/${dialog.tabId}`, { method: "PATCH", body: JSON.stringify({ name: value }) });
      else if (dialog.kind === "rename-group" && value !== dialog.initialValue) await api(`/api/groups/${dialog.groupId}`, { method: "PATCH", body: JSON.stringify({ name: value }) });
      setDialog(null);
      await refresh();
    } catch (reason) {
      setError(reason);
      throw reason;
    }
  };

  const confirmDelete = async () => {
    if (!dialog || (dialog.kind !== "delete-tab" && dialog.kind !== "delete-group")) return;
    try {
      if (dialog.kind === "delete-tab") await api(`/api/tabs/${dialog.tabId}`, { method: "DELETE" });
      else await api(`/api/groups/${dialog.groupId}`, { method: "DELETE" });
      setDialog(null);
      await refresh();
    } catch (reason) {
      setError(reason);
      throw reason;
    }
  };

  const persistNavigation = async (nextGroups: Group[], nextTabs: TabMeta[]) => {
    if (!index || navigationBusy.current) return;
    navigationBusy.current = true;
    setIndex({ ...index, groups: nextGroups, tabs: nextTabs });
    const groupIds = [...nextGroups].sort((a, b) => a.order - b.order).map((group) => group.id);
    const sections = [
      ...groupIds.map((groupId) => ({ groupId, tabIds: orderedTabIds(nextTabs, groupId) })),
      { groupId: null, tabIds: orderedTabIds(nextTabs, null) },
    ];
    try { setIndex(await api<IndexFile>("/api/navigation/order", { method: "PUT", body: JSON.stringify({ groupIds, sections }) })); }
    catch (reason) { setError(reason); await refresh(); }
    finally { navigationBusy.current = false; }
  };

  const moveGroup = (sourceId: string, targetId: string) => {
    if (!index || sourceId === targetId) return;
    const ordered = [...groups];
    const from = ordered.findIndex((group) => group.id === sourceId);
    const to = ordered.findIndex((group) => group.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    void persistNavigation(ordered.map((group, order) => ({ ...group, order })), index.tabs);
  };

  const moveTab = (sourceId: string, targetId: string | null, groupId: string | null) => {
    if (!index) return;
    const source = index.tabs.find((tab) => tab.id === sourceId);
    if (!source || (targetId === sourceId && source.groupId === groupId)) return;
    const groupKeys: Array<string | null> = [...groups.map((group) => group.id), null];
    const idsByGroup = new Map(groupKeys.map((key) => [key, orderedTabIds(index.tabs, key).filter((id) => id !== sourceId)]));
    const targetIds = idsByGroup.get(groupId);
    if (!targetIds) return;
    const targetIndex = targetId ? targetIds.indexOf(targetId) : -1;
    targetIds.splice(targetIndex >= 0 ? targetIndex : targetIds.length, 0, sourceId);
    const byId = new Map(index.tabs.map((tab) => [tab.id, tab]));
    const nextTabs = groupKeys.flatMap((key) => (idsByGroup.get(key) ?? []).map((id, order) => ({ ...byId.get(id)!, groupId: key, order })));
    void persistNavigation(groups, nextTabs);
  };

  const toggleGroup = async (group: Group) => {
    try { await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ collapsed: !group.collapsed }) }); await refresh(); }
    catch (reason) { setError(reason); }
  };

  const reloadSelected = async () => { await refresh(); setViewNonce((value) => value + 1); };
  const syncSelected = async () => {
    if (!selected?.session.threadId) return;
    try { await api(`/api/tabs/${selected.id}/history/sync`, { method: "POST" }); await reloadSelected(); }
    catch (reason) { setError(reason); }
  };

  if (!index) return <I18nContext.Provider value={i18n}><div className="loading-screen"><div className="orb" /><p>{error ? i18n.errorText(error) : t("app.loading")}</p><button onClick={() => void refresh()}>{t("action.retry")}</button></div></I18nContext.Provider>;

  return <I18nContext.Provider value={i18n}><div className="app-shell" style={{ gridTemplateColumns: `${consoleWidth}px 7px minmax(0, 1fr)` }}>
    <aside className="sidebar" aria-label={t("aria.console")}>
      <div className="brand"><div className="brand-mark">✦</div><div><strong>Promptor</strong><span>{t("brand.subtitle")}</span></div></div>
      <div className="sidebar-actions"><button className="primary small" onClick={() => void createTab()}>{t("nav.newConversation")}</button><button className="icon-button" title={t("nav.newGroupTitle")} onClick={() => setDialog({ kind: "group" })}>{t("nav.newGroup")}</button></div>
      <div className="tab-tree">
        {groups.map((group) => {
          const groupTabs = index.tabs.filter((tab) => tab.groupId === group.id).sort((a, b) => a.order - b.order);
          return <div className="group" key={group.id}>
            <div className="group-heading" draggable onDragStart={() => { dragItem.current = { type: "group", id: group.id }; }} onDragEnd={() => { dragItem.current = null; }} onDragEnter={(event) => { event.preventDefault(); if (dragItem.current?.type === "group") moveGroup(dragItem.current.id, group.id); else if (dragItem.current?.type === "tab" && groupTabs.length === 0) moveTab(dragItem.current.id, null, group.id); }}>
              <button className="collapse-button" aria-label={t(group.collapsed ? "nav.expand" : "nav.collapse", { name: group.name })} onClick={() => void toggleGroup(group)}>{group.collapsed ? "▸" : "▾"}</button><span className="group-name">{group.name}</span><em>{groupTabs.length}</em><RowActionsMenu subject={t("nav.groupSubject", { name: group.name })} deleteTitle={t("nav.deleteGroupHint")} onEdit={() => setDialog({ kind: "rename-group", groupId: group.id, initialValue: group.name })} onDelete={() => setDialog({ kind: "delete-group", groupId: group.id, name: group.name, tabCount: groupTabs.length })} />
            </div>
            {!group.collapsed && groupTabs.map((tab) => <ConsoleTabRow key={tab.id} tab={tab} activity={activities[tab.id]} recentlyCompleted={Boolean(recentCompletionExpiries[tab.id])} selected={tab.id === selectedId} onClick={() => setSelectedId(tab.id)} onRename={() => setDialog({ kind: "rename-tab", tabId: tab.id, initialValue: tab.name })} onDelete={() => setDialog({ kind: "delete-tab", tabId: tab.id, name: tab.name })} onDragStart={() => { dragItem.current = { type: "tab", id: tab.id }; }} onDragEnd={() => { dragItem.current = null; }} onDragEnter={() => { if (dragItem.current?.type === "tab") moveTab(dragItem.current.id, tab.id, group.id); }} />)}
          </div>;
        })}
        <div className="group ungrouped-group">
          <div className="group-heading" onDragEnter={(event) => { event.preventDefault(); if (dragItem.current?.type === "tab" && ungrouped.length === 0) moveTab(dragItem.current.id, null, null); }}>
            <button className="collapse-button" aria-label={t(index.ui.ungroupedCollapsed ? "nav.expand" : "nav.collapse", { name: t("nav.ungrouped") })} onClick={() => void updatePreferences({ ungroupedCollapsed: !index.ui.ungroupedCollapsed })}>{index.ui.ungroupedCollapsed ? "▸" : "▾"}</button><span className="group-name">{t("nav.ungrouped")}</span><em>{ungrouped.length}</em>
          </div>
          {!index.ui.ungroupedCollapsed && ungrouped.map((tab) => <ConsoleTabRow key={tab.id} tab={tab} activity={activities[tab.id]} recentlyCompleted={Boolean(recentCompletionExpiries[tab.id])} selected={tab.id === selectedId} onClick={() => setSelectedId(tab.id)} onRename={() => setDialog({ kind: "rename-tab", tabId: tab.id, initialValue: tab.name })} onDelete={() => setDialog({ kind: "delete-tab", tabId: tab.id, name: tab.name })} onDragStart={() => { dragItem.current = { type: "tab", id: tab.id }; }} onDragEnd={() => { dragItem.current = null; }} onDragEnter={() => { if (dragItem.current?.type === "tab") moveTab(dragItem.current.id, tab.id, null); }} />)}
        </div>
        {!groups.length && !ungrouped.length && <div className="empty-sidebar">{t("nav.empty")}<br /><span>{t("nav.emptyHint")}</span></div>}
      </div>
      <div className="sidebar-footer">
        {selected && <label className="footer-select"><span>{t("footer.currentGroup")}</span><select value={selected.groupId ?? ""} onChange={(event) => moveTab(selected.id, null, event.target.value || null)}><option value="">{t("nav.ungrouped")}</option>{groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label>}
        <div className="footer-actions"><button className="ghost" onClick={() => void reloadSelected()}>{t("footer.refresh")}</button><button className="ghost" disabled={!selected?.session.threadId || selected.session.state === "closed"} onClick={() => void syncSelected()}>{t("footer.syncHistory")}</button></div>
        <div className="footer-bottom-row">
          <button className="footer-compact-button theme-icon-toggle" title={t(index.ui.theme === "light" ? "theme.toDark" : "theme.toLight")} aria-label={t(index.ui.theme === "light" ? "theme.toDark" : "theme.toLight")} onClick={() => void updatePreferences({ theme: index.ui.theme === "light" ? "dark" : "light" })}><ThemeIcon theme={index.ui.theme} /></button>
          <div className="service-status" title={t("service.title", { state: serviceStateLabel(i18n, service?.codex?.state) })}><span className={`status-dot ${service?.codex?.state === "ready" ? "ready" : service?.codex?.state === "error" ? "error" : ""}`} /><time>{i18n.formatClock(clock)}</time></div>
          <button className="footer-compact-button locale-toggle" title={t(locale === "zh-CN" ? "language.toEnglish" : "language.toChinese")} aria-label={t(locale === "zh-CN" ? "language.toEnglish" : "language.toChinese")} onClick={() => void updatePreferences({ locale: locale === "zh-CN" ? "en" : "zh-CN" })}><span className={locale === "zh-CN" ? "active" : ""}>中</span><span aria-hidden="true">/</span><span className={locale === "en" ? "active" : ""}>En</span></button>
        </div>
      </div>
    </aside>
    <div className="console-splitter" role="separator" aria-label={t("aria.resizeConsole")} onMouseDown={() => { consoleDragging.current = true; }} />
    <main className="workspace" aria-label={t("aria.conversationPage")}>
      {Boolean(error) && <div className="toast error-toast">{i18n.errorText(error)}<button onClick={() => setError(null)}>×</button></div>}
      {selected ? <TabView key={`${selected.id}-${viewNonce}`} tab={selected} theme={index.ui.theme} onChanged={refresh} onError={setError} /> : <Welcome onCreate={() => void createTab()} />}
    </main>
    {dialog && (dialog.kind === "delete-tab" || dialog.kind === "delete-group" ? <ConfirmDialog
      title={t(dialog.kind === "delete-tab" ? "dialog.deleteConversation" : "dialog.deleteGroup")}
      message={dialog.kind === "delete-tab" ? t("dialog.deleteConversationMessage", { name: dialog.name }) : t("dialog.deleteGroupMessage", { name: dialog.name, count: dialog.tabCount })}
      confirmLabel={t("action.delete")}
      onCancel={() => setDialog(null)}
      onConfirm={confirmDelete}
    /> : <TextDialog
      key={dialog.kind === "group" ? "group" : dialog.kind === "rename-tab" ? `rename-tab-${dialog.tabId}` : `rename-group-${dialog.groupId}`}
      title={t(dialog.kind === "group" ? "dialog.newGroup" : dialog.kind === "rename-tab" ? "dialog.renameConversation" : "dialog.renameGroup")}
      label={t(dialog.kind === "rename-tab" ? "dialog.conversationName" : "dialog.groupName")}
      initialValue={dialog.kind === "group" ? t("dialog.defaultGroupName") : dialog.initialValue}
      confirmLabel={t(dialog.kind === "group" ? "action.create" : "action.save")}
      onCancel={() => setDialog(null)}
      onConfirm={submitDialog}
    />)}
  </div></I18nContext.Provider>;
}

function ThemeIcon({ theme }: { theme: "light" | "dark" }) {
  return theme === "light"
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 15.3A8.5 8.5 0 0 1 8.7 3.8 8.5 8.5 0 1 0 20.2 15.3Z" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
}

function ConfirmDialog({ title, message, confirmLabel, onCancel, onConfirm }: { title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try { await onConfirm(); } catch { /* parent displays the API error */ }
    finally { setBusy(false); }
  };
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <div className="text-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" onKeyDown={(event) => { if (event.key === "Escape" && !busy) onCancel(); }}>
      <h3 id="confirm-dialog-title">{title}</h3><p className="confirm-copy">{message}</p>
      <div className="dialog-actions"><button type="button" className="ghost" disabled={busy} onClick={onCancel}>{t("action.cancel")}</button><button type="button" className="danger-action" disabled={busy} onClick={() => void confirm()}>{busy ? t("action.processing") : confirmLabel}</button></div>
    </div>
  </div>;
}

function TextDialog({ title, label, initialValue, confirmLabel, multiline = false, onCancel, onConfirm }: { title: string; label: string; initialValue: string; confirmLabel: string; multiline?: boolean; onCancel: () => void; onConfirm: (value: string) => Promise<void> }) {
  const { t } = useI18n();
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try { await onConfirm(trimmed); } catch { /* parent displays the API error */ }
    finally { setBusy(false); }
  };
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <form className="text-dialog" role="dialog" aria-modal="true" aria-labelledby="text-dialog-title" onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === "Escape" && !busy) onCancel(); }}>
      <h3 id="text-dialog-title">{title}</h3><label htmlFor="text-dialog-value">{label}</label>
      {multiline ? <textarea id="text-dialog-value" autoFocus rows={7} value={value} onChange={(event) => setValue(event.target.value)} /> : <input id="text-dialog-value" autoFocus value={value} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setValue(event.target.value)} />}
      <div className="dialog-actions"><button type="button" className="ghost" disabled={busy} onClick={onCancel}>{t("action.cancel")}</button><button type="submit" className="primary" disabled={busy || !value.trim()}>{busy ? t("action.processing") : confirmLabel}</button></div>
    </form>
  </div>;
}

function RowActionsMenu({ subject, deleteTitle, onEdit, onDelete }: { subject: string; deleteTitle?: string; onEdit: () => void; onDelete: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const positionMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 116;
    const height = 82;
    const gap = 4;
    const top = rect.bottom + gap + height <= window.innerHeight - 8 ? rect.bottom + gap : Math.max(8, rect.top - height - gap);
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
    setPosition({ top, left });
  };
  useEffect(() => {
    if (!open) return;
    const focusFrame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    const dismiss = () => setOpen(false);
    const outsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) dismiss();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", outsidePointer);
    document.addEventListener("keydown", keyDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", outsidePointer);
      document.removeEventListener("keydown", keyDown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  return <span className="row-actions-anchor" onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <button ref={buttonRef} type="button" className="row-actions-button" aria-label={t("menu.moreFor", { subject })} aria-haspopup="menu" aria-expanded={open} title={t("menu.more")} draggable={false} onClick={(event) => { event.stopPropagation(); if (!open) positionMenu(); setOpen((value) => !value); }}>⋮</button>
    {open && createPortal(<div ref={menuRef} className="row-actions-menu" role="menu" aria-label={t("menu.actionsFor", { subject })} style={position} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      items[(current + direction + items.length) % items.length]?.focus();
    }}><button type="button" role="menuitem" onClick={() => run(onEdit)}>{t("menu.edit")}</button><button type="button" role="menuitem" className="danger" title={deleteTitle} onClick={() => run(onDelete)}>{t("menu.delete")}</button></div>, document.body)}
  </span>;
}

function ConsoleTabRow({ tab, activity, recentlyCompleted, selected, onClick, onRename, onDelete, onDragStart, onDragEnd, onDragEnter }: { tab: TabMeta; activity?: TabActivitySummary; recentlyCompleted: boolean; selected: boolean; onClick: () => void; onRename: () => void; onDelete: () => void; onDragStart: () => void; onDragEnd: () => void; onDragEnter: () => void }) {
  const { t } = useI18n();
  const visualState = tabVisualState(tab.session.state, activity);
  const tabStatus = visualState === "closed"
    ? t("tab.closed")
    : visualState === "running"
      ? t("tab.running")
      : visualState === "idle"
        ? t("tab.idle")
        : visualState === "error"
          ? t("tab.error")
          : t("tab.unconfigured");
  return <div className={`tab-row ${selected ? "selected" : ""}`} draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onDragEnter={(event) => { event.preventDefault(); onDragEnter(); }}>
    <span className="console-drag" title={t("nav.dragConversation")}>⠿</span><button className="tab-button" onClick={onClick}><span className="tab-label">{tab.name}</span><span className="tab-status-cluster">{recentlyCompleted && <span className="tab-completion-bell" role="img" aria-label={t("tab.justCompleted")} title={t("tab.justCompletedRecent")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg></span>}<span className={`tab-status-indicator ${visualState}`} role="img" aria-label={tabStatus} title={tabStatus} /></span></button><RowActionsMenu subject={t("nav.conversationSubject", { name: tab.name })} onEdit={onRename} onDelete={onDelete} />
  </div>;
}

function Welcome({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();
  return <div className="welcome"><div className="welcome-icon">✦</div><h1>{t("welcome.title")}</h1><p>{t("welcome.body")}</p><button className="primary" onClick={onCreate}>{t("welcome.start")}</button></div>;
}

function TabView({ tab, theme, onChanged, onError }: { tab: TabMeta; theme: "light" | "dark"; onChanged: () => void; onError: (error: unknown) => void }) {
  const { t } = useI18n();
  const [bundle, setBundle] = useState<TabBundle | null>(null);
  const [leftWidth, setLeftWidth] = useState(tab.layout.leftWidthPercent);
  const dragging = useRef(false);
  const [reopening, setReopening] = useState(false);
  const load = useCallback(async () => {
    try { setBundle(await api<TabBundle>(`/api/tabs/${tab.id}`)); }
    catch (reason) { onError(reason); }
  }, [tab.id, onError]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const move = (event: MouseEvent) => { if (!dragging.current) return; const rect = document.querySelector(".tab-workspace")?.getBoundingClientRect(); if (!rect) return; setLeftWidth(Math.max(24, Math.min(76, ((event.clientX - rect.left) / rect.width) * 100))); };
    const up = () => { if (!dragging.current) return; dragging.current = false; void api(`/api/tabs/${tab.id}`, { method: "PATCH", body: JSON.stringify({ layout: { leftWidthPercent: leftWidth } }) }).catch(() => undefined); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [leftWidth, tab.id]);
  if (!bundle) return <div className="loading-pane"><div className="spinner" />{t("conversation.loading")}</div>;
  const closed = bundle.tab.session.state === "closed";
  const runnable = bundle.tab.session.state === "ready" && Boolean(bundle.tab.session.threadId);
  const reopen = async () => {
    if (reopening) return;
    setReopening(true);
    try { await api(`/api/tabs/${tab.id}/terminal/reopen`, { method: "POST" }); await load(); onChanged(); }
    catch (reason) { onError(reason); }
    finally { setReopening(false); }
  };
  const threadId = bundle.tab.session.threadId;
  const answers = threadId ? bundle.answers.answers.filter((answer) => answer.threadId === threadId) : [];
  return <div className={`tab-view ${closed ? "conversation-closed" : ""}`}><div className="tab-workspace" style={{ gridTemplateColumns: `${leftWidth}fr 7px ${100 - leftWidth}fr` }}>
    <section className="conversation-pane"><SessionPanel bundle={bundle} reopening={reopening} onReopen={reopen} onChanged={() => { void load(); onChanged(); }} onError={onError} /><AnswerHistory answers={answers} /></section>
    <div className={`splitter ${closed ? "disabled" : ""}`} onMouseDown={() => { if (!closed) dragging.current = true; }} title={t(closed ? "conversation.splitterClosed" : "conversation.splitter")} />
    <section className="queue-pane"><PromptQueue bundle={bundle} disabled={closed} runnable={runnable} onChanged={() => void load()} onError={onError} /><TerminalPanel tabId={tab.id} runtime={bundle.runtime} theme={theme} closed={closed} onChanged={load} onError={onError} /></section>
  </div></div>;
}

function orderedTabIds(tabs: TabMeta[], groupId: string | null): string[] {
  return tabs.filter((tab) => tab.groupId === groupId).sort((a, b) => a.order - b.order).map((tab) => tab.id);
}

function SessionPanel({ bundle, reopening, onReopen, onChanged, onError }: { bundle: TabBundle; reopening: boolean; onReopen: () => Promise<void>; onChanged: () => void; onError: (error: unknown) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [cwd, setCwd] = useState(bundle.tab.session.workingDirectory ?? "");
  const [mode, setMode] = useState<"new" | "resume">("new");
  const [resumeId, setResumeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const session = bundle.tab.session;
  const restoring = session.state === "connecting" && Boolean(session.threadId && session.workingDirectory);
  const connected = session.state === "ready" || session.state === "closed" || restoring;
  const connect = async () => {
    setBusy(true);
    try { await api(`/api/tabs/${bundle.tab.id}/session`, jsonBody({ mode, workingDirectory: cwd, resumeId })); onChanged(); }
    catch (reason) { onError(reason); }
    finally { setBusy(false); }
  };
  const browse = async () => {
    if (browsing) return;
    setBrowsing(true);
    try {
      const result = await api<{ path: string | null }>("/api/dialog/select-directory", jsonBody({ initialPath: cwd }));
      if (result.path) setCwd(result.path);
    } catch (reason) { onError(reason); }
    finally { setBrowsing(false); }
  };
  const closeConversation = async () => { try { setBusy(true); await api(`/api/tabs/${bundle.tab.id}/session/close`, { method: "POST" }); onChanged(); } catch (reason) { onError(reason); } finally { setBusy(false); } };
  return <div className="session-card">
    <div className="section-title"><span className="section-icon">◌</span><div><strong>{t(session.state === "ready" ? "session.ready" : session.state === "closed" ? "session.closed" : restoring ? "session.restoring" : "session.setup")}</strong><small>{t(restoring ? "session.restoringHelp" : connected ? "session.connectedHelp" : "session.setupHelp")}</small></div></div>
    {connected ? <div className="session-ready">{session.state === "closed" && <div className="closed-notice" role="status">{t("session.closedNotice")}</div>}<div className="session-path"><span>{t("session.workingDirectory")}</span><code>{session.workingDirectory}</code></div><div className="session-ids"><div><span>{t("session.threadId")}</span><code>{session.threadId}</code></div><div><span>{t("session.sessionId")}</span><code>{session.sessionId}</code></div></div>{session.lastThreadSwitch && <div className="thread-switch-notice" role="status" title={`${session.lastThreadSwitch.fromThreadId} → ${session.lastThreadSwitch.toThreadId}`}><strong>{t("session.followedSwitch")}</strong><span>/{session.lastThreadSwitch.method.split("/").at(-1)} · {i18n.formatTime(session.lastThreadSwitch.switchedAt)}</span></div>}<div className="session-actions"><button className="ghost" disabled={busy || reopening || restoring} onClick={() => void onReopen()}>{t(reopening || restoring ? "session.restoringAction" : "session.reopen")}</button>{session.state === "ready" && <button className="danger-action" disabled={busy} onClick={() => void closeConversation()}>{t(busy ? "session.closing" : "session.close")}</button>}</div></div> : <>
      <label className="field-label">{t("session.localPath")}</label><div className="path-row"><input value={cwd} title={cwd} onChange={(event) => setCwd(event.target.value)} placeholder={t("session.pathExample")} /><button className="ghost" disabled={browsing} onClick={() => void browse()}>{t(browsing ? "session.choosingFolder" : "session.chooseFolder")}</button></div>{cwd && <code className="path-preview" title={cwd}>{cwd}</code>}
      <div className="mode-switch"><button className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>{t("session.createNew")}</button><button className={mode === "resume" ? "active" : ""} onClick={() => setMode("resume")}>{t("session.resumeOld")}</button></div>
      {mode === "resume" && <input className="resume-input" value={resumeId} onChange={(event) => setResumeId(event.target.value)} placeholder={t("session.resumePlaceholder")} />}
      <button className="primary connect" disabled={busy || !cwd.trim()} onClick={() => void connect()}>{t(busy ? "session.connecting" : "session.confirmOpen")}</button>
    </>}
    {session.lastError && <div className="inline-error">{i18n.errorText(session.lastError)}</div>}
  </div>;
}

function AnswerHistory({ answers }: { answers: AnswerRecord[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const scroll = useRef<HTMLDivElement>(null);
  const contentKey = answers.map((answer) => answer.id).join("|");
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [contentKey]);
  return <div className="answers"><div className="answers-heading"><span>{t("answers.title")}</span><em>{answers.length}</em></div><div className="answer-scroll" ref={scroll}>{answers.length === 0 ? <div className="empty-answers">{t("answers.empty")}</div> : <div className="answer-list">{answers.map((answer) => <article className="answer-card" key={answer.id}><div className="answer-meta"><span>{t(answer.origin === "imported" ? "answers.imported" : answer.origin === "manual" ? "answers.manual" : "answers.queue")}</span><time>{i18n.formatTime(answer.completedAt)}</time></div><div className="answer-prompt">{answer.prompt}</div><div className="markdown"><ReactMarkdown rehypePlugins={[rehypeSanitize]}>{answer.finalAnswer}</ReactMarkdown></div></article>)}</div>}</div></div>;
}

function PromptQueue({ bundle, disabled, runnable, onChanged, onError }: { bundle: TabBundle; disabled: boolean; runnable: boolean; onChanged: () => void; onError: (error: unknown) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);
  const [runnerAction, setRunnerAction] = useState<"start" | "pause" | null>(null);
  const [insertBeforeId, setInsertBeforeId] = useState<string | null>(null);
  const nativeDragSource = useRef<string | null>(null);
  const reorderInFlight = useRef(false);
  const promptList = useRef<HTMLDivElement>(null);
  const threadId = bundle.tab.session.threadId;
  const currentAnswerPromptIds = new Set(bundle.answers.answers
    .filter((answer) => answer.threadId === threadId)
    .map((answer) => answer.promptId));
  const prompts = bundle.prompts.prompts.filter((prompt) => prompt.threadId === threadId
    || (!prompt.threadId && currentAnswerPromptIds.has(prompt.id))
    || (prompt.status === "pending" && !prompt.threadId));
  const promptContentKey = prompts.map((prompt) => prompt.id).join("|");
  useLayoutEffect(() => { if (promptList.current) promptList.current.scrollTop = promptList.current.scrollHeight; }, [promptContentKey]);
  const runtime = bundle.runtime;
  const runnerRunning = runtime.runner.desiredState === "running";
  const hasPendingPrompt = prompts.some((prompt) => prompt.status === "pending");
  const changeRunner = async (action: "start" | "pause") => {
    if (disabled || runnerAction || (action === "start" ? !runnable || runnerRunning || !hasPendingPrompt : !runnerRunning)) return;
    setRunnerAction(action);
    try {
      await api(`/api/tabs/${bundle.tab.id}/runner/${action}`, jsonBody({}));
      onChanged();
    } catch (reason) {
      onError(reason);
    } finally {
      setRunnerAction(null);
    }
  };
  const add = async () => {
    const text = newText.trim();
    if (!text || adding || disabled) return;
    setAdding(true);
    try { await api(`/api/tabs/${bundle.tab.id}/prompts`, jsonBody({ text })); setNewText(""); onChanged(); }
    catch (reason) { onError(reason); }
    finally { setAdding(false); }
  };
  const reorder = async (sourceId: string, targetId: string) => {
    if (disabled || !sourceId || sourceId === targetId || reorderInFlight.current) return;
    const ids = reorderPromptIds(prompts.filter((item) => item.status === "pending").map((item) => item.id), sourceId, targetId);
    if (!ids) return;
    reorderInFlight.current = true;
    try { await api(`/api/tabs/${bundle.tab.id}/prompts/order`, { method: "PUT", body: JSON.stringify({ promptIds: ids }) }); onChanged(); }
    catch (reason) { onError(reason); }
    finally { reorderInFlight.current = false; nativeDragSource.current = null; }
  };
  const insertBefore = async (value: string) => {
    if (!insertBeforeId || disabled) return;
    try { await api(`/api/tabs/${bundle.tab.id}/prompts`, jsonBody({ text: value, beforeId: insertBeforeId })); setInsertBeforeId(null); onChanged(); }
    catch (reason) { onError(reason); throw reason; }
  };
  const pendingIds = prompts.filter((item) => item.status === "pending").map((item) => item.id);
  const runnerState = runnerLabel(i18n, runtime);
  const completedCount = prompts.filter((item) => item.status === "completed").length;
  return <div className="queue-card"><div className="queue-heading"><div className="queue-summary"><h3>{t("queue.title")}</h3><span className="queue-count">{completedCount}/{prompts.length}</span><span className={`queue-state ${runtime.runner.state === "error" ? "error" : ""}`} title={runnerState}><i className={`status-dot ${runtime.runner.state === "running" ? "running" : runtime.runner.state === "error" ? "error" : ""}`} /><span>{runnerState}</span></span></div><div className="runner-actions"><button className="primary runner-start-button" disabled={disabled || !runnable || Boolean(runnerAction) || runnerRunning || !hasPendingPrompt} onClick={() => void changeRunner("start")}>{t(runnerAction === "start" ? "queue.starting" : "queue.start")}</button><button className="pause-button" disabled={disabled || Boolean(runnerAction) || !runnerRunning} onClick={() => void changeRunner("pause")}>{t(runnerAction === "pause" ? "queue.pausing" : "queue.pause")}</button></div></div>
    {runtime.runner.lastError && <div className="runner-error" role="alert">{i18n.errorText(runtime.runner.lastError)}</div>}
    <div className="prompt-list" ref={promptList}>{prompts.length === 0 && <div className="empty-prompts">{t("queue.empty")}</div>}{prompts.map((prompt, index) => { const pendingIndex = pendingIds.indexOf(prompt.id); return <PromptRow key={prompt.id} prompt={prompt} index={index} tabId={bundle.tab.id} locked={disabled} onDrop={reorder} onNativeDragStart={(sourceId) => { nativeDragSource.current = sourceId; }} onNativeDragEnter={(targetId) => { if (nativeDragSource.current) void reorder(nativeDragSource.current, targetId); }} onInsert={() => { if (!disabled) setInsertBeforeId(prompt.id); }} canMoveUp={pendingIndex > 0} canMoveDown={pendingIndex >= 0 && pendingIndex < pendingIds.length - 1} onMove={(direction) => { const target = pendingIds[pendingIndex + direction]; if (target) void reorder(prompt.id, target); }} onChanged={onChanged} onError={onError} />; })}</div>
    <div className="add-prompt"><textarea disabled={disabled} value={newText} onChange={(event) => setNewText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void add(); } }} placeholder={t(disabled ? "queue.closedPlaceholder" : "queue.inputPlaceholder")} /><button className="primary" disabled={disabled || adding || !newText.trim()} onClick={() => void add()}>{t(adding ? "queue.adding" : "queue.add")}</button></div>
    {insertBeforeId && <TextDialog title={t("queue.insertPrompt")} label={t("queue.promptContent")} initialValue="" confirmLabel={t("queue.insert")} multiline onCancel={() => setInsertBeforeId(null)} onConfirm={insertBefore} />}
  </div>;
}

function PromptRow({ prompt, index, tabId, locked, onDrop, onNativeDragStart, onNativeDragEnter, onInsert, canMoveUp, canMoveDown, onMove, onChanged, onError }: { prompt: PromptRecord; index: number; tabId: string; locked: boolean; onDrop: (sourceId: string, targetId: string) => void; onNativeDragStart: (sourceId: string | null) => void; onNativeDragEnter: (targetId: string) => void; onInsert: () => void; canMoveUp: boolean; canMoveDown: boolean; onMove: (direction: -1 | 1) => void; onChanged: () => void; onError: (error: unknown) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const editable = !locked && !["completed", "running", "dispatching"].includes(prompt.status);
  const [text, setText] = useState(prompt.text);
  const [editing, setEditing] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setText(prompt.text); setEditing(false); }, [prompt.text, prompt.status]);
  const beginEdit = () => { if (!editable) return; setEditing(true); requestAnimationFrame(() => { editor.current?.focus(); editor.current?.select(); }); };
  const save = async () => {
    if (!editable) return;
    if (!text.trim()) { onError(new PromptorApiError("PROMPT_EMPTY", t("queue.promptEmpty"), 400, false)); return; }
    if (text.trim() === prompt.text) { setEditing(false); return; }
    try { await api(`/api/tabs/${tabId}/prompts/${prompt.id}`, { method: "PATCH", body: JSON.stringify({ text }) }); setEditing(false); onChanged(); }
    catch (reason) { onError(reason); }
  };
  const remove = async () => { try { await api(`/api/tabs/${tabId}/prompts/${prompt.id}`, { method: "DELETE" }); onChanged(); } catch (reason) { onError(reason); } };
  const retry = async () => { try { await api(`/api/tabs/${tabId}/prompts/${prompt.id}/retry`, jsonBody({})); onChanged(); } catch (reason) { onError(reason); } };
  const skip = async () => { try { await api(`/api/tabs/${tabId}/prompts/${prompt.id}/skip`, jsonBody({})); onChanged(); } catch (reason) { onError(reason); } };
  const pendingStatus = prompt.status === "pending";
  const pending = pendingStatus && !locked;
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => { if (!pending || event.pointerType === "mouse" || event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.classList.add("dragging"); };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => { if (event.pointerType === "mouse") return; event.currentTarget.classList.remove("dragging"); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); const targetId = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".prompt-row.pending")?.dataset.promptId; if (pending && targetId) onDrop(prompt.id, targetId); };
  const mouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!pending || event.button !== 0 || (event.target as HTMLElement).closest("textarea, button")) return;
    const handle = event.currentTarget.querySelector<HTMLElement>(".drag-handle") ?? event.currentTarget; handle.classList.add("dragging"); let completed = false;
    const cleanup = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", release); handle.classList.remove("dragging"); };
    const move = (moveEvent: globalThis.MouseEvent) => { const targetId = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>(".prompt-row.pending")?.dataset.promptId; if (targetId && targetId !== prompt.id && !completed) { completed = true; cleanup(); onDrop(prompt.id, targetId); } };
    const release = (releaseEvent: globalThis.MouseEvent) => { if (!completed) { const targetId = document.elementFromPoint(releaseEvent.clientX, releaseEvent.clientY)?.closest<HTMLElement>(".prompt-row.pending")?.dataset.promptId; if (targetId && targetId !== prompt.id) onDrop(prompt.id, targetId); } cleanup(); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", release, { once: true });
  };
  const nativeDragStart = (event: DragEvent<HTMLDivElement>) => { if ((event.target as HTMLElement).closest("textarea, button")) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", prompt.id); onNativeDragStart(prompt.id); };
  return <div className={`prompt-row ${prompt.status} ${locked ? "locked" : ""}`} data-prompt-id={prompt.id} draggable={pending && !editing} onMouseDown={mouseDown} onDragStart={nativeDragStart} onDragEnd={() => onNativeDragStart(null)} onDragEnter={(event) => { if (pending) { event.preventDefault(); onNativeDragEnter(prompt.id); } }} onDragOver={(event) => { if (pending) event.preventDefault(); }}><div className="prompt-index">{prompt.status === "completed" ? "✓" : index + 1}</div><div className={`drag-handle ${pending ? "enabled" : ""}`} title={pending ? t("queue.drag") : undefined} onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={(event) => event.currentTarget.classList.remove("dragging")}>⠿</div><textarea ref={editor} value={text} disabled={!editable} readOnly={!editing} className={editing ? "editing" : ""} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void save(); } }} rows={Math.min(5, Math.max(1, text.split("\n").length))} /><div className="prompt-side"><span className="prompt-status">{prompt.status === "completed" && prompt.completedAt && <time>{i18n.formatTime(prompt.completedAt)}</time>}<span>{promptStatusLabel(i18n, prompt.status)}</span></span>{pendingStatus && <button className="link-button" disabled={locked} onClick={() => editing ? void save() : beginEdit()}>{t(editing ? "action.save" : "queue.edit")}</button>}{pendingStatus && <span className="move-buttons"><button aria-label={t("queue.moveUp")} title={t("queue.moveUp")} disabled={locked || !canMoveUp} onClick={() => onMove(-1)}>↑</button><button aria-label={t("queue.moveDown")} title={t("queue.moveDown")} disabled={locked || !canMoveDown} onClick={() => onMove(1)}>↓</button></span>}<button className="link-button" disabled={locked} onClick={onInsert}>{t("queue.insert")}</button>{prompt.status === "failed" || prompt.status === "interrupted" ? <><button className="link-button" disabled={locked} onClick={() => void retry()}>{t("queue.retry")}</button><button className="link-button" disabled={locked} onClick={() => void skip()}>{t("queue.skip")}</button></> : editable && <button className="delete-button" aria-label={t("queue.deletePrompt")} onClick={() => void remove()}>×</button>}</div></div>;
}

function TerminalPanel({ tabId, runtime, theme, closed, onChanged, onError }: { tabId: string; runtime: RuntimeFile; theme: "light" | "dark"; closed: boolean; onChanged: () => void; onError: (error: unknown) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const reconnect = useRef<(() => void) | null>(null);
  const closedRef = useRef(closed);
  const themeRef = useRef(theme);
  const callbacks = useRef({ onChanged, onError });
  const [connected, setConnected] = useState(false);
  const [hasOutput, setHasOutput] = useState(false);
  const runnerBusy = runtime.runner.desiredState === "running"
    || ["starting", "waiting_for_thread", "dispatching", "running", "waiting_for_prompt", "pausing"].includes(runtime.runner.state);
  closedRef.current = closed;
  themeRef.current = theme;
  callbacks.current = { onChanged, onError };
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let reconnectTimer: number | null = null;
    let resizeFrame: number | null = null;
    let cursorRevealFrame: number | null = null;
    let terminalWriteSequence = 0;
    const decoder = new TextDecoder();
    const cursor: { generation: string | null; nextOffset: number | null } = { generation: null, nextOffset: null };
    let lastSentSize: { cols: number; rows: number } | null = null;
    const term = new Terminal({ cursorBlink: false, cursorStyle: "block", cursorInactiveStyle: "none", fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 14, lineHeight: 1.18, theme: getTerminalTheme(themeRef.current), scrollback: 5000, allowProposedApi: false });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); term.blur(); terminal.current = term;
    const beginTerminalUpdate = () => {
      if (cursorRevealFrame !== null) { cancelAnimationFrame(cursorRevealFrame); cursorRevealFrame = null; }
      const sequence = ++terminalWriteSequence;
      host.current?.classList.add("terminal-updating");
      return sequence;
    };
    const finishTerminalUpdate = (sequence: number) => {
      if (sequence !== terminalWriteSequence) return;
      cursorRevealFrame = requestAnimationFrame(() => {
        cursorRevealFrame = null;
        if (sequence === terminalWriteSequence) host.current?.classList.remove("terminal-updating");
      });
    };
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const sendInput = (data: string) => {
      const ws = socket.current;
      if (!closedRef.current && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "terminal.input", tabId, dataBase64: encodeBase64(data) }));
    };
    const inputDisposable = term.onData(sendInput);
    const foregroundQuery = term.parser.registerOscHandler(10, (data) => {
      if (data.trim() === "?") sendInput(`\x1b]10;${themeRef.current === "light" ? "rgb:1d1d/2727/3838" : "rgb:e5e5/eded/f8f8"}\x1b\\`);
      return true;
    });
    const backgroundQuery = term.parser.registerOscHandler(11, (data) => {
      if (data.trim() === "?") sendInput(`\x1b]11;${themeRef.current === "light" ? "rgb:f8f8/fafa/fcfc" : "rgb:0f0f/1717/2222"}\x1b\\`);
      return true;
    });
    const colorSchemeQuery = term.parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
      if (params[0] !== 996) return false;
      sendInput(themeRef.current === "light" ? "\x1b[?997;2n" : "\x1b[?997;1n");
      return true;
    });
    const cursorBlinkOn = term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.length !== 1 || params[0] !== 12) return false;
      term.options.cursorBlink = false;
      return true;
    });
    const cursorBlinkOff = term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.length !== 1 || params[0] !== 12) return false;
      term.options.cursorBlink = false;
      return true;
    });
    const sendSize = () => {
      resizeFrame = null;
      try {
        const dimensions = fit.proposeDimensions();
        if (!dimensions) return;
        const cols = Math.max(20, dimensions.cols);
        const rows = Math.max(5, dimensions.rows);
        if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
        const ws = socket.current;
        if (ws?.readyState === WebSocket.OPEN && (!lastSentSize || lastSentSize.cols !== cols || lastSentSize.rows !== rows)) {
          lastSentSize = { cols, rows };
          ws.send(JSON.stringify({ type: "terminal.resize", tabId, cols, rows }));
        }
      } catch { /* element can be between layouts */ }
    };
    const scheduleSize = () => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(sendSize);
    };
    const observer = new ResizeObserver(scheduleSize); observer.observe(host.current);
    const requestSync = () => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "terminal.sync", tabId, cursor }));
    };
    const handleOutput = (message: any) => {
      const generation = String(message.generation ?? "");
      const startOffset = Number(message.startOffset);
      const endOffset = Number(message.endOffset);
      if (!generation || !Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || endOffset < startOffset) return;
      let updateSequence: number | null = null;
      if (message.reset || cursor.generation !== generation || cursor.nextOffset === null) {
        updateSequence = beginTerminalUpdate();
        term.reset();
        term.options.cursorBlink = false;
        cursor.generation = generation;
        cursor.nextOffset = startOffset;
        setHasOutput(false);
      }
      if (cursor.generation !== generation) { if (updateSequence !== null) finishTerminalUpdate(updateSequence); requestSync(); return; }
      if (startOffset > cursor.nextOffset!) { if (updateSequence !== null) finishTerminalUpdate(updateSequence); requestSync(); return; }
      if (endOffset <= cursor.nextOffset!) { if (updateSequence !== null) finishTerminalUpdate(updateSequence); return; }
      const bytes = Uint8Array.from(atob(String(message.dataBase64 ?? "")), (char) => char.charCodeAt(0));
      const overlap = Math.max(0, cursor.nextOffset! - startOffset);
      const fresh = bytes.subarray(Math.min(overlap, bytes.length));
      cursor.nextOffset = endOffset;
      if (fresh.length) {
        updateSequence ??= beginTerminalUpdate();
        setHasOutput(true);
        const sequence = updateSequence;
        term.write(decoder.decode(fresh, { stream: true }), () => { term.options.cursorBlink = false; finishTerminalUpdate(sequence); });
      } else {
        if (endOffset > 0) setHasOutput(true);
        if (updateSequence !== null) finishTerminalUpdate(updateSequence);
      }
    };
    const connect = () => {
      if (disposed || closedRef.current || socket.current?.readyState === WebSocket.OPEN || socket.current?.readyState === WebSocket.CONNECTING) return;
      const ws = new WebSocket(`${protocol}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      socket.current = ws;
      ws.onopen = () => {
        if (disposed || closedRef.current) { ws.close(); return; }
        setConnected(true);
        lastSentSize = null;
        ws.send(JSON.stringify({ type: "subscribe", tabIds: [tabId], terminals: { [tabId]: cursor } }));
        scheduleSize();
      };
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "terminal.output") handleOutput(message);
          else if (["runner.changed", "answer.added", "snapshot", "terminal.state", "service.changed"].includes(message.type)) {
            callbacks.current.onChanged();
            if (message.type === "terminal.state") scheduleSize();
          } else if (message.type === "error" && message.error) callbacks.current.onError(message.error);
        } catch { /* ignore malformed terminal frames */ }
      };
      ws.onerror = () => { if (!closedRef.current) callbacks.current.onError({ code: "TERMINAL_WEBSOCKET_FAILED", message: "Terminal WebSocket connection failed" }); };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null;
        if (disposed) return;
        setConnected(false);
        if (!closedRef.current) reconnectTimer = window.setTimeout(connect, 750);
      };
    };
    reconnect.current = connect;
    if (!closedRef.current) connect();
    return () => {
      disposed = true;
      reconnect.current = null;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      if (cursorRevealFrame !== null) cancelAnimationFrame(cursorRevealFrame);
      terminalWriteSequence += 1;
      host.current?.classList.remove("terminal-updating");
      observer.disconnect();
      inputDisposable.dispose(); foregroundQuery.dispose(); backgroundQuery.dispose(); colorSchemeQuery.dispose(); cursorBlinkOn.dispose(); cursorBlinkOff.dispose();
      socket.current?.close(); term.dispose(); terminal.current = null; socket.current = null;
    };
  }, [tabId]);
  useEffect(() => { if (runnerBusy) terminal.current?.blur(); }, [runnerBusy]);
  useEffect(() => {
    themeRef.current = theme;
    if (terminal.current) terminal.current.options.theme = getTerminalTheme(theme);
  }, [theme]);
  useEffect(() => {
    closedRef.current = closed;
    if (closed) {
      socket.current?.close();
      setConnected(false);
    } else reconnect.current?.();
  }, [closed]);
  const placeholder = t(runtime.terminal.state === "stopped" ? "terminal.notStarted" : runtime.terminal.state === "starting" ? "terminal.startingHelp" : runtime.terminal.state === "running" ? "terminal.runningHelp" : runtime.terminal.state === "error" ? "terminal.failedHelp" : "terminal.exitedHelp");
  return <div className={`terminal-card ${closed ? "locked" : ""} ${runnerBusy ? "runner-busy" : ""}`}><div className="terminal-heading"><span><i className={`status-dot ${runtime.terminal.state === "running" ? "running" : runtime.terminal.state === "error" ? "error" : ""}`} />PowerShell / Codex</span><span className="terminal-meta"><i className={`connection-dot ${connected ? "connected" : ""}`} />{t(closed ? "terminal.inputDisabled" : connected ? "terminal.inputConnected" : "terminal.inputConnecting")}<b>{closed ? t("terminal.closed") : terminalStateLabel(i18n, runtime.terminal.state)}</b></span></div>{runtime.terminal.lastError && <div className="terminal-error">{i18n.errorText(runtime.terminal.lastError)}</div>}<div className={`terminal-body ${theme} ${closed ? "locked" : ""}`} onMouseDown={() => { if (!closed) terminal.current?.focus(); }}><div className="terminal-host" ref={host} />{!hasOutput && <div className="terminal-placeholder">{closed ? t("terminal.closedPlaceholder") : placeholder}</div>}</div></div>;
}

function getTerminalTheme(theme: "light" | "dark") {
  return theme === "light" ? {
    background: "#f8fafc", foreground: "#1d2738", cursor: "#3157c8", selectionBackground: "#9bb4ff66",
    black: "#1d2738", brightBlack: "#64728a", white: "#e7edf6", brightWhite: "#ffffff",
  } : {
    background: "#0f1722", foreground: "#e5edf8", cursor: "#9bb4ff", selectionBackground: "#526baf88",
    black: "#263246", brightBlack: "#a6b4c9", white: "#dbe5f5", brightWhite: "#f8fafc",
  };
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

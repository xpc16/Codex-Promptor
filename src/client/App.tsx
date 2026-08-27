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
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { AgentProvider, AnswerRecord, Group, IndexFile, PromptRecord, RuntimeFile, TabBundle, TabMeta, TabRecordPage } from "../shared/schemas.js";
import { extractDocumentTarget, isLoopbackHostname } from "../shared/document-link.js";
import type { TerminalScreenFrame, TerminalTransportMode, TerminalTransportPreference } from "../shared/terminal-protocol.js";
import { DOCUMENT_RAW_CATCH_UP_BYTES } from "../shared/document-protocol.js";
import { reorderPromptIds } from "../shared/prompt-order.js";
import { completionNoticeExpiresAt, latestQueueCompletion, runnerIsWorking, tabVisualState, type TabActivitySummary } from "../shared/tab-activity.js";
import { EARLIER_ANSWER_PAGE, EARLIER_PROMPT_PAGE, INITIAL_ANSWER_WINDOW, INITIAL_PROMPT_WINDOW } from "../shared/tab-window.js";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { sameTerminalSize, terminalFrameLooksSettled, terminalResetNeedsSettling, TerminalCursorQuietScheduler, TerminalResizeScheduler } from "./terminal-resize.js";
import { loadTabWithRetry, retainRecentTabIds } from "./tab-load.js";
import { MOBILE_PANES, type MobilePane } from "./mobile-pane.js";
import { dialogSurvivesIndex, nextSelectedTabId, shouldAdoptIndexRevision } from "./index-sync.js";
import { applyTabMessage } from "./tab-bundle-delta.js";
import { forgetCachedTab, readCachedTab, rememberTab, retainCachedTabs, windowLimits } from "./tab-cache.js";
import { CONSOLE_WIDTH, conversationSplit, readPaneSize, readStoredPaneSize, workspaceSplit, writePaneSize } from "./pane-size.js";
import { isAtBottom, isNearTop, shouldHandoffWheel, wheelDeltaPixels } from "./scroll-anchor.js";
import { clearPromptDraft, readPromptDraft, writePromptDraft } from "./prompt-draft.js";
import { autoSizedHeight, readTextareaMetrics } from "./textarea-autosize.js";
import { applyProjectionFrame, projectionScreenToAnsi, type ProjectionScreenState } from "./terminal-projection.js";
import { readTerminalTransportPreference, resolveTerminalTransportPreference, writeTerminalTransportPreference } from "./terminal-preference.js";
import { createConnectionAlarm, reconnectDelay } from "./socket-retry.js";
import { forgetCachedTerminal, readCachedProjection, readCachedRawTerminal, rememberProjection, rememberRawTerminal, retainCachedTerminals } from "./terminal-cache.js";
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
import { api, jsonBody, promptorToken as token } from "./api-client.js";
import { SafeMarkdown } from "./safe-markdown.js";
import { DocumentView, useDocumentViewer, type DocumentOpenIntent } from "./document-viewer.js";

/**
 * Sockets this screen closed on purpose -- leaving a tab, switching transport,
 * unmounting. A WebSocket reports an error for any abnormal close, including
 * one we asked for, and that error arrives a tick later: long enough for the
 * reader to have switched back and for the "is this tab still active" guard to
 * read true again. Marking the socket is the only account of intent that
 * survives that gap.
 */
const deliberateCloses = new WeakSet<WebSocket>();

function closeSocketQuietly(socket: WebSocket | null): void {
  if (!socket) return;
  deliberateCloses.add(socket);
  try { socket.close(); } catch { /* already gone */ }
}


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
  const [retainedTabIds, setRetainedTabIds] = useState<string[]>([]);
  const [viewRefreshNonces, setViewRefreshNonces] = useState<Record<string, number>>({});
  const [consoleWidth, setConsoleWidth] = useState(() => readPaneSize(CONSOLE_WIDTH));
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [activities, setActivities] = useState<Record<string, TabActivitySummary>>({});
  const [recentCompletionExpiries, setRecentCompletionExpiries] = useState<Record<string, number>>({});
  const [terminalPreference, setTerminalPreference] = useState<TerminalTransportPreference>(() => readTerminalTransportPreference());
  const consoleDragging = useRef(false);
  const consoleWidthRef = useRef(readPaneSize(CONSOLE_WIDTH));
  // Highest index revision already applied, so a replayed or out-of-order push
  // cannot roll the sidebar back to an older shape.
  const appliedRevision = useRef(-1);
  const navigationBusy = useRef(false);
  const dragItem = useRef<{ type: "group" | "tab"; id: string } | null>(null);
  const completionTimers = useRef(new Map<string, number>());
  const completionExpiries = useRef(new Map<string, number>());
  const locale: Locale = index?.ui.locale ?? "zh-CN";
  const i18n = useMemo(() => createI18n(locale), [locale]);
  const { t } = i18n;
  const changeTerminalPreference = useCallback((value: TerminalTransportPreference) => {
    writeTerminalTransportPreference(value);
    setTerminalPreference(value);
  }, []);

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

  // Applies a navigation index from either source — this page's own fetch or a
  // push telling us another viewer changed something — through one path, so a
  // remote rename lands exactly like a local one.
  const adoptIndex = useCallback((next: IndexFile) => {
    if (!shouldAdoptIndexRevision(next.revision, appliedRevision.current)) return;
    appliedRevision.current = next.revision;
    // Pane widths are deliberately absent here: they live in this browser's own
    // storage, so a push from another viewer never resizes what you are using.
    setIndex(next);
    const tabIds = next.tabs.map((tab) => tab.id);
    const groupIds = next.groups.map((group) => group.id);
    setSelectedId((current) => nextSelectedTabId(current, tabIds));
    setDialog((current) => dialogSurvivesIndex(current, tabIds, groupIds) ? current : null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ index: IndexFile; activities: Record<string, TabActivitySummary>; app: any }>("/api/bootstrap");
      adoptIndex(data.index);
      setActivities(data.activities);
      for (const [tabId, activity] of Object.entries(data.activities)) {
        markRecentCompletion(tabId, activity.lastQueueCompletedAt, false);
      }
      setService(data.app);
      setError(null);
    } catch (reason) { setError(reason); }
  }, [adoptIndex, markRecentCompletion]);

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
    const validIds = new Set(tabIdsKey ? tabIdsKey.split(",") : []);
    // Cached conversation records outlive the mounted views, so a deleted
    // conversation has to be dropped here or it would keep its bytes for the
    // life of the page.
    retainCachedTabs(validIds);
    retainCachedTerminals(validIds);
    setRetainedTabIds((current) => {
      const next = retainRecentTabIds(current, selectedId, validIds);
      return next.length === current.length && next.every((tabId, index) => tabId === current[index]) ? current : next;
    });
  }, [selectedId, tabIdsKey]);
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
        details: false,
        // Only this socket wants navigation pushes; the per-tab terminal
        // sockets would just receive copies they have no use for.
        index: true,
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
        } else if ((message.type === "answer.activity" || message.type === "answer.added") && tabId && (message.origin === "queue" || message.answer?.origin === "queue") && (message.status === "completed" || message.answer?.status === "completed")) {
          const completedAt = String(message.completedAt ?? message.answer?.completedAt ?? message.answer?.recordedAt ?? "");
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
        } else if (message.type === "index.changed" && message.index) {
          adoptIndex(message.index as IndexFile);
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
  }, [adoptIndex, markRecentCompletion, tabIdsKey]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const updatePreferences = useCallback(async (patch: Partial<IndexFile["ui"]>) => {
    setIndex((current) => current ? { ...current, ui: { ...current.ui, ...patch } } : current);
    try { adoptIndex(await api<IndexFile>("/api/preferences", { method: "PATCH", body: JSON.stringify(patch) })); }
    catch (reason) { setError(reason); await refresh(); }
  }, [adoptIndex, refresh]);

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
      writePaneSize(CONSOLE_WIDTH, consoleWidthRef.current);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    // Refs and module-level helpers only: the drag listeners never need rebinding.
  }, []);

  const selected = index?.tabs.find((tab) => tab.id === selectedId) ?? null;
  const applyTabBundle = useCallback((bundle: TabBundle) => {
    setIndex((current) => {
      if (!current) return current;
      const existing = current.tabs.find((tab) => tab.id === bundle.tab.id);
      if (!existing || existing.updatedAt === bundle.tab.updatedAt) return current;
      return { ...current, tabs: current.tabs.map((tab) => tab.id === bundle.tab.id ? bundle.tab : tab) };
    });
    setActivities((current) => ({
      ...current,
      [bundle.tab.id]: {
        runnerState: bundle.runtime.runner.state,
        desiredState: bundle.runtime.runner.desiredState,
        activePromptId: bundle.runtime.runner.activePromptId,
        lastQueueCompletedAt: latestQueueCompletion(bundle.prompts.prompts),
      },
    }));
  }, []);
  const retainedTabs = useMemo(() => {
    if (!index) return [];
    const validIds = new Set(index.tabs.map((tab) => tab.id));
    const retained = new Set(retainRecentTabIds(retainedTabIds, selectedId, validIds));
    return index.tabs.filter((tab) => retained.has(tab.id));
  }, [index, retainedTabIds, selectedId]);
  const groups = useMemo(() => [...(index?.groups ?? [])].sort((a, b) => a.order - b.order), [index]);
  const ungrouped = index?.tabs.filter((tab) => !tab.groupId).sort((a, b) => a.order - b.order) ?? [];
  // On a phone the four desktop panes become four full-screen pages, chosen
  // from the bar at the bottom. The attribute drives the layout and is inert
  // above the CSS breakpoint.
  const [mobilePane, setMobilePane] = useState<MobilePane>("console");
  // Picking a conversation from the console is a request to go read it, so the
  // phone follows the tap to the conversation page instead of staying on a
  // list whose selection just moved off-screen.
  const openTab = (tabId: string) => { setSelectedId(tabId); setMobilePane("conversation"); };

  const createTab = async () => {
    try { const tab = await api<TabMeta>("/api/tabs", jsonBody({ name: t("dialog.defaultConversationName") })); await refresh(); openTab(tab.id); }
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
      if (dialog.kind === "delete-tab") { await api(`/api/tabs/${dialog.tabId}`, { method: "DELETE" }); forgetCachedTab(dialog.tabId); forgetCachedTerminal(dialog.tabId); }
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
    try { adoptIndex(await api<IndexFile>("/api/navigation/order", { method: "PUT", body: JSON.stringify({ groupIds, sections }) })); }
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

  const reloadSelected = async () => {
    const tabId = selectedId;
    await refresh();
    if (tabId) setViewRefreshNonces((current) => ({ ...current, [tabId]: (current[tabId] ?? 0) + 1 }));
  };
  const syncSelected = async () => {
    if (!selected?.session.threadId) return;
    try { await api(`/api/tabs/${selected.id}/history/sync`, { method: "POST" }); await reloadSelected(); }
    catch (reason) { setError(reason); }
  };

  if (!index) return <I18nContext.Provider value={i18n}><div className="loading-screen"><div className="orb" /><p>{error ? i18n.errorText(error) : t("app.loading")}</p><button onClick={() => void refresh()}>{t("action.retry")}</button></div></I18nContext.Provider>;

  return <I18nContext.Provider value={i18n}><div className="app-shell" data-mobile-pane={mobilePane} style={{ gridTemplateColumns: `${consoleWidth}px 7px minmax(0, 1fr)` }}>
    <aside className="sidebar" aria-label={t("aria.console")}>
      <div className="brand"><img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" draggable={false} /><div><strong>Promptor</strong><span>{t("brand.subtitle")}</span></div></div>
      <div className="sidebar-actions"><button className="primary small" onClick={() => void createTab()}>{t("nav.newConversation")}</button><button className="icon-button" title={t("nav.newGroupTitle")} onClick={() => setDialog({ kind: "group" })}>{t("nav.newGroup")}</button></div>
      <div className="tab-tree">
        {groups.map((group) => {
          const groupTabs = index.tabs.filter((tab) => tab.groupId === group.id).sort((a, b) => a.order - b.order);
          return <div className="group" key={group.id}>
            <div className="group-heading" draggable onDragStart={() => { dragItem.current = { type: "group", id: group.id }; }} onDragEnd={() => { dragItem.current = null; }} onDragEnter={(event) => { event.preventDefault(); if (dragItem.current?.type === "group") moveGroup(dragItem.current.id, group.id); else if (dragItem.current?.type === "tab" && groupTabs.length === 0) moveTab(dragItem.current.id, null, group.id); }}>
              <button className="collapse-button" aria-label={t(group.collapsed ? "nav.expand" : "nav.collapse", { name: group.name })} onClick={() => void toggleGroup(group)}>{group.collapsed ? "▸" : "▾"}</button><span className="group-name">{group.name}</span><em>{groupTabs.length}</em><RowActionsMenu subject={t("nav.groupSubject", { name: group.name })} deleteTitle={t("nav.deleteGroupHint")} onEdit={() => setDialog({ kind: "rename-group", groupId: group.id, initialValue: group.name })} onDelete={() => setDialog({ kind: "delete-group", groupId: group.id, name: group.name, tabCount: groupTabs.length })} />
            </div>
            {!group.collapsed && groupTabs.map((tab) => <ConsoleTabRow key={tab.id} tab={tab} activity={activities[tab.id]} recentlyCompleted={Boolean(recentCompletionExpiries[tab.id])} selected={tab.id === selectedId} onClick={() => openTab(tab.id)} onRename={() => setDialog({ kind: "rename-tab", tabId: tab.id, initialValue: tab.name })} onDelete={() => setDialog({ kind: "delete-tab", tabId: tab.id, name: tab.name })} onDragStart={() => { dragItem.current = { type: "tab", id: tab.id }; }} onDragEnd={() => { dragItem.current = null; }} onDragEnter={() => { if (dragItem.current?.type === "tab") moveTab(dragItem.current.id, tab.id, group.id); }} />)}
          </div>;
        })}
        <div className="group ungrouped-group">
          <div className="group-heading" onDragEnter={(event) => { event.preventDefault(); if (dragItem.current?.type === "tab" && ungrouped.length === 0) moveTab(dragItem.current.id, null, null); }}>
            <button className="collapse-button" aria-label={t(index.ui.ungroupedCollapsed ? "nav.expand" : "nav.collapse", { name: t("nav.ungrouped") })} onClick={() => void updatePreferences({ ungroupedCollapsed: !index.ui.ungroupedCollapsed })}>{index.ui.ungroupedCollapsed ? "▸" : "▾"}</button><span className="group-name">{t("nav.ungrouped")}</span><em>{ungrouped.length}</em>
          </div>
          {!index.ui.ungroupedCollapsed && ungrouped.map((tab) => <ConsoleTabRow key={tab.id} tab={tab} activity={activities[tab.id]} recentlyCompleted={Boolean(recentCompletionExpiries[tab.id])} selected={tab.id === selectedId} onClick={() => openTab(tab.id)} onRename={() => setDialog({ kind: "rename-tab", tabId: tab.id, initialValue: tab.name })} onDelete={() => setDialog({ kind: "delete-tab", tabId: tab.id, name: tab.name })} onDragStart={() => { dragItem.current = { type: "tab", id: tab.id }; }} onDragEnd={() => { dragItem.current = null; }} onDragEnter={() => { if (dragItem.current?.type === "tab") moveTab(dragItem.current.id, tab.id, null); }} />)}
        </div>
        {!groups.length && !ungrouped.length && <div className="empty-sidebar">{t("nav.empty")}<br /><span>{t("nav.emptyHint")}</span></div>}
      </div>
      <div className="sidebar-footer">
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
      {retainedTabs.map((tab) => <TabView key={tab.id} tab={tab} active={tab.id === selectedId} refreshNonce={viewRefreshNonces[tab.id] ?? 0} theme={index.ui.theme} terminalPreference={terminalPreference} projectionSupported={service?.terminal?.modes?.includes?.("projection") !== false} onTerminalPreferenceChange={changeTerminalPreference} onBundleChanged={applyTabBundle} onError={setError} />)}
      {!selected && <Welcome onCreate={() => void createTab()} />}
    </main>
    <nav className="mobile-pane-bar" aria-label={t("aria.paneSwitcher")}>
      {MOBILE_PANES.map((pane) => <button key={pane} className={pane === mobilePane ? "active" : ""} aria-current={pane === mobilePane ? "page" : undefined} onClick={() => setMobilePane(pane)}>{t(`pane.${pane}`)}</button>)}
    </nav>
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

function useTailWindow<T>(items: readonly T[], contentKey: string, pageSize: number, hasEarlier = false, onLoadEarlier?: () => Promise<number>) {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  // Whether the reader is following the tail. Recorded as they scroll, because
  // by the time the layout effect below runs the list has already grown.
  const following = useRef(true);
  // Scrolling to the top is the usual way back through history, but an opening
  // window of a few short records may not overflow its pane at all, leaving
  // nothing to scroll. The reveal is therefore also exposed as a control.
  const [revealing, setRevealing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);
  const loadingEarlier = useRef(false);
  const startIndex = Math.max(0, items.length - visibleCount);
  const visibleItems = items.slice(startIndex);

  const revealEarlier = useCallback(async () => {
    const element = scrollRef.current;
    if (!element || prependAnchor.current || loadingEarlier.current) return;
    if (visibleCount < items.length) {
      prependAnchor.current = { height: element.scrollHeight, top: element.scrollTop };
      setVisibleCount((current) => Math.min(items.length, current + pageSize));
      return;
    }
    if (!hasEarlier || !onLoadEarlier) return;
    loadingEarlier.current = true;
    setRevealing(true);
    prependAnchor.current = { height: element.scrollHeight, top: element.scrollTop };
    try {
      const added = await onLoadEarlier();
      if (added > 0) setVisibleCount((current) => current + added);
      else prependAnchor.current = null;
    } catch {
      prependAnchor.current = null;
    } finally {
      loadingEarlier.current = false;
      setRevealing(false);
    }
  }, [hasEarlier, items.length, onLoadEarlier, pageSize, visibleCount]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = isAtBottom(element);
    if (isNearTop(element)) void revealEarlier();
  }, [revealEarlier]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const anchor = prependAnchor.current;
    if (anchor) {
      element.scrollTop = anchor.top + (element.scrollHeight - anchor.height);
      prependAnchor.current = null;
    } else if (following.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [contentKey, visibleCount]);

  useEffect(() => {
    setVisibleCount((current) => Math.max(Math.min(current, items.length), Math.min(pageSize, items.length)));
  }, [items.length, pageSize]);

  return { onScroll, scrollRef, startIndex, visibleItems, revealEarlier, revealing, canRevealEarlier: hasEarlier || visibleCount < items.length };
}

function LoadEarlier({ shown, busy, label, busyLabel, onReveal }: { shown: boolean; busy: boolean; label: string; busyLabel: string; onReveal: () => void }) {
  if (!shown) return null;
  return <button type="button" className="load-earlier" disabled={busy} onClick={onReveal}>{busy ? busyLabel : label}</button>;
}

function TabView({ tab, active, refreshNonce, theme, terminalPreference, projectionSupported, onTerminalPreferenceChange, onBundleChanged, onError }: { tab: TabMeta; active: boolean; refreshNonce: number; theme: "light" | "dark"; terminalPreference: TerminalTransportPreference; projectionSupported: boolean; onTerminalPreferenceChange: (value: TerminalTransportPreference) => void; onBundleChanged: (bundle: TabBundle) => void; onError: (error: unknown) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  // Re-selecting a conversation paints from what this page already downloaded
  // instead of showing a spinner and fetching the same records again; the load
  // below still runs, but as a revalidation the server answers with a 304.
  const cached = readCachedTab(tab.id);
  const [bundle, setBundle] = useState<TabBundle | null>(cached?.bundle ?? null);
  const [loadError, setLoadError] = useState<unknown | null>(null);
  // The persisted tab layout is only the starting point for a browser that has
  // never been resized here; after that this screen keeps its own split.
  const splitSpec = useMemo(() => workspaceSplit(tab.id, tab.layout.leftWidthPercent), [tab.id, tab.layout.leftWidthPercent]);
  const [leftWidth, setLeftWidth] = useState(() => readPaneSize(splitSpec));
  const dragging = useRef(false);
  const workspace = useRef<HTMLDivElement>(null);
  // How tall the session card is, in this browser only. Null until dragged, so
  // an untouched conversation keeps sizing the card to its own content.
  const sessionSpec = useMemo(() => conversationSplit(tab.id), [tab.id]);
  const [sessionHeight, setSessionHeight] = useState<number | null>(() => readStoredPaneSize(sessionSpec));
  const conversation = useRef<HTMLElement>(null);
  const [reopening, setReopening] = useState(false);
  const [documentIntent, setDocumentIntent] = useState<DocumentOpenIntent | null>(null);
  const documentIntentId = useRef(0);
  const documentOpenBusy = useRef(false);
  const lastDocumentClick = useRef<{ href: string; at: number } | null>(null);
  const loadSequence = useRef(0);
  const initialBundleApplied = useRef(Boolean(cached));
  const bundleRef = useRef<TabBundle | null>(cached?.bundle ?? null);
  // How deep this browser is currently scrolled, so a refresh re-reads the
  // same span rather than snapping back to the opening records.
  const windowDepth = useRef({ promptLimit: cached?.promptLimit ?? INITIAL_PROMPT_WINDOW, answerLimit: cached?.answerLimit ?? INITIAL_ANSWER_WINDOW });
  const keepBundle = useCallback((next: TabBundle) => {
    bundleRef.current = next;
    windowDepth.current = windowLimits(next);
    rememberTab(next);
  }, []);
  const applyBundle = useCallback((next: TabBundle) => {
    initialBundleApplied.current = true;
    keepBundle(next);
    setBundle(next);
    setLoadError(null);
    onBundleChanged(next);
  }, [keepBundle, onBundleChanged]);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const { promptLimit, answerLimit } = windowDepth.current;
    try {
      const next = await loadTabWithRetry(() => api<TabBundle>(`/api/tabs/${tab.id}?promptLimit=${promptLimit}&answerLimit=${answerLimit}`));
      if (!initialBundleApplied.current) {
        // A fast response followed by Markdown/xterm setup can otherwise land
        // before the browser paints this newly selected view, producing a
        // blank workspace until the expensive render completes.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }
      if (sequence === loadSequence.current) applyBundle(next);
      return next;
    } catch (reason) {
      if (sequence === loadSequence.current) {
        setLoadError(reason);
        onError(reason);
      }
      return null;
    }
  }, [applyBundle, tab.id, onError]);
  const applyRealtimeMessage = useCallback((message: any) => {
    const current = bundleRef.current;
    if (!current) return;
    const result = applyTabMessage(current, message);
    if (result.needsSnapshot) {
      void load();
      return;
    }
    if (!result.changed) return;
    keepBundle(result.bundle);
    setBundle(result.bundle);
    onBundleChanged(result.bundle);
  }, [keepBundle, load, onBundleChanged]);
  const loadEarlierPrompts = useCallback(async (): Promise<number> => {
    try {
      const current = bundleRef.current;
      const before = current?.window?.prompts.start ?? 0;
      if (!current || before <= 0) return 0;
      const page = await api<TabRecordPage<PromptRecord>>(`/api/tabs/${tab.id}/prompts/page?before=${before}&limit=${EARLIER_PROMPT_PAGE}`);
      if (bundleRef.current?.prompts.revision !== page.revision) { void load(); return 0; }
      const known = new Set(current.prompts.prompts.map((item) => item.id));
      const earlier = page.records.filter((item) => !known.has(item.id));
      const next: TabBundle = {
        ...current,
        prompts: { ...current.prompts, prompts: [...earlier, ...current.prompts.prompts] },
        window: { ...(current.window ?? { prompts: { start: 0, total: 0, completed: 0 }, answers: { start: 0, total: 0 } }), prompts: { start: page.start, total: page.total, completed: current.window?.prompts.completed ?? current.prompts.prompts.filter((prompt) => prompt.status === "completed").length } },
      };
      keepBundle(next);
      setBundle(next);
      onBundleChanged(next);
      return earlier.length;
    } catch (error) {
      onError(error);
      return 0;
    }
  }, [keepBundle, load, onBundleChanged, onError, tab.id]);
  const loadEarlierAnswers = useCallback(async (): Promise<number> => {
    try {
      const current = bundleRef.current;
      const before = current?.window?.answers.start ?? 0;
      if (!current || before <= 0) return 0;
      const page = await api<TabRecordPage<AnswerRecord>>(`/api/tabs/${tab.id}/answers/page?before=${before}&limit=${EARLIER_ANSWER_PAGE}`);
      if (bundleRef.current?.answers.revision !== page.revision) { void load(); return 0; }
      const known = new Set(current.answers.answers.map((item) => item.id));
      const earlier = page.records.filter((item) => !known.has(item.id));
      const next: TabBundle = {
        ...current,
        answers: { ...current.answers, answers: [...earlier, ...current.answers.answers] },
        window: { ...(current.window ?? { prompts: { start: 0, total: 0, completed: 0 }, answers: { start: 0, total: 0 } }), answers: { start: page.start, total: page.total } },
      };
      keepBundle(next);
      setBundle(next);
      onBundleChanged(next);
      return earlier.length;
    } catch (error) {
      onError(error);
      return 0;
    }
  }, [keepBundle, load, onBundleChanged, onError, tab.id]);
  /**
   * What a queue mutation reports back.
   *
   * These routes used to answer with the whole conversation and the screen
   * threw it away and reloaded anyway -- three transfers for one edited row.
   * Now they return the delta they just broadcast, and it goes through the
   * same realtime path: whichever copy lands second is a no-op, because the
   * delta is guarded by revision. Only a response carrying neither falls back
   * to a reload.
   */
  const applyServerEcho = useCallback((echo?: unknown) => {
    const data = echo as { delta?: unknown; runtime?: unknown } | null | undefined;
    if (data?.delta) applyRealtimeMessage({ type: "prompts.changed", delta: data.delta });
    else if (data?.runtime) applyRealtimeMessage({ type: "runtime.changed", runner: data.runtime });
    else void load();
  }, [applyRealtimeMessage, load]);
  useEffect(() => { void load(); }, [load, refreshNonce]);
  useEffect(() => {
    const move = (event: MouseEvent) => { if (!active || !dragging.current) return; const rect = workspace.current?.getBoundingClientRect(); if (!rect) return; setLeftWidth(Math.max(24, Math.min(76, ((event.clientX - rect.left) / rect.width) * 100))); };
    const up = () => { if (!dragging.current) return; dragging.current = false; writePaneSize(splitSpec, leftWidth); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [active, leftWidth, splitSpec]);
  // Pointer events rather than mouse: this divider is worth having on a phone,
  // where the conversation column is the whole screen.
  const dragSessionHeight = (event: PointerEvent<HTMLDivElement>) => {
    const pane = conversation.current;
    if (!pane) return;
    const rect = pane.getBoundingClientRect();
    if (rect.height <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    let latest = sessionHeight ?? 38;
    const move = (moveEvent: globalThis.PointerEvent) => {
      latest = Math.max(12, Math.min(80, ((moveEvent.clientY - rect.top) / rect.height) * 100));
      setSessionHeight(latest);
    };
    const release = () => {
      window.removeEventListener("pointermove", move);
      writePaneSize(sessionSpec, latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release, { once: true });
    window.addEventListener("pointercancel", release, { once: true });
  };
  if (!bundle) return <div className={`tab-view ${active ? "" : "tab-view-hidden"}`} aria-hidden={!active}><div className="loading-pane">{loadError ? <><strong>{t("conversation.loadFailed")}</strong><span>{i18n.errorText(loadError)}</span><button className="ghost" onClick={() => void load()}>{t("action.retry")}</button></> : <><div className="spinner" />{t("conversation.loading")}</>}</div></div>;
  const closed = bundle.tab.session.state === "closed";
  const runnable = bundle.tab.session.state === "ready" && Boolean(bundle.tab.session.threadId);
  const reopen = async () => {
    if (reopening) return;
    setReopening(true);
    try { applyBundle(await api<TabBundle>(`/api/tabs/${tab.id}/terminal/reopen`, { method: "POST" })); }
    catch (reason) { onError(reason); }
    finally { setReopening(false); }
  };
  const threadId = bundle.tab.session.threadId;
  const answers = threadId ? bundle.answers.answers.filter((answer) => answer.threadId === threadId) : [];
  const openDocumentLink = async (href: string, answerId: string) => {
    const clickedAt = Date.now();
    if (documentOpenBusy.current || lastDocumentClick.current?.href === href && clickedAt - lastDocumentClick.current.at < 600) return;
    lastDocumentClick.current = { href, at: clickedAt };
    const target = extractDocumentTarget(href);
    if (target.kind !== "local-file") return;
    const request = { href, tabId: tab.id, answerId };
    if (!isLoopbackHostname(location.hostname)) {
      setDocumentIntent({ id: ++documentIntentId.current, request });
      return;
    }
    documentOpenBusy.current = true;
    try {
      await api("/api/documents/open-local", jsonBody(request));
    } catch (reason) {
      if (reason instanceof PromptorApiError && reason.code === "DOCUMENT_CONFIRMATION_REQUIRED") {
        const confirmationToken = String(reason.details.confirmationToken ?? "");
        const name = String(reason.details.name ?? target.displayName ?? "");
        if (confirmationToken && window.confirm(t("document.confirmActive", { name }))) {
          try { await api("/api/documents/open-local", jsonBody({ ...request, confirmationToken })); }
          catch (error) { onError(error); }
        }
        return;
      }
      onError(reason);
    } finally { documentOpenBusy.current = false; }
  };
  return <div className={`tab-view ${active ? "" : "tab-view-hidden"} ${closed ? "conversation-closed" : ""}`} aria-hidden={!active}><div className="tab-workspace" ref={workspace} style={{ gridTemplateColumns: `${leftWidth}fr 7px ${100 - leftWidth}fr` }}>
    <section className="conversation-pane" ref={conversation}>{active && <><SessionPanel bundle={bundle} height={sessionHeight} reopening={reopening} onReopen={reopen} onBundle={applyBundle} onError={onError} /><div className="session-splitter" role="separator" aria-orientation="horizontal" title={t("conversation.sessionSplitter")} onPointerDown={dragSessionHeight} /><AnswerHistory key={`answers-${threadId ?? "none"}`} answers={answers} total={bundle.window?.answers.total ?? answers.length} hasEarlier={(bundle.window?.answers.start ?? 0) > 0} onLoadEarlier={loadEarlierAnswers} onDocumentLink={(href, answerId) => void openDocumentLink(href, answerId)} emptyKey={bundle.tab.session.provider === "shell" ? "answers.shellEmpty" : "answers.empty"} /></>}</section>
    <div className={`splitter ${closed ? "disabled" : ""}`} onMouseDown={() => { if (!closed) dragging.current = true; }} title={t(closed ? "conversation.splitterClosed" : "conversation.splitter")} />
    <section className="queue-pane">{active && <PromptQueue key={`queue-${threadId ?? "none"}`} bundle={bundle} total={bundle.window?.prompts.total ?? bundle.prompts.prompts.length} hasEarlier={(bundle.window?.prompts.start ?? 0) > 0} onLoadEarlier={loadEarlierPrompts} disabled={closed} runnable={runnable} onChanged={applyServerEcho} onError={onError} />}<TerminalPanel tabId={tab.id} provider={bundle.tab.session.provider} runtime={bundle.runtime} theme={theme} active={active} closed={closed} documentIntent={documentIntent} terminalPreference={terminalPreference} projectionSupported={projectionSupported} onTerminalPreferenceChange={onTerminalPreferenceChange} onBundle={applyBundle} onMessage={applyRealtimeMessage} onError={onError} /></section>
  </div></div>;
}

function orderedTabIds(tabs: TabMeta[], groupId: string | null): string[] {
  return tabs.filter((tab) => tab.groupId === groupId).sort((a, b) => a.order - b.order).map((tab) => tab.id);
}

function SessionPanel({ bundle, height, reopening, onReopen, onBundle, onError }: { bundle: TabBundle; height: number | null; reopening: boolean; onReopen: () => Promise<void>; onBundle: (bundle: TabBundle) => void; onError: (error: unknown) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [cwd, setCwd] = useState(bundle.tab.session.workingDirectory ?? "");
  const [mode, setMode] = useState<"new" | "resume">("new");
  const [provider, setProvider] = useState<AgentProvider>(bundle.tab.session.provider);
  const [resumeId, setResumeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const session = bundle.tab.session;
  const restoring = session.state === "connecting" && Boolean(session.threadId && session.workingDirectory);
  const connected = session.state === "ready" || session.state === "closed" || restoring;
  const connect = async () => {
    setBusy(true);
    try {
      const result = await api<{ bundle: TabBundle }>(`/api/tabs/${bundle.tab.id}/session`, jsonBody({ provider, mode, workingDirectory: cwd, resumeId }));
      onBundle(result.bundle);
    }
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
  const closeConversation = async () => { try { setBusy(true); onBundle(await api<TabBundle>(`/api/tabs/${bundle.tab.id}/session/close`, { method: "POST" })); } catch (reason) { onError(reason); } finally { setBusy(false); } };
  const activeProvider = connected ? session.provider : provider;
  const providerName = t(activeProvider === "claude" ? "provider.claude" : activeProvider === "cursor" ? "provider.cursor" : activeProvider === "shell" ? "provider.shell" : "provider.codex");
  // A terminal has no agent, so everything downstream of one is switched off.
  const isShell = activeProvider === "shell";
  const sessionTitle = session.state === "ready"
    ? t("session.ready", { provider: providerName })
    : session.state === "closed"
      ? t("session.closed", { provider: providerName })
      : restoring
        ? t("session.restoring", { provider: providerName })
        : t("session.setup");
  const sessionHelp = restoring
    ? t("session.restoringHelp", { provider: providerName })
    : connected
      ? t(session.provider === "claude" ? "session.connectedHelp.claude" : session.provider === "cursor" ? "session.connectedHelp.cursor" : session.provider === "shell" ? "session.connectedHelp.shell" : "session.connectedHelp.codex")
      : t("session.setupHelp");
  return <div className="session-card" style={height === null ? undefined : { height: `${height}%`, maxHeight: "none" }}>
    <div className="section-title"><span className="section-icon">◌</span><div><strong>{sessionTitle}</strong><small>{sessionHelp}</small></div></div>
    {connected ? <div className="session-ready">{session.state === "closed" && <div className="closed-notice" role="status">{t("session.closedNotice")}</div>}<div className="session-path"><span>{t("session.workingDirectory")}</span><code>{session.workingDirectory}</code></div>{session.provider !== "shell" && <div className={`session-ids ${session.provider !== "codex" ? "single" : ""}`}>{session.provider === "codex" && <div><span>{t("session.threadId")}</span><code>{session.threadId}</code></div>}<div><span>{t("session.sessionId")}</span><code>{session.sessionId}</code></div></div>}{session.lastThreadSwitch && <div className="thread-switch-notice" role="status" title={`${session.lastThreadSwitch.fromThreadId} → ${session.lastThreadSwitch.toThreadId}`}><strong>{t("session.followedSwitch")}</strong><span>/{session.lastThreadSwitch.method.split("/").at(-1)} · {i18n.formatTime(session.lastThreadSwitch.switchedAt)}</span></div>}<div className="session-actions"><button className="ghost" disabled={busy || reopening || restoring} onClick={() => void onReopen()}>{t(reopening || restoring ? "session.restoringAction" : "session.reopen")}</button>{session.state === "ready" && <button className="danger-action" disabled={busy} onClick={() => void closeConversation()}>{t(busy ? "session.closing" : "session.close")}</button>}</div></div> : <>
      <label className="field-label">{t("session.localPath")}</label><div className="path-row"><input value={cwd} title={cwd} onChange={(event) => setCwd(event.target.value)} placeholder={t("session.pathExample")} /><button className="ghost" disabled={browsing} onClick={() => void browse()}>{t(browsing ? "session.choosingFolder" : "session.chooseFolder")}</button></div>{cwd && <code className="path-preview" title={cwd}>{cwd}</code>}{isShell && !cwd.trim() && <small className="field-hint">{t("session.shellPathHint")}</small>}
      {!isShell && <div className="mode-switch"><button className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>{t("session.createNew")}</button><button className={mode === "resume" ? "active" : ""} onClick={() => setMode("resume")}>{t("session.resumeOld")}</button></div>}
      {!isShell && mode === "resume" && <input className="resume-input" value={resumeId} onChange={(event) => setResumeId(event.target.value)} placeholder={t("session.resumePlaceholder")} />}
      <div className="connect-row"><button className="primary connect" disabled={busy || (!isShell && !cwd.trim())} onClick={() => void connect()}>{t(busy ? "session.connecting" : "session.confirmOpen")}</button><select value={provider} disabled={busy} onChange={(event) => setProvider(event.target.value as AgentProvider)} aria-label={providerName}><option value="codex">{t("provider.codex")}</option><option value="claude">{t("provider.claude")}</option><option value="cursor">{t("provider.cursor")}</option><option value="shell">{t("provider.shell")}</option></select></div>
    </>}
    {session.lastError && <div className="inline-error">{i18n.errorText(session.lastError)}</div>}
  </div>;
}

function AnswerHistory({ answers, total, hasEarlier, onLoadEarlier, onDocumentLink, emptyKey }: { answers: AnswerRecord[]; total: number; hasEarlier: boolean; onLoadEarlier: () => Promise<number>; onDocumentLink: (href: string, answerId: string) => void; emptyKey: "answers.empty" | "answers.shellEmpty" }) {
  const i18n = useI18n();
  const { t } = i18n;
  const contentKey = answers.map((answer) => `${answer.id}:${answer.status}:${answer.completedAt ?? ""}:${answer.finalAnswer.length}`).join("|");
  const { onScroll, scrollRef, visibleItems, revealEarlier, revealing, canRevealEarlier } = useTailWindow(answers, contentKey, 12, hasEarlier, onLoadEarlier);
  return <div className="answers"><div className="answers-heading"><span>{t("answers.title")}</span><em>{total}</em></div><div className="answer-scroll" ref={scrollRef} onScroll={onScroll}>{answers.length === 0 ? <div className="empty-answers">{t(emptyKey)}</div> : <div className="answer-list"><LoadEarlier shown={canRevealEarlier} busy={revealing} label={t("answers.loadEarlier")} busyLabel={t("answers.loadingEarlier")} onReveal={() => void revealEarlier()} />{visibleItems.map((answer) => {
    const statusLabel = t(answer.status === "running" ? "answers.running" : answer.status === "completed" ? "answers.completed" : answer.status === "interrupted" ? "answers.interrupted" : "answers.failed");
    // A turn can end without a clean final answer (interrupted mid-stream, or
    // Claude's transcript never reaching end_turn) yet still carry the last
    // thing the agent said. Show that content instead of an empty card, with
    // a badge marking it as partial rather than a genuine completed answer.
    // A running turn already shows content as it streams; that is not a turn
    // that "did not finish", so it must never get the partial badge's wording.
    const isRunning = answer.status === "running";
    const isPartial = !isRunning && (answer.captureMode === "fallback_partial_answer" || (answer.status !== "completed" && Boolean(answer.finalAnswer)));
    return <article className={`answer-card ${answer.status}`} key={answer.id}>
      <div className="answer-meta"><span className="answer-meta-left"><span>{t(answer.origin === "imported" ? "answers.imported" : answer.origin === "manual" ? "answers.manual" : "answers.queue")}</span><b className={`answer-state ${answer.status}`}>{statusLabel}</b></span><time>{t("answers.startedAt")} {i18n.formatTime(answer.startedAt)}</time></div>
      <div className="answer-prompt">{answer.prompt}</div>
      {answer.finalAnswer ? <>
        {isRunning && <div className="answer-lifecycle running"><span className="status-dot running" />{t("answers.waitingFinal")}</div>}
        {isPartial && <div className={`answer-lifecycle partial ${answer.status}`}><strong>{answer.status === "completed" ? t("answers.partial") : statusLabel}</strong><span>{t("answers.partialDetail")}</span></div>}
        <div className="markdown"><SafeMarkdown source={answer.finalAnswer} onDocumentLink={(href) => onDocumentLink(href, answer.id)} /></div>
      </> : answer.status === "running" ? <div className="answer-lifecycle running"><span className="status-dot running" />{t("answers.waitingFinal")}</div> : <div className={`answer-lifecycle ${answer.status}`}><strong>{statusLabel}</strong><span>{answer.error ? i18n.errorText(answer.error) : t(answer.status === "interrupted" ? "answers.interruptedDetail" : "answers.failedDetail")}</span></div>}
      {answer.status !== "running" && <div className="answer-ended"><time>{t("answers.endedAt")} {i18n.formatTime(answer.completedAt)}</time></div>}
    </article>;
  })}</div>}</div></div>;
}

function PromptQueue({ bundle, total, hasEarlier, onLoadEarlier, disabled, runnable, onChanged, onError }: { bundle: TabBundle; total: number; hasEarlier: boolean; onLoadEarlier: () => Promise<number>; disabled: boolean; runnable: boolean; onChanged: (echo?: unknown) => void; onError: (error: unknown) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  // The composer holds unsaved work, so it is restored from this browser rather
  // than reset every time the queue remounts (switching conversations, a reload,
  // or the tab falling out of the retained set).
  const tabId = bundle.tab.id;
  const [newText, setNewText] = useState(() => readPromptDraft(tabId));
  const editDraft = (text: string) => { setNewText(text); writePromptDraft(tabId, text); };
  const [adding, setAdding] = useState(false);
  const [runnerAction, setRunnerAction] = useState<"start" | "pause" | "interrupt" | null>(null);
  const nativeDragSource = useRef<string | null>(null);
  const reorderInFlight = useRef(false);
  const threadId = bundle.tab.session.threadId;
  const currentAnswerPromptIds = new Set(bundle.answers.answers
    .filter((answer) => answer.threadId === threadId)
    .map((answer) => answer.promptId));
  const prompts = bundle.prompts.prompts.filter((prompt) => prompt.threadId === threadId
    || (!prompt.threadId && currentAnswerPromptIds.has(prompt.id))
    || (prompt.status === "pending" && !prompt.threadId));
  const promptContentKey = prompts.map((prompt) => prompt.id).join("|");
  const { onScroll: onPromptScroll, scrollRef: promptWindow, startIndex: promptStartIndex, visibleItems: visiblePrompts, revealEarlier: revealEarlierPrompts, revealing: revealingPrompts, canRevealEarlier: canRevealEarlierPrompts } = useTailWindow(prompts, promptContentKey, 24, hasEarlier, onLoadEarlier);
  const runtime = bundle.runtime;
  // Two different facts, and they come apart: the agent can be idle between
  // prompts while the queue is still set to keep feeding it, and the agent can
  // be finishing a turn while the queue is already set to stop after it.
  // "armed" is the third: idle, but the next prompt added will run.
  const queueStateKey = runtime.runner.desiredState === "running"
    ? "queue.rolling"
    : runtime.runner.desiredState === "armed" ? "queue.armed" : "queue.notRolling";
  const queueRolling = runtime.runner.desiredState !== "paused";
  // A terminal conversation has no agent to hand prompts to. The runner buttons
  // are already off (runnable needs a threadId); this closes the composer too
  // so nothing can be queued that could never run.
  const isShell = bundle.tab.session.provider === "shell";
  const runnerControlsDisabled = disabled || !runnable;
  const changeRunner = async (action: "start" | "pause" | "interrupt") => {
    if (runnerControlsDisabled || runnerAction) return;
    setRunnerAction(action);
    try {
      onChanged(await api(`/api/tabs/${bundle.tab.id}/runner/${action}`, jsonBody({})));
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
    // Only drop the draft once the prompt is safely on the list; a failed add
    // must leave the text exactly where the user can retry it.
    try { const echo = await api(`/api/tabs/${bundle.tab.id}/prompts`, jsonBody({ text })); setNewText(""); clearPromptDraft(tabId); onChanged(echo); }
    catch (reason) { onError(reason); }
    finally { setAdding(false); }
  };
  // The move is checked here so an impossible drag never leaves the screen,
  // but only the two ids are sent: the server owns the order and recomputes it
  // with this same function, so a queue of any length costs one small request.
  const reorder = async (sourceId: string, targetId: string) => {
    if (disabled || !sourceId || sourceId === targetId || reorderInFlight.current) return;
    if (!reorderPromptIds(prompts.filter((item) => item.status === "pending").map((item) => item.id), sourceId, targetId)) return;
    reorderInFlight.current = true;
    try { onChanged(await api(`/api/tabs/${bundle.tab.id}/prompts/order`, { method: "PUT", body: JSON.stringify({ sourceId, targetId }) })); }
    catch (reason) { onError(reason); }
    finally { reorderInFlight.current = false; nativeDragSource.current = null; }
  };
  const runnerState = runnerLabel(i18n, runtime);
  const completedCount = bundle.window?.prompts.completed ?? prompts.filter((item) => item.status === "completed").length;
  return <div className="queue-card"><div className="queue-heading"><div className="queue-summary"><h3>{t("queue.title")}</h3><span className="queue-count">{completedCount}/{total}</span><span className={`queue-state ${runtime.runner.state === "error" ? "error" : ""}`} title={runnerState}><i className={`status-dot ${runtime.runner.state === "error" ? "error" : runnerIsWorking(runtime.runner.state) ? "running" : ""}`} /><span>{runnerState}</span></span><span className={`queue-state ${runtime.runner.desiredState}`} title={t(queueStateKey)}><i className={`status-dot ${runtime.runner.desiredState === "running" ? "running" : queueRolling ? "armed" : ""}`} /><span>{t(queueStateKey)}</span></span></div><div className="runner-actions"><button className="primary runner-start-button" disabled={runnerControlsDisabled} aria-busy={runnerAction === "start"} onClick={() => void changeRunner("start")}>{t(runnerAction === "start" ? "queue.starting" : "queue.start")}</button><button className="pause-button" disabled={runnerControlsDisabled} aria-busy={runnerAction === "pause"} onClick={() => void changeRunner("pause")}>{t(runnerAction === "pause" ? "queue.pausing" : "queue.pause")}</button><button className="interrupt-button" disabled={runnerControlsDisabled} aria-busy={runnerAction === "interrupt"} onClick={() => void changeRunner("interrupt")}>{t(runnerAction === "interrupt" ? "queue.interrupting" : "queue.interrupt")}</button></div></div>
    {runtime.runner.lastError && <div className="runner-error" role="alert">{i18n.errorText(runtime.runner.lastError)}</div>}
    <div className="prompt-list" ref={promptWindow} onScroll={onPromptScroll}>{prompts.length === 0 && <div className="empty-prompts">{t("queue.empty")}</div>}<LoadEarlier shown={canRevealEarlierPrompts} busy={revealingPrompts} label={t("queue.loadEarlier")} busyLabel={t("queue.loadingEarlier")} onReveal={() => void revealEarlierPrompts()} />{visiblePrompts.map((prompt, visibleIndex) => { const index = promptStartIndex + visibleIndex; return <PromptRow key={prompt.id} prompt={prompt} index={index} tabId={bundle.tab.id} locked={disabled} onDrop={reorder} onNativeDragStart={(sourceId) => { nativeDragSource.current = sourceId; }} onNativeDragEnter={(targetId) => { if (nativeDragSource.current) void reorder(nativeDragSource.current, targetId); }} onChanged={onChanged} onError={onError} />; })}</div>
    {isShell && <div className="queue-shell-notice" role="status">{t("queue.shellNotice")}</div>}
    <div className="add-prompt"><textarea disabled={disabled || isShell} value={newText} onChange={(event) => editDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void add(); } }} placeholder={t(disabled ? "queue.closedPlaceholder" : "queue.inputPlaceholder")} /><button className="primary" disabled={disabled || isShell || adding || !newText.trim()} onClick={() => void add()}>{t(adding ? "queue.adding" : "queue.add")}</button></div>
  </div>;
}

/**
 * Sizes a queue row's text box to the prompt it holds, up to a cap.
 *
 * The measurement has to happen after layout and at the box's real width, so
 * it reruns when the text changes, when editing swaps the padding, and when
 * the column is resized. The observer compares widths only: reacting to the
 * height it just set would loop.
 */
function useAutoSizedTextarea(ref: { current: HTMLTextAreaElement | null }, text: string, editing: boolean) {
  const measuredWidth = useRef(0);
  const resize = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${autoSizedHeight(readTextareaMetrics(element))}px`;
  }, [ref]);
  useLayoutEffect(() => { resize(); }, [resize, text, editing]);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    measuredWidth.current = element.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - measuredWidth.current) < 1) return;
      measuredWidth.current = width;
      resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, resize]);
}

/**
 * A long prompt owns the wheel only while its three-line textarea can move in
 * that direction. At either edge, move the queue list explicitly so disabled
 * and read-only textareas behave the same across Chromium versions.
 */
function handoffPromptTextareaWheel(event: ReactWheelEvent<HTMLDivElement>) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  const target = event.target instanceof Element ? event.target.closest("textarea") : null;
  if (!(target instanceof HTMLTextAreaElement) || !event.currentTarget.contains(target)) return;
  if (!shouldHandoffWheel(target, event.deltaY)) return;
  const promptList = event.currentTarget.closest<HTMLElement>(".prompt-list");
  if (!promptList) return;
  const lineHeight = Number.parseFloat(getComputedStyle(target).lineHeight);
  const delta = wheelDeltaPixels(event.deltaY, event.deltaMode, lineHeight, promptList.clientHeight);
  event.preventDefault();
  event.stopPropagation();
  promptList.scrollTop += delta;
}

function PromptRow({ prompt, index, tabId, locked, onDrop, onNativeDragStart, onNativeDragEnter, onChanged, onError }: { prompt: PromptRecord; index: number; tabId: string; locked: boolean; onDrop: (sourceId: string, targetId: string) => void; onNativeDragStart: (sourceId: string | null) => void; onNativeDragEnter: (targetId: string) => void; onChanged: (echo?: unknown) => void; onError: (error: unknown) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const editable = !locked && !["completed", "running", "dispatching"].includes(prompt.status);
  const [text, setText] = useState(prompt.text);
  const [editing, setEditing] = useState(false);
  const [insertingNow, setInsertingNow] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  useAutoSizedTextarea(editor, text, editing);
  useEffect(() => { setText(prompt.text); setEditing(false); }, [prompt.text, prompt.status]);
  const beginEdit = () => { if (!editable) return; setEditing(true); requestAnimationFrame(() => { editor.current?.focus({ preventScroll: true }); editor.current?.select(); }); };
  const save = async () => {
    if (!editable) return;
    if (!text.trim()) { onError(new PromptorApiError("PROMPT_EMPTY", t("queue.promptEmpty"), 400, false)); return; }
    if (text.trim() === prompt.text) { setEditing(false); return; }
    try { const echo = await api(`/api/tabs/${tabId}/prompts/${prompt.id}`, { method: "PATCH", body: JSON.stringify({ text }) }); setEditing(false); onChanged(echo); }
    catch (reason) { onError(reason); }
  };
  const remove = async () => { try { onChanged(await api(`/api/tabs/${tabId}/prompts/${prompt.id}`, { method: "DELETE" })); } catch (reason) { onError(reason); } };
  const retry = async () => { try { onChanged(await api(`/api/tabs/${tabId}/prompts/${prompt.id}/retry`, jsonBody({}))); } catch (reason) { onError(reason); } };
  const skip = async () => { try { onChanged(await api(`/api/tabs/${tabId}/prompts/${prompt.id}/skip`, jsonBody({}))); } catch (reason) { onError(reason); } };
  const insertNow = async () => {
    if (locked || insertingNow || prompt.status !== "pending") return;
    setInsertingNow(true);
    try { onChanged(await api(`/api/tabs/${tabId}/prompts/${prompt.id}/insert-now`, jsonBody({}))); }
    catch (reason) { onError(reason); }
    finally { setInsertingNow(false); }
  };
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
  return <div className={`prompt-row ${prompt.status} ${locked ? "locked" : ""}`} data-prompt-id={prompt.id} draggable={pending && !editing} onWheelCapture={handoffPromptTextareaWheel} onMouseDown={mouseDown} onDragStart={nativeDragStart} onDragEnd={() => onNativeDragStart(null)} onDragEnter={(event) => { if (pending) { event.preventDefault(); onNativeDragEnter(prompt.id); } }} onDragOver={(event) => { if (pending) event.preventDefault(); }}><div className="prompt-index">{prompt.status === "completed" ? "✓" : index + 1}</div><div className={`drag-handle ${pending ? "enabled" : ""}`} title={pending ? t("queue.drag") : undefined} onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={(event) => event.currentTarget.classList.remove("dragging")}>⠿</div><textarea ref={editor} value={text} disabled={!editable} readOnly={!editing} className={editing ? "editing" : ""} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void save(); } }} rows={1} /><div className="prompt-side"><span className="prompt-status">{prompt.status === "completed" && prompt.completedAt && <time>{i18n.formatTime(prompt.completedAt)}</time>}<span>{promptStatusLabel(i18n, prompt.status)}</span></span>{pendingStatus && <button className="prompt-edit-button" aria-label={t(editing ? "action.save" : "queue.edit")} title={t(editing ? "action.save" : "queue.edit")} disabled={locked || insertingNow} onClick={() => editing ? void save() : beginEdit()}>{editing ? "✓" : "✎"}</button>}{pendingStatus && <button className="link-button insert-now-button" disabled={locked || insertingNow || editing} title={t("queue.insertNowHelp")} onClick={() => void insertNow()}>{t(insertingNow ? "queue.insertingNow" : "queue.insertNow")}</button>}{prompt.status === "failed" || prompt.status === "interrupted" ? <><button className="link-button" disabled={locked} onClick={() => void retry()}>{t("queue.retry")}</button><button className="link-button" disabled={locked} onClick={() => void skip()}>{t("queue.skip")}</button></> : editable && <button className="delete-button" aria-label={t("queue.deletePrompt")} onClick={() => void remove()}>×</button>}</div></div>;
}

function TerminalPanel({ tabId, provider, runtime, theme, active, closed, documentIntent, terminalPreference, projectionSupported, onTerminalPreferenceChange, onBundle, onMessage, onError }: { tabId: string; provider: AgentProvider; runtime: RuntimeFile; theme: "light" | "dark"; active: boolean; closed: boolean; documentIntent: DocumentOpenIntent | null; terminalPreference: TerminalTransportPreference; projectionSupported: boolean; onTerminalPreferenceChange: (value: TerminalTransportPreference) => void; onBundle: (bundle: TabBundle) => void; onMessage: (message: any) => void; onError: (error: unknown) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const reconnect = useRef<(() => void) | null>(null);
  const scheduleLayout = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  const closedRef = useRef(closed);
  const themeRef = useRef(theme);
  const providerRef = useRef(provider);
  const callbacks = useRef({ onBundle, onMessage, onError });
  const subscriptionController = useRef<((includeTerminal: boolean) => void) | null>(null);
  const { loader: documentLoader, state: documentState, visible: documentVisible } = useDocumentViewer(documentIntent, active);
  const documentVisibleRef = useRef(documentVisible);
  const [connected, setConnected] = useState(false);
  const [hasOutput, setHasOutput] = useState(false);
  const transportMode: TerminalTransportMode = projectionSupported
    ? resolveTerminalTransportPreference(terminalPreference, location.hostname)
    : "raw";
  const runnerBusy = runtime.runner.desiredState === "running"
    || ["starting", "waiting_for_thread", "dispatching", "running", "waiting_for_prompt", "pausing"].includes(runtime.runner.state);
  closedRef.current = closed;
  activeRef.current = active;
  themeRef.current = theme;
  providerRef.current = provider;
  callbacks.current = { onBundle, onMessage, onError };
  documentVisibleRef.current = documentVisible;
  useEffect(() => {
    if (!host.current) return;
    setConnected(false);
    setHasOutput(false);
    let disposed = false;
    let reconnectTimer: number | null = null;
    let connectFrame: number | null = null;
    let resizeFrame: number | null = null;
    let settlingQuietTimer: number | null = null;
    let settlingMaxTimer: number | null = null;
    let terminalWriteSequence = 0;
    let terminalWriteEpoch = 0;
    let terminalWriteQueue = Promise.resolve();
    let longTerminal = false;
    let connectedOnce = false;
    const alarm = createConnectionAlarm();
    const projectionMode = transportMode === "projection";
    // Reconnecting with no cursor makes the server resend the whole scroll
    // buffer. What this page already received is still good, so the cursor and
    // the bytes are restored first and the socket asks only for the remainder.
    const remembered = transportMode === "projection" ? null : readCachedRawTerminal(tabId);
    const cursor: { generation: string | null; nextOffset: number | null } = remembered
      ? { generation: remembered.generation, nextOffset: remembered.nextOffset }
      : { generation: null, nextOffset: null };
    let projectionState: ProjectionScreenState | null = transportMode === "projection" ? readCachedProjection(tabId) : null;
    let projectionRenderPending = 0;
    let rawLeaseWritable = true;
    let awaitingRawOneShot = false;
    let rawOneShotAttempts = 0;
    const pendingProjectionInput: string[] = [];
    const initialSize = !projectionMode && runtime.terminal.cols !== null && runtime.terminal.rows !== null
      ? { cols: runtime.terminal.cols, rows: runtime.terminal.rows }
      : null;
    const term = new Terminal({ ...(initialSize ?? (projectionMode ? { cols: 80, rows: 20 } : {})), cursorBlink: false, cursorStyle: "block", cursorInactiveStyle: "none", fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 14, lineHeight: 1.18, theme: getTerminalTheme(themeRef.current), scrollback: projectionMode ? 0 : 5000, allowProposedApi: false });
    host.current.classList.toggle("projection", projectionMode);
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); term.blur(); terminal.current = term;
    const cursorQuietScheduler = new TerminalCursorQuietScheduler((suppressed) => {
      host.current?.classList.toggle("terminal-updating", suppressed);
    });
    const resizeScheduler = new TerminalResizeScheduler(({ cols, rows }) => {
      if (documentVisibleRef.current || projectionMode || !rawLeaseWritable) return;
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) {
        if (longTerminal) {
          beginTerminalSettling();
          scheduleTerminalSettled(2_500);
        }
        ws.send(JSON.stringify({ type: "terminal.resize", tabId, cols, rows }));
      }
    }, 220, initialSize);
    const forceFinishTerminalSettling = () => {
      if (settlingQuietTimer !== null) { window.clearTimeout(settlingQuietTimer); settlingQuietTimer = null; }
      if (settlingMaxTimer !== null) { window.clearTimeout(settlingMaxTimer); settlingMaxTimer = null; }
      host.current?.classList.remove("terminal-settling");
    };
    const terminalLooksSettled = () => {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let index = Math.max(0, buffer.length - 12); index < buffer.length; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
      }
      return terminalFrameLooksSettled(lines);
    };
    const finishTerminalSettlingWhenReady = () => {
      settlingQuietTimer = null;
      if (!host.current?.classList.contains("terminal-settling")) return;
      if (terminalLooksSettled()) {
        forceFinishTerminalSettling();
        return;
      }
      // A long TUI repaint can pause between historical frames. Keep polling
      // without exposing that frame; fresh output below resets this timer.
      settlingQuietTimer = window.setTimeout(finishTerminalSettlingWhenReady, 800);
    };
    const scheduleTerminalSettled = (delay = 800) => {
      if (!host.current?.classList.contains("terminal-settling")) return;
      if (settlingQuietTimer !== null) window.clearTimeout(settlingQuietTimer);
      settlingQuietTimer = window.setTimeout(finishTerminalSettlingWhenReady, delay);
    };
    const beginTerminalSettling = () => {
      host.current?.classList.add("terminal-settling");
      if (settlingQuietTimer !== null) { window.clearTimeout(settlingQuietTimer); settlingQuietTimer = null; }
      if (settlingMaxTimer === null) settlingMaxTimer = window.setTimeout(forceFinishTerminalSettling, 20_000);
    };
    const beginTerminalUpdate = () => {
      const sequence = ++terminalWriteSequence;
      cursorQuietScheduler.beginWrite();
      return sequence;
    };
    const finishTerminalUpdate = (sequence: number) => {
      if (sequence !== terminalWriteSequence) return;
      cursorQuietScheduler.finishWrite();
    };
    const queueTerminalWrite = (fresh: Uint8Array, sequence: number, epoch: number) => {
      const owned = fresh.slice();
      terminalWriteQueue = terminalWriteQueue.then(async () => {
        if (disposed || epoch !== terminalWriteEpoch) { finishTerminalUpdate(sequence); return; }
        const chunkBytes = owned.length >= 64 * 1024 ? 32 * 1024 : Math.max(1, owned.length);
        for (let offset = 0; offset < owned.length; offset += chunkBytes) {
          if (disposed || epoch !== terminalWriteEpoch) { finishTerminalUpdate(sequence); return; }
          const chunk = owned.subarray(offset, Math.min(owned.length, offset + chunkBytes));
          await new Promise<void>((resolve) => term.write(chunk, resolve));
          if (offset + chunkBytes < owned.length) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        term.options.cursorBlink = false;
        finishTerminalUpdate(sequence);
        scheduleTerminalSettled();
      }).catch(() => finishTerminalUpdate(sequence));
    };
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const sendInputNow = (data: string) => {
      const ws = socket.current;
      if (documentVisibleRef.current || (!projectionMode && !rawLeaseWritable)) return;
      if (!closedRef.current && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "terminal.input", tabId, dataBase64: encodeBase64(data) }));
    };
    const flushProjectionInput = () => {
      if (projectionRenderPending > 0 || pendingProjectionInput.length === 0) return;
      for (const data of pendingProjectionInput.splice(0)) sendInputNow(data);
    };
    const sendInput = (data: string) => {
      // A projection frame carries the input modes used to encode the next
      // keystroke. Hold input for the few milliseconds in which xterm applies
      // those controlled mode sequences, then forward it immediately.
      if (projectionMode && projectionRenderPending > 0) {
        pendingProjectionInput.push(data);
        return;
      }
      sendInputNow(data);
    };
    const queueProjectionWrite = (state: ProjectionScreenState, sequence: number, epoch: number, reset: boolean) => {
      projectionRenderPending += 1;
      let settled = false;
      const settleProjectionWrite = () => {
        if (settled) return;
        settled = true;
        projectionRenderPending = Math.max(0, projectionRenderPending - 1);
        finishTerminalUpdate(sequence);
        flushProjectionInput();
      };
      terminalWriteQueue = terminalWriteQueue.then(async () => {
        try {
          if (disposed || epoch !== terminalWriteEpoch) return;
          if (reset) term.reset();
          if (term.cols !== state.cols || term.rows !== state.viewportRows) term.resize(state.cols, state.viewportRows);
          await new Promise<void>((resolve) => term.write(projectionScreenToAnsi(state), resolve));
          term.options.cursorBlink = false;
        } finally {
          settleProjectionWrite();
        }
      }).catch(() => {
        settleProjectionWrite();
      });
    };
    const inputDisposable = term.onData(sendInput);
    const foregroundQuery = term.parser.registerOscHandler(10, (data) => {
      if (!projectionMode && data.trim() === "?") sendInput(`\x1b]10;${themeRef.current === "light" ? "rgb:1d1d/2727/3838" : "rgb:e5e5/eded/f8f8"}\x1b\\`);
      return true;
    });
    const backgroundQuery = term.parser.registerOscHandler(11, (data) => {
      if (!projectionMode && data.trim() === "?") sendInput(`\x1b]11;${themeRef.current === "light" ? "rgb:f8f8/fafa/fcfc" : "rgb:0f0f/1717/2222"}\x1b\\`);
      return true;
    });
    const colorSchemeQuery = term.parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
      if (params[0] !== 996) return false;
      if (!projectionMode) sendInput(themeRef.current === "light" ? "\x1b[?997;2n" : "\x1b[?997;1n");
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
      if (!activeRef.current || documentVisibleRef.current || projectionMode) return;
      try {
        const dimensions = fit.proposeDimensions();
        if (!dimensions) return;
        const cols = Math.max(20, dimensions.cols);
        const rows = Math.max(5, dimensions.rows);
        // The emulator follows whatever the PTY will actually be running at,
        // never the raw proposal. Small changes are deliberately not forwarded
        // to ConPTY (Codex repaints its whole screen on every PTY resize, which
        // is enormous for a resumed long thread) -- but the emulator must then
        // hold the PTY's size too, or the two wrap text differently and a
        // cursor-repainting TUI degrades a little more with every frame.
        const target = resizeScheduler.effectiveSize({ cols, rows });
        if (!sameTerminalSize({ cols: term.cols, rows: term.rows }, target)) term.resize(target.cols, target.rows);
        if (socket.current?.readyState === WebSocket.OPEN) resizeScheduler.schedule({ cols, rows });
      } catch { /* element can be between layouts */ }
    };
    const scheduleSize = () => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(sendSize);
    };
    scheduleLayout.current = scheduleSize;
    const observer = new ResizeObserver(scheduleSize); observer.observe(host.current);
    const currentTerminalSubscription = (boundedCatchUp = false) => projectionMode
      ? {
        mode: "projection",
        viewportRows: 20,
        fps: 2,
        generation: projectionState?.generation ?? null,
        revision: projectionState?.revision ?? null,
        sizeEpoch: projectionState?.sizeEpoch ?? null,
      }
      : {
        mode: "raw",
        generation: cursor.generation,
        nextOffset: cursor.nextOffset,
        ...(boundedCatchUp ? { maxCatchUpBytes: DOCUMENT_RAW_CATCH_UP_BYTES } : {}),
      };
    const sendSubscription = (includeTerminal: boolean, snapshots = false, boundedCatchUp = false) => {
      const ws = socket.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: "subscribe",
        terminalProtocolVersion: 2,
        tabIds: [tabId],
        snapshots,
        details: true,
        terminals: includeTerminal ? { [tabId]: currentTerminalSubscription(boundedCatchUp) } : {},
      }));
    };
    const requestRawOneShot = () => {
      const ws = socket.current;
      if (projectionMode || ws?.readyState !== WebSocket.OPEN) return;
      if (rawOneShotAttempts >= 2) {
        callbacks.current.onError({ code: "TERMINAL_SCREEN_UNAVAILABLE", message: t("terminal.screenUnavailable") });
        return;
      }
      rawOneShotAttempts += 1;
      awaitingRawOneShot = true;
      // Retire the raw stream first. The following one-shot is generated from
      // the server's parsed screen and carries the matching raw cursor.
      sendSubscription(false);
      ws.send(JSON.stringify({ type: "terminal.screen.snapshot.request", tabId, viewportRows: Math.max(5, Math.min(60, term.rows)), oneShot: true }));
    };
    const requestSync = () => {
      const ws = socket.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      if (projectionMode) {
        ws.send(JSON.stringify({
          type: "terminal.screen.snapshot.request",
          tabId,
          generation: projectionState?.generation ?? null,
          streamId: projectionState?.streamId ?? null,
          revision: projectionState?.revision ?? null,
          sizeEpoch: projectionState?.sizeEpoch ?? null,
          viewportRows: 20,
        }));
      } else {
        ws.send(JSON.stringify({ type: "terminal.sync", tabId, cursor }));
      }
    };
    const handleOutput = (message: any) => {
      if (documentVisibleRef.current) return;
      if (message.catchUpExceeded === true) {
        requestRawOneShot();
        return;
      }
      const generation = String(message.generation ?? "");
      const startOffset = Number(message.startOffset);
      const endOffset = Number(message.endOffset);
      if (!generation || !Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || endOffset < startOffset) return;
      // The settled-frame recognizer is deliberately Codex-specific (input
      // glyph plus model status). Do not hold Claude/Cursor snapshots behind a
      // 20-second fallback while looking for a frame they never render.
      if (providerRef.current === "codex" && endOffset >= 200_000) longTerminal = true;
      let updateSequence: number | null = null;
      if (message.reset || cursor.generation !== generation || cursor.nextOffset === null) {
        if (terminalResetNeedsSettling(providerRef.current, longTerminal, message.reason)) beginTerminalSettling();
        else if (message.reason === "context_compacted") forceFinishTerminalSettling();
        terminalWriteEpoch += 1;
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
      rememberRawTerminal(tabId, generation, endOffset, fresh, Boolean(message.reset) || updateSequence !== null);
      if (fresh.length) {
        if (host.current?.classList.contains("terminal-settling")) {
          if (settlingQuietTimer !== null) { window.clearTimeout(settlingQuietTimer); settlingQuietTimer = null; }
        }
        updateSequence ??= beginTerminalUpdate();
        setHasOutput(true);
        const sequence = updateSequence;
        queueTerminalWrite(fresh, sequence, terminalWriteEpoch);
      } else {
        if (endOffset > 0) setHasOutput(true);
        if (updateSequence !== null) finishTerminalUpdate(updateSequence);
        scheduleTerminalSettled(120);
      }
    };
    const handleScreen = (message: TerminalScreenFrame) => {
      if (documentVisibleRef.current) return;
      const result = applyProjectionFrame(projectionState, message);
      if (result.needsSnapshot) {
        requestSync();
        return;
      }
      if (!result.applied || !result.state) return;
      const reset = message.full;
      if (reset) terminalWriteEpoch += 1;
      projectionState = result.state;
      rememberProjection(tabId, result.state);
      const sequence = beginTerminalUpdate();
      setHasOutput(true);
      queueProjectionWrite(result.state, sequence, terminalWriteEpoch, reset);
    };
    const handleRawOneShot = (message: TerminalScreenFrame) => {
      if (!awaitingRawOneShot || message.oneShot !== true) return;
      const rawNextOffset = Number(message.rawNextOffset);
      const result = applyProjectionFrame(null, message);
      if (!Number.isSafeInteger(rawNextOffset) || rawNextOffset < 0 || !result.applied || !result.state) {
        awaitingRawOneShot = false;
        callbacks.current.onError({ code: "TERMINAL_SCREEN_UNAVAILABLE", message: t("terminal.screenUnavailable") });
        return;
      }
      awaitingRawOneShot = false;
      const state = result.state;
      const bytes = new TextEncoder().encode(projectionScreenToAnsi(state));
      terminalWriteEpoch += 1;
      term.reset();
      term.options.cursorBlink = false;
      cursor.generation = message.generation;
      cursor.nextOffset = rawNextOffset;
      rememberRawTerminal(tabId, message.generation, rawNextOffset, bytes, true);
      setHasOutput(true);
      queueTerminalWrite(bytes, beginTerminalUpdate(), terminalWriteEpoch);
      sendSubscription(true, false, true);
      scheduleSize();
    };
    const connect = () => {
      if (disposed || closedRef.current || !activeRef.current || socket.current?.readyState === WebSocket.OPEN || socket.current?.readyState === WebSocket.CONNECTING) return;
      const ws = new WebSocket(`${protocol}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      socket.current = ws;
      ws.onopen = () => {
        if (disposed || closedRef.current || !activeRef.current) { closeSocketQuietly(ws); return; }
        alarm.noteSuccess();
        setConnected(true);
        const reconnecting = connectedOnce;
        if (!projectionMode && reconnecting) resizeScheduler.invalidate();
        connectedOnce = true;
        // TabView already loaded its bundle over REST. This socket needs the
        // terminal cursor snapshot and live tab events, not a duplicate bundle.
        subscriptionController.current = (documentIsVisible) => {
          if (documentIsVisible) {
            awaitingRawOneShot = false;
            rawOneShotAttempts = 0;
            sendSubscription(false);
          } else if (projectionMode) sendSubscription(true);
          else requestRawOneShot();
        };
        sendSubscription(!documentVisibleRef.current, reconnecting);
        if (!projectionMode && !documentVisibleRef.current) scheduleSize();
      };
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (!projectionMode && message.type === "terminal.output") handleOutput(message);
          else if (!projectionMode && message.type === "terminal.screen" && message.oneShot === true) handleRawOneShot(message as TerminalScreenFrame);
          else if (projectionMode && message.type === "terminal.screen") handleScreen(message as TerminalScreenFrame);
          else if (!projectionMode && message.type === "terminal.lease" && message.tabId === tabId) rawLeaseWritable = message.writable === true;
          else if (message.type === "snapshot" && message.data) callbacks.current.onBundle(message.data as TabBundle);
          else if (["runner.changed", "runtime.changed", "prompts.changed", "answers.changed", "answer.added", "answer.changed", "tab.changed", "terminal.state"].includes(message.type)) {
            callbacks.current.onMessage(message);
            if (message.type === "terminal.state") {
              if (!projectionMode && (message.state === "starting" || message.state === "running")) resizeScheduler.invalidate();
              if (!projectionMode) scheduleSize();
            }
          } else if (message.type === "error" && message.error) {
            if (awaitingRawOneShot && String(message.error.code ?? "").startsWith("TERMINAL_")) awaitingRawOneShot = false;
            if (projectionMode && String(message.error.code ?? "").startsWith("TERMINAL_PROJECTION")) onTerminalPreferenceChange("raw");
            callbacks.current.onError(message.error);
          }
        } catch { /* ignore malformed terminal frames */ }
      };
      // Errors are counted, not announced. The close handler below decides
      // whether the reader needs to know, because only it can tell a drop that
      // reconnects from an outage that does not.
      ws.onerror = () => { /* handled on close */ };
      ws.onclose = () => {
        if (socket.current !== ws) return;
        socket.current = null;
        if (subscriptionController.current) subscriptionController.current = null;
        if (disposed) return;
        setConnected(false);
        if (closedRef.current || !activeRef.current || deliberateCloses.has(ws)) return;
        if (alarm.noteFailure()) callbacks.current.onError({ code: "TERMINAL_WEBSOCKET_FAILED", message: t("terminal.connectionLost") });
        reconnectTimer = window.setTimeout(scheduleConnect, reconnectDelay(alarm.failures()));
      };
    };
    const scheduleConnect = () => {
      if (disposed || connectFrame !== null || closedRef.current || !activeRef.current) return;
      // Let React paint the selected conversation before replaying a large TUI
      // buffer. Otherwise xterm parsing can make the whole page look blank on
      // the first tab switch even though its data has already loaded.
      connectFrame = requestAnimationFrame(() => {
        connectFrame = requestAnimationFrame(() => {
          connectFrame = null;
          connect();
        });
      });
    };
    reconnect.current = scheduleConnect;
    // Repaint from memory immediately: the reader sees the terminal they left
    // rather than a blank pane waiting on a socket, and nothing is refetched.
    if (remembered?.data.length) {
      setHasOutput(true);
      queueTerminalWrite(remembered.data, beginTerminalUpdate(), terminalWriteEpoch);
    } else if (projectionState) {
      setHasOutput(true);
      queueProjectionWrite(projectionState, beginTerminalUpdate(), terminalWriteEpoch, true);
    }
    if (!closedRef.current && activeRef.current) scheduleConnect();
    return () => {
      disposed = true;
      reconnect.current = null;
      subscriptionController.current = null;
      scheduleLayout.current = null;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (connectFrame !== null) cancelAnimationFrame(connectFrame);
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      if (settlingQuietTimer !== null) window.clearTimeout(settlingQuietTimer);
      if (settlingMaxTimer !== null) window.clearTimeout(settlingMaxTimer);
      resizeScheduler.dispose();
      cursorQuietScheduler.dispose();
      terminalWriteSequence += 1;
      observer.disconnect();
      inputDisposable.dispose(); foregroundQuery.dispose(); backgroundQuery.dispose(); colorSchemeQuery.dispose(); cursorBlinkOn.dispose(); cursorBlinkOff.dispose();
      closeSocketQuietly(socket.current); term.dispose(); terminal.current = null; socket.current = null;
    };
  }, [tabId, transportMode]);
  useEffect(() => {
    subscriptionController.current?.(documentVisible);
    if (documentVisible) {
      terminal.current?.blur();
    }
    else if (activeRef.current) scheduleLayout.current?.();
  }, [documentVisible]);
  useEffect(() => {
    if (active && documentVisible && documentState.status === "open" && documentState.nextChunkIndex === 0 && !documentState.complete) {
      void documentLoader.loadNext(true);
    }
  }, [active, documentLoader, documentState.complete, documentState.documentEpoch, documentState.nextChunkIndex, documentState.status, documentVisible]);
  const lastDocumentError = useRef<string | null>(null);
  useEffect(() => {
    if (documentState.status !== "error" || documentState.docId || !documentState.error) return;
    const key = `${documentState.documentEpoch}:${documentState.error.message}`;
    if (lastDocumentError.current === key) return;
    lastDocumentError.current = key;
    onError(documentState.error);
  }, [documentState, onError]);
  useEffect(() => {
    if (!active) {
      closeSocketQuietly(socket.current);
      setConnected(false);
      terminal.current?.blur();
      return;
    }
    reconnect.current?.();
    const frame = requestAnimationFrame(() => {
      scheduleLayout.current?.();
      const term = terminal.current;
      if (term) term.refresh(0, Math.max(0, term.rows - 1));
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  useEffect(() => { if (runnerBusy) terminal.current?.blur(); }, [runnerBusy]);
  useEffect(() => {
    themeRef.current = theme;
    if (terminal.current) terminal.current.options.theme = getTerminalTheme(theme);
  }, [theme]);
  useEffect(() => {
    closedRef.current = closed;
    if (closed) {
      closeSocketQuietly(socket.current);
      setConnected(false);
    } else reconnect.current?.();
  }, [closed]);
  const placeholder = t(runtime.terminal.state === "stopped" ? "terminal.notStarted" : runtime.terminal.state === "starting" ? "terminal.startingHelp" : runtime.terminal.state === "running" ? "terminal.runningHelp" : runtime.terminal.state === "error" ? "terminal.failedHelp" : "terminal.exitedHelp");
  const terminalProvider = provider === "claude" ? t("provider.claude") : provider === "cursor" ? t("provider.cursor") : provider === "shell" ? t("provider.shell") : t("provider.codex");
  return <div className={`terminal-card ${closed ? "locked" : ""} ${runnerBusy ? "runner-busy" : ""} ${documentVisible ? "document-open" : ""}`}>
    <div className="terminal-heading">
      <span><i className={`status-dot ${runtime.terminal.state === "running" ? "running" : runtime.terminal.state === "error" ? "error" : ""}`} />PowerShell / {terminalProvider}</span>
      <span className="terminal-meta">
        <label className="terminal-mode-control" title={t("terminal.transportHelp")}>
          <span className="sr-only">{t("terminal.transport")}</span>
          <select aria-label={t("terminal.transport")} value={terminalPreference} onChange={(event) => onTerminalPreferenceChange(event.currentTarget.value as TerminalTransportPreference)}>
            <option value="auto">{t("terminal.transportAuto")}</option>
            <option value="projection" disabled={!projectionSupported}>{t("terminal.transportProjection")}</option>
            <option value="raw">{t("terminal.transportRaw")}</option>
          </select>
        </label>
        <span className={`terminal-mode-badge ${transportMode}`}>{t(transportMode === "projection" ? "terminal.modeProjection" : "terminal.modeRaw")}</span>
        <i className={`connection-dot ${connected ? "connected" : ""}`} />{t(closed ? "terminal.inputDisabled" : connected ? "terminal.inputConnected" : "terminal.inputConnecting")}<b>{closed ? t("terminal.closed") : terminalStateLabel(i18n, runtime.terminal.state)}</b>
      </span>
    </div>
    {runtime.terminal.lastError && <div className="terminal-error">{i18n.errorText(runtime.terminal.lastError)}</div>}
    <div className={`terminal-body ${theme} ${transportMode} ${closed ? "locked" : ""}`} onMouseDown={() => { if (!closed && !documentVisible) terminal.current?.focus(); }}><div className={`terminal-host ${documentVisible ? "document-hidden" : ""}`} ref={host} />{documentVisible ? <DocumentView state={documentState} loader={documentLoader} onClose={() => documentLoader.close()} /> : <><div className="terminal-settling-overlay" role="status"><span className="terminal-settling-spinner" />{t("terminal.settling")}</div>{!hasOutput && <div className="terminal-placeholder">{closed ? t("terminal.closedPlaceholder") : placeholder}</div>}</>}</div>
  </div>;
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

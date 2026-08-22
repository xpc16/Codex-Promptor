import {
  useCallback,
  useEffect,
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
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const token = new URLSearchParams(location.search).get("token") ?? "";

async function api<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-codex-promptor-token", token);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload.data as T;
}

function jsonBody(value: unknown): RequestInit { return { method: "POST", body: JSON.stringify(value) }; }

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
  const [error, setError] = useState<string | null>(null);
  const [viewNonce, setViewNonce] = useState(0);
  const [consoleWidth, setConsoleWidth] = useState(300);
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const consoleDragging = useRef(false);
  const consoleWidthRef = useRef(300);
  const navigationBusy = useRef(false);
  const dragItem = useRef<{ type: "group" | "tab"; id: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ index: IndexFile; app: any }>("/api/bootstrap");
      setIndex(data.index);
      setService(data.app);
      if (!consoleDragging.current) {
        consoleWidthRef.current = data.index.ui.consoleWidth;
        setConsoleWidth(data.index.ui.consoleWidth);
      }
      setSelectedId((current) => current && data.index.tabs.some((tab) => tab.id === current) ? current : data.index.tabs[0]?.id ?? null);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (index) document.documentElement.dataset.theme = index.ui.theme; }, [index?.ui.theme]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const updatePreferences = useCallback(async (patch: Partial<IndexFile["ui"]>) => {
    setIndex((current) => current ? { ...current, ui: { ...current.ui, ...patch } } : current);
    try { setIndex(await api<IndexFile>("/api/preferences", { method: "PATCH", body: JSON.stringify(patch) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); await refresh(); }
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
    try { const tab = await api<TabMeta>("/api/tabs", jsonBody({ name: "新对话" })); await refresh(); setSelectedId(tab.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
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
      setError(reason instanceof Error ? reason.message : String(reason));
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
      setError(reason instanceof Error ? reason.message : String(reason));
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
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); await refresh(); }
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
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const reloadSelected = async () => { await refresh(); setViewNonce((value) => value + 1); };
  const syncSelected = async () => {
    if (!selected?.session.threadId) return;
    try { await api(`/api/tabs/${selected.id}/history/sync`, { method: "POST" }); await reloadSelected(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  if (!index) return <div className="loading-screen"><div className="orb" /><p>{error ?? "正在打开 Promptor…"}</p><button onClick={() => void refresh()}>重试</button></div>;

  return <div className="app-shell" style={{ gridTemplateColumns: `${consoleWidth}px 7px minmax(0, 1fr)` }}>
    <aside className="sidebar" aria-label="控制台栏">
      <div className="brand"><div className="brand-mark">✦</div><div><strong>Promptor</strong><span>Codex 控制台</span></div></div>
      <div className="sidebar-actions"><button className="primary small" onClick={() => void createTab()}>＋ 新建对话</button><button className="icon-button" title="新建分组" onClick={() => setDialog({ kind: "group" })}>＋组</button></div>
      <div className="tab-tree">
        {groups.map((group) => {
          const groupTabs = index.tabs.filter((tab) => tab.groupId === group.id).sort((a, b) => a.order - b.order);
          return <div className="group" key={group.id}>
            <div className="group-heading" draggable onDragStart={() => { dragItem.current = { type: "group", id: group.id }; }} onDragEnd={() => { dragItem.current = null; }} onDragEnter={(event) => { event.preventDefault(); if (dragItem.current?.type === "group") moveGroup(dragItem.current.id, group.id); else if (dragItem.current?.type === "tab" && groupTabs.length === 0) moveTab(dragItem.current.id, null, group.id); }}>
              <button className="collapse-button" aria-label={group.collapsed ? `展开 ${group.name}` : `折叠 ${group.name}`} onClick={() => void toggleGroup(group)}>{group.collapsed ? "▸" : "▾"}</button><span className="group-drag" title="拖动分组排序">⠿</span><span className="group-name">{group.name}</span><em>{groupTabs.length}</em><button className="rename-button" aria-label={`重命名分组 ${group.name}`} onClick={() => setDialog({ kind: "rename-group", groupId: group.id, initialValue: group.name })}>✎</button><button className="row-delete-button" aria-label={`删除分组 ${group.name}`} title="删除分组，对话移到未分组" onMouseDown={(event) => event.stopPropagation()} onClick={() => setDialog({ kind: "delete-group", groupId: group.id, name: group.name, tabCount: groupTabs.length })}>×</button>
            </div>
            {!group.collapsed && groupTabs.map((tab) => <ConsoleTabRow key={tab.id} tab={tab} selected={tab.id === selectedId} onClick={() => setSelectedId(tab.id)} onRename={() => setDialog({ kind: "rename-tab", tabId: tab.id, initialValue: tab.name })} onDelete={() => setDialog({ kind: "delete-tab", tabId: tab.id, name: tab.name })} onDragStart={() => { dragItem.current = { type: "tab", id: tab.id }; }} onDragEnd={() => { dragItem.current = null; }} onDragEnter={() => { if (dragItem.current?.type === "tab") moveTab(dragItem.current.id, tab.id, group.id); }} />)}
          </div>;
        })}
        <div className="group ungrouped-group">
          <div className="group-heading" onDragEnter={(event) => { event.preventDefault(); if (dragItem.current?.type === "tab" && ungrouped.length === 0) moveTab(dragItem.current.id, null, null); }}>
            <button className="collapse-button" aria-label={index.ui.ungroupedCollapsed ? "展开未分组" : "折叠未分组"} onClick={() => void updatePreferences({ ungroupedCollapsed: !index.ui.ungroupedCollapsed })}>{index.ui.ungroupedCollapsed ? "▸" : "▾"}</button><span className="group-name">未分组</span><em>{ungrouped.length}</em>
          </div>
          {!index.ui.ungroupedCollapsed && ungrouped.map((tab) => <ConsoleTabRow key={tab.id} tab={tab} selected={tab.id === selectedId} onClick={() => setSelectedId(tab.id)} onRename={() => setDialog({ kind: "rename-tab", tabId: tab.id, initialValue: tab.name })} onDelete={() => setDialog({ kind: "delete-tab", tabId: tab.id, name: tab.name })} onDragStart={() => { dragItem.current = { type: "tab", id: tab.id }; }} onDragEnd={() => { dragItem.current = null; }} onDragEnter={() => { if (dragItem.current?.type === "tab") moveTab(dragItem.current.id, tab.id, null); }} />)}
        </div>
        {!groups.length && !ungrouped.length && <div className="empty-sidebar">还没有对话<br /><span>从上方新建一个对话标签</span></div>}
      </div>
      <div className="sidebar-footer">
        {selected && <label className="footer-select"><span>当前对话分组</span><select value={selected.groupId ?? ""} onChange={(event) => moveTab(selected.id, null, event.target.value || null)}><option value="">未分组</option>{groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label>}
        <div className="footer-actions"><button className="ghost" onClick={() => void reloadSelected()}>↻ 刷新</button><button className="ghost" disabled={!selected?.session.threadId || selected.session.state === "closed"} onClick={() => void syncSelected()}>同步历史</button></div>
        <button className="theme-toggle" onClick={() => void updatePreferences({ theme: index.ui.theme === "light" ? "dark" : "light" })}><span>{index.ui.theme === "light" ? "☾" : "☀"}</span>{index.ui.theme === "light" ? "切换深色模式" : "切换浅色模式"}</button>
        <div className="service-status" title={`Codex App Server: ${service?.codex?.state ?? "starting"}`}><span className={`status-dot ${service?.codex?.state === "ready" ? "ready" : service?.codex?.state === "error" ? "error" : ""}`} />Codex App Server <time className="muted">{formatClock(clock)}</time></div>
      </div>
    </aside>
    <div className="console-splitter" role="separator" aria-label="调整控制台栏宽度" onMouseDown={() => { consoleDragging.current = true; }} />
    <main className="workspace" aria-label="对话页">
      {error && <div className="toast error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {selected ? <TabView key={`${selected.id}-${viewNonce}`} tab={selected} theme={index.ui.theme} onChanged={refresh} onError={setError} /> : <Welcome onCreate={() => void createTab()} />}
    </main>
    {dialog && (dialog.kind === "delete-tab" || dialog.kind === "delete-group" ? <ConfirmDialog
      title={dialog.kind === "delete-tab" ? "删除对话" : "删除分组"}
      message={dialog.kind === "delete-tab" ? `确定删除“${dialog.name}”吗？数据将移入 data/trash，可手工恢复。` : `确定删除分组“${dialog.name}”吗？其中 ${dialog.tabCount} 个对话会移到“未分组”，不会删除对话数据。`}
      confirmLabel="删除"
      onCancel={() => setDialog(null)}
      onConfirm={confirmDelete}
    /> : <TextDialog
      key={dialog.kind === "group" ? "group" : dialog.kind === "rename-tab" ? `rename-tab-${dialog.tabId}` : `rename-group-${dialog.groupId}`}
      title={dialog.kind === "group" ? "新建分组" : dialog.kind === "rename-tab" ? "重命名对话" : "重命名分组"}
      label={dialog.kind === "rename-tab" ? "对话名称" : "分组名称"}
      initialValue={dialog.kind === "group" ? "新分组" : dialog.initialValue}
      confirmLabel={dialog.kind === "group" ? "创建" : "保存"}
      onCancel={() => setDialog(null)}
      onConfirm={submitDialog}
    />)}
  </div>;
}

function ConfirmDialog({ title, message, confirmLabel, onCancel, onConfirm }: { title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => Promise<void> }) {
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
      <div className="dialog-actions"><button type="button" className="ghost" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="danger-action" disabled={busy} onClick={() => void confirm()}>{busy ? "处理中…" : confirmLabel}</button></div>
    </div>
  </div>;
}

function TextDialog({ title, label, initialValue, confirmLabel, multiline = false, onCancel, onConfirm }: { title: string; label: string; initialValue: string; confirmLabel: string; multiline?: boolean; onCancel: () => void; onConfirm: (value: string) => Promise<void> }) {
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
      <div className="dialog-actions"><button type="button" className="ghost" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className="primary" disabled={busy || !value.trim()}>{busy ? "处理中…" : confirmLabel}</button></div>
    </form>
  </div>;
}

function ConsoleTabRow({ tab, selected, onClick, onRename, onDelete, onDragStart, onDragEnd, onDragEnter }: { tab: TabMeta; selected: boolean; onClick: () => void; onRename: () => void; onDelete: () => void; onDragStart: () => void; onDragEnd: () => void; onDragEnter: () => void }) {
  const state = tab.session.state;
  return <div className={`tab-row ${selected ? "selected" : ""}`} draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onDragEnter={(event) => { event.preventDefault(); onDragEnter(); }}>
    <span className="console-drag" title="拖动对话排序或移动分组">⠿</span><button className="tab-button" onClick={onClick} onDoubleClick={onRename}><span className={`tab-dot ${state}`} /><span className="tab-label">{tab.name}</span><span className="tab-state">{state === "ready" ? "●" : state === "closed" ? "■" : state === "error" ? "!" : ""}</span></button><button className="rename-button" aria-label={`重命名对话 ${tab.name}`} onClick={onRename}>✎</button><button className="row-delete-button" aria-label={`删除对话 ${tab.name}`} onMouseDown={(event) => event.stopPropagation()} onClick={onDelete}>×</button>
  </div>;
}

function Welcome({ onCreate }: { onCreate: () => void }) {
  return <div className="welcome"><div className="welcome-icon">✦</div><h1>把一组 prompt 交给 Codex</h1><p>每个对话标签绑定独立的工作路径与 Codex thread。执行队列和 PowerShell 终端分别保留自动化与手工控制能力。</p><button className="primary" onClick={onCreate}>开始一个新对话</button></div>;
}

function TabView({ tab, theme, onChanged, onError }: { tab: TabMeta; theme: "light" | "dark"; onChanged: () => void; onError: (message: string) => void }) {
  const [bundle, setBundle] = useState<TabBundle | null>(null);
  const [leftWidth, setLeftWidth] = useState(tab.layout.leftWidthPercent);
  const dragging = useRef(false);
  const [reopening, setReopening] = useState(false);
  const load = useCallback(async () => {
    try { setBundle(await api<TabBundle>(`/api/tabs/${tab.id}`)); }
    catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
  }, [tab.id, onError]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const move = (event: MouseEvent) => { if (!dragging.current) return; const rect = document.querySelector(".tab-workspace")?.getBoundingClientRect(); if (!rect) return; setLeftWidth(Math.max(24, Math.min(76, ((event.clientX - rect.left) / rect.width) * 100))); };
    const up = () => { if (!dragging.current) return; dragging.current = false; void api(`/api/tabs/${tab.id}`, { method: "PATCH", body: JSON.stringify({ layout: { leftWidthPercent: leftWidth } }) }).catch(() => undefined); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [leftWidth, tab.id]);
  if (!bundle) return <div className="loading-pane"><div className="spinner" />读取对话数据…</div>;
  const closed = bundle.tab.session.state === "closed";
  const reopen = async () => {
    if (reopening) return;
    setReopening(true);
    try { await api(`/api/tabs/${tab.id}/terminal/reopen`, { method: "POST" }); await load(); onChanged(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setReopening(false); }
  };
  return <div className={`tab-view ${closed ? "conversation-closed" : ""}`}><div className="tab-workspace" style={{ gridTemplateColumns: `${leftWidth}fr 7px ${100 - leftWidth}fr` }}>
    <section className="conversation-pane"><SessionPanel bundle={bundle} reopening={reopening} onReopen={reopen} onChanged={() => { void load(); onChanged(); }} onError={onError} /><AnswerHistory answers={bundle.answers.answers} /></section>
    <div className={`splitter ${closed ? "disabled" : ""}`} onMouseDown={() => { if (!closed) dragging.current = true; }} title={closed ? "对话关闭时不能调整布局" : "拖动调整对话页左右栏宽度"} />
    <section className="queue-pane"><PromptQueue bundle={bundle} disabled={closed} onChanged={() => void load()} onError={onError} /><TerminalPanel tabId={tab.id} runtime={bundle.runtime} theme={theme} closed={closed} onChanged={load} onError={onError} /></section>
  </div></div>;
}

function orderedTabIds(tabs: TabMeta[], groupId: string | null): string[] {
  return tabs.filter((tab) => tab.groupId === groupId).sort((a, b) => a.order - b.order).map((tab) => tab.id);
}

function SessionPanel({ bundle, reopening, onReopen, onChanged, onError }: { bundle: TabBundle; reopening: boolean; onReopen: () => Promise<void>; onChanged: () => void; onError: (message: string) => void }) {
  const [cwd, setCwd] = useState(bundle.tab.session.workingDirectory ?? "");
  const [mode, setMode] = useState<"new" | "resume">("new");
  const [resumeId, setResumeId] = useState("");
  const [busy, setBusy] = useState(false);
  const session = bundle.tab.session;
  const connected = session.state === "ready" || session.state === "closed";
  const connect = async () => {
    setBusy(true);
    try { await api(`/api/tabs/${bundle.tab.id}/session`, jsonBody({ mode, workingDirectory: cwd, resumeId })); onChanged(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const browse = async () => { try { const result = await api<{ path: string | null }>("/api/dialog/select-directory", jsonBody({})); if (result.path) setCwd(result.path); } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); } };
  const closeConversation = async () => { try { setBusy(true); await api(`/api/tabs/${bundle.tab.id}/session/close`, { method: "POST" }); onChanged(); } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  return <div className="session-card">
    <div className="section-title"><span className="section-icon">◌</span><div><strong>{session.state === "ready" ? "Codex 对话已连接" : session.state === "closed" ? "Codex 对话已关闭" : "连接一个 Codex 对话"}</strong><small>{connected ? "队列使用此 thread；PowerShell TUI 连接同一个 App Server" : "选择工作目录，然后新建或恢复 session"}</small></div></div>
    {connected ? <div className="session-ready">{session.state === "closed" && <div className="closed-notice" role="status">对话已关闭。内容仍可查看，队列和终端操作已停用。</div>}<div className="session-path"><span>工作路径</span><code>{session.workingDirectory}</code></div><div className="session-ids"><div><span>thread id</span><code>{session.threadId}</code></div><div><span>session id</span><code>{session.sessionId}</code></div></div><div className="session-actions"><button className="ghost" disabled={busy || reopening} onClick={() => void onReopen()}>{reopening ? "正在恢复…" : "重新打开终端"}</button>{session.state === "ready" && <button className="danger-action" disabled={busy} onClick={() => void closeConversation()}>{busy ? "正在关闭…" : "关闭对话"}</button>}</div></div> : <>
      <label className="field-label">本地工作路径</label><div className="path-row"><input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="例如 D:\\work\\project" /><button className="ghost" onClick={() => void browse()}>选择文件夹</button></div>
      <div className="mode-switch"><button className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>创建新对话</button><button className={mode === "resume" ? "active" : ""} onClick={() => setMode("resume")}>继续旧对话</button></div>
      {mode === "resume" && <input className="resume-input" value={resumeId} onChange={(event) => setResumeId(event.target.value)} placeholder="粘贴 session / thread id" />}
      <button className="primary connect" disabled={busy || !cwd.trim()} onClick={() => void connect()}>{busy ? "正在连接…" : "确定并打开 Codex"}</button>
    </>}
    {session.lastError && <div className="inline-error">{session.lastError.message}</div>}
  </div>;
}

function AnswerHistory({ answers }: { answers: AnswerRecord[] }) {
  return <div className="answers"><div className="answers-heading"><span>Final answers</span><em>{answers.length}</em></div><div className="answer-scroll">{answers.length === 0 ? <div className="empty-answers">完成的 final answer 会持续记录在这里。</div> : <div className="answer-list">{answers.map((answer) => <article className="answer-card" key={answer.id}><div className="answer-meta"><span>{answer.origin === "imported" ? "历史导入" : answer.origin === "manual" ? "手工对话" : "队列"}</span><time>{formatTime(answer.completedAt)}</time></div><div className="answer-prompt">{answer.prompt}</div><div className="markdown"><ReactMarkdown rehypePlugins={[rehypeSanitize]}>{answer.finalAnswer}</ReactMarkdown></div></article>)}</div>}</div></div>;
}

function PromptQueue({ bundle, disabled, onChanged, onError }: { bundle: TabBundle; disabled: boolean; onChanged: () => void; onError: (message: string) => void }) {
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);
  const [insertBeforeId, setInsertBeforeId] = useState<string | null>(null);
  const nativeDragSource = useRef<string | null>(null);
  const reorderInFlight = useRef(false);
  const prompts = bundle.prompts.prompts;
  const runtime = bundle.runtime;
  const add = async () => {
    const text = newText.trim();
    if (!text || adding || disabled) return;
    setAdding(true);
    try { await api(`/api/tabs/${bundle.tab.id}/prompts`, jsonBody({ text })); setNewText(""); onChanged(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAdding(false); }
  };
  const reorder = async (sourceId: string, targetId: string) => {
    if (disabled || !sourceId || sourceId === targetId || reorderInFlight.current) return;
    const ids = reorderPromptIds(prompts.filter((item) => item.status === "pending").map((item) => item.id), sourceId, targetId);
    if (!ids) return;
    reorderInFlight.current = true;
    try { await api(`/api/tabs/${bundle.tab.id}/prompts/order`, { method: "PUT", body: JSON.stringify({ promptIds: ids }) }); onChanged(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { reorderInFlight.current = false; nativeDragSource.current = null; }
  };
  const insertBefore = async (value: string) => {
    if (!insertBeforeId || disabled) return;
    try { await api(`/api/tabs/${bundle.tab.id}/prompts`, jsonBody({ text: value, beforeId: insertBeforeId })); setInsertBeforeId(null); onChanged(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); throw reason; }
  };
  const pendingIds = prompts.filter((item) => item.status === "pending").map((item) => item.id);
  return <div className="queue-card"><div className="queue-heading"><div><div className="eyebrow">Prompt list</div><h3>执行队列 <span>{prompts.filter((item) => item.status === "completed").length}/{prompts.length}</span></h3></div></div>
    <div className="runner-status"><span className={`status-dot ${runtime.runner.state === "running" ? "running" : runtime.runner.state === "error" ? "error" : ""}`} />{runnerLabel(runtime)}{runtime.runner.lastError && <span className="runner-error">· {runtime.runner.lastError.message}</span>}</div>
    <div className="prompt-list">{prompts.length === 0 && <div className="empty-prompts">添加第一条 prompt，开始你的批处理。</div>}{prompts.map((prompt, index) => { const pendingIndex = pendingIds.indexOf(prompt.id); return <PromptRow key={prompt.id} prompt={prompt} index={index} tabId={bundle.tab.id} locked={disabled} onDrop={reorder} onNativeDragStart={(sourceId) => { nativeDragSource.current = sourceId; }} onNativeDragEnter={(targetId) => { if (nativeDragSource.current) void reorder(nativeDragSource.current, targetId); }} onInsert={() => { if (!disabled) setInsertBeforeId(prompt.id); }} canMoveUp={pendingIndex > 0} canMoveDown={pendingIndex >= 0 && pendingIndex < pendingIds.length - 1} onMove={(direction) => { const target = pendingIds[pendingIndex + direction]; if (target) void reorder(prompt.id, target); }} onChanged={onChanged} onError={onError} />; })}</div>
    <div className="add-prompt"><textarea disabled={disabled} value={newText} onChange={(event) => setNewText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void add(); } }} placeholder={disabled ? "对话已关闭，重新打开后可添加 prompt" : "输入 prompt…（Enter 添加，Shift + Enter 换行）"} /><button className="primary" disabled={disabled || adding || !newText.trim()} onClick={() => void add()}>{adding ? "添加中…" : "添加"}</button></div>
    {insertBeforeId && <TextDialog title="插入 prompt" label="Prompt 内容" initialValue="" confirmLabel="插入" multiline onCancel={() => setInsertBeforeId(null)} onConfirm={insertBefore} />}
  </div>;
}

function PromptRow({ prompt, index, tabId, locked, onDrop, onNativeDragStart, onNativeDragEnter, onInsert, canMoveUp, canMoveDown, onMove, onChanged, onError }: { prompt: PromptRecord; index: number; tabId: string; locked: boolean; onDrop: (sourceId: string, targetId: string) => void; onNativeDragStart: (sourceId: string | null) => void; onNativeDragEnter: (targetId: string) => void; onInsert: () => void; canMoveUp: boolean; canMoveDown: boolean; onMove: (direction: -1 | 1) => void; onChanged: () => void; onError: (message: string) => void }) {
  const editable = !locked && !["completed", "running", "dispatching"].includes(prompt.status);
  const [text, setText] = useState(prompt.text);
  const [editing, setEditing] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setText(prompt.text); setEditing(false); }, [prompt.text, prompt.status]);
  const beginEdit = () => { if (!editable) return; setEditing(true); requestAnimationFrame(() => { editor.current?.focus(); editor.current?.select(); }); };
  const save = async () => {
    if (!editable) return;
    if (!text.trim()) { onError("Prompt 不能为空"); return; }
    if (text.trim() === prompt.text) { setEditing(false); return; }
    try { await api(`/api/tabs/${tabId}/prompts/${prompt.id}`, { method: "PATCH", body: JSON.stringify({ text }) }); setEditing(false); onChanged(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const remove = async () => { try { await api(`/api/tabs/${tabId}/prompts/${prompt.id}`, { method: "DELETE" }); onChanged(); } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); } };
  const retry = async () => { try { await api(`/api/tabs/${tabId}/prompts/${prompt.id}/retry`, jsonBody({})); onChanged(); } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); } };
  const skip = async () => { try { await api(`/api/tabs/${tabId}/prompts/${prompt.id}/skip`, jsonBody({})); onChanged(); } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); } };
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
  return <div className={`prompt-row ${prompt.status} ${locked ? "locked" : ""}`} data-prompt-id={prompt.id} draggable={pending && !editing} onMouseDown={mouseDown} onDragStart={nativeDragStart} onDragEnd={() => onNativeDragStart(null)} onDragEnter={(event) => { if (pending) { event.preventDefault(); onNativeDragEnter(prompt.id); } }} onDragOver={(event) => { if (pending) event.preventDefault(); }}><div className="prompt-index">{prompt.status === "completed" ? "✓" : index + 1}</div><div className={`drag-handle ${pending ? "enabled" : ""}`} title={pending ? "拖动排序" : undefined} onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={(event) => event.currentTarget.classList.remove("dragging")}>⠿</div><textarea ref={editor} value={text} disabled={!editable} readOnly={!editing} className={editing ? "editing" : ""} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void save(); } }} rows={Math.min(5, Math.max(1, text.split("\n").length))} /><div className="prompt-side"><span className="prompt-status">{prompt.status === "completed" && prompt.completedAt && <time>{formatTime(prompt.completedAt)}</time>}<span>{statusLabel(prompt.status)}</span></span>{pendingStatus && <button className="link-button" disabled={locked} onClick={() => editing ? void save() : beginEdit()}>{editing ? "保存" : "编辑"}</button>}{pendingStatus && <span className="move-buttons"><button aria-label="上移" title="上移" disabled={locked || !canMoveUp} onClick={() => onMove(-1)}>↑</button><button aria-label="下移" title="下移" disabled={locked || !canMoveDown} onClick={() => onMove(1)}>↓</button></span>}<button className="link-button" disabled={locked} onClick={onInsert}>插入</button>{prompt.status === "failed" || prompt.status === "interrupted" ? <><button className="link-button" disabled={locked} onClick={() => void retry()}>重试</button><button className="link-button" disabled={locked} onClick={() => void skip()}>跳过</button></> : editable && <button className="delete-button" aria-label="删除 prompt" onClick={() => void remove()}>×</button>}</div></div>;
}

function TerminalPanel({ tabId, runtime, theme, closed, onChanged, onError }: { tabId: string; runtime: RuntimeFile; theme: "light" | "dark"; closed: boolean; onChanged: () => void; onError: (message: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const reconnect = useRef<(() => void) | null>(null);
  const closedRef = useRef(closed);
  const themeRef = useRef(theme);
  const callbacks = useRef({ onChanged, onError });
  const [connected, setConnected] = useState(false);
  const [hasOutput, setHasOutput] = useState(false);
  closedRef.current = closed;
  themeRef.current = theme;
  callbacks.current = { onChanged, onError };
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let reconnectTimer: number | null = null;
    let resizeFrame: number | null = null;
    const decoder = new TextDecoder();
    const cursor: { generation: string | null; nextOffset: number | null } = { generation: null, nextOffset: null };
    let lastSentSize: { cols: number; rows: number } | null = null;
    const term = new Terminal({ cursorBlink: false, cursorStyle: "block", cursorInactiveStyle: "outline", fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 14, lineHeight: 1.18, theme: getTerminalTheme(themeRef.current), scrollback: 5000, allowProposedApi: false });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); terminal.current = term;
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
      if (message.reset || cursor.generation !== generation || cursor.nextOffset === null) {
        term.reset();
        term.options.cursorBlink = false;
        cursor.generation = generation;
        cursor.nextOffset = startOffset;
        setHasOutput(false);
      }
      if (cursor.generation !== generation) { requestSync(); return; }
      if (startOffset > cursor.nextOffset!) { requestSync(); return; }
      if (endOffset <= cursor.nextOffset!) return;
      const bytes = Uint8Array.from(atob(String(message.dataBase64 ?? "")), (char) => char.charCodeAt(0));
      const overlap = Math.max(0, cursor.nextOffset! - startOffset);
      const fresh = bytes.subarray(Math.min(overlap, bytes.length));
      cursor.nextOffset = endOffset;
      if (fresh.length) {
        setHasOutput(true);
        term.write(decoder.decode(fresh, { stream: true }), () => { term.options.cursorBlink = false; });
      } else if (endOffset > 0) setHasOutput(true);
    };
    const connect = () => {
      if (disposed || closedRef.current || socket.current?.readyState === WebSocket.OPEN || socket.current?.readyState === WebSocket.CONNECTING) return;
      const ws = new WebSocket(`${protocol}://${location.host}/ws?token=${encodeURIComponent(token)}`);
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
          }
        } catch { /* ignore malformed terminal frames */ }
      };
      ws.onerror = () => { if (!closedRef.current) callbacks.current.onError("终端 WebSocket 连接失败"); };
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
      observer.disconnect();
      inputDisposable.dispose(); foregroundQuery.dispose(); backgroundQuery.dispose(); colorSchemeQuery.dispose(); cursorBlinkOn.dispose(); cursorBlinkOff.dispose();
      socket.current?.close(); term.dispose(); terminal.current = null; socket.current = null;
    };
  }, [tabId]);
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
  const placeholder = runtime.terminal.state === "stopped" ? "终端尚未启动" : runtime.terminal.state === "starting" ? "正在启动 PowerShell / Codex…" : runtime.terminal.state === "running" ? "等待终端输出…点击此区域后可直接输入" : runtime.terminal.state === "error" ? "终端启动失败，请重新打开" : "终端已退出，可点击“重新打开终端”";
  return <div className={`terminal-card ${closed ? "locked" : ""}`}><div className="terminal-heading"><span><i className={`status-dot ${runtime.terminal.state === "running" ? "running" : runtime.terminal.state === "error" ? "error" : ""}`} />PowerShell / Codex</span><span className="terminal-meta"><i className={`connection-dot ${connected ? "connected" : ""}`} />{closed ? "输入已停用" : connected ? "输入通道已连接" : "正在连接输入通道"}<b>{closed ? "已关闭" : terminalStateLabel(runtime.terminal.state)}</b></span></div>{runtime.terminal.lastError && <div className="terminal-error">{runtime.terminal.lastError.message}</div>}<div className={`terminal-body ${theme} ${closed ? "locked" : ""}`} onMouseDown={() => { if (!closed) terminal.current?.focus(); }}><div className="terminal-host" ref={host} />{!hasOutput && <div className="terminal-placeholder">{closed ? "对话已关闭，终端输入不可用" : placeholder}</div>}</div></div>;
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

function runnerLabel(runtime: RuntimeFile) { return ({ paused: "已暂停", starting: "正在启动", waiting_for_thread: "等待当前对话结束", dispatching: "发送下一条 prompt", running: "Codex 正在回答", waiting_for_prompt: "等待新的 prompt", pausing: "当前轮结束后暂停", error: "队列出错" } as Record<string, string>)[runtime.runner.state] ?? runtime.runner.state; }
function statusLabel(status: PromptRecord["status"]) { return ({ pending: "待执行", dispatching: "发送中", running: "执行中", completed: "已完成", failed: "失败", interrupted: "已中断", skipped: "已跳过" } as Record<string, string>)[status]; }
function terminalStateLabel(state: RuntimeFile["terminal"]["state"]) { return ({ stopped: "未启动", starting: "正在启动", running: "运行中", exited: "已退出", error: "启动失败" } as Record<string, string>)[state]; }
function formatTime(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "时间未知"; }
function formatClock(value: Date) { return value.toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }

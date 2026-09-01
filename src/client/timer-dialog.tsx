import { useCallback, useEffect, useRef, useState } from "react";
import type { Timer, TimerFile, TimerPromptTemplate } from "../shared/schemas.js";
import { apiResponse } from "./api-client.js";
import { useI18n } from "./i18n.js";
import { ModalShell } from "./modal-shell.js";

type Editor = {
  id: string | null;
  title: string;
  enabled: boolean;
  policy: "priority" | "after_running_queue";
  kind: "once" | "weekly" | "interval";
  onceAt: string;
  weeklyDays: number[];
  weeklyTime: string;
  startDate: string;
  endDate: string;
  every: number;
  unit: "hours" | "days";
  anchorAt: string;
  intervalEnd: string;
  prompts: TimerPromptTemplate[];
  bindToCurrentThread: boolean;
};

const NEW_TIMER_DRAFT = "__new__";
const timerEditorDrafts = new Map<string, Editor>();
const timerEditorSelections = new Map<string, string | null>();

export function TimerDialog({ open, tabId, sessionReady, currentThreadId, provider, onClose, onError }: {
  open: boolean;
  tabId: string;
  sessionReady: boolean;
  currentThreadId: string | null;
  provider: string;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const i18n = useI18n();
  const c = i18n.locale === "zh-CN" ? zh : en;
  const [file, setFile] = useState<TimerFile | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(() => newEditor());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dragTemplateId, setDragTemplateId] = useState<string | null>(null);
  const runKeys = useRef(new Map<string, string>());

  const selectTimer = useCallback((timer: Timer) => {
    const draft = timerEditorDrafts.get(timerDraftKey(tabId, timer.id));
    timerEditorSelections.set(tabId, timer.id);
    setEditor(draft ?? editorFromTimer(timer));
    setDirty(Boolean(draft));
  }, [tabId]);
  const selectNew = useCallback(() => {
    const draft = timerEditorDrafts.get(timerDraftKey(tabId, null));
    timerEditorSelections.set(tabId, null);
    setEditor(draft ?? newEditor());
    setDirty(Boolean(draft));
  }, [tabId]);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiResponse<TimerFile>(`/api/tabs/${tabId}/timers`, {
        headers: etag ? { "If-None-Match": etag } : undefined,
        cache: "no-cache",
      });
      if (response.data) {
        setFile(response.data);
        const hasSelection = timerEditorSelections.has(tabId);
        const selectedId = timerEditorSelections.get(tabId);
        const current = selectedId ? response.data.timers.find((timer) => timer.id === selectedId) : undefined;
        if (current) selectTimer(current);
        else if (hasSelection && selectedId === null) selectNew();
        else if (response.data.timers[0]) selectTimer(response.data.timers[0]);
        else selectNew();
      }
      if (response.etag) setEtag(response.etag);
    } catch (error) { onError(error); }
    finally { setLoading(false); }
  }, [etag, onError, selectNew, selectTimer, tabId]);
  useEffect(() => { if (open) void refresh(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (value: Partial<Editor>) => {
    setEditor((current) => {
      const next = { ...current, ...value };
      timerEditorDrafts.set(timerDraftKey(tabId, current.id), next);
      timerEditorSelections.set(tabId, current.id);
      return next;
    });
    setDirty(true);
  };
  const setPrompts = (prompts: TimerPromptTemplate[]) => patch({ prompts });
  const schedule = () => {
    if (editor.kind === "once") return { kind: "once", localDateTime: editor.onceAt };
    if (editor.kind === "weekly") return { kind: "weekly", daysOfWeek: editor.weeklyDays, localTime: editor.weeklyTime, startDate: editor.startDate || null, endDate: editor.endDate || null };
    return { kind: "interval", every: roundHundredths(editor.every), unit: editor.unit, anchorAt: editor.anchorAt, endAt: editor.intervalEnd || null };
  };
  const validInterval = editor.kind !== "interval" || (Number.isFinite(editor.every) && roundHundredths(editor.every) >= 0.01 && isLocalDateTime(editor.anchorAt));
  const valid = Boolean(editor.title.trim()
    && editor.prompts.length > 0
    && editor.prompts.every((prompt) => prompt.text.trim())
    && (editor.kind !== "weekly" || editor.weeklyDays.length > 0)
    && validInterval);

  const save = async () => {
    if (!file || !etag || !valid || saving) return;
    const prior = editor.id ? file.timers.find((timer) => timer.id === editor.id) : null;
    if (editor.enabled && !prior?.enabled && localStorage.getItem(BACKGROUND_WARNING_KEY) !== "shown") {
      if (!window.confirm(c.backgroundWarning)) return;
      localStorage.setItem(BACKGROUND_WARNING_KEY, "shown");
    }
    setSaving(true);
    try {
      const body = {
        title: editor.title.trim(),
        enabled: editor.enabled,
        externalQueuePolicy: editor.policy,
        schedule: schedule(),
        prompts: editor.prompts.map((prompt) => ({ id: prompt.id, text: prompt.text })),
        bindToCurrentThread: editor.bindToCurrentThread,
      };
      const response = await apiResponse<{ timer: Timer; file: TimerFile }>(editor.id
        ? `/api/tabs/${tabId}/timers/${editor.id}`
        : `/api/tabs/${tabId}/timers`, {
        method: editor.id ? "PUT" : "POST",
        headers: { "If-Match": etag },
        body: JSON.stringify(body),
      });
      if (response.data) {
        timerEditorDrafts.delete(timerDraftKey(tabId, editor.id));
        setFile(response.data.file);
        selectTimer(response.data.timer);
      }
      if (response.etag) setEtag(response.etag);
    } catch (error) { onError(error); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!editor.id || !etag || !window.confirm(c.deleteConfirm)) return;
    setSaving(true);
    try {
      const response = await apiResponse(`/api/tabs/${tabId}/timers/${editor.id}`, { method: "DELETE", headers: { "If-Match": etag } });
      const remaining = file?.timers.filter((timer) => timer.id !== editor.id) ?? [];
      timerEditorDrafts.delete(timerDraftKey(tabId, editor.id));
      setFile((current) => current ? { ...current, timers: remaining } : current);
      if (response.etag) setEtag(response.etag);
      if (remaining[0]) selectTimer(remaining[0]); else selectNew();
    } catch (error) { onError(error); }
    finally { setSaving(false); }
  };
  const runNow = async () => {
    if (!editor.id || !sessionReady || running) return;
    const key = runKeys.current.get(editor.id) ?? crypto.randomUUID();
    runKeys.current.set(editor.id, key);
    setRunning(true);
    try {
      const response = await apiResponse<{ timer: Timer; promptIds: string[]; file: TimerFile }>(`/api/tabs/${tabId}/timers/${editor.id}/run-now`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: "{}",
      });
      runKeys.current.delete(editor.id);
      if (response.data) { setFile(response.data.file); selectTimer(response.data.timer); }
      if (response.etag) setEtag(response.etag);
    } catch (error) { onError(error); }
    finally { setRunning(false); }
  };
  const addPrompt = () => setPrompts([...editor.prompts, { id: crypto.randomUUID(), text: "" }]);
  const copyPrompt = (id: string) => {
    const index = editor.prompts.findIndex((prompt) => prompt.id === id);
    if (index < 0 || editor.prompts.length >= 20) return;
    const next = [...editor.prompts];
    next.splice(index + 1, 0, { id: crypto.randomUUID(), text: editor.prompts[index].text });
    setPrompts(next);
  };
  const removePrompt = (id: string) => setPrompts(editor.prompts.filter((prompt) => prompt.id !== id));
  const patchPrompt = (id: string, text: string) => setPrompts(editor.prompts.map((prompt) => prompt.id === id ? { ...prompt, text } : prompt));
  const dropTemplate = (targetId: string) => {
    if (!dragTemplateId || dragTemplateId === targetId) return;
    const source = editor.prompts.find((prompt) => prompt.id === dragTemplateId);
    if (!source) return;
    const next = editor.prompts.filter((prompt) => prompt.id !== dragTemplateId);
    next.splice(next.findIndex((prompt) => prompt.id === targetId), 0, source);
    setPrompts(next);
    setDragTemplateId(null);
  };
  const requestClose = () => { onClose(); };
  const displayedTimeZone = file?.timers.find((timer) => timer.id === editor.id)?.timeZone
    ?? file?.timers[0]?.timeZone
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return <ModalShell open={open} wide title={c.title} closeLabel={c.close} onClose={requestClose}>
    <div className="timer-toolbar"><button className="primary" onClick={selectNew}>{c.newTimer}</button><button className="ghost" disabled={loading} onClick={() => void refresh()}>{loading ? c.loading : c.refresh}</button><span>{c.hostZone}: {displayedTimeZone}</span></div>
    <div className="timer-layout">
      <div className="timer-list">{file?.timers.length ? file.timers.map((timer) => <button key={timer.id} className={`timer-item ${timer.id === editor.id ? "active" : ""}`} onClick={() => selectTimer(timer)}><span><i className={`status-dot ${timer.enabled ? "armed" : ""}`} /><strong>{timer.title}</strong></span><small>{ruleSummary(timer, c)} · {timer.prompts.length} {c.promptCount}</small><small>{timer.nextRunAt ? `${c.next}: ${i18n.formatTime(timer.nextRunAt)}` : c.disabled}</small>{timer.lastTrigger && <em>{c.last}: {triggerLabel(timer.lastTrigger.status, c)}</em>}</button>) : <div className="modal-empty">{c.empty}</div>}</div>
      <div className="timer-editor">
        <div className="timer-editor-grid"><label className="span-2">{c.timerTitle}<input value={editor.title} maxLength={120} onChange={(event) => patch({ title: event.target.value })} /></label><label className="toggle-field"><input type="checkbox" checked={editor.enabled} onChange={(event) => patch({ enabled: event.target.checked })} /> {c.enabled}</label><label>{c.queuePolicy}<select value={editor.policy} onChange={(event) => patch({ policy: event.target.value as Editor["policy"] })}><option value="priority">{c.priority}</option><option value="after_running_queue">{c.afterQueue}</option></select></label></div>
        <fieldset className="timer-rule"><legend>{c.schedule}</legend><div className="mode-switch"><button className={editor.kind === "once" ? "active" : ""} onClick={() => patch({ kind: "once" })}>{c.once}</button><button className={editor.kind === "weekly" ? "active" : ""} onClick={() => patch({ kind: "weekly" })}>{c.weekly}</button><button className={editor.kind === "interval" ? "active" : ""} onClick={() => patch({ kind: "interval" })}>{c.interval}</button></div>
          {editor.kind === "once" && <label>{c.localTime}<input type="datetime-local" value={editor.onceAt} onChange={(event) => patch({ onceAt: event.target.value })} /></label>}
          {editor.kind === "weekly" && <div className="weekly-fields"><div className="weekday-picker">{c.weekdays.map((label, index) => { const day = index + 1; return <button key={day} className={editor.weeklyDays.includes(day) ? "active" : ""} onClick={() => patch({ weeklyDays: editor.weeklyDays.includes(day) ? editor.weeklyDays.filter((item) => item !== day) : [...editor.weeklyDays, day].sort() })}>{label}</button>; })}</div><label>{c.localClock}<input type="time" value={editor.weeklyTime} onChange={(event) => patch({ weeklyTime: event.target.value })} /></label><label>{c.startDate}<input type="date" value={editor.startDate} onChange={(event) => patch({ startDate: event.target.value })} /></label><label>{c.endDate}<input type="date" value={editor.endDate} onChange={(event) => patch({ endDate: event.target.value })} /></label></div>}
          {editor.kind === "interval" && <><div className="interval-fields"><label>{c.every}<input type="number" min={0.01} step={0.01} value={editor.every} onChange={(event) => patch({ every: Number(event.target.value) })} onBlur={() => patch({ every: roundHundredths(editor.every) })} /></label><label>{c.unit}<select value={editor.unit} onChange={(event) => patch({ unit: event.target.value as Editor["unit"] })}><option value="hours">{c.hours}</option><option value="days">{c.days}</option></select></label><label>{c.anchor}<input type="datetime-local" value={editor.anchorAt} onChange={(event) => patch({ anchorAt: event.target.value })} /></label><label>{c.optionalEnd}<input type="datetime-local" value={editor.intervalEnd} onChange={(event) => patch({ intervalEnd: event.target.value })} /></label></div><small>{c.intervalNote}</small></>}
        </fieldset>
        <div className="timer-binding"><span>{c.binding}: <code>{editor.bindToCurrentThread && currentThreadId ? currentThreadId : file?.timers.find((timer) => timer.id === editor.id)?.threadId ?? currentThreadId ?? c.none}</code></span><button className="ghost" disabled={!currentThreadId || provider === "shell"} onClick={() => patch({ bindToCurrentThread: true })}>{c.rebind}</button></div>
        <div className="timer-prompts-heading"><strong>{c.templates}</strong><span>{editor.prompts.length}/20</span><button className="ghost" disabled={editor.prompts.length >= 20} onClick={addPrompt}>{c.addTemplate}</button></div>
        <div className="timer-prompts">{editor.prompts.map((prompt, index) => <div className="timer-prompt" key={prompt.id} draggable onDragStart={() => setDragTemplateId(prompt.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropTemplate(prompt.id)}><span className="drag-handle" title={c.drag}>⋮⋮</span><span className="template-index">{index + 1}</span><textarea value={prompt.text} onChange={(event) => patchPrompt(prompt.id, event.target.value)} /><button className="ghost compact" onClick={() => copyPrompt(prompt.id)}>{c.copy}</button><button className="delete-button" disabled={editor.prompts.length === 1} onClick={() => removePrompt(prompt.id)} aria-label={c.delete}>×</button></div>)}</div>
        <div className="modal-actions split"><span>{editor.id && <><button className="danger-action" disabled={saving} onClick={() => void remove()}>{c.deleteTimer}</button><button className="ghost" disabled={!sessionReady || running} title={!sessionReady ? c.runDisabled : undefined} onClick={() => void runNow()}>{running ? c.running : c.runNow}</button></>}</span><span><button className="ghost" onClick={requestClose}>{c.close}</button><button className="primary" disabled={!valid || saving || (!dirty && Boolean(editor.id))} onClick={() => void save()}>{saving ? c.saving : editor.id ? c.save : c.create}</button></span></div>
      </div>
    </div>
  </ModalShell>;
}

const BACKGROUND_WARNING_KEY = "codex-promptor.timer-background-warning.v1";

function newEditor(): Editor {
  const future = new Date(Date.now() + 60 * 60_000);
  const now = new Date();
  return { id: null, title: "", enabled: false, policy: "after_running_queue", kind: "once", onceAt: dateTimeLocal(future), weeklyDays: [1, 2, 3, 4, 5], weeklyTime: "09:00", startDate: "", endDate: "", every: 1, unit: "hours", anchorAt: dateTimeLocal(now), intervalEnd: "", prompts: [{ id: crypto.randomUUID(), text: "" }], bindToCurrentThread: true };
}

function editorFromTimer(timer: Timer): Editor {
  return {
    ...newEditor(), id: timer.id, title: timer.title, enabled: timer.enabled, policy: timer.externalQueuePolicy, kind: timer.schedule.kind, prompts: timer.prompts.map((prompt) => ({ ...prompt })), bindToCurrentThread: false,
    ...(timer.schedule.kind === "once" ? { onceAt: timer.schedule.localDateTime } : {}),
    ...(timer.schedule.kind === "weekly" ? { weeklyDays: timer.schedule.daysOfWeek, weeklyTime: timer.schedule.localTime, startDate: timer.schedule.startDate ?? "", endDate: timer.schedule.endDate ?? "" } : {}),
    ...(timer.schedule.kind === "interval" ? { every: timer.schedule.every, unit: timer.schedule.unit, anchorAt: timerDateTimeInput(timer.schedule.anchorAt), intervalEnd: timer.schedule.endAt ? timerDateTimeInput(timer.schedule.endAt) : "" } : {}),
  };
}

function dateTimeLocal(value: Date): string { return `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}T${two(value.getHours())}:${two(value.getMinutes())}`; }
function isLocalDateTime(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value); }
function timerDateTimeInput(value: string): string { return isLocalDateTime(value) ? value : dateTimeLocal(new Date(value)); }
function timerDraftKey(tabId: string, timerId: string | null): string { return `${tabId}\0${timerId ?? NEW_TIMER_DRAFT}`; }
function roundHundredths(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100; }
function two(value: number): string { return String(value).padStart(2, "0"); }
function triggerLabel(status: Timer["lastTrigger"] extends infer _T ? "queued" | "coalesced" | "blocked" : never, c: typeof zh): string { return status === "queued" ? c.queued : status === "coalesced" ? c.coalesced : c.blocked; }
function ruleSummary(timer: Timer, c: typeof zh): string { return timer.schedule.kind === "once" ? `${c.once} ${timer.schedule.localDateTime}` : timer.schedule.kind === "weekly" ? `${c.weekly} ${timer.schedule.localTime}` : `${c.every} ${timer.schedule.every} ${timer.schedule.unit === "hours" ? c.hours : c.days}`; }

const zh = {
  title: "定时 Prompt", close: "关闭", newTimer: "新建定时器", loading: "加载中…", refresh: "刷新", hostZone: "宿主机时区", empty: "当前对话还没有定时器。", promptCount: "条", next: "下次", disabled: "已停用", last: "最近触发", queued: "已排队", coalesced: "已合并", blocked: "受阻", timerTitle: "标题", enabled: "启用", queuePolicy: "队列位置", priority: "定时器优先", afterQueue: "等待当前队列", schedule: "规则", once: "一次", weekly: "每周", interval: "间隔", localTime: "本地日期与时间", localClock: "本地时间", startDate: "开始日期（可选）", endDate: "结束日期（可选）", every: "每", unit: "单位", hours: "小时", days: "天", anchor: "当地时间锚点", optionalEnd: "结束时间（可选）", intervalNote: "间隔保留两位小数并换算为整分钟；每轮在计划时间后 0～3 分钟内随机提交。", weekdays: ["一", "二", "三", "四", "五", "六", "日"], binding: "绑定对话", none: "无", rebind: "绑定当前对话", templates: "Prompt 模板", addTemplate: "添加模板", drag: "拖动排序", copy: "复制", delete: "删除", deleteTimer: "删除定时器", runNow: "立即运行", running: "登记中…", runDisabled: "重新打开并连接绑定的对话后才能立即运行", saving: "保存中…", save: "保存", create: "创建", deleteConfirm: "删除此定时器？已经进入队列和答案历史的记录会保留。", backgroundWarning: "启用定时器后，即使浏览器页面关闭，Promptor 后端也会继续保持运行并在到期时执行。确认启用？",
};
const en: typeof zh = {
  title: "Prompt timers", close: "Close", newTimer: "New timer", loading: "Loading…", refresh: "Refresh", hostZone: "Host time zone", empty: "No timers for this conversation.", promptCount: "prompts", next: "Next", disabled: "Disabled", last: "Last trigger", queued: "Queued", coalesced: "Coalesced", blocked: "Blocked", timerTitle: "Title", enabled: "Enabled", queuePolicy: "Queue position", priority: "Timer priority", afterQueue: "After current queue", schedule: "Schedule", once: "Once", weekly: "Weekly", interval: "Interval", localTime: "Local date and time", localClock: "Local time", startDate: "Start date (optional)", endDate: "End date (optional)", every: "Every", unit: "Unit", hours: "hours", days: "days", anchor: "Local-time anchor", optionalEnd: "End time (optional)", intervalNote: "Intervals keep two decimals and round to whole minutes; each occurrence is submitted 0–3 minutes after its nominal time.", weekdays: ["M", "T", "W", "T", "F", "S", "S"], binding: "Conversation binding", none: "None", rebind: "Bind current conversation", templates: "Prompt templates", addTemplate: "Add template", drag: "Drag to reorder", copy: "Duplicate", delete: "Delete", deleteTimer: "Delete timer", runNow: "Run now", running: "Registering…", runDisabled: "Reopen the bound conversation before running now", saving: "Saving…", save: "Save", create: "Create", deleteConfirm: "Delete this timer? Queue and answer history already created by it will remain.", backgroundWarning: "An enabled timer keeps the Promptor backend running after browser pages close and executes when due. Enable it?",
};

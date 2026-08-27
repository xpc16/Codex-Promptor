import { useCallback, useEffect, useMemo, useState } from "react";
import type { CommonPrompt, CommonPromptFile } from "../shared/schemas.js";
import { apiResponse } from "./api-client.js";
import { useI18n } from "./i18n.js";
import { ModalShell } from "./modal-shell.js";

export function CommonPromptDialog({ open, canInsert, onClose, onInsert, onError }: {
  open: boolean;
  canInsert: boolean;
  onClose: () => void;
  onInsert: (text: string) => void;
  onError: (error: unknown) => void;
}) {
  const { locale } = useI18n();
  const c = locale === "zh-CN" ? zh : en;
  const [file, setFile] = useState<CommonPromptFile | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiResponse<CommonPromptFile>("/api/common-prompts", {
        headers: etag ? { "If-None-Match": etag } : undefined,
        cache: "no-cache",
      });
      if (response.data) {
        setFile(response.data);
        setSelectedId((current) => response.data!.items.some((item) => item.id === current) ? current : response.data!.items[0]?.id ?? null);
        setDirty(false);
      }
      if (response.etag) setEtag(response.etag);
    } catch (error) { onError(error); }
    finally { setLoading(false); }
  }, [etag, onError]);

  useEffect(() => { if (open && (!file || !dirty)) void refresh(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = file?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const shown = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query ? items.filter((item) => `${item.title}\n${item.text}`.toLocaleLowerCase().includes(query)) : items;
  }, [items, search]);

  const replaceItems = (next: CommonPrompt[]) => {
    setFile((current) => ({ schemaVersion: 1, updatedAt: current?.updatedAt ?? null, items: next }));
    setDirty(true);
  };
  const patchSelected = (patch: Partial<CommonPrompt>) => {
    if (!selected) return;
    replaceItems(items.map((item) => item.id === selected.id ? { ...item, ...patch } : item));
  };
  const add = () => {
    const item = { id: crypto.randomUUID(), title: c.newTitle, text: "" };
    replaceItems([...items, item]);
    setSelectedId(item.id);
  };
  const copy = () => {
    if (!selected) return;
    const item = { ...selected, id: crypto.randomUUID(), title: `${selected.title} ${c.copySuffix}` };
    const index = items.findIndex((entry) => entry.id === selected.id);
    const next = [...items];
    next.splice(index + 1, 0, item);
    replaceItems(next);
    setSelectedId(item.id);
  };
  const remove = () => {
    if (!selected || !window.confirm(c.deleteConfirm)) return;
    const next = items.filter((item) => item.id !== selected.id);
    replaceItems(next);
    setSelectedId(next[0]?.id ?? null);
  };
  const dropBefore = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const source = items.find((item) => item.id === dragId);
    if (!source) return;
    const next = items.filter((item) => item.id !== dragId);
    next.splice(next.findIndex((item) => item.id === targetId), 0, source);
    replaceItems(next);
    setDragId(null);
  };
  const save = async () => {
    if (!file || !etag || saving) return;
    setSaving(true);
    try {
      const response = await apiResponse<CommonPromptFile>("/api/common-prompts", {
        method: "PUT",
        headers: { "If-Match": etag },
        body: JSON.stringify({ items: file.items }),
      });
      if (response.data) setFile(response.data);
      if (response.etag) setEtag(response.etag);
      setDirty(false);
    } catch (error) { onError(error); }
    finally { setSaving(false); }
  };
  const requestClose = () => {
    if (!dirty || window.confirm(c.discardConfirm)) { setDirty(false); onClose(); }
  };

  return <ModalShell open={open} wide title={c.title} closeLabel={c.close} onClose={requestClose}>
    <div className="library-toolbar"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={c.search} /><button className="ghost" disabled={loading} onClick={() => void refresh()}>{loading ? c.loading : c.refresh}</button><button className="primary" onClick={add}>{c.newItem}</button></div>
    <div className="library-layout">
      <div className="library-list" aria-label={c.listLabel}>{shown.length === 0 ? <div className="modal-empty">{c.empty}</div> : shown.map((item) => <button key={item.id} className={`library-item ${item.id === selectedId ? "active" : ""}`} draggable onDragStart={() => setDragId(item.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropBefore(item.id)} onClick={() => setSelectedId(item.id)}><strong>{item.title || c.untitled}</strong><span>{item.text || c.noText}</span></button>)}</div>
      <div className="library-editor">{selected ? <>
        <label>{c.itemTitle}<input value={selected.title} maxLength={120} onChange={(event) => patchSelected({ title: event.target.value })} /></label>
        <label className="grow">{c.body}<textarea value={selected.text} onChange={(event) => patchSelected({ text: event.target.value })} /></label>
        <div className="modal-actions split"><span><button className="ghost" onClick={copy}>{c.copy}</button><button className="danger-action" onClick={remove}>{c.delete}</button></span><span><button className="ghost" disabled={!canInsert || !selected.text.trim()} title={!canInsert ? c.insertDisabled : undefined} onClick={() => onInsert(selected.text)}>{c.insert}</button><button className="primary" disabled={!dirty || saving || items.some((item) => !item.title.trim() || !item.text.trim())} onClick={() => void save()}>{saving ? c.saving : c.save}</button></span></div>
      </> : <div className="modal-empty">{c.select}</div>}</div>
    </div>
  </ModalShell>;
}

const zh = {
  title: "常用 Prompt", close: "关闭", search: "搜索标题或正文", loading: "加载中…", refresh: "刷新", newItem: "新建", listLabel: "常用 Prompt 列表", empty: "还没有常用 Prompt。", untitled: "未命名", noText: "空正文", itemTitle: "标题", body: "Prompt 正文", copy: "复制", copySuffix: "副本", delete: "删除", deleteConfirm: "删除这条常用 Prompt？", insert: "插入草稿", insertDisabled: "当前对话不能编辑 Prompt 草稿", save: "保存列表", saving: "保存中…", select: "选择或新建一条常用 Prompt。", newTitle: "新 Prompt", discardConfirm: "放弃尚未保存的修改？",
};
const en: typeof zh = {
  title: "Common prompts", close: "Close", search: "Search title or body", loading: "Loading…", refresh: "Refresh", newItem: "New", listLabel: "Common prompt list", empty: "No common prompts yet.", untitled: "Untitled", noText: "Empty body", itemTitle: "Title", body: "Prompt body", copy: "Duplicate", copySuffix: "copy", delete: "Delete", deleteConfirm: "Delete this common prompt?", insert: "Insert draft", insertDisabled: "The prompt draft is unavailable for this conversation", save: "Save list", saving: "Saving…", select: "Select or create a common prompt.", newTitle: "New prompt", discardConfirm: "Discard unsaved changes?",
};

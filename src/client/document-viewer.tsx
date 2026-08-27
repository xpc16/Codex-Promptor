import React, { useEffect, useMemo, useRef, useState } from "react";

import { extractDocumentTarget } from "../shared/document-link.js";
import type { DocumentOpenRequest } from "../shared/document-protocol.js";
import { DocumentLoader, type DocumentViewerState } from "./document-loader.js";
import { planMarkdownHeadingIds, SafeMarkdown } from "./safe-markdown.js";
import { useI18n } from "./i18n.js";

export type DocumentOpenIntent = {
  id: number;
  request: DocumentOpenRequest;
};

export function useDocumentViewer(intent: DocumentOpenIntent | null, active: boolean) {
  const loader = useMemo(() => new DocumentLoader(), []);
  const [state, setState] = useState<DocumentViewerState>(loader.state);
  const handledIntent = useRef<number | null>(null);

  useEffect(() => loader.subscribe(setState), [loader]);
  useEffect(() => {
    if (!intent || handledIntent.current === intent.id) return;
    handledIntent.current = intent.id;
    void loader.open(intent.request);
  }, [intent, loader]);
  useEffect(() => { loader.setActive(active); }, [active, loader]);
  useEffect(() => () => loader.close(), [loader]);

  return {
    loader,
    state,
    // Opening performs only the small authorization POST. Terminal traffic is
    // retired after metadata succeeds, before chunk zero is requested.
    visible: state.viewerReserved && state.status !== "closed",
  };
}

export function DocumentView({ state, loader, onClose }: { state: DocumentViewerState; loader: DocumentLoader; onClose: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const scroll = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | null>(null);
  const [anchorPending, setAnchorPending] = useState(false);
  const fragment = state.source ? extractDocumentTarget(state.source.href).fragment : null;
  const headingIds = useMemo(() => planMarkdownHeadingIds(state.markdownBlocks), [state.markdownBlocks]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  useEffect(() => {
    if (!fragment || !scroll.current) { setAnchorPending(false); return; }
    const target = [...scroll.current.querySelectorAll<HTMLElement>("[id]")].find((node) => node.id === fragment);
    if (target) {
      target.scrollIntoView({ block: "start" });
      setAnchorPending(false);
    } else setAnchorPending(!state.complete);
  }, [fragment, state.loadedBytes, state.complete]);

  const onScroll = () => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const node = scroll.current;
      if (!node || node.scrollHeight - node.scrollTop - node.clientHeight > 200) return;
      void loader.loadNext(false);
    });
  };
  useEffect(() => () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); }, []);

  const openNestedDocument = (href: string) => {
    if (!state.source || !state.docId) return;
    void loader.open({ href, tabId: state.source.tabId, parentDocId: state.docId });
  };
  const percent = state.totalBytes > 0 ? Math.min(100, Math.round(state.loadedBytes / state.totalBytes * 100)) : 100;
  return <div className="document-view" role="region" aria-label={t("document.viewer")}>
    <div className="document-toolbar">
      <span className="document-title" title={state.name}>{state.name || t("document.opening")}</span>
      <span className="document-progress">{state.loadedBytes.toLocaleString()} / {state.totalBytes.toLocaleString()} B · {percent}%</span>
      <button className="ghost compact" onClick={onClose}>{t("document.close")}</button>
    </div>
    <div className="document-scroll" ref={scroll} onScroll={onScroll}>
      {state.kind === "text" && <pre className="document-text">{state.textSegments}</pre>}
      {state.kind === "markdown" && <div className="document-markdown markdown">
        {state.markdownBlocks.map((block, index) => <div className="document-markdown-block" style={{ contentVisibility: "auto", containIntrinsicSize: "1px 160px" }} key={`${state.documentEpoch}:${index}`}><SafeMarkdown source={block} headingIds={headingIds[index]} onDocumentLink={openNestedDocument} /></div>)}
        {state.pendingMarkdown && <pre className="document-markdown-pending">{state.pendingMarkdown}</pre>}
      </div>}
      {state.status === "loading" && <div className="document-loading"><span className="spinner" />{t("document.loading")}</div>}
      {state.status === "opening" && <div className="document-loading"><span className="spinner" />{t("document.opening")}</div>}
      {state.status === "error" && <div className="document-error" role="alert"><strong>{i18n.errorText(state.error)}</strong><button className="ghost" onClick={() => void loader.retry()}>{t("action.retry")}</button></div>}
      {anchorPending && <div className="document-anchor-pending"><span>{t("document.anchorPending")}</span><button className="ghost" onClick={() => void loader.loadNext(true)}>{t("document.loadToAnchor")}</button></div>}
      {!state.complete && state.status !== "loading" && <button className="document-load-more ghost" onClick={() => void loader.loadNext(true)}>{t("document.loadMore")}</button>}
      {state.complete && <div className="document-complete">{t("document.complete")}</div>}
    </div>
  </div>;
}

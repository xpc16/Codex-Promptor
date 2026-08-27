import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function ModalShell({ open, title, closeLabel, onClose, children, wide = false }: {
  open: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const first = panel.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='0']");
      (first ?? panel.current)?.focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); return; }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='0']")];
      if (!focusable.length) { event.preventDefault(); panel.current.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", keydown, true);
      returnFocus.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(<div className="modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} className={`modal-shell ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-shell-title" tabIndex={-1} onKeyDown={(event) => event.stopPropagation()}>
      <header className="modal-shell-heading"><h2 id="modal-shell-title">{title}</h2><button className="modal-close" onClick={onClose} aria-label={closeLabel} title={closeLabel}>×</button></header>
      <div className="modal-shell-body">{children}</div>
    </div>
  </div>, document.body);
}

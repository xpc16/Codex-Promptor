import { Component, type ReactNode } from "react";
import { useI18n, type Locale } from "./i18n.js";
import { ModalShell } from "./modal-shell.js";

type LazyDialogBoundaryProps = {
  open: boolean;
  label: string;
  onClose: () => void;
  children: ReactNode;
};

type LazyDialogBoundaryState = {
  failed: boolean;
};

export function lazyDialogFailureCopy(locale: Locale, label: string) {
  return locale === "zh-CN"
    ? {
        title: `${label}加载失败`,
        message: "弹窗内容未能载入，请关闭后刷新页面再试。",
        close: "关闭",
      }
    : {
        title: `Failed to load ${label}`,
        message: "The dialog could not be loaded. Close it, refresh the page, and try again.",
        close: "Close",
      };
}

export function lazyDialogFailureVisible(failed: boolean, open: boolean): boolean {
  return failed && open;
}

function LazyDialogFailure({ open, label, onClose }: Omit<LazyDialogBoundaryProps, "children">) {
  const { locale } = useI18n();
  const copy = lazyDialogFailureCopy(locale, label);
  return <ModalShell open={open} title={copy.title} closeLabel={copy.close} onClose={onClose}>
    <div className="modal-empty" role="alert">
      <p>{copy.message}</p>
      <button className="primary" onClick={onClose}>{copy.close}</button>
    </div>
  </ModalShell>;
}

/** Keeps a rejected lazy-loaded dialog from taking down the conversation page. */
export class LazyDialogBoundary extends Component<LazyDialogBoundaryProps, LazyDialogBoundaryState> {
  state: LazyDialogBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazyDialogBoundaryState {
    return { failed: true };
  }

  render() {
    if (lazyDialogFailureVisible(this.state.failed, this.props.open)) {
      return <LazyDialogFailure open label={this.props.label} onClose={this.props.onClose} />;
    }
    if (this.state.failed) return null;
    return this.props.children;
  }
}

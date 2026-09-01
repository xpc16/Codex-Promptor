import { describe, expect, it } from "vitest";
import { lazyDialogFailureCopy, lazyDialogFailureVisible } from "./lazy-dialog-boundary.js";

describe("lazy dialog failure handling", () => {
  it("shows a localized load failure instead of leaving the dialog blank", () => {
    expect(lazyDialogFailureCopy("zh-CN", "定时器")).toEqual({
      title: "定时器加载失败",
      message: "弹窗内容未能载入，请关闭后刷新页面再试。",
      close: "关闭",
    });
    expect(lazyDialogFailureCopy("en", "Common prompts").title).toBe("Failed to load Common prompts");
  });

  it("removes the failure dialog as soon as the user closes it", () => {
    expect(lazyDialogFailureVisible(true, true)).toBe(true);
    expect(lazyDialogFailureVisible(true, false)).toBe(false);
    expect(lazyDialogFailureVisible(false, true)).toBe(false);
  });
});

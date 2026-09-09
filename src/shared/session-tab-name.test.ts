import { describe, expect, it } from "vitest";
import { nameForSession } from "./session-tab-name.js";

describe("naming a tab after what was opened on it", () => {
  it("names an encryption switch and a terminal", () => {
    // A sidebar where the switch and the shell both read "新对话" is a sidebar
    // where the two things that most need finding look like everything else.
    expect(nameForSession("新对话", "e2ee", "zh-CN")).toBe("E2EE");
    expect(nameForSession("新对话", "shell", "zh-CN")).toBe("终端");
    expect(nameForSession("New conversation", "shell", "en")).toBe("Terminal");
  });

  it("leaves a name the reader chose", () => {
    // Someone who typed this before connecting meant it, and having it
    // overwritten by the act of connecting would be worse than no naming.
    expect(nameForSession("工作机加密", "e2ee", "zh-CN")).toBe("工作机加密");
    expect(nameForSession("build logs", "shell", "en")).toBe("build logs");
  });

  it("takes a placeholder from either language, whichever one is in use now", () => {
    // A tab created in English and configured after switching to Chinese is
    // still a tab nobody has named.
    expect(nameForSession("New conversation", "shell", "zh-CN")).toBe("终端");
    expect(nameForSession("未命名对话", "e2ee", "en")).toBe("E2EE");
  });

  it("leaves the agents alone", () => {
    // Codex, Claude and Cursor conversations are conversations; their names
    // are the reader's way of telling them apart.
    for (const provider of ["codex", "claude", "cursor"]) {
      expect(nameForSession("新对话", provider, "zh-CN")).toBe("新对话");
    }
  });
});

import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { describe, expect, it } from "vitest";

const write = (terminal: Terminal, text: string) => new Promise<void>((resolve) => terminal.write(text, resolve));

describe("terminal scrollback checkpoint", () => {
  it("restores history and the current screen without replaying the PTY output stream", async () => {
    const original = new Terminal({ cols: 20, rows: 3, scrollback: 20, allowProposedApi: true });
    const serializer = new SerializeAddon();
    original.loadAddon(serializer);
    const restored = new Terminal({ cols: 20, rows: 3, scrollback: 20, allowProposedApi: true });
    try {
      await write(original, "one\r\ntwo\r\nthree\r\nfour");
      await write(restored, serializer.serialize({ scrollback: 20 }));
      expect(restored.buffer.normal.length).toBe(4);
      expect(restored.buffer.normal.getLine(0)?.translateToString(true)).toBe("one");
      expect(restored.buffer.normal.getLine(3)?.translateToString(true)).toBe("four");
    } finally {
      original.dispose();
      restored.dispose();
    }
  });
});

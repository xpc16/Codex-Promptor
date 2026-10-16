import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: mocks.spawn }));

import { PtyManager } from "./pty.js";

function fakePty() {
  const proc = { pid: 4321, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
  mocks.spawn.mockReturnValue(proc);
  return proc;
}

/** Past the 180 ms after which a typed command would have been written. */
const pastReady = () => new Promise((resolve) => setTimeout(resolve, 260));

describe("how a terminal's first command reaches PowerShell", () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    mocks.spawn.mockReset();
  });

  it("outside Windows, is handed to pwsh as -Command, never typed into a shell that is still starting", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const proc = fakePty();
    const manager = new PtyManager();
    await manager.startCommand("tab-mac", "/Users/someone", "Write-Output hello", "PowerShell", "__MARK__:");
    await pastReady();
    expect(mocks.spawn).toHaveBeenCalledWith("pwsh", ["-NoLogo", "-NoExit", "-NoProfile", "-Command", "Write-Output hello"], expect.objectContaining({ cwd: "/Users/someone" }));
    // Typed text would sit unsent at PSReadLine's first prompt.
    expect(proc.write).not.toHaveBeenCalled();
    await manager.stop("tab-mac", false);
  });

  it("on Windows, is typed into the console as before", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const proc = fakePty();
    const manager = new PtyManager();
    await manager.startCommand("tab-win", "C:\\work", "Write-Output hello", "PowerShell", "__MARK__:");
    await pastReady();
    expect(mocks.spawn).toHaveBeenCalledWith("powershell.exe", ["-NoLogo", "-NoExit", "-NoProfile"], expect.objectContaining({ cwd: "C:\\work" }));
    expect(proc.write).toHaveBeenCalledWith("Write-Output hello\r");
    await manager.stop("tab-win", false);
  });
});

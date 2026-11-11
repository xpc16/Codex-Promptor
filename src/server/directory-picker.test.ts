import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DirectoryPickerBusyError,
  DirectoryPickerService,
  NativeDirectoryPickerRunner,
  supportsNativeDirectoryPicker,
  type DirectoryPickerRunner,
} from "./directory-picker.js";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

type PickerCallback = (error: Error | null, stdout: string, stderr: string) => void;

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    }),
  });
  return child;
}

function completeNext(stdout = "", error: Error | null = null) {
  const child = childProcess();
  execFileMock.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: PickerCallback) => {
    queueMicrotask(() => callback(error, stdout, ""));
    return child;
  });
  return child;
}

beforeEach(() => execFileMock.mockReset());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("DirectoryPickerService", () => {
  it("allows only one native picker and becomes reusable after it closes", async () => {
    const first = deferred<string | null>();
    let calls = 0;
    const runner: DirectoryPickerRunner = {
      run: async () => {
        calls += 1;
        return calls === 1 ? first.promise : "D:\\next";
      },
      stop: async () => undefined,
    };
    const picker = new DirectoryPickerService(runner);
    const pending = picker.select("D:\\first");

    await expect(picker.select("D:\\duplicate")).rejects.toBeInstanceOf(DirectoryPickerBusyError);
    first.resolve("D:\\first");
    await expect(pending).resolves.toBe("D:\\first");
    await expect(picker.select("D:\\next")).resolves.toBe("D:\\next");
    expect(calls).toBe(2);
  });
});

describe("NativeDirectoryPickerRunner", () => {
  it("opens the macOS picker with an initial path passed as data and preserves path spaces", async () => {
    const initialPath = '/Users/test/中文/"quoted"\nproject';
    const selectedPath = "/Users/test/ leading and trailing ";
    completeNext(`${selectedPath}\r\n`);

    await expect(new NativeDirectoryPickerRunner("darwin").run(initialPath)).resolves.toBe(selectedPath);

    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file).toBe("/usr/bin/osascript");
    expect(args).toEqual(["-e", expect.any(String), initialPath]);
    expect(args[1]).not.toContain(initialPath);
    expect(args[1]).toContain("choose folder");
    expect(options).toMatchObject({ encoding: "utf8", timeout: 600_000 });
  });

  it("returns null after cancellation and can open another picker", async () => {
    completeNext("");
    completeNext("/Users/test/next/\n");
    const runner = new NativeDirectoryPickerRunner("darwin");

    await expect(runner.run("/Users/test")).resolves.toBeNull();
    await expect(runner.run("/Users/test")).resolves.toBe("/Users/test/next/");
    expect(execFileMock.mock.calls[0][1][1]).toContain("-128");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("rejects execution errors and becomes reusable", async () => {
    const failure = new Error("Automation permission denied");
    completeNext("", failure);
    completeNext("/Users/test/retry\n");
    const runner = new NativeDirectoryPickerRunner("darwin");

    await expect(runner.run("/Users/test")).rejects.toBe(failure);
    await expect(runner.run("/Users/test")).resolves.toBe("/Users/test/retry");
  });

  it("stops the running dialog process and waits for it to exit", async () => {
    const child = childProcess();
    let callback!: PickerCallback;
    execFileMock.mockImplementationOnce((_file: string, _args: string[], _options: unknown, done: PickerCallback) => {
      callback = done;
      return child;
    });
    const runner = new NativeDirectoryPickerRunner("darwin");
    const pending = runner.run("/Users/test");
    const rejected = expect(pending).rejects.toThrow("Dialog terminated");

    await runner.stop();
    callback(new Error("Dialog terminated"), "", "");
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("keeps the Windows native dialog and passes its initial path through the environment", async () => {
    completeNext("C:\\Users\\test\\项目");
    const initialPath = "C:\\Users\\test\\start";

    await expect(new NativeDirectoryPickerRunner("win32").run(initialPath)).resolves.toBe("C:\\Users\\test\\项目");

    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file).toBe("powershell.exe");
    expect(args).toEqual(["-NoProfile", "-STA", "-Command", expect.any(String)]);
    expect(options).toMatchObject({
      encoding: "utf8",
      timeout: 600_000,
      env: { CODEX_PROMPTOR_PICKER_INITIAL_PATH: initialPath },
    });
  });

  it("reports unsupported platforms without spawning a dialog", async () => {
    expect(supportsNativeDirectoryPicker("win32")).toBe(true);
    expect(supportsNativeDirectoryPicker("darwin")).toBe(true);
    expect(supportsNativeDirectoryPicker("linux")).toBe(false);

    await expect(new NativeDirectoryPickerRunner("linux").run("/tmp")).rejects.toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

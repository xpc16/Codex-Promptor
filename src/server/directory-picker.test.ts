import { describe, expect, it } from "vitest";
import { DirectoryPickerBusyError, DirectoryPickerService, type DirectoryPickerRunner } from "./directory-picker.js";

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

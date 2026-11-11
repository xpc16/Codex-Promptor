import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type PromptorApp } from "./app.js";
import { DirectoryPickerService } from "./directory-picker.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
const apps: PromptorApp[] = [];
const localHeaders = { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" };

afterEach(async () => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) {
    await app.promptor.close();
    await app.close();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryApp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "promptor-directory-picker-"));
  roots.push(root);
  const workspace = path.join(root, "workspace 中文");
  await mkdir(workspace);
  const app = await createApp(root);
  apps.push(app);
  await app.ready();
  return { app, workspace };
}

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
}

describe("native directory picker API", () => {
  it("allows a local macOS browser to select a folder with its current path", async () => {
    const { app, workspace } = await temporaryApp();
    const selected = path.join(workspace, "selected");
    const picker = vi.spyOn(DirectoryPickerService.prototype, "select").mockResolvedValue(selected);
    setPlatform("darwin");

    const response = await app.inject({
      method: "POST",
      url: "/api/dialog/select-directory",
      headers: localHeaders,
      payload: { initialPath: workspace },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { path: selected } });
    expect(picker).toHaveBeenCalledExactlyOnceWith(workspace);
  });

  it("returns a normal empty selection when the macOS user cancels", async () => {
    const { app, workspace } = await temporaryApp();
    vi.spyOn(DirectoryPickerService.prototype, "select").mockResolvedValue(null);
    setPlatform("darwin");

    const response = await app.inject({
      method: "POST",
      url: "/api/dialog/select-directory",
      headers: localHeaders,
      payload: { initialPath: workspace },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { path: null } });
  });

  it("does not open a native dialog for a remote browser even with a valid token", async () => {
    const { app, workspace } = await temporaryApp();
    const picker = vi.spyOn(DirectoryPickerService.prototype, "select").mockResolvedValue(workspace);
    setPlatform("darwin");

    const response = await app.inject({
      method: "POST",
      url: "/api/dialog/select-directory",
      headers: {
        host: "promptor.example.com",
        origin: "https://promptor.example.com",
        "x-codex-promptor-token": app.promptor.token,
      },
      payload: { initialPath: workspace },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("DIRECTORY_DIALOG_LOCAL_ONLY");
    expect(picker).not.toHaveBeenCalled();
  });

  it("reports unsupported platforms without attempting a native dialog", async () => {
    const { app, workspace } = await temporaryApp();
    const picker = vi.spyOn(DirectoryPickerService.prototype, "select").mockResolvedValue(workspace);
    setPlatform("linux");

    const response = await app.inject({
      method: "POST",
      url: "/api/dialog/select-directory",
      headers: localHeaders,
      payload: { initialPath: workspace },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("DIRECTORY_DIALOG_UNSUPPORTED");
    expect(picker).not.toHaveBeenCalled();
  });
});

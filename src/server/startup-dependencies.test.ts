import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type EnsureDependencies = (root: string, options: {
  install: (root: string) => Promise<void>;
  log: (message: string) => void;
}) => Promise<boolean>;

let ensureDependencies: EnsureDependencies;
let root: string;

const manifest = {
  name: "promptor-startup-fixture",
  dependencies: { "@xterm/addon-fit": "^0.10.0", "@xterm/addon-serialize": "^0.13.0" },
  devDependencies: { vite: "^7.0.0" },
};

function lockfile() {
  return {
    lockfileVersion: 3,
    packages: {
      "": { ...manifest },
      "node_modules/@xterm/addon-fit": { version: "0.10.0" },
      "node_modules/@xterm/addon-serialize": { version: "0.13.0" },
      "node_modules/vite": { version: "7.3.6" },
      "node_modules/transitive-example": { version: "1.0.0" },
    },
  };
}

async function installPackage(name: string, version: string) {
  const packagePath = path.join(root, "node_modules", name, "package.json");
  await mkdir(path.dirname(packagePath), { recursive: true });
  await writeFile(packagePath, JSON.stringify({ name, version }));
}

async function installFixture(installRoot: string) {
  expect(installRoot).toBe(root);
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  for (const name of [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]) {
    await installPackage(name, lock.packages[`node_modules/${name}`].version);
  }
}

function markerPath() {
  return path.join(root, "node_modules", ".promptor-dependencies.json");
}

function synchronize(install = installFixture) {
  return ensureDependencies(root, { install, log: () => {} });
}

beforeAll(async () => {
  const scriptUrl = pathToFileURL(path.join(process.cwd(), "scripts", "ensure-dependencies.mjs")).href;
  ({ ensureDependencies } = await import(scriptUrl));
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "promptor-startup-dependencies-"));
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify(lockfile(), null, 2)}\n`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("startup dependency synchronization", () => {
  it("repairs an existing dependency tree after pulling the new serialize addon", async () => {
    await installPackage("@xterm/addon-fit", "0.10.0");
    await installPackage("vite", "7.3.6");
    const install = vi.fn(installFixture);

    expect(await synchronize(install)).toBe(true);
    expect(install).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path.join(root, "node_modules", "@xterm", "addon-serialize", "package.json"), "utf8")).version).toBe("0.13.0");
    expect(await readFile(markerPath(), "utf8")).toBeTruthy();
  });

  it("adopts an existing installation only after its first synchronization, then stays offline", async () => {
    await installFixture(root);
    const install = vi.fn(installFixture);

    expect(await synchronize(install)).toBe(true);
    expect(await synchronize(install)).toBe(false);
    expect(install).toHaveBeenCalledOnce();
  });

  it("synchronizes a changed lockfile even when direct dependency versions did not change", async () => {
    await synchronize();
    const changedLock = lockfile();
    changedLock.packages["node_modules/transitive-example"].version = "1.0.1";
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify(changedLock));
    const install = vi.fn(installFixture);

    expect(await synchronize(install)).toBe(true);
    expect(await synchronize(install)).toBe(false);
    expect(install).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "@xterm/addon-serialize", mismatch: false },
    { name: "vite", mismatch: false },
    { name: "@xterm/addon-serialize", mismatch: true },
  ])("repairs $name with an existing marker (version mismatch: $mismatch)", async ({ name, mismatch }) => {
    await synchronize();
    if (mismatch) {
      await installPackage(name, "0.0.1");
    } else {
      await rm(path.join(root, "node_modules", name, "package.json"));
    }
    const install = vi.fn(installFixture);

    expect(await synchronize(install)).toBe(true);
    expect(install).toHaveBeenCalledOnce();
    expect(await synchronize(install)).toBe(false);
  });

  it("removes the previous success marker on installation failure and retries next launch", async () => {
    await synchronize();
    await rm(path.join(root, "node_modules", "vite", "package.json"));
    const install = vi.fn(async () => { throw new Error("fixture installation failed"); });

    await expect(synchronize(install)).rejects.toThrow("fixture installation failed");
    await expect(readFile(markerPath())).rejects.toMatchObject({ code: "ENOENT" });
    const retry = vi.fn(installFixture);
    expect(await synchronize(retry)).toBe(true);
    expect(retry).toHaveBeenCalledOnce();
    expect(await synchronize(retry)).toBe(false);
  });

  it("does not record success when the installer returns without providing required packages", async () => {
    const install = vi.fn(async () => {});

    await expect(synchronize(install)).rejects.toThrow();
    await expect(readFile(markerPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(install).toHaveBeenCalledOnce();
  });

  it("does not install again when Git only changes LF to CRLF", async () => {
    await synchronize();
    for (const name of ["package.json", "package-lock.json"]) {
      const filePath = path.join(root, name);
      await writeFile(filePath, (await readFile(filePath, "utf8")).replace(/\n/g, "\r\n"));
    }
    const install = vi.fn(installFixture);

    expect(await synchronize(install)).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });
});

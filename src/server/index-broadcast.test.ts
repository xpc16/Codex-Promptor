import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StorageService } from "./storage.js";
import { applyNavigationOrder, deleteGroupAndUngroupTabs } from "./navigation.js";
import type { Group, IndexFile } from "../shared/schemas.js";

async function withStorage(run: (storage: StorageService, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-index-sync-"));
  try {
    const storage = new StorageService(root);
    await storage.ensure();
    await run(storage, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("navigation index change notifications", () => {
  it("notifies for every sidebar mutation so other viewers can follow along", async () => {
    await withStorage(async (storage) => {
      const seen: IndexFile[] = [];
      storage.onIndexChanged((index) => { seen.push(index); });

      const tab = await storage.createTab("会话一");
      const second = await storage.createTab("会话二");
      expect(seen.map((index) => index.tabs.length)).toEqual([1, 2]);

      await storage.updateTab(tab.id, (current) => ({ ...current, name: "改名后" }));
      expect(seen.at(-1)!.tabs.find((item) => item.id === tab.id)?.name).toBe("改名后");

      const group: Group = { id: "group-1", name: "分组", order: 0, collapsed: false };
      await storage.updateIndex((current) => ({ ...current, groups: [...current.groups, group] }));
      expect(seen.at(-1)!.groups).toHaveLength(1);

      // Membership plus ordering, the same call the reorder route makes.
      await storage.updateIndex((current) => applyNavigationOrder(
        current,
        ["group-1"],
        [{ groupId: "group-1", tabIds: [second.id] }, { groupId: null, tabIds: [tab.id] }],
      ));
      expect(seen.at(-1)!.tabs.find((item) => item.id === second.id)?.groupId).toBe("group-1");

      await storage.updateIndex((current) => deleteGroupAndUngroupTabs(current, "group-1"));
      expect(seen.at(-1)!.groups).toHaveLength(0);
      expect(seen.at(-1)!.tabs.find((item) => item.id === second.id)?.groupId).toBeNull();

      await storage.deleteTab(second.id);
      expect(seen.at(-1)!.tabs.map((item) => item.id)).toEqual([tab.id]);

      // Ordering matters: a viewer uses revision to discard a stale replay.
      const revisions = seen.map((index) => index.revision);
      expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
      expect(new Set(revisions).size).toBe(revisions.length);
    });
  });

  it("persists every change, so a viewer that reloads sees the same sidebar", async () => {
    await withStorage(async (storage, root) => {
      const tab = await storage.createTab("原名");
      await storage.updateTab(tab.id, (current) => ({ ...current, name: "远端改的名字" }));
      await storage.updateIndex((current) => ({
        ...current,
        groups: [{ id: "group-1", name: "远端建的分组", order: 0, collapsed: false }],
      }));
      await storage.updateIndex((current) => applyNavigationOrder(
        current,
        ["group-1"],
        [{ groupId: "group-1", tabIds: [tab.id] }, { groupId: null, tabIds: [] }],
      ));

      const reloaded = await new StorageService(root).readIndex();
      expect(reloaded.tabs.find((item) => item.id === tab.id)?.name).toBe("远端改的名字");
      expect(reloaded.tabs.find((item) => item.id === tab.id)?.groupId).toBe("group-1");
      expect(reloaded.groups.map((group) => group.name)).toEqual(["远端建的分组"]);
    });
  });

  it("keeps saving when a listener throws, and stops after unsubscribe", async () => {
    await withStorage(async (storage, root) => {
      const seen: number[] = [];
      storage.onIndexChanged(() => { throw new Error("viewer socket died"); });
      const unsubscribe = storage.onIndexChanged((index) => { seen.push(index.revision); });

      const tab = await storage.createTab("会话");
      expect(seen).toHaveLength(1);
      expect((await new StorageService(root).readIndex()).tabs).toHaveLength(1);

      unsubscribe();
      await storage.updateTab(tab.id, (current) => ({ ...current, name: "之后" }));
      expect(seen).toHaveLength(1);
      expect((await new StorageService(root).readIndex()).tabs[0].name).toBe("之后");
    });
  });
});

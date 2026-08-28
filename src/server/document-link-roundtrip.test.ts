import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { extractDocumentTarget } from "../shared/document-link.js";
import { DOCUMENT_CHUNK_BYTES, DOCUMENT_FIRST_CHUNK_BYTES, documentChunkCount } from "../shared/document-protocol.js";
import { isoNow } from "../shared/schemas.js";
import { DocumentService } from "./documents.js";
import { StorageService } from "./storage.js";

/**
 * The document link, end to end, against a document that actually exists in
 * this repository rather than a synthesized fixture.
 *
 * A Markdown link written in an answer only opens if three separate things
 * agree: the href parses as a local file, the path resolves inside a root the
 * tab is allowed to read, and the file is a format the remote viewer accepts.
 * Each of those has its own tests; this one checks that a link a person would
 * plausibly type survives all three and comes back readable.
 */

const REPO = path.resolve(import.meta.dirname, "..", "..");
const DOC = path.join(REPO, "docs", "TRAFFIC_OPTIMIZATION.md");

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 30 })));
});

/** A tab whose working directory is this checkout, which is what makes `./docs/...` resolvable. */
async function tabInRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-doclink-"));
  temporaryRoots.push(root);
  const storage = new StorageService(root);
  await storage.ensure();
  const tab = await storage.createTab("文档链接");
  await storage.updateTab(tab.id, (current) => ({
    ...current,
    session: { ...current.session, state: "ready", provider: "codex", threadId: "t", sessionId: "t", workingDirectory: REPO },
    updatedAt: isoNow(),
  }));
  const documents = await DocumentService.create(root, storage, { openWithDefaultApplication: vi.fn(async () => undefined) });
  return { tab, documents };
}

describe("a Markdown link to a document in this repository", () => {
  it("is recognised as a local file only when the path says it is relative", () => {
    // The bare form is the one people reach for first, and it is deliberately
    // not a document link: without a leading `./` it is indistinguishable from
    // a site-relative URL, so treating it as a file would be a guess.
    expect(extractDocumentTarget("docs/TRAFFIC_OPTIMIZATION.md").kind).toBe("unknown");

    expect(extractDocumentTarget("./docs/TRAFFIC_OPTIMIZATION.md")).toMatchObject({
      kind: "local-file",
      path: "./docs/TRAFFIC_OPTIMIZATION.md",
      displayName: "TRAFFIC_OPTIMIZATION.md",
    });
    expect(extractDocumentTarget(DOC)).toMatchObject({ kind: "local-file", displayName: "TRAFFIC_OPTIMIZATION.md" });
    expect(extractDocumentTarget("./docs/TRAFFIC_OPTIMIZATION.md#4-优化方案").fragment).toBe("4-优化方案");
  });

  it("opens through the viewer and reads back byte-for-byte", async () => {
    const { tab, documents } = await tabInRepo();
    const onDisk = await fs.readFile(DOC);

    const opened = await documents.open({ tabId: tab.id, href: "./docs/TRAFFIC_OPTIMIZATION.md" });
    expect(opened).toMatchObject({ name: "TRAFFIC_OPTIMIZATION.md", kind: "markdown", encoding: "utf-8" });
    expect(opened.size).toBe(onDisk.length);

    const chunks: Buffer[] = [];
    for (let index = 0; index < documentChunkCount(opened.size); index += 1) {
      chunks.push((await documents.readChunk(opened.docId, opened.revision, index)).bytes);
    }
    expect(Buffer.concat(chunks).equals(onDisk)).toBe(true);

    // The first chunk is deliberately smaller: it is what the reader waits for
    // before anything appears, and the rest arrive as they scroll.
    expect(chunks[0].length).toBe(Math.min(DOCUMENT_FIRST_CHUNK_BYTES, onDisk.length));
    for (const chunk of chunks.slice(1, -1)) expect(chunk.length).toBe(DOCUMENT_CHUNK_BYTES);
  });

  it("reaches the same document by absolute path, and by a sibling link from inside it", async () => {
    const { tab, documents } = await tabInRepo();

    const byAbsolute = await documents.open({ tabId: tab.id, href: DOC });
    const byRelative = await documents.open({ tabId: tab.id, href: "./docs/TRAFFIC_OPTIMIZATION.md" });
    // Same file, so the same content-addressed id -- otherwise the browser
    // would cache the same bytes twice under two URLs.
    expect(byAbsolute.docId).toBe(byRelative.docId);

    // This document links to its siblings; following one has to resolve
    // against the document's own directory, not the tab's working directory.
    const sibling = await documents.open({ tabId: tab.id, parentDocId: byRelative.docId, href: "./END_TO_END_ENCRYPTION.md" });
    expect(sibling.name).toBe("END_TO_END_ENCRYPTION.md");
  });

  it("refuses a path that climbs out of every authorized root", async () => {
    const { tab, documents } = await tabInRepo();
    await expect(documents.open({ tabId: tab.id, href: "./docs/../../../../Windows/System32/drivers/etc/hosts" }))
      .rejects.toMatchObject({ code: expect.stringMatching(/DOCUMENT_(ACCESS_DENIED|NOT_FOUND)/) });
  });
});

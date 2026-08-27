import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultAnswerFile, isoNow, type AnswerRecord } from "../shared/schemas.js";
import { DOCUMENT_FIRST_CHUNK_BYTES } from "../shared/document-protocol.js";
import { createApp, type PromptorApp } from "./app.js";
import { DocumentError, DocumentService, isLocalBrowserRequest } from "./documents.js";
import { StorageService } from "./storage.js";

const temporaryRoots: string[] = [];
const apps: PromptorApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => {
    await app.promptor.close();
    await app.close();
  }));
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 30 })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-documents-"));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const storage = new StorageService(root);
  await storage.ensure();
  const tab = await storage.createTab("documents");
  await storage.updateTab(tab.id, (current) => ({
    ...current,
    session: {
      ...current.session,
      state: "ready",
      provider: "codex",
      threadId: "thread-documents",
      sessionId: "thread-documents",
      workingDirectory: workspace,
    },
    updatedAt: isoNow(),
  }));
  const opener = vi.fn(async () => undefined);
  const documents = await DocumentService.create(root, storage, { openWithDefaultApplication: opener });
  return { root, workspace, storage, tab, opener, documents };
}

describe("DocumentService", () => {
  it("authorizes a UTF-8 document and reads only fixed-size chunks", async () => {
    const { root, workspace, tab, documents, storage } = await fixture();
    const text = "a".repeat(DOCUMENT_FIRST_CHUNK_BYTES + 37);
    await fs.writeFile(path.join(workspace, "notes.md"), text, "utf8");

    const opened = await documents.open({ tabId: tab.id, href: "./notes.md" });
    const first = await documents.readChunk(opened.docId, opened.revision, 0);
    const second = await documents.readChunk(opened.docId, opened.revision, 1);

    expect(opened).toMatchObject({ name: "notes.md", kind: "markdown", size: text.length, encoding: "utf-8" });
    expect(first.bytes).toHaveLength(DOCUMENT_FIRST_CHUNK_BYTES);
    expect(second.bytes.toString("utf8")).toBe("a".repeat(37));
    expect(await fs.readFile(path.join(root, "data", "private", "document-key"))).toHaveLength(32);

    const restarted = await DocumentService.create(root, storage, { openWithDefaultApplication: async () => undefined });
    expect((await restarted.open({ tabId: tab.id, href: "./notes.md" })).docId).toBe(opened.docId);
  });

  it("rejects traversal, similarly prefixed sibling roots and unsupported remote formats", async () => {
    const { root, workspace, tab, documents } = await fixture();
    const sibling = `${workspace}-outside`;
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, "outside.md"), "outside", "utf8");
    await fs.writeFile(path.join(workspace, "image.pdf"), "%PDF", "utf8");
    await fs.writeFile(path.join(workspace, "utf16.txt"), Buffer.from([0xff, 0xfe, 0x61, 0x00]));

    await expect(documents.open({ tabId: tab.id, href: path.join(sibling, "outside.md") }))
      .rejects.toMatchObject({ code: "DOCUMENT_ACCESS_DENIED" });
    await expect(documents.open({ tabId: tab.id, href: `../${path.basename(sibling)}/outside.md` }))
      .rejects.toMatchObject({ code: "DOCUMENT_ACCESS_DENIED" });
    await expect(documents.open({ tabId: tab.id, href: "./image.pdf" }))
      .rejects.toMatchObject({ code: "DOCUMENT_REMOTE_FORMAT_UNSUPPORTED" });
    await expect(documents.open({ tabId: tab.id, href: "./utf16.txt" }))
      .rejects.toMatchObject({ code: "DOCUMENT_ENCODING_UNSUPPORTED" });
    await expect(documents.open({ tabId: tab.id, href: "./notes.md?download=1" }))
      .rejects.toMatchObject({ code: "DOCUMENT_LINK_INVALID" });
    await expect(documents.open({ tabId: tab.id, href: "./%252e%252e/outside.md" }))
      .rejects.toMatchObject({ code: "DOCUMENT_LINK_INVALID" });
    await expect(documents.open({ tabId: tab.id, href: "./bad%00name.md" }))
      .rejects.toMatchObject({ code: "DOCUMENT_LINK_INVALID" });
    await expect(documents.open({ tabId: tab.id, href: "./image.pdf:stream" }))
      .rejects.toMatchObject({ code: "DOCUMENT_ACCESS_DENIED" });
    expect(root).toBeTruthy();
  });

  it("binds parent document authorization to the tab and detects file changes", async () => {
    const { workspace, tab, documents, storage } = await fixture();
    const file = path.join(workspace, "parent.md");
    await fs.writeFile(file, "first", "utf8");
    const opened = await documents.open({ tabId: tab.id, href: "./parent.md" });
    const other = await storage.createTab("other");
    await storage.updateTab(other.id, (current) => ({ ...current, session: { ...current.session, workingDirectory: workspace }, updatedAt: isoNow() }));

    await expect(documents.open({ tabId: other.id, href: "./parent.md", parentDocId: opened.docId }))
      .rejects.toMatchObject({ code: "DOCUMENT_ACCESS_DENIED" });
    await fs.writeFile(file, "later", "utf8");
    await expect(documents.readChunk(opened.docId, opened.revision, 0))
      .rejects.toMatchObject({ code: "DOCUMENT_CHANGED" });
  });

  it("requires a path-and-revision-bound confirmation before opening active files", async () => {
    const { workspace, tab, documents, opener } = await fixture();
    await fs.writeFile(path.join(workspace, "run.ps1"), "Write-Host test", "utf8");

    let confirmation: DocumentError | null = null;
    try { await documents.openLocal({ tabId: tab.id, href: "./run.ps1" }); }
    catch (error) { confirmation = error as DocumentError; }

    expect(confirmation).toMatchObject({ code: "DOCUMENT_CONFIRMATION_REQUIRED" });
    expect(opener).not.toHaveBeenCalled();
    await expect(documents.openLocal({
      tabId: tab.id,
      href: "./run.ps1",
      confirmationToken: String(confirmation?.details.confirmationToken),
    })).resolves.toMatchObject({ name: "run.ps1", opened: true });
    expect(opener).toHaveBeenCalledWith(path.join(workspace, "run.ps1"));
  });

  it("keeps answer document bases on disk and strips them from windows, pages and deltas", async () => {
    const { workspace, tab, storage } = await fixture();
    const now = isoNow();
    const answer: AnswerRecord = {
      id: "answer-doc-base",
      promptId: "prompt-doc-base",
      threadId: "thread-documents",
      codexTurnId: "turn-doc-base",
      origin: "queue",
      prompt: "write a document",
      status: "completed",
      finalAnswer: "[read](./notes.md)",
      captureMode: "phase_final_answer",
      startedAt: now,
      completedAt: now,
      recordedAt: now,
      clientUserMessageId: null,
      error: null,
      metadata: {},
    };
    const deltas: any[] = [];
    storage.onAnswersChanged((_tabId, delta) => deltas.push(delta));
    await storage.writeAnswers(tab.id, { ...defaultAnswerFile(), revision: 1, updatedAt: now, answers: [answer] });

    expect((await storage.readTab(tab.id)).answers.answers[0].metadata.documentBasePath).toBe(workspace);
    expect((await storage.readTabWindow(tab.id)).answers.answers[0].metadata.documentBasePath).toBeUndefined();
    expect((await storage.readAnswerPage(tab.id, 1, 1)).records[0].metadata.documentBasePath).toBeUndefined();
    expect(deltas[0].upserts[0].metadata.documentBasePath).toBeUndefined();
  });
});

describe("document HTTP boundary", () => {
  it("requires loopback browser provenance for desktop side effects", () => {
    expect(isLocalBrowserRequest({ host: "127.0.0.1:4317", origin: "http://localhost:4317" })).toBe(true);
    expect(isLocalBrowserRequest({ host: "127.0.0.1:4317", origin: "https://remote.example" })).toBe(false);
    expect(isLocalBrowserRequest({ host: "127.0.0.1:4317" })).toBe(false);
  });

  it("serves raw immutable chunks while keeping opens and errors no-store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-document-http-"));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, "dist", "client"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html>", "utf8");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "readme.txt"), "small document", "utf8");
    const app = await createApp(root);
    apps.push(app);
    await app.ready();
    const tab = await app.promptor.storage.createTab("http");
    await app.promptor.storage.updateTab(tab.id, (current) => ({
      ...current,
      session: { ...current.session, state: "ready", threadId: "thread-http", sessionId: "thread-http", workingDirectory: workspace },
      updatedAt: isoNow(),
    }));
    const headers = { "x-codex-promptor-token": app.promptor.token };

    const openedResponse = await app.inject({ method: "POST", url: "/api/documents/open", headers, payload: { tabId: tab.id, href: "./readme.txt" } });
    expect(openedResponse.statusCode).toBe(200);
    expect(openedResponse.headers["cache-control"]).toBe("no-store");
    const opened = openedResponse.json().data;
    const chunk = await app.inject({ method: "GET", url: `/api/documents/${opened.docId}/chunks/0?rev=${opened.revision}`, headers });
    expect(chunk.statusCode).toBe(200);
    expect(chunk.body).toBe("small document");
    expect(chunk.headers["cache-control"]).toContain("immutable");
    expect(chunk.headers.vary).toContain("x-codex-promptor-token");
    expect(chunk.headers.etag).toBe(`W/\"${opened.docId}.${opened.revision}.0\"`);

    const failed = await app.inject({ method: "GET", url: `/api/documents/${opened.docId}/chunks/99?rev=${opened.revision}`, headers });
    expect(failed.statusCode).toBe(416);
    expect(failed.headers["cache-control"]).toBe("no-store");

    const unauthorized = await app.inject({ method: "GET", url: `/api/documents/${opened.docId}/chunks/0?rev=${opened.revision}` });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["cache-control"]).toBe("no-store");
  });
});

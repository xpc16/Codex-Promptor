/**
 * The bytes both ends already know, so no frame has to carry them.
 *
 * Measured on two weeks of tunnel traffic (TRAFFIC_OPTIMIZATION.md §2.11): a
 * projection delta sealed to 464 B, and 360 B of that was a header that never
 * changes between frames -- field names, enum values, the skeleton of a row.
 * Compressing each frame on its own cannot remove it: every frame is the
 * first time the compressor has seen those strings. A preset dictionary makes
 * them the *second* time. The same one-row delta sealed with this dictionary
 * measured 227 B.
 *
 * This is deliberately not cross-frame compression. Each frame is still
 * deflated independently; the dictionary is a fixed, public byte string with
 * no user data in it, so the compression side channel discussed in
 * TRAFFIC_OPTIMIZATION.md §5.5 is exactly what it was without it.
 *
 * It is built from sample messages rather than a list of words because
 * deflate matches substrings: `"clearToEnd":true,"runs":[{"text":"` is worth
 * more as one run than as four tokens. Values are placeholders. The most
 * frequent shapes go last -- deflate encodes a match by its distance back,
 * and the end of the dictionary is the cheapest place to point at.
 *
 * Both ends must hold the same bytes. They negotiate by `DICTIONARY_DIGEST`
 * (the SHA-256 of the bytes, first 16 bytes, hex), which a test pins to the
 * bytes: change the samples and the test fails until the digest is updated,
 * and a page built before the change offers a digest the server no longer
 * recognises and simply gets no dictionary.
 */

const STYLE = { fg: "default", bg: "default", flags: [] as string[] };
const RUNNER = {
  desiredState: "running", state: "running", activePromptId: "", activeTurnId: "", lastError: null,
  stalledSince: null, lastTransitionAt: "2026-01-01T00:00:00.000Z",
};

/** Least frequent first, most frequent last. */
const SAMPLES: unknown[] = [
  // Bundle sections carried by `snapshot`, `prompts.changed`, `answers.changed`, `tab.changed`.
  {
    type: "snapshot", tabId: "", sequence: 0,
    snapshotTags: { tab: "", prompts: "", answers: "", runtime: "" },
    data: {
      tab: { id: "", name: "", groupId: null, order: 0, createdAt: "", updatedAt: "", session: { provider: "codex", state: "ready", threadId: "", sessionId: null, workingDirectory: "", reopenOnLaunch: true, lastError: null }, layout: null },
      prompts: { schemaVersion: 1, revision: 0, updatedAt: "", prompts: [{ id: "", text: "", status: "pending", createdAt: "", updatedAt: "", origin: "queue", threadId: null, startedAt: null, completedAt: null, codexTurnId: null, clientUserMessageId: null, attempts: [{ id: "", startedAt: "", completedAt: null, status: "running", submittedText: "" }], inputSnapshot: null, timerId: null, timerOccurrenceId: null, timerAutoRun: false, error: null }] },
      answers: { schemaVersion: 1, revision: 0, updatedAt: "", answers: [{ id: "", promptId: "", threadId: "", codexTurnId: "", origin: "queue", prompt: "", status: "completed", finalAnswer: "", captureMode: "final", startedAt: "", completedAt: "", recordedAt: "", clientUserMessageId: null, error: null, metadata: null }] },
      runtime: { schemaVersion: 1, revision: 0, runner: RUNNER, terminal: { state: "running", lastExitCode: null, lastStartedAt: "", lastError: null, appServer: null, cols: 120, rows: 30 }, reconciliation: { required: false, lastCompletedAt: null }, queueConfig: { onFailure: "pause" } },
    },
  },
  { type: "prompts.changed", tabId: "", sequence: 0, delta: { revision: 0, updatedAt: "", total: 0, upserts: [], deletedIds: [], order: [] } },
  { type: "answers.changed", tabId: "", sequence: 0, delta: { revision: 0, updatedAt: "", total: 0, upserts: [], deletedIds: [] } },
  { type: "index.changed", delta: { from: 0, revision: 0, updatedAt: "", tabs: { revision: 0, updatedAt: "", total: 0, upserts: [], deletedIds: [], order: [] }, groups: { revision: 0, updatedAt: "", total: 0, upserts: [], deletedIds: [] }, ui: { lastSelectedTabId: "" } } },
  // Subscriptions and the small state events.
  { type: "subscribe", terminalProtocolVersion: 2, tabIds: [""], allTabs: true, snapshots: true, details: true, index: true, indexRevision: 0, snapshotTags: {}, terminals: { "": { mode: "projection", viewportRows: 30, fps: 2, generation: "", revision: 0, sizeEpoch: 0 } } },
  { type: "terminal.subscription", tabId: "", mode: "projection", streamId: "", viewportRows: 30, fps: 2, writable: true, sequence: 0 },
  { type: "terminal.state", tabId: "", sequence: 0, state: "running", cols: 120, rows: 30 },
  { type: "answer.activity", tabId: "", sequence: 0, answerId: "", completedAt: "", status: "completed", origin: "queue" },
  { type: "error", error: { code: "", message: "" } },
  { type: "ti", s: "", d: "" },
  // The lights, on every tab, on every runner transition.
  { type: "runner.changed", tabId: "", sequence: 0, delta: { from: 0, revision: 0, runner: RUNNER } },
  // The tunnel's main flow: a projection frame. Header once, then one row of each kind.
  {
    type: "terminal.screen", tabId: "", generation: "", streamId: "", sequence: 0, revision: 0, full: false,
    cols: 120, totalRows: 0, viewportTop: 0, viewportRows: 30, alternateScreen: false, sizeEpoch: 0,
    inputModes: { applicationCursorKeys: false, applicationKeypad: false, bracketedPaste: true, mouseTracking: "none", sendFocus: false },
    cursor: { row: 0, col: 0, visible: true },
    rows: [
      { row: 0, clearToEnd: true, isWrapped: true, runs: [{ text: "", style: { fg: 2, bg: "default", flags: ["bold", "dim", "italic", "underline", "inverse"] } }] },
      { row: 0, clearToEnd: true, runs: [{ text: "", style: STYLE }, { text: "", style: STYLE }] },
    ],
    scroll: { top: 0, bottom: 29, lines: 1 },
  },
];

function buildDictionary(): Uint8Array {
  // ASCII only, by construction of the samples, so the byte string is the
  // same wherever JSON.stringify and TextEncoder run.
  return new TextEncoder().encode(SAMPLES.map((sample) => JSON.stringify(sample)).join(""));
}

export const DICTIONARY_D1: Uint8Array = buildDictionary();

/**
 * SHA-256 of DICTIONARY_D1, first 16 bytes, hex. Pinned by a test, and the
 * only thing that crosses the wire about the dictionary.
 */
export const DICTIONARY_DIGEST = "d1:8650f5e533a45649b76169b48b50b635";

/** What a client offers, and what a server confirms: the digest, or nothing. */
export function dictionaryOffered(value: unknown): boolean {
  return value === DICTIONARY_DIGEST;
}

/**
 * Deflate wants the dictionary's *bytes* to be identical on both ends; a
 * digest that lines up with a different byte string would open every frame
 * into noise. Both ends therefore also check their own bytes against the
 * digest they advertise, at startup, and refuse to offer it if they differ.
 */
export async function digestOf(bytes: Uint8Array, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const hash = new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
  return `d1:${Array.from(hash.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

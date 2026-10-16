import { useEffect, useRef } from "react";
import { KEY_CHANGED_CLOSE_CODE } from "../shared/e2ee-handshake.js";
import { applyIndexDelta } from "../shared/index-delta.js";
import type { RuntimeDelta } from "../shared/runtime-delta.js";
import type { IndexFile, RuntimeFile } from "../shared/schemas.js";
import type { TabActivitySummary } from "../shared/tab-activity.js";
import { deriveSessionKey } from "./e2ee-client.js";
import { noteSocketClosed, type E2eeState } from "./e2ee-gate.js";
import type { Device } from "./device.js";
import { shouldAdoptIndexRevision } from "./index-sync.js";
import { reconnectDelay } from "./socket-retry.js";

/**
 * Another machine's sidebar, kept live (docs/MULTI_DEVICE_FEDERATION_IMPLEMENTATION.md §9.4).
 *
 * One navigation socket per machine, subscribed exactly as the page's own:
 * every conversation's lights and the index, no details, no terminals. Only
 * the conversation actually open subscribes to more, through its own view.
 * Nothing here is cached across reloads: a machine this page has never
 * reached shows its name and state and no invented list.
 */

export type RemoteDeviceState = {
  index: IndexFile | null;
  activities: Record<string, TabActivitySummary>;
  e2ee: E2eeState;
  kdf: { salt: string; iterations: number } | null;
  /** That machine's own bootstrap `app` section: providers, terminal capabilities. */
  app: any | null;
  connected: boolean;
  /** When its list last came from the machine itself, for "offline since". */
  updatedAt: number | null;
};

export function initialRemoteState(device: Device): RemoteDeviceState {
  return { index: null, activities: {}, e2ee: device.gate.e2eeState(), kdf: null, app: null, connected: false, updatedAt: null };
}

type Update = (current: RemoteDeviceState) => RemoteDeviceState;

/** The runner section a message carries, whether as a whole runtime or a delta. */
function runnerSectionOf(message: any): RuntimeFile["runner"] | undefined {
  if (message?.type !== "runner.changed") return undefined;
  return (message.runner as RuntimeFile | undefined)?.runner ?? (message.delta as RuntimeDelta | undefined)?.runner;
}

/** A finished queue or timer answer, which is what lights the completion mark. */
function queueCompletionOf(message: any): string | null {
  if (message?.type !== "answer.activity" && message?.type !== "answer.added") return null;
  const origin = message.origin ?? message.answer?.origin;
  const status = message.status ?? message.answer?.status;
  if ((origin !== "queue" && origin !== "timer") || status !== "completed") return null;
  return String(message.completedAt ?? message.answer?.completedAt ?? message.answer?.recordedAt ?? "");
}

export function RemoteDeviceSync({ device, online, onChange, onCompletion, onError }: {
  device: Device;
  online: boolean;
  onChange: (deviceId: string, update: Update) => void;
  onCompletion: (tabKey: string, completedAt: string | null, audible: boolean) => void;
  onError: (error: unknown) => void;
}): null {
  const callbacks = useRef({ onChange, onCompletion, onError });
  callbacks.current = { onChange, onCompletion, onError };
  const indexRef = useRef<IndexFile | null>(null);
  const appliedRevision = useRef(-1);
  const update = (change: Update) => callbacks.current.onChange(device.id, change);

  const adoptIndex = (next: IndexFile) => {
    if (!shouldAdoptIndexRevision(next.revision, appliedRevision.current)) return;
    appliedRevision.current = next.revision;
    indexRef.current = next;
    update((current) => ({ ...current, index: next, updatedAt: Date.now() }));
  };

  const adoptNavigation = (navigation: { index: IndexFile; activities: Record<string, TabActivitySummary> }) => {
    adoptIndex(navigation.index);
    update((current) => ({ ...current, activities: navigation.activities }));
    for (const [tabId, activity] of Object.entries(navigation.activities)) {
      callbacks.current.onCompletion(device.cacheKey(tabId), activity.lastQueueCompletedAt, false);
    }
  };

  /** That machine's bootstrap: whether it wants a key, what it can do, and -- when no key is needed -- its list. */
  const loadBootstrap = async () => {
    try {
      const data = await device.api<{ index: IndexFile | null; activities: Record<string, TabActivitySummary> | null; app: any; e2ee?: { required: boolean; fingerprint?: string; salt?: string; iterations?: number } }>("/api/bootstrap");
      await device.gate.applyRequirement(data.e2ee);
      update((current) => ({
        ...current,
        app: data.app ?? null,
        kdf: data.e2ee?.required ? { salt: data.e2ee.salt ?? "", iterations: data.e2ee.iterations ?? 0 } : null,
      }));
      if (data.index && data.activities) adoptNavigation({ index: data.index, activities: data.activities });
      else if (device.gate.e2eeState().proved) adoptNavigation(await device.api("/api/navigation"));
    } catch (error) {
      callbacks.current.onError(error);
    }
  };

  useEffect(() => device.gate.observe((e2ee) => update((current) => ({ ...current, e2ee }))), [device]); // eslint-disable-line react-hooks/exhaustive-deps

  // Proved: read what bootstrap withheld.
  const proved = useRef(false);
  useEffect(() => device.gate.observe((e2ee) => {
    if (e2ee.required && e2ee.proved && !proved.current) {
      proved.current = true;
      device.api<{ index: IndexFile; activities: Record<string, TabActivitySummary> }>("/api/navigation")
        .then(adoptNavigation, (error) => callbacks.current.onError(error));
    }
    if (!e2ee.proved) proved.current = false;
  }), [device]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!online) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let failures = 0;
    void loadBootstrap();

    const connect = () => {
      if (disposed) return;
      const live = new WebSocket(device.wsUrl());
      socket = live;
      live.binaryType = "arraybuffer";
      const subscribe = (withRevision = true) => device.gate.send(live, JSON.stringify({
        type: "subscribe",
        allTabs: true,
        index: true,
        snapshots: false,
        details: false,
        indexRevision: withRevision ? indexRef.current?.revision ?? null : null,
      }));
      // Everything sent before the handshake was refused; ask again once proved.
      device.gate.attachSocket(live, () => subscribe());
      live.onopen = () => {
        failures = 0;
        update((current) => ({ ...current, connected: true }));
        subscribe();
      };
      live.onmessage = async (event) => {
        const message = await device.gate.receive(live, event.data);
        if (!message) return;
        const tabId = typeof message.tabId === "string" ? message.tabId : "";
        const runner = runnerSectionOf(message);
        const completedAt = queueCompletionOf(message);
        if (runner && tabId) {
          update((current) => ({
            ...current,
            activities: {
              ...current.activities,
              [tabId]: {
                runnerState: runner.state,
                desiredState: runner.desiredState,
                activePromptId: runner.activePromptId,
                activeTurnId: runner.activeTurnId,
                lastQueueCompletedAt: current.activities[tabId]?.lastQueueCompletedAt ?? null,
              },
            },
          }));
        } else if (completedAt !== null && tabId) {
          update((current) => ({
            ...current,
            activities: {
              ...current.activities,
              [tabId]: {
                runnerState: current.activities[tabId]?.runnerState ?? "paused",
                desiredState: current.activities[tabId]?.desiredState ?? "paused",
                activePromptId: current.activities[tabId]?.activePromptId ?? null,
                activeTurnId: current.activities[tabId]?.activeTurnId ?? null,
                lastQueueCompletedAt: completedAt,
              },
            },
          }));
          callbacks.current.onCompletion(device.cacheKey(tabId), completedAt, true);
        } else if (message.type === "index.changed") {
          if (message.index) adoptIndex(message.index as IndexFile);
          else if (message.delta) {
            const next = indexRef.current ? applyIndexDelta(indexRef.current, message.delta) : null;
            // A delta that does not line up cannot be applied halfway: ask for
            // the whole index again, which always applies.
            if (next) adoptIndex(next);
            else subscribe(false);
          }
        }
      };
      live.onclose = (event) => {
        noteSocketClosed(event.code);
        if (socket === live) socket = null;
        update((current) => ({ ...current, connected: false }));
        if (disposed) return;
        // The key changed on that machine: ask its bootstrap what is true now.
        if (event.code === KEY_CHANGED_CLOSE_CODE) void loadBootstrap();
        failures += 1;
        retryTimer = window.setTimeout(connect, reconnectDelay(failures));
      };
    };
    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      try { socket?.close(); } catch { /* gone */ }
      update((current) => ({ ...current, connected: false }));
    };
  }, [device, online]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

/**
 * One passphrase, every machine it opens.
 *
 * Each machine has its own salt, so the same passphrase derives a different
 * key for each; a key is handed only to the gate whose fingerprint it
 * matches. The passphrase is used here and not kept. Returns how many
 * machines took it.
 */
export async function unlockWithPassphrase(
  passphrase: string,
  devices: ReadonlyArray<{ device: Device; kdf: { salt: string; iterations: number } | null }>,
): Promise<number> {
  let unlocked = 0;
  for (const { device, kdf } of devices) {
    const state = device.gate.e2eeState();
    if (!state.required || state.proved || !kdf) continue;
    const key = await deriveSessionKey(passphrase, kdf.salt, kdf.iterations);
    if (state.fingerprint && key.fingerprint !== state.fingerprint) continue;
    await device.gate.useKey(key);
    unlocked += 1;
  }
  return unlocked;
}

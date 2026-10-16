import { createContext, useContext } from "react";
import { isLoopbackHostname } from "../shared/document-link.js";
import { createApiClient, promptorToken, type ApiClient } from "./api-client.js";
import { E2eeGate, homeGate } from "./e2ee-gate.js";

/**
 * A machine this page can reach (docs/MULTI_DEVICE_FEDERATION_IMPLEMENTATION.md §9.2).
 *
 * A component takes the device it belongs to when it is created and sends
 * every request through it. Nothing reads a global "current device": a reply
 * that arrives after the reader moved to another machine can then only ever
 * land where its request came from.
 *
 * The machine serving the page -- the home device -- keeps the plain `/api/…`
 * and `/ws` addresses and the plain tab ids as cache keys, so a page with one
 * machine behaves exactly as it always has. Every other device is reached
 * under `/d/<id>/` and keys its caches as `<id>/<tabId>`.
 */
export type Device = ApiClient & {
  /** The federation device id; "local" while federation is off. */
  id: string;
  home: boolean;
  prefix: string;
  /**
   * The home device on a loopback page: the full raw terminal, the native
   * folder picker, opening files in desktop apps, export. Never true for a
   * device reached through another machine, even from a loopback page.
   */
  native: boolean;
  gate: E2eeGate;
  wsUrl(): string;
  cacheKey(tabId: string): string;
};

export const LOCAL_DEVICE_ID = "local";

const pageIsLoopback = (): boolean => typeof location !== "undefined" && isLoopbackHostname(location.hostname);

function socketBase(): string {
  if (typeof location === "undefined") return "";
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

function build(id: string, home: boolean, gate: E2eeGate): Device {
  const prefix = home ? "" : `/d/${id}`;
  return {
    ...createApiClient({ prefix, gate }),
    id,
    home,
    prefix,
    native: home && pageIsLoopback(),
    gate,
    // The page's token authenticates it to the machine serving it; that
    // machine forwards with its own credentials.
    wsUrl: () => `${socketBase()}${prefix}/ws${promptorToken ? `?token=${encodeURIComponent(promptorToken)}` : ""}`,
    cacheKey: (tabId: string) => home ? tabId : `${id}/${tabId}`,
  };
}

let homeDeviceValue: Device = build(LOCAL_DEVICE_ID, true, homeGate);
const remote = new Map<string, Device>();

/** The machine serving this page. */
export function homeDevice(): Device { return homeDeviceValue; }

/**
 * Gives the home device its federation id once the page knows it. The id is
 * only a label for it -- its addresses and cache keys do not change -- so a
 * page that learns it late has nothing to migrate.
 */
export function setHomeDeviceId(id: string | null): Device {
  const next = id ?? LOCAL_DEVICE_ID;
  if (homeDeviceValue.id !== next) homeDeviceValue = { ...homeDeviceValue, id: next };
  return homeDeviceValue;
}

/** One object per machine for the life of the page, so its gate and its sockets' state persist. */
export function deviceFor(id: string): Device {
  if (id === homeDeviceValue.id) return homeDeviceValue;
  let device = remote.get(id);
  if (!device) { device = build(id, false, new E2eeGate()); remote.set(id, device); }
  return device;
}

/** A device the workspace no longer lists: its gate and key go with it. */
export function forgetDevice(id: string): void {
  remote.delete(id);
}

/** A tab key names a tab on a device: the plain id at home, `<deviceId>/<tabId>` elsewhere. */
export function splitTabKey(key: string): { deviceId: string | null; tabId: string } {
  const slash = key.indexOf("/");
  return slash === -1 ? { deviceId: null, tabId: key } : { deviceId: key.slice(0, slash), tabId: key.slice(slash + 1) };
}

export const DeviceContext = createContext<Device | null>(null);

/** The device of the conversation being rendered; the home device outside any. */
export function useDevice(): Device {
  return useContext(DeviceContext) ?? homeDeviceValue;
}

/**
 * Which link a byte travelled over.
 *
 * The 24h ledger sample that prompted this could not answer "how much of that
 * went over the public internet", because every connection was pooled into one
 * total. Without the answer there is no way to size a tunnel, and no way to
 * tell an expensive remote habit from a free local one.
 *
 * Two layers, deliberately separated by how much they can be trusted:
 *
 *   - The peer address comes from the socket. A client cannot forge it, so the
 *     loopback / not-loopback split is authoritative.
 *   - `local` vs `tunnel` splits the loopback half using the Host header,
 *     because a relay running on this machine (cloudflared, an SSH forward)
 *     reaches the origin from 127.0.0.1 exactly like the local browser does.
 *     Host is client-controlled, so this refinement is an attribution hint for
 *     capacity planning -- never an access-control decision.
 */

export type NetworkScope = "local" | "tunnel" | "remote";

export const NETWORK_SCOPES: readonly NetworkScope[] = ["local", "tunnel", "remote"];

const LOOPBACK = /^(?:::1|::ffff:127\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+)$/;

export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  return LOOPBACK.test(address.trim().toLowerCase());
}

/** Host header without its port, lowercased; brackets kept off IPv6 literals. */
export function hostname(host: string | undefined | null): string {
  const value = String(host ?? "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]") > 0 ? value.indexOf("]") : undefined);
  const colon = value.lastIndexOf(":");
  return colon > 0 && !value.slice(colon + 1).includes(".") ? value.slice(0, colon) : value;
}

export function isLoopbackHostname(host: string | undefined | null): boolean {
  const name = hostname(host);
  return name === "localhost" || name === "::1" || /^127\.\d+\.\d+\.\d+$/.test(name);
}

export function classifyNetworkScope(
  remoteAddress: string | undefined | null,
  host: string | undefined | null,
): NetworkScope {
  if (!isLoopbackAddress(remoteAddress)) return "remote";
  // Reached loopback under a name that is not loopback: something on this
  // machine forwarded it here, which for capacity purposes is remote traffic.
  return isLoopbackHostname(host) ? "local" : "tunnel";
}

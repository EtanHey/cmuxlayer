import { realpathSync, statSync } from "node:fs";

export interface CmuxObserverIdentity {
  /** Stable for one bound cmux Unix socket node; safe to persist as ownership. */
  ownerId: string;
  /** Process-local transport epoch; use for cache and in-flight observation guards. */
  epoch: string;
}

interface ObserverIdentityClient {
  currentSocketPath?: () => string | null | undefined;
  currentObserverTransportEpoch?: () => string | null | undefined;
}

function currentSocketPath(
  client: unknown,
  fallbackSocketPath: string | null | undefined,
): string | null {
  const candidate = client as ObserverIdentityClient | null | undefined;
  if (candidate && "currentSocketPath" in candidate) {
    if (typeof candidate.currentSocketPath !== "function") return null;
    try {
      return candidate.currentSocketPath()?.trim() || null;
    } catch {
      return null;
    }
  }
  return fallbackSocketPath?.trim() || null;
}

function currentTransportEpoch(client: unknown): string | null {
  const candidate = client as ObserverIdentityClient | null | undefined;
  if (!candidate || !("currentObserverTransportEpoch" in candidate)) {
    return "static";
  }
  if (typeof candidate.currentObserverTransportEpoch !== "function") return null;
  try {
    return candidate.currentObserverTransportEpoch()?.trim() || null;
  } catch {
    return null;
  }
}

export function deriveCmuxObserverIdentity(
  client: unknown,
  fallbackSocketPath: string | null | undefined =
    process.env.CMUX_SOCKET_PATH,
): CmuxObserverIdentity | null {
  const socketPath = currentSocketPath(client, fallbackSocketPath);
  if (!socketPath) return null;

  try {
    const canonicalPath = realpathSync.native(socketPath);
    const stats = statSync(canonicalPath, { bigint: true });
    if (!stats.isSocket()) return null;
    const ownerId =
      `cmux:${canonicalPath}#socket=` +
      `${stats.dev}:${stats.ino}:${stats.birthtimeNs}:${stats.ctimeNs}`;
    const transportEpoch = currentTransportEpoch(client);
    if (!transportEpoch) return null;
    return { ownerId, epoch: `${ownerId}@${transportEpoch}` };
  } catch {
    return null;
  }
}

export function deriveCmuxObserverOwnerId(
  client: unknown,
  fallbackSocketPath?: string | null,
): string | null {
  return deriveCmuxObserverIdentity(client, fallbackSocketPath)?.ownerId ?? null;
}

export function deriveCmuxObserverEpoch(
  client: unknown,
  fallbackSocketPath?: string | null,
): string | null {
  return deriveCmuxObserverIdentity(client, fallbackSocketPath)?.epoch ?? null;
}

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliType } from "./agent-types.js";

export type SeatPermissionMode = "skip-permissions" | "default";

export interface SeatManifest {
  surface_id: string;
  /** Stable cmux surface UUID when the creating transport supplied it. */
  surface_uuid?: string | null;
  agent_id: string;
  tab_name: string;
  session_name: string | null;
  model: string;
  permission_mode: SeatPermissionMode;
  cwd: string;
  repo: string;
  cli: CliType;
  updated_at: string;
}

export type SeatManifestWriter = (manifest: SeatManifest) => Promise<void>;

function isRealDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where seat manifests are published.
 *
 * AIDEV-NOTE (E0 sweep): the historical default writes into a *sibling repo's*
 * checkout, and `mkdir -p` would happily conjure that whole tree on a machine
 * that has no such repo. The legacy path is kept when it genuinely exists, so
 * installs that depend on it are untouched; anywhere else this lands in the
 * XDG-style state directory the daemon socket already uses.
 */
export function defaultSeatManifestDir(
  env: NodeJS.ProcessEnv = process.env,
  isDirectory: (path: string) => boolean = isRealDirectory,
): string {
  const override = env.CMUXLAYER_SEAT_MANIFEST_DIR?.trim();
  if (override) return override;

  const home = env.HOME?.trim() || homedir();
  const legacyRoot = join(home, "Gits", "orchestrator", "docs.local");
  if (isDirectory(legacyRoot)) {
    return join(legacyRoot, "monitor-state", "seat-manifests");
  }
  return join(home, ".local", "state", "cmuxlayer", "seat-manifests");
}

export function seatManifestFileName(surfaceId: string): string {
  return `${surfaceId.replace(/[^A-Za-z0-9._-]/g, "-")}.json`;
}

export function createFileSystemSeatManifestWriter(opts?: {
  directory?: string;
}): SeatManifestWriter {
  const directory = opts?.directory ?? defaultSeatManifestDir();

  return async (manifest) => {
    await mkdir(directory, { recursive: true });
    const fileName = seatManifestFileName(manifest.surface_id);
    const targetPath = join(directory, fileName);
    const temporaryPath = join(directory, `.${fileName}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, targetPath);
  };
}

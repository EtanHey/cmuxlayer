import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliType } from "./agent-types.js";

export type SeatPermissionMode = "skip-permissions" | "default";

export interface SeatManifest {
  surface_id: string;
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

export function defaultSeatManifestDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CMUXLAYER_SEAT_MANIFEST_DIR?.trim();
  if (override) return override;

  const home = env.HOME?.trim() || homedir();
  return join(
    home,
    "Gits",
    "orchestrator",
    "docs.local",
    "monitor-state",
    "seat-manifests",
  );
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

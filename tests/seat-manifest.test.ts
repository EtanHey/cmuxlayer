import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileSystemSeatManifestWriter,
  defaultSeatManifestDir,
  seatManifestFileName,
  type SeatManifest,
} from "../src/seat-manifest.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("seat manifest", () => {
  it("uses the orchestrator monitor-state directory unless the env override is set", () => {
    expect(defaultSeatManifestDir({ HOME: "/Users/test" })).toBe(
      "/Users/test/Gits/orchestrator/docs.local/monitor-state/seat-manifests",
    );
    expect(
      defaultSeatManifestDir({
        HOME: "/Users/test",
        CMUXLAYER_SEAT_MANIFEST_DIR: "/tmp/seat-state",
      }),
    ).toBe("/tmp/seat-state");
  });

  it("sanitizes colon-delimited surface ids for the manifest filename", () => {
    expect(seatManifestFileName("surface:42")).toBe("surface-42.json");
  });

  it("atomically writes the exact expected-state schema to an injected directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-seat-manifest-"));
    roots.push(dir);
    const writer = createFileSystemSeatManifestWriter({ directory: dir });
    const manifest: SeatManifest = {
      surface_id: "surface:42",
      surface_uuid: "11111111-2222-4333-8444-555555555555",
      agent_id: "cmuxlayer-codex",
      tab_name: "cmuxlayerCodex [surface:42]",
      session_name: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      model: "fable-5",
      permission_mode: "skip-permissions",
      cwd: "/Users/test/Gits/cmuxlayer",
      repo: "cmuxlayer",
      cli: "codex",
      updated_at: "2026-07-12T12:00:00.000Z",
    };

    await writer(manifest);

    expect(
      JSON.parse(readFileSync(join(dir, "surface-42.json"), "utf8")),
    ).toEqual(manifest);
  });
});

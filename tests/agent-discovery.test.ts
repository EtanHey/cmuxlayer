import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AgentDiscovery,
  discoveredStatusToAgentState,
  inferRepoFromDiscovery,
} from "../src/agent-discovery.js";

const deadCodexShellFixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/live/codex-dead-pane-shell-with-stale-banner.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { lines_80: string };

describe("AgentDiscovery", () => {
  it("uses managed registry identity instead of parsing a role-first display title", async () => {
    const discovery = new AgentDiscovery({
      listSurfaces: async () => [
        {
          ref: "surface:managed",
          title: "run1 name-the-tabs",
          type: "terminal",
          index: 0,
          selected: true,
        },
      ],
      managedIdentityProvider: () => ({
        repo: "cmuxlayer",
        cli: "codex",
        role: "worker",
      }),
      readScreen: async (surface) => ({
        surface,
        text: "Select an action:\n> 1. Continue\n  2. Cancel\n",
        lines: 3,
        scrollback_used: false,
      }),
    });

    const [managed] = await discovery.scan(true);

    expect(managed).toMatchObject({
      cli: "codex",
      managed_repo: "cmuxlayer",
      managed_role: "worker",
    });
    expect(inferRepoFromDiscovery(managed!)).toBe("cmuxlayer");
  });

  it("keeps a frozen discovered agent non-terminal while it waits for input", () => {
    expect(discoveredStatusToAgentState("frozen")).toBe("error");
  });

  it("derives a repo root instead of a nested cwd basename", () => {
    expect(
      inferRepoFromDiscovery({
        current_directory: "/home/test-user/Gits/cmuxlayer/src",
        working_directory_source: "surface",
        surface_title: "cmuxlayerClaude",
      }),
    ).toBe("cmuxlayer");
  });

  it("ignores workspace fallback cwd when the title carries repo identity", () => {
    expect(
      inferRepoFromDiscovery({
        current_directory: "/home/test-user/Gits/unrelated-workspace",
        working_directory_source: "workspace_fallback",
        surface_title: "cmuxlayerClaude",
      }),
    ).toBe("cmuxlayer");
  });

  it("falls back to title when a trusted cwd has no recognizable repo root", () => {
    expect(
      inferRepoFromDiscovery({
        current_directory: "/home/test-user/scratch/misc",
        working_directory_source: "surface",
        surface_title: "cmuxlayerClaude",
      }),
    ).toBe("cmuxlayer");
  });

  it("retains the working-directory evidence source in discovery", async () => {
    const discovery = new AgentDiscovery({
      listSurfaces: async () => [
        {
          ref: "surface:cwd-source",
          title: "cmuxlayerCodex",
          type: "terminal",
          index: 0,
          selected: true,
          current_directory: "/home/test-user/Gits/cmuxlayer/src",
          working_directory_source: "terminal_metadata",
        },
      ],
      readScreen: async (surface) => ({
        surface,
        text: "codex> ",
        lines: 1,
        scrollback_used: false,
      }),
    });

    await expect(discovery.scan(true)).resolves.toMatchObject([
      { working_directory_source: "terminal_metadata" },
    ]);
  });

  it("keeps dead Codex identity while exposing the active shell control state", async () => {
    const discovery = new AgentDiscovery({
      listSurfaces: async () => [
        {
          ref: "surface:dead-codex",
          title: "cmuxlayerCodex",
          type: "terminal",
          index: 0,
          selected: true,
        },
      ],
      readScreen: async (surface) => ({
        surface,
        text: deadCodexShellFixture.lines_80,
        lines: 30,
        scrollback_used: false,
      }),
    });

    await expect(discovery.scan(true)).resolves.toMatchObject([
      {
        surface_id: "surface:dead-codex",
        cli: "codex",
        has_agent: true,
        parsed_status: "idle",
        control_state: "shell",
      },
    ]);
  });

  it("reads each surface in its owning workspace", async () => {
    const readScreen = vi.fn().mockResolvedValue({
      surface: "surface:1",
      text: "codex> ",
      lines: 1,
      scrollback_used: false,
    });
    const discovery = new AgentDiscovery({
      listSurfaces: async () => [
        {
          id: "11111111-2222-4333-8444-555555555555",
          ref: "surface:1",
          title: "brainlayerCodex",
          type: "terminal",
          index: 0,
          selected: true,
          workspace_ref: "workspace:brainlayer",
        },
      ],
      readScreen,
    });

    const result = await discovery.scan(true);

    expect(result[0]?.workspace_id).toBe("workspace:brainlayer");
    expect(result[0]?.surface_uuid).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(readScreen).toHaveBeenCalledWith("surface:1", {
      lines: 30,
      workspace: "workspace:brainlayer",
    });
  });

  it("does not reuse a cached scan after the surface observer changes", async () => {
    let observerId = "cmux:/tmp/cmux-primary.sock";
    const listSurfaces = vi.fn(async () => [
      {
        id:
          observerId === "cmux:/tmp/cmux-primary.sock"
            ? "11111111-2222-4333-8444-555555555555"
            : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        ref:
          observerId === "cmux:/tmp/cmux-primary.sock"
            ? "surface:primary"
            : "surface:secondary",
        title: "cmuxlayerCodex",
        type: "terminal" as const,
        index: 0,
        selected: true,
        workspace_ref:
          observerId === "cmux:/tmp/cmux-primary.sock"
            ? "workspace:primary"
            : "workspace:secondary",
      },
    ]);
    const discovery = new AgentDiscovery({
      observerIdProvider: () => observerId,
      listSurfaces,
      readScreen: async (surface) => ({
        surface,
        text: "codex> ",
        lines: 1,
        scrollback_used: false,
      }),
    });

    await expect(discovery.scan(false)).resolves.toMatchObject([
      { surface_id: "surface:primary" },
    ]);

    observerId = "cmux:/tmp/cmux-secondary.sock";

    await expect(discovery.scan(false)).resolves.toMatchObject([
      { surface_id: "surface:secondary" },
    ]);
    expect(listSurfaces).toHaveBeenCalledTimes(4);
  });

  it("rejects a scan whose surface observer changes mid-enumeration", async () => {
    let observerId = "cmux:/tmp/cmux-primary.sock";
    const discovery = new AgentDiscovery({
      observerIdProvider: () => observerId,
      listSurfaces: async () => [
        {
          id: "11111111-2222-4333-8444-555555555555",
          ref: "surface:primary",
          title: "cmuxlayerCodex",
          type: "terminal",
          index: 0,
          selected: true,
          workspace_ref: "workspace:primary",
        },
      ],
      readScreen: async (surface) => {
        observerId = "cmux:/tmp/cmux-secondary.sock";
        return {
          surface,
          text: "codex> ",
          lines: 1,
          scrollback_used: false,
        };
      },
    });

    await expect(discovery.scan(true)).rejects.toThrow(
      /surface observer changed during discovery/i,
    );
  });

  it("rejects screen evidence when the stable UUID moves during read-screen", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    let moved = false;
    const discovery = new AgentDiscovery({
      observerIdProvider: () => "cmux:/tmp/cmux-primary.sock",
      listSurfaces: async () =>
        moved
          ? [
              {
                id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                ref: "surface:old",
                title: "foreignCodex",
                type: "terminal",
                index: 0,
                selected: true,
                workspace_ref: "workspace:old",
              },
              {
                id: stableUuid,
                ref: "surface:new",
                title: "cmuxlayerCodex",
                type: "terminal",
                index: 1,
                selected: false,
                workspace_ref: "workspace:new",
              },
            ]
          : [
              {
                id: stableUuid,
                ref: "surface:old",
                title: "cmuxlayerCodex",
                type: "terminal",
                index: 0,
                selected: true,
                workspace_ref: "workspace:old",
              },
            ],
      readScreen: async (surface) => {
        moved = true;
        return {
          surface,
          text: "codex> stale screen evidence",
          lines: 1,
          scrollback_used: false,
        };
      },
    });

    await expect(discovery.scan(true)).rejects.toThrow(
      /surface binding changed during discovery/i,
    );
  });

  it("does not cache scans while a configured observer identity is unknown", async () => {
    let surfaceRef = "surface:first";
    const listSurfaces = vi.fn(async () => [
      {
        ref: surfaceRef,
        title: "cmuxlayerCodex",
        type: "terminal" as const,
        index: 0,
        selected: true,
      },
    ]);
    const discovery = new AgentDiscovery({
      observerIdProvider: () => null,
      listSurfaces,
      readScreen: async (surface) => ({
        surface,
        text: "codex> ",
        lines: 1,
        scrollback_used: false,
      }),
    });

    await expect(discovery.scan(false)).resolves.toMatchObject([
      { surface_id: "surface:first" },
    ]);
    surfaceRef = "surface:second";

    await expect(discovery.scan(false)).resolves.toMatchObject([
      { surface_id: "surface:second" },
    ]);
    expect(listSurfaces).toHaveBeenCalledTimes(4);
  });

  it("retains TTL caching for legacy callers without an observer provider", async () => {
    let surfaceRef = "surface:first";
    const listSurfaces = vi.fn(async () => [
      {
        ref: surfaceRef,
        title: "cmuxlayerCodex",
        type: "terminal" as const,
        index: 0,
        selected: true,
      },
    ]);
    const discovery = new AgentDiscovery({
      listSurfaces,
      readScreen: async (surface) => ({
        surface,
        text: "codex> ",
        lines: 1,
        scrollback_used: false,
      }),
    });

    await expect(discovery.scan(false)).resolves.toMatchObject([
      { surface_id: "surface:first" },
    ]);
    surfaceRef = "surface:second";

    await expect(discovery.scan(false)).resolves.toMatchObject([
      { surface_id: "surface:first" },
    ]);
    expect(listSurfaces).toHaveBeenCalledTimes(2);
  });
});

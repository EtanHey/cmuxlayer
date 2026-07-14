import { describe, expect, it, vi } from "vitest";
import { AgentDiscovery } from "../src/agent-discovery.js";

describe("AgentDiscovery", () => {
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

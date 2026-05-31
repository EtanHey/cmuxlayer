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
    expect(readScreen).toHaveBeenCalledWith("surface:1", {
      lines: 30,
      workspace: "workspace:brainlayer",
    });
  });
});

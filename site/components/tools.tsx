interface Tool {
  name: string;
  desc: string;
}

const coreTools: Tool[] = [
  {
    name: "read_screen",
    desc: "Read terminal output with parsed agent status",
  },
  {
    name: "control_health",
    desc: "Inspect socket, binary, process, and control-plane health",
  },
  {
    name: "close_surface",
    desc: "Close a surface or managed agent with live-agent guards",
  },
  {
    name: "update_surface",
    desc: "Rename or move a terminal surface",
  },
  { name: "list_surfaces", desc: "List workspace, pane, and surface topology" },
];

const agentTools: Tool[] = [
  {
    name: "spawn_agent",
    desc: "Launch a Claude, Codex, Gemini, Cursor, or Kiro agent in a pane",
  },
  {
    name: "report_to_parent",
    desc: "Escalate a blocker to the direct parent agent",
  },
  {
    name: "send_to",
    desc: "Send text, commands, or keys to an agent or surface",
  },
  {
    name: "list_agents",
    desc: "List addressable agents with lifecycle state",
  },
  {
    name: "wait_for",
    desc: "Block until an agent reaches a target state",
  },
];

function ToolItem({ tool }: { tool: Tool }) {
  return (
    <div className="flex items-baseline gap-5 px-4 py-3 rounded-lg transition-colors duration-200 hover:bg-bg-elevated">
      <span className="font-mono text-[13px] font-medium text-accent min-w-[160px] shrink-0">
        {tool.name}
      </span>
      <span className="text-sm text-text-secondary font-light">
        {tool.desc}
      </span>
    </div>
  );
}

export function Tools() {
  return (
    <section className="py-[100px]" id="tools">
      <div className="max-w-[960px] mx-auto px-6">
        <div className="text-[11px] uppercase tracking-[0.12em] text-accent mb-3 text-center font-medium">
          MCP tools
        </div>
        <h2 className="font-display text-[clamp(26px,3.5vw,36px)] font-semibold tracking-[-0.025em] text-center mb-14 leading-[1.15]">
          Every operation is a tool call
        </h2>

        <div className="max-w-[640px] mx-auto mb-12">
          <div className="text-xs uppercase tracking-[0.1em] text-text-dim mb-4 pl-0.5 font-medium">
            Terminal and control
          </div>
          {coreTools.map((tool) => (
            <ToolItem key={tool.name} tool={tool} />
          ))}
        </div>

        <div className="h-px bg-border max-w-[640px] mx-auto my-2" />

        <div className="max-w-[640px] mx-auto mt-12">
          <div className="text-xs uppercase tracking-[0.1em] text-text-dim mb-4 pl-0.5 font-medium">
            Agent lifecycle &mdash; spawn and monitor
          </div>
          {agentTools.map((tool) => (
            <ToolItem key={tool.name} tool={tool} />
          ))}
        </div>
      </div>
    </section>
  );
}

interface Tool {
  name: string;
  desc: string;
}

const coreTools: Tool[] = [
  { name: "list_surfaces", desc: "Enumerate all surfaces across workspaces" },
  {
    name: "new_split",
    desc: "Create terminal or browser splits in any direction",
  },
  {
    name: "send_input",
    desc: "Type text into a surface as if from the keyboard",
  },
  {
    name: "send_key",
    desc: "Send key combos \u2014 Enter, Ctrl-C, Escape, arrows",
  },
  {
    name: "read_screen",
    desc: "Capture visible terminal output with optional scrollback",
  },
  { name: "rename_tab", desc: "Set the workspace tab title" },
  { name: "notify", desc: "Push macOS notifications from any surface" },
  {
    name: "set_status",
    desc: "Update sidebar status entries with icons and colors",
  },
  {
    name: "set_progress",
    desc: "Show a progress bar with label in the sidebar",
  },
  { name: "close_surface", desc: "Close a terminal or browser surface" },
  {
    name: "browser_surface",
    desc: "Open a scriptable browser alongside terminal panes",
  },
];

const agentTools: Tool[] = [
  {
    name: "spawn_agent",
    desc: "Launch a Claude, Codex, Gemini, or Cursor agent in a new pane",
  },
  {
    name: "send_to_agent",
    desc: "Deliver a message to a running agent",
  },
  {
    name: "read_agent_output",
    desc: "Capture an agent\u2019s latest terminal output",
  },
  {
    name: "get_agent_state",
    desc: "Check agent status: running, idle, waiting, done, error",
  },
  {
    name: "list_agents",
    desc: "Enumerate all active agents across workspaces",
  },
  {
    name: "wait_for",
    desc: "Block until an agent reaches a target state",
  },
  {
    name: "wait_for_all",
    desc: "Block until multiple agents finish in parallel",
  },
  {
    name: "stop_agent",
    desc: "Gracefully stop a running agent",
  },
  {
    name: "kill",
    desc: "Force-kill an unresponsive agent process",
  },
  {
    name: "interact",
    desc: "Send interactive input to an agent waiting for a response",
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
            Core &mdash; terminal operations
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

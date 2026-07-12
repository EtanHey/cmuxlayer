export const CMUXLAYER_DEFAULT_PALETTE_ENV =
  "CMUXLAYER_DEFAULT_PALETTE" as const;

export const REGISTERED_TOOL_NAMES = [
  "list_surfaces",
  "control_health",
  "register_monitor",
  "signal_monitor",
  "deregister_monitor",
  "list_monitors",
  "query_monitor_registry",
  "select_workspace",
  "create_workspace",
  "delete_workspace",
  "new_split",
  "new_surface",
  "move_surface",
  "send_input",
  "send_command",
  "send_key",
  "read_screen",
  "rename_tab",
  "notify",
  "set_status",
  "set_progress",
  "close_surface",
  "browser_surface",
  "dispatch_to_agent",
  "inbox_check",
  "spawn_agent",
  "new_worktree_split",
  "spawn_in_workspace",
  "wait_for",
  "wait_for_all",
  "get_agent_state",
  "list_agents",
  "broadcast",
  "resync_agents",
  "stop_agent",
  "send_to",
  "send_to_agent",
  "supersede_agent_goal",
  "read_agent_output",
  "interact",
  "kill",
  "my_agents",
] as const;

type ToolRegistrar = (...args: unknown[]) => unknown;

export interface PaletteExpansion {
  expanded: boolean;
  already_expanded: boolean;
  registered_tools: string[];
}

export interface DefaultToolPalette {
  shouldRegister(toolName: string): boolean;
  defer(toolName: string, args: unknown[]): unknown;
  warnAboutUnknownTools(): void;
  expand(register: ToolRegistrar): PaletteExpansion;
}

export function createDefaultToolPalette(
  rawValue: string | undefined,
  warn: (message: string) => void = console.warn,
): DefaultToolPalette | null {
  if (!rawValue?.trim()) {
    return null;
  }

  const requested = new Set(
    rawValue
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const known = new Set<string>(REGISTERED_TOOL_NAMES);
  const deferred = new Map<
    string,
    { args: unknown[]; updates: Array<Record<string, unknown>> }
  >();
  let expanded = false;

  return {
    shouldRegister(toolName) {
      return requested.has(toolName);
    },
    defer(toolName, args) {
      const registration = {
        args,
        updates: [] as Array<Record<string, unknown>>,
      };
      deferred.set(toolName, registration);
      return {
        update(update: Record<string, unknown>) {
          registration.updates.push(update);
        },
      };
    },
    warnAboutUnknownTools() {
      const unknown = [...requested].filter((name) => !known.has(name));
      if (unknown.length > 0) {
        warn(
          `[cmuxlayer] ${CMUXLAYER_DEFAULT_PALETTE_ENV} ignored unknown tool name${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
        );
      }
    },
    expand(register) {
      if (expanded) {
        return {
          expanded: false,
          already_expanded: true,
          registered_tools: [],
        };
      }

      expanded = true;
      const registeredTools = [...deferred.keys()];
      for (const registration of deferred.values()) {
        const registered = register(...registration.args) as {
          update?: (update: Record<string, unknown>) => void;
        };
        for (const update of registration.updates) {
          if (typeof registered?.update !== "function") {
            throw new Error(
              "Deferred tool registration did not return an update handle",
            );
          }
          registered.update(update);
        }
      }
      deferred.clear();
      return {
        expanded: true,
        already_expanded: false,
        registered_tools: registeredTools,
      };
    },
  };
}

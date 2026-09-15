import type { CmuxTerminalMetadata } from "./types.js";

export async function readRuntimeMetadata(
  read: () => Promise<{ terminals: CmuxTerminalMetadata[] }>,
  timeoutMs = 2_000,
): Promise<{ terminals: CmuxTerminalMetadata[] }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Runtime metadata unavailable")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SurfaceRuntimeNotStartedError extends Error {
  constructor(surface: string) {
    super(`surface_runtime_not_started (surface_not_realized): ${surface}; cmux runtime did not initialize after input demand (cmux #9769)`);
    this.name = "SurfaceRuntimeNotStartedError";
  }
}

/** Only call for a newly created, owned terminal, before typing its launcher. */
export async function initializeNewSurfaceRuntime(
  client: {
    listTerminalMetadata?: () => Promise<{ terminals: CmuxTerminalMetadata[] }>;
    sendKey: (surface: string, key: string, opts: { workspace?: string }) => Promise<unknown>;
  },
  surface: string,
  workspace: string | undefined,
  timeoutMs = 2_000,
  beforeMutation?: () => Promise<void>,
  surfaceUuid?: string,
): Promise<"unsupported" | "already_ready" | "input_demand"> {
  if (!client.listTerminalMetadata) return "unsupported";
  const read = async (remaining = Math.min(timeoutMs, 2_000)) => {
    const metadata = await readRuntimeMetadata(() => client.listTerminalMetadata!(), remaining);
    return metadata.terminals.find((item) =>
      (surfaceUuid ? item.surface_id === surfaceUuid ||
        (!item.surface_id && (item.surface_ref ?? item.ref) === surface) :
        [item.surface_ref, item.ref, item.surface_id].includes(surface)) &&
      (!workspace || !item.workspace_ref || item.workspace_ref === workspace));
  };
  const ready = (state: CmuxTerminalMetadata | undefined) =>
    state?.runtime_surface_ready === true &&
    typeof state.ghostty_surface_ptr === "string" &&
    /^0x[0-9a-f]+$/i.test(state.ghostty_surface_ptr) &&
    !/^0x0+$/i.test(state.ghostty_surface_ptr);
  let state = await read().catch(() => undefined);
  if (ready(state)) return "already_ready";
  await beforeMutation?.();
  // Input demand creates cmux's hidden bootstrap window. Ctrl-U leaves no
  // shell text and submits nothing; never use it on an existing surface.
  await client.sendKey(surface, "ctrl-u", { workspace });
  const deadline = Date.now() + Math.min(timeoutMs, 2_000);
  do {
    state = await read(Math.max(1, deadline - Date.now())).catch(() => undefined);
    if (ready(state)) return "input_demand";
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
  } while (Date.now() <= deadline);
  throw new SurfaceRuntimeNotStartedError(surface);
}

import type { CmuxTerminalMetadata } from "./types.js";

/** A wrapper method is not evidence that the native backend exposes metadata. */
export async function runtimeMetadataAvailable(client: {
  listSurfaceRuntimeMetadata?: () => Promise<{ terminals: CmuxTerminalMetadata[] }>;
  listTerminalMetadata?: () => Promise<{ terminals: CmuxTerminalMetadata[] }>;
}): Promise<boolean> {
  const read = client.listSurfaceRuntimeMetadata ?? client.listTerminalMetadata;
  return !!read && await readRuntimeMetadata(() => read.call(client))
    .then(({ terminals }) => terminals.some(item => typeof item.runtime_surface_ready === "boolean"))
    .catch(() => false);
}

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
    super(`surface_runtime_not_started (surface_not_realized): ${surface}; background runtime readiness could not be proven (cmux #9769); use focus:true to permit initialization focus`);
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
  focusFallback?: () => Promise<void>,
): Promise<"unsupported" | "already_ready" | "input_demand" | "focus"> {
  if (!client.listTerminalMetadata) {
    if (!focusFallback) return "unsupported";
    await beforeMutation?.();
    await focusFallback();
    return "focus";
  }
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
  const focus = async (): Promise<"focus"> => {
    await beforeMutation?.();
    await focusFallback!();
    // Legacy/unknown metadata uses focused shell readiness. If metadata is
    // available, focus must actually realize the owned runtime as well.
    const deadline = Date.now() + Math.min(timeoutMs, 2_000);
    do {
      state = await read(Math.max(1, deadline - Date.now())).catch(() => undefined);
      if (typeof state?.runtime_surface_ready !== "boolean" || ready(state)) return "focus";
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    } while (Date.now() <= deadline);
    throw new SurfaceRuntimeNotStartedError(surface);
  };
  if (focusFallback && typeof state?.runtime_surface_ready !== "boolean") return focus();
  await beforeMutation?.();
  // Input demand creates cmux's hidden bootstrap window. Ctrl-U leaves no
  // shell text and submits nothing; never use it on an existing surface.
  try {
    await client.sendKey(surface, "ctrl-u", { workspace });
  } catch {
    if (focusFallback) return focus();
    throw new SurfaceRuntimeNotStartedError(surface);
  }
  const deadline = Date.now() + Math.min(timeoutMs, 2_000);
  do {
    state = await read(Math.max(1, deadline - Date.now())).catch(() => undefined);
    if (ready(state)) return "input_demand";
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
  } while (Date.now() <= deadline);
  if (focusFallback) return focus();
  throw new SurfaceRuntimeNotStartedError(surface);
}

export class CmuxSocketError extends Error {
  readonly transport_phase?: "connect" | "write" | "response";
  retry_count?: number;
  transport_state?: string;

  constructor(
    message: string,
    public readonly code?: string,
    opts?: { transportPhase?: "connect" | "write" | "response" },
  ) {
    super(message);
    this.name = "CmuxSocketError";
    this.transport_phase = opts?.transportPhase;
  }
}

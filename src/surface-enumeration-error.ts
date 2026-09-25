// Malformed-enumeration error shared by the surface provider, list_agents and
// broadcast (moved out of server.ts, CX-3b S10a).

export class SurfaceEnumerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceEnumerationError";
  }
}

export function requireSurfaceEnumerationArray<T>(value: unknown, label: string): T[] {
  if (Array.isArray(value)) return value as T[];
  throw new SurfaceEnumerationError(
    `Malformed cmux surface enumeration: ${label} is not an array`,
  );
}

export function isSurfaceEnumerationError(error: unknown): boolean {
  return error instanceof SurfaceEnumerationError;
}

const CREATED_IDENTITY = Symbol("cmuxlayer.created_identity");

type CreatedIdentityCarrier = {
  [CREATED_IDENTITY]?: Record<string, unknown>;
};

function asError(error: unknown): Error & CreatedIdentityCarrier {
  if (error instanceof Error) {
    return error as Error & CreatedIdentityCarrier;
  }
  return new Error(String(error), { cause: error }) as Error &
    CreatedIdentityCarrier;
}

export class CreatedIdentityScope {
  private readonly identity: Record<string, unknown> = {};

  record(identity: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(identity)) {
      if (value !== undefined) {
        this.identity[key] = value;
      }
    }
  }

  append(
    key: string,
    identity: Record<string, unknown>,
    sameIdentity: (left: Record<string, unknown>, right: Record<string, unknown>) => boolean,
  ): void {
    const current = Array.isArray(this.identity[key])
      ? ([...(this.identity[key] as Record<string, unknown>[])] as Record<
          string,
          unknown
        >[])
      : [];
    const index = current.findIndex((candidate) =>
      sameIdentity(candidate, identity),
    );
    if (index >= 0) {
      current[index] = { ...current[index], ...identity };
    } else {
      current.push({ ...identity });
    }
    this.identity[key] = current;
  }

  attach(error: unknown): Error {
    const target = asError(error);
    const existing = target[CREATED_IDENTITY] ?? {};
    Object.defineProperty(target, CREATED_IDENTITY, {
      configurable: true,
      value: { ...existing, ...this.identity },
    });
    return target;
  }
}

export function createdIdentityFromError(
  error: unknown,
): Record<string, unknown> {
  if (!(error instanceof Error)) return {};
  return { ...((error as Error & CreatedIdentityCarrier)[CREATED_IDENTITY] ?? {}) };
}

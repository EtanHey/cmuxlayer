const BARE_SURFACE_INDEX_RE = /^\d+$/;

export function assertCanonicalSurfaceRef(value: string): void {
  if (BARE_SURFACE_INDEX_RE.test(value.trim())) {
    throw new Error(
      `bare surface index ${JSON.stringify(value)} is not allowed; use surface:<index> ref or a surface UUID`,
    );
  }
}

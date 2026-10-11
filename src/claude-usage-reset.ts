/**
 * Claude reset labels. The clock is explicit so historical
 * captures never borrow today's date. Time-only labels require an explicit
 * zone and a valid refusal anchor; without that, relative labels,
 * invalid dates and DST gaps/overlaps are unknown, not clearance.
 * A missing year means the nearest month/day in the supplied zone's adjacent
 * calendar years; this handles December/January rollover without guessing UTC.
 */
export function claudeUsageResetAt(label: string, nowMs: number, defaultTimeZone?: string, refusalAt?: number): number | null {
  const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:\s+(\d{4}))?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+\(([^()]+)\))?$/i.exec(label.trim());
  const timeOnly = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+\(([^()]+)\)$/i.exec(label.trim());
  if ((!match && !timeOnly) || !Number.isFinite(nowMs)) return null;
  const timeZone = match ? match[7] ?? defaultTimeZone : timeOnly![4];
  if (!timeZone) return null;
  const month = match ? "jan feb mar apr may jun jul aug sep oct nov dec".split(" ").indexOf(match[1].toLowerCase()) + 1 : 1;
  const day = match ? Number(match[2]) : 1;
  const hour12 = Number(match ? match[4] : timeOnly![1]), minute = Number((match ? match[5] : timeOnly![2]) ?? 0);
  if (day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = hour12 % 12 + ((match ? match[6] : timeOnly![3]).toLowerCase() === "pm" ? 12 : 0);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
    const parts = (ms: number) => {
      const values = Object.fromEntries(formatter.formatToParts(ms).map(part => [part.type, Number(part.value)]));
      return [values.year, values.month, values.day, values.hour, values.minute];
    };
    const naive = ([y, m, d, h, min]: number[]) => Date.UTC(y, m - 1, d, h, min);
    const candidatesFor = (wanted: number[]) => {
      const localMs = naive(wanted);
      const offsets = new Set([-36, 0, 36].map(hours => {
        const sample = localMs + hours * 3_600_000;
        return naive(parts(sample)) - sample;
      }));
      return [...offsets].map(offset => localMs - offset)
        .filter(ms => parts(ms).every((value, index) => value === wanted[index]));
    };
    if (!match) {
      if (refusalAt === undefined || !Number.isFinite(refusalAt) || refusalAt < 0 || refusalAt > nowMs) return null;
      const anchor = parts(refusalAt);
      for (const offset of [0, 1]) {
        const day = new Date(Date.UTC(anchor[0], anchor[1] - 1, anchor[2] + offset));
        const wanted = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute];
        const candidates = candidatesFor(wanted);
        const future = candidates.filter(ms => ms > refusalAt);
        // Never skip a future gap/overlap in order to invent next-day clearance.
        if (candidates.length !== 1 && (future.length > 0 || naive(wanted) > naive(anchor))) return null;
        if (future.length === 1) return future[0];
      }
      return null;
    }
    const current = parts(nowMs);
    const years = match[3] ? [Number(match[3])] : [current[0] - 1, current[0], current[0] + 1];
    const ranked = years.map(year => ({ year, distance: Math.abs(naive([year, month, day, hour, minute]) - naive(current)) }))
      .sort((a, b) => a.distance - b.distance);
    if (ranked[1]?.distance === ranked[0].distance) return null;
    const wanted = [ranked[0].year, month, day, hour, minute];
    // Sample both sides of a possible offset transition, then round-trip
    // every candidate. Zero/two matches are a DST gap/overlap: fail closed.
    const candidates = candidatesFor(wanted);
    return candidates.length === 1 ? candidates[0] : null;
  } catch { return null; }
}

/** Exact explicit navigation only; no arguments, aliases or arbitrary slash skills. */
export function isClaudeQuotaRecoveryCommand(text: string): boolean {
  return text === "/usage-credits" || text === "/usage" || text === "/rate-limit-options";
}

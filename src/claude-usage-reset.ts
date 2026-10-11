/**
 * Absolute Claude reset labels only. The clock is explicit so historical
 * captures never borrow today's date. Missing date/zone, relative labels,
 * invalid dates and DST gaps/overlaps are unknown, not clearance.
 * A missing year means the nearest month/day in the supplied zone's adjacent
 * calendar years; this handles December/January rollover without guessing UTC.
 */
export function claudeUsageResetAt(label: string, nowMs: number, defaultTimeZone?: string): number | null {
  const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:\s+(\d{4}))?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+\(([^()]+)\))?$/i.exec(label.trim());
  if (!match || !Number.isFinite(nowMs)) return null;
  const timeZone = match[7] ?? defaultTimeZone;
  if (!timeZone) return null;
  const month = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ").indexOf(match[1].toLowerCase()) + 1;
  const day = Number(match[2]), hour12 = Number(match[4]), minute = Number(match[5] ?? 0);
  if (day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = hour12 % 12 + (match[6].toLowerCase() === "pm" ? 12 : 0);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
    const parts = (ms: number) => {
      const values = Object.fromEntries(formatter.formatToParts(ms).map(part => [part.type, Number(part.value)]));
      return [values.year, values.month, values.day, values.hour, values.minute];
    };
    const naive = ([y, m, d, h, min]: number[]) => Date.UTC(y, m - 1, d, h, min);
    const current = parts(nowMs);
    const years = match[3] ? [Number(match[3])] : [current[0] - 1, current[0], current[0] + 1];
    const ranked = years.map(year => ({ year, distance: Math.abs(naive([year, month, day, hour, minute]) - naive(current)) }))
      .sort((a, b) => a.distance - b.distance);
    if (ranked[1]?.distance === ranked[0].distance) return null;
    const wanted = [ranked[0].year, month, day, hour, minute];
    const localMs = naive(wanted);
    // Sample both sides of a possible offset transition, then round-trip
    // every candidate. Zero/two matches are a DST gap/overlap: fail closed.
    const offsets = new Set([-36, 0, 36].map(hours => {
      const sample = localMs + hours * 3_600_000;
      return naive(parts(sample)) - sample;
    }));
    const candidates = [...offsets].map(offset => localMs - offset)
      .filter(ms => parts(ms).every((value, index) => value === wanted[index]));
    return candidates.length === 1 ? candidates[0] : null;
  } catch { return null; }
}

/** Exact explicit navigation only; no arguments, aliases or arbitrary slash skills. */
export function isClaudeQuotaRecoveryCommand(text: string): boolean {
  return text === "/usage-credits" || text === "/usage" || text === "/rate-limit-options";
}

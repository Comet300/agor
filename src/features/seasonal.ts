/**
 * Seasonal price-pattern detection. Given a monitor's per-month average prices
 * (accumulated over time), find the cheapest calendar month — the "best time to
 * buy" — but only once there is enough spread of data to mean anything, and only
 * when the dip is large enough to be a real pattern rather than noise.
 *
 * Pure. Restricts to the dominant currency so a mixed-currency market can't
 * distort the seasonal curve. Needs months of accumulated history to activate.
 */
export interface MonthlyAvg {
  month: number; // 1–12
  currency: string;
  avg: number;
  n: number;
}

/** Distinct calendar months required before a seasonal call is made. */
export const SEASONAL_MIN_MONTHS = 4;
/** Total observations required. */
export const SEASONAL_MIN_POINTS = 20;
/** Minimum dip below the yearly mean (percent) to report a season. */
export const SEASONAL_MIN_BELOW_PCT = 5;

export interface SeasonalHint {
  /** Cheapest calendar month, 1–12. */
  month: number;
  /** How far that month sits below the yearly mean, in percent. */
  belowPct: number;
}

export function seasonalHint(rows: MonthlyAvg[]): SeasonalHint | undefined {
  if (rows.length === 0) return undefined;

  // Dominant currency by observation count.
  const byCur = new Map<string, number>();
  for (const r of rows) byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + r.n);
  let currency = '';
  let best = 0;
  for (const [c, n] of byCur) if (n > best) { currency = c; best = n; }

  const months = rows.filter((r) => r.currency === currency);
  const totalN = months.reduce((s, r) => s + r.n, 0);
  if (months.length < SEASONAL_MIN_MONTHS || totalN < SEASONAL_MIN_POINTS) return undefined;

  const mean = months.reduce((s, r) => s + r.avg, 0) / months.length;
  if (mean <= 0) return undefined;
  const cheapest = months.reduce((lo, r) => (r.avg < lo.avg ? r : lo));
  const belowPct = ((mean - cheapest.avg) / mean) * 100;
  if (belowPct < SEASONAL_MIN_BELOW_PCT) return undefined;

  return { month: cheapest.month, belowPct: Math.round(belowPct) };
}

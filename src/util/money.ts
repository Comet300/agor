/** Monetary helpers. */

/** Round to the nearest multiple of 5 (used by the offer anchor, Feature 9). */
export function roundToNearest5(n: number): number {
  return Math.round(n / 5) * 5;
}

/** Round to the nearest `step` (used to bucket prices for the dedup signature). */
export function roundToNearest(n: number, step: number): number {
  return Math.round(n / step) * step;
}

/**
 * Bucket a price for the dedup signature using a step that scales with the
 * price's magnitude (≈5% of its order of magnitude), so two cross-posts of the
 * same listing collapse whether it costs 4 300 RON or 230 000 EUR — a fixed
 * step would either over-collapse cheap items or never collapse expensive ones.
 */
export function priceBucket(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(price)));
  // 5% of the order of magnitude, floored to a sensible minimum step of 1.
  const step = Math.max(1, magnitude * 0.05);
  return Math.round(price / step) * step;
}

/** Compact human-readable money string, e.g. `4 300 RON`. */
export function formatMoney(amount: number, currency: string): string {
  const whole = Math.round(amount);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped} ${currency}`;
}

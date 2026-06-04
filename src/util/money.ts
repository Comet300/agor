/** Monetary helpers. */

/** Round to the nearest multiple of 5 (used by the offer anchor, Feature 9). */
export function roundToNearest5(n: number): number {
  return Math.round(n / 5) * 5;
}

/** Round to the nearest `step` (used to bucket prices for the dedup signature). */
export function roundToNearest(n: number, step: number): number {
  return Math.round(n / step) * step;
}

/** Compact human-readable money string, e.g. `4 300 RON`. */
export function formatMoney(amount: number, currency: string): string {
  const whole = Math.round(amount);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped} ${currency}`;
}

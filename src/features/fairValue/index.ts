/**
 * Fair-value estimation (v2) — per-category log-price ridge regression over the
 * numeric attributes a listing exposes. The model's slope weights are kept as
 * incremental accumulators per (category, currency) and updated from every
 * scraped listing (see persistence `ValuationRepo` + the orchestrator cycle); the
 * point estimate here is `exp(w · features)`.
 *
 * This is the v2.0 foundation. The richer comparable-adjustment refinement
 * (hedonic level from comps, confidence bands) is documented in
 * docs/predicted-fair-price.md as v2.1.
 */
import { parseNumericAttrs, type NumericAttrs } from './attributes';
import { solveRidge, predict, type RidgeState } from './ridge';

export { parseNumber, parseNumericAttrs, type NumericAttrs } from './attributes';
export { hedonicFairValue } from './hedonic';
export {
  emptyState, addObservation, decay, solveRidge, predict, type RidgeState,
} from './ridge';

import type { FairValue, ValuationCategory } from '../../contracts';
export type { FairValue, ValuationCategory } from '../../contracts';

/** Feature-vector length per category (intercept included). */
export const FEATURE_K: Record<ValuationCategory, number> = { car: 3, property: 3 };

/** Ridge regularization strength (small; stabilizes sparse/collinear fits). */
export const LAMBDA = 1;

/** Minimum accumulated observations before a model is trusted to value. */
export const MIN_OBSERVATIONS = 30;

/**
 * Infer the valuation category from the parsed attributes. A listing with a year
 * AND mileage is a car; one with an area is property. Anything else has no model.
 */
export function inferCategory(a: NumericAttrs): ValuationCategory | null {
  if (a.year !== undefined && a.km !== undefined) return 'car';
  if (a.area !== undefined && a.area > 0) return 'property';
  return null;
}

/**
 * Build the model feature row for a listing, or `null` when required attributes
 * are missing. `now` (epoch ms) sets the reference year for car age.
 *   car:      [1, ln(age+1), km/10_000]
 *   property: [1, ln(area), rooms]
 */
export function featureVector(category: ValuationCategory, a: NumericAttrs, now: number): number[] | null {
  if (category === 'car') {
    if (a.year === undefined || a.km === undefined) return null;
    const age = Math.max(0, new Date(now).getFullYear() - a.year);
    return [1, Math.log(age + 1), a.km / 10_000];
  }
  // property
  if (a.area === undefined || a.area <= 0) return null;
  return [1, Math.log(a.area), a.rooms ?? 0];
}

/** The regression target: log price (homoscedastic, keeps predictions positive). */
export function targetValue(price: number): number {
  return Math.log(price);
}

/**
 * Estimate a listing's fair price from its attributes + the category model state.
 * Returns `null` when the category is unknown, features are missing, the model
 * isn't trained enough (`state.n < MIN_OBSERVATIONS`), or the solve is singular.
 */
export function estimateFairValue(
  attributes: Record<string, string> | undefined,
  price: number,
  now: number,
  state: RidgeState | undefined,
): FairValue | null {
  if (!state || state.n < MIN_OBSERVATIONS) return null;
  const a = parseNumericAttrs(attributes);
  const category = inferCategory(a);
  if (!category) return null;
  const x = featureVector(category, a, now);
  if (!x || x.length !== state.k) return null;
  const w = solveRidge(state, LAMBDA);
  if (!w) return null;
  const fair = Math.exp(predict(w, x));
  if (!Number.isFinite(fair) || fair <= 0) return null;
  return { category, fair, delta: price - fair, deltaPct: (price - fair) / fair };
}

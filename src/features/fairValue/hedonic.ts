/**
 * Fair-value v2.1 — hedonic comparable adjustment.
 *
 * The v2.0 model gives a per-category log-price regression; its SLOPES (how price
 * moves with km/age/area) generalize well, but its LEVEL skews from tracking bias
 * (we only see the listings our users watch). So instead of trusting the model's
 * intercept, we take real comparables and adjust each to the target's spec using
 * the model's slopes, then take the median:
 *
 *   adjusted_comp = comp_price · exp( w·(x_target − x_comp) )
 *   fair          = median(adjusted_comp over same-category, same-currency comps)
 *
 * Slopes carry the curve; comps carry the level. With too few comps we fall back
 * to the raw model prediction (low confidence). See docs/predicted-fair-price.md.
 */
import type { FairValue } from '../../contracts';
import { parseNumericAttrs } from './attributes';
import {
  inferCategory, featureVector, LAMBDA, MIN_OBSERVATIONS,
} from './index';
import { solveRidge, predict, type RidgeState } from './ridge';

/** Comparables needed for a hedonic (comp-based) estimate; fewer → raw fallback. */
const MIN_COMPS = 5;
/** Comparables for a high-confidence estimate. */
const STRONG_COMPS = 15;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Minimal comparable shape — satisfied by both ItemSnapshot and a scraped item map. */
export interface FairComp {
  lastPrice: number;
  currency: string;
  attributes?: Record<string, string>;
}

/**
 * Estimate a listing's fair value by hedonic adjustment of `comps` to its spec,
 * using the category model `state` for the slopes. Falls back to the raw model
 * prediction (low confidence) when too few comparables match. Returns `null` when
 * the category is unknown, features missing, the model untrained, or solve fails.
 */
export function hedonicFairValue(
  attributes: Record<string, string> | undefined,
  price: number,
  currency: string,
  comps: ReadonlyArray<FairComp>,
  state: RidgeState | undefined,
  now: number,
): FairValue | null {
  if (!state || state.n < MIN_OBSERVATIONS) return null;
  const ta = parseNumericAttrs(attributes);
  const category = inferCategory(ta);
  if (!category) return null;
  const xt = featureVector(category, ta, now);
  if (!xt || xt.length !== state.k) return null;
  const w = solveRidge(state, LAMBDA);
  if (!w) return null;
  const predTarget = predict(w, xt);

  // Adjust each same-category, same-currency comp to the target's spec.
  const adjusted: number[] = [];
  for (const c of comps) {
    if (c.currency !== currency || c.lastPrice <= 0) continue;
    const ca = parseNumericAttrs(c.attributes);
    if (inferCategory(ca) !== category) continue;
    const xc = featureVector(category, ca, now);
    if (!xc) continue;
    const adj = c.lastPrice * Math.exp(predTarget - predict(w, xc));
    if (Number.isFinite(adj) && adj > 0) adjusted.push(adj);
  }

  let fair: number;
  let confidence: 'high' | 'medium' | 'low';
  if (adjusted.length >= MIN_COMPS) {
    fair = median([...adjusted].sort((a, b) => a - b));
    confidence = adjusted.length >= STRONG_COMPS ? 'high' : 'medium';
  } else {
    fair = Math.exp(predTarget); // raw prediction — level may skew
    confidence = 'low';
  }
  if (!Number.isFinite(fair) || fair <= 0) return null;
  return { category, fair, delta: price - fair, deltaPct: (price - fair) / fair, confidence };
}

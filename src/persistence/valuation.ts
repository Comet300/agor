/**
 * Persistence for fair-value (v2) ridge accumulators: one row per
 * (category, currency) holding the normal-equation sufficient statistics
 * (`A`, `b`, `n`) serialized as JSON. The model is rebuilt by solving on demand
 * (see features/fairValue), never from raw rows.
 */
import type { RidgeState } from '../features/fairValue/ridge';
import type { DB } from './db';

interface ValuationRow {
  k: number;
  a_json: string;
  b_json: string;
  n: number;
}

export class ValuationRepo {
  constructor(private readonly db: DB) {}

  /** Load the accumulator for a category+currency, or `undefined` if untrained. */
  get(category: string, currency: string): RidgeState | undefined {
    const row = this.db
      .prepare(`SELECT k, a_json, b_json, n FROM valuation_models WHERE category = ? AND currency = ?`)
      .get(category, currency) as ValuationRow | undefined;
    if (!row) return undefined;
    try {
      const A = JSON.parse(row.a_json) as number[];
      const b = JSON.parse(row.b_json) as number[];
      if (!Array.isArray(A) || !Array.isArray(b) || A.length !== row.k * row.k || b.length !== row.k) {
        return undefined; // corrupt → treat as untrained
      }
      return { k: row.k, A, b, n: row.n };
    } catch {
      return undefined;
    }
  }

  /** Persist (upsert) an accumulator for a category+currency. */
  save(category: string, currency: string, state: RidgeState, now: number): void {
    this.db
      .prepare(
        `INSERT INTO valuation_models (category, currency, k, a_json, b_json, n, updated_at)
         VALUES (@category, @currency, @k, @aJson, @bJson, @n, @now)
         ON CONFLICT(category, currency) DO UPDATE SET
           k = excluded.k, a_json = excluded.a_json, b_json = excluded.b_json,
           n = excluded.n, updated_at = excluded.updated_at`,
      )
      .run({
        category,
        currency,
        k: state.k,
        aJson: JSON.stringify(state.A),
        bJson: JSON.stringify(state.b),
        n: state.n,
        now,
      });
  }
}

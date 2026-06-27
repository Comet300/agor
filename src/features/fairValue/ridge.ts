/**
 * Incremental ridge regression via normal-equation accumulators.
 *
 * Holds the sufficient statistics `A = ΣxxᵀW` and `b = ΣxyW` (k×k and k×1) so a
 * model can be updated one observation at a time in O(k²) and solved on demand —
 * no raw rows kept, ~k² floats of state. A forgetting factor lets old data fade
 * so the fit tracks market drift. Pure linear algebra, dependency-free; k is
 * small (≤ ~6 features) so a Pi solves it in microseconds.
 *
 * See docs/predicted-fair-price.md for how this powers the fair-value estimate.
 */

/** Accumulator state. `A` is row-major k×k; `b` is length k; `n` is the (decayed) count. */
export interface RidgeState {
  k: number;
  A: number[];
  b: number[];
  n: number;
}

/** A fresh accumulator for `k` features (intercept included by the caller). */
export function emptyState(k: number): RidgeState {
  return { k, A: new Array(k * k).fill(0), b: new Array(k).fill(0), n: 0 };
}

/** Fold one observation (feature row `x`, target `y`) into the accumulator. */
export function addObservation(s: RidgeState, x: number[], y: number, weight = 1): void {
  const { k } = s;
  for (let i = 0; i < k; i++) {
    s.b[i]! += weight * x[i]! * y;
    const row = i * k;
    for (let j = 0; j < k; j++) s.A[row + j]! += weight * x[i]! * x[j]!;
  }
  s.n += weight;
}

/** Multiply the accumulator by a forgetting factor `rho` (0<rho≤1) — drift decay. */
export function decay(s: RidgeState, rho: number): void {
  for (let i = 0; i < s.A.length; i++) s.A[i]! *= rho;
  for (let i = 0; i < s.b.length; i++) s.b[i]! *= rho;
  s.n *= rho;
}

/**
 * Solve `(A + λI) w = b` for the ridge weights, or `null` when the system is
 * singular even with regularization. Gaussian elimination with partial pivoting
 * (k is tiny). `lambda` shrinks toward zero and keeps the matrix invertible.
 */
export function solveRidge(s: RidgeState, lambda: number): number[] | null {
  const { k } = s;
  // Augmented matrix [M | b] with M = A + λI.
  const M: number[][] = [];
  for (let i = 0; i < k; i++) {
    const row = new Array(k + 1);
    for (let j = 0; j < k; j++) row[j] = s.A[i * k + j]! + (i === j ? lambda : 0);
    row[k] = s.b[i]!;
    M.push(row);
  }
  for (let col = 0; col < k; col++) {
    // Partial pivot.
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    if (Math.abs(M[pivot]![col]!) < 1e-12) return null; // singular
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    // Eliminate below.
    for (let r = col + 1; r < k; r++) {
      const f = M[r]![col]! / M[col]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= k; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  // Back-substitution.
  const w = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let sum = M[i]![k]!;
    for (let j = i + 1; j < k; j++) sum -= M[i]![j]! * w[j]!;
    w[i] = sum / M[i]![i]!;
  }
  return w;
}

/** Dot product of weights and a feature row (the model's linear prediction). */
export function predict(w: number[], x: number[]): number {
  let sum = 0;
  for (let i = 0; i < w.length; i++) sum += w[i]! * x[i]!;
  return sum;
}

import { describe, it, expect } from 'vitest';
import {
  parseNumber, parseNumericAttrs, inferCategory, featureVector, targetValue,
  emptyState, addObservation, solveRidge, predict, estimateFairValue, FEATURE_K,
} from '../src/features/fairValue';
import { openStore } from '../src/persistence';

const NOW = Date.UTC(2026, 0, 1); // reference year 2026

describe('attribute parsing', () => {
  it('parses thousands dots, dotted years, units and decimal commas', () => {
    expect(parseNumber('145.000 km')).toBe(145000);
    expect(parseNumber('2.016')).toBe(2016);
    expect(parseNumber('65 m²')).toBe(65);
    expect(parseNumber('116 CP')).toBe(116);
    expect(parseNumber('65,5')).toBe(65.5);
    expect(parseNumber('n/a')).toBeUndefined();
  });

  it('extracts the recognised numeric attributes', () => {
    expect(parseNumericAttrs({ year: '2.016', km: '145.000 km', fuel: 'Diesel' })).toEqual({ year: 2016, km: 145000 });
    expect(parseNumericAttrs({ area: '65 m²', rooms: '3' })).toEqual({ area: 65, rooms: 3 });
  });
});

describe('category + feature vector', () => {
  it('infers car from year+km, property from area, else null', () => {
    expect(inferCategory({ year: 2016, km: 100000 })).toBe('car');
    expect(inferCategory({ area: 65 })).toBe('property');
    expect(inferCategory({})).toBeNull();
  });

  it('builds the right-length feature row, null when attrs missing', () => {
    expect(featureVector('car', { year: 2018, km: 100000 }, NOW)).toHaveLength(FEATURE_K.car);
    expect(featureVector('car', { year: 2018 }, NOW)).toBeNull();
    expect(featureVector('property', { area: 60, rooms: 3 }, NOW)).toHaveLength(FEATURE_K.property);
  });
});

describe('ridge regression', () => {
  it('recovers known weights from exact synthetic data', () => {
    const wTrue = [3, -1.5, 0.4];
    const s = emptyState(3);
    // Varied, independent feature rows; y = wTrue·x exactly.
    for (let a = 1; a <= 6; a++) {
      for (let b = 0; b < 4; b++) {
        const x = [1, a, b * 2];
        addObservation(s, x, predict(wTrue, x));
      }
    }
    const w = solveRidge(s, 1e-9)!;
    expect(w[0]).toBeCloseTo(3, 2);
    expect(w[1]).toBeCloseTo(-1.5, 2);
    expect(w[2]).toBeCloseTo(0.4, 2);
  });

  it('returns null for a singular system at λ=0', () => {
    const s = emptyState(2);
    addObservation(s, [1, 1], 1); // rank-1
    expect(solveRidge(s, 0)).toBeNull();
    expect(solveRidge(s, 1)).not.toBeNull(); // ridge makes it solvable
  });
});

describe('estimateFairValue', () => {
  it('returns null when the model is untrained', () => {
    expect(estimateFairValue({ year: '2018', km: '100000' }, 12000, NOW, undefined)).toBeNull();
    const tiny = emptyState(3);
    addObservation(tiny, [1, 1, 1], Math.log(1000));
    expect(estimateFairValue({ year: '2018', km: '100000' }, 12000, NOW, tiny)).toBeNull(); // n < MIN
  });

  it('predicts a fair price close to the generating model', () => {
    // ln(price) = 9 − 0.3·ln(age+1) − 0.05·(km/10k)
    const s = emptyState(3);
    for (let year = 2016; year <= 2025; year++) {
      for (const km of [50000, 100000, 150000]) {
        const x = featureVector('car', { year, km }, NOW)!;
        addObservation(s, x, 9 - 0.3 * x[1]! - 0.05 * x[2]!);
      }
    }
    const fv = estimateFairValue({ year: '2020', km: '100000' }, 99999, NOW, s)!;
    expect(fv.category).toBe('car');
    const expected = Math.exp(9 - 0.3 * Math.log(6 + 1) - 0.05 * 10);
    expect(fv.fair).toBeGreaterThan(expected * 0.8);
    expect(fv.fair).toBeLessThan(expected * 1.2);
    expect(fv.delta).toBe(99999 - fv.fair); // priced way over
  });
});

describe('ValuationRepo', () => {
  it('round-trips an accumulator', () => {
    const store = openStore(':memory:');
    const s = emptyState(3);
    addObservation(s, [1, 2, 3], 1.5);
    addObservation(s, [1, 4, 5], 2.0);
    store.valuation.save('car', 'EUR', s, 1000);
    const back = store.valuation.get('car', 'EUR')!;
    expect(back.k).toBe(3);
    expect(back.n).toBe(2);
    expect(back.A).toEqual(s.A);
    expect(back.b).toEqual(s.b);
    expect(store.valuation.get('car', 'RON')).toBeUndefined(); // isolation
  });
});

import { describe, it, expect } from 'vitest';
import type { PricePoint } from '../src/contracts/index';
import { renderPriceHistory } from '../src/features/priceGraph';

/** Canonical 8-byte PNG file signature. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Build a PricePoint with sensible defaults; override per test. */
function makePoint(overrides: Partial<PricePoint> = {}): PricePoint {
  return {
    monitorId: 1,
    itemId: 'item-1',
    price: 100,
    currency: 'RON',
    observedAt: 1_000,
    ...overrides,
  };
}

describe('renderPriceHistory', () => {
  it('returns insufficient_history for fewer than 2 points', () => {
    expect(renderPriceHistory([])).toEqual({
      ok: false,
      reason: 'insufficient_history',
    });

    expect(renderPriceHistory([makePoint()])).toEqual({
      ok: false,
      reason: 'insufficient_history',
    });
  });

  it('renders a PNG buffer for >= 2 points', () => {
    const points: PricePoint[] = [
      makePoint({ price: 4500, observedAt: 1_000 }),
      makePoint({ price: 4300, observedAt: 2_000 }),
      makePoint({ price: 4100, observedAt: 3_000 }),
    ];

    const result = renderPriceHistory(points);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result'); // narrow the union

    const { png } = result;
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(100);

    // First 8 bytes must be the PNG signature.
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  });

  it('sorts unordered points without throwing and still returns a PNG', () => {
    const points: PricePoint[] = [
      makePoint({ price: 4100, observedAt: 3_000 }),
      makePoint({ price: 4500, observedAt: 1_000 }),
      makePoint({ price: 4300, observedAt: 2_000 }),
    ];

    const result = renderPriceHistory(points);
    expect(result.ok).toBe(true);
  });

  it('handles a flat (single-value) price series', () => {
    const points: PricePoint[] = [
      makePoint({ price: 4200, observedAt: 1_000 }),
      makePoint({ price: 4200, observedAt: 2_000 }),
    ];

    const result = renderPriceHistory(points);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.png.length).toBeGreaterThan(100);
  });

  it('accepts a title and custom dimensions without throwing', () => {
    const points: PricePoint[] = [
      makePoint({ price: 4500, observedAt: 1_000 }),
      makePoint({ price: 4300, observedAt: 2_000 }),
    ];

    const result = renderPriceHistory(points, {
      title: 'iPhone 13 — price history',
      width: 1024,
      height: 512,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect([...result.png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  });
});

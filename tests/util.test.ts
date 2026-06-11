import { describe, it, expect } from 'vitest';
import { roundToNearest5, formatMoney } from '../src/util/money';
import { compositeSignature, normalizeTitle } from '../src/util/hash';
import { scrubUrl, extractDomain } from '../src/util/url';

describe('money', () => {
  it('rounds to nearest 5', () => {
    expect(roundToNearest5(887 * 0.9)).toBe(800); // 798.3 -> 800
    expect(roundToNearest5(900)).toBe(900);
    expect(roundToNearest5(887)).toBe(885);
  });
  it('formats with thousands grouping', () => {
    expect(formatMoney(4300, 'RON')).toBe('4 300 RON');
    expect(formatMoney(1090.4, 'RON')).toBe('1 090 RON');
  });
});

describe('composite signature', () => {
  it('normalizes titles (diacritics, punctuation, case)', () => {
    expect(normalizeTitle('  VW Golf 5 — 1.9 TDI!! ')).toBe('vw golf 5 1 9 tdi');
  });
  it('collapses near-identical cross-posts to one signature', () => {
    const a = compositeSignature({ title: 'VW Golf 5', price: 4300, location: 'Cluj' });
    const b = compositeSignature({ title: 'vw  golf 5', price: 4320, location: 'cluj' });
    expect(a).toBe(b); // same title, price within 50 bucket, same location
  });
  it('separates genuinely different listings', () => {
    const a = compositeSignature({ title: 'VW Golf 5', price: 4300, location: 'Cluj' });
    const b = compositeSignature({ title: 'VW Passat', price: 4300, location: 'Cluj' });
    expect(a).not.toBe(b);
  });

  it('collapses near-identical HIGH prices (relative bucket, not a fixed 50)', () => {
    // Two cross-posts of the same €230k flat at €228,690 vs €230,400 must collapse.
    // A fixed ±50 bucket would NEVER collapse these; a relative bucket does.
    const a = compositeSignature({ title: 'Apartament 3 camere', price: 228690, location: 'Bucuresti' });
    const b = compositeSignature({ title: 'apartament 3 camere', price: 230400, location: 'bucuresti' });
    expect(a).toBe(b);
  });

  it('still separates genuinely different HIGH prices', () => {
    // €230k vs €290k are different listings — must NOT collapse.
    const a = compositeSignature({ title: 'Apartament 3 camere', price: 230000, location: 'Bucuresti' });
    const b = compositeSignature({ title: 'Apartament 3 camere', price: 290000, location: 'Bucuresti' });
    expect(a).not.toBe(b);
  });
});

describe('url scrubbing', () => {
  it('strips telemetry but keeps search params', () => {
    const out = scrubUrl(
      'https://www.olx.ro/auto/q-golf/?search[filter]=1&utm_source=google&gclid=xyz',
    );
    expect(out).toContain('search%5Bfilter%5D=1');
    expect(out).not.toContain('utm_source');
    expect(out).not.toContain('gclid');
  });
  it('extracts domain without www', () => {
    expect(extractDomain('https://www.autovit.ro/anunt/x')).toBe('autovit.ro');
  });
});

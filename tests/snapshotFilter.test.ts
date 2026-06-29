import { describe, it, expect } from 'vitest';
import { snapshotHidden } from '../src/pipeline/snapshotFilter';
import type { FilterConfig } from '../src/contracts';

const base: FilterConfig = { sellerVisibility: 'both', exclusionKeywords: [] };

describe('snapshotHidden', () => {
  it('keeps a snapshot that matches no filter', () => {
    expect(snapshotHidden({ title: 'VW Golf 2015' }, base)).toBe(false);
  });

  it('hides an excluded keyword (word-boundary, diacritic-aware)', () => {
    expect(snapshotHidden({ title: 'VW Golf avariat' }, { ...base, exclusionKeywords: ['avariat'] })).toBe(true);
    expect(snapshotHidden({ title: 'VW Golf' }, { ...base, exclusionKeywords: ['avariat'] })).toBe(false);
  });

  it('hides a title missing all required keywords', () => {
    const f = { ...base, requiredKeywords: ['golf'] };
    expect(snapshotHidden({ title: 'VW Golf' }, f)).toBe(false);
    expect(snapshotHidden({ title: 'VW Passat' }, f)).toBe(true);
  });

  it('matches keywords in the description, not only the title', () => {
    // Required word only in the body → kept (not hidden).
    expect(snapshotHidden({ title: 'Apartament', description: 'are swace' }, { ...base, requiredKeywords: ['swace'] })).toBe(false);
    // Excluded word only in the body → hidden.
    expect(snapshotHidden({ title: 'Apartament', description: 'mobilat avariat' }, { ...base, exclusionKeywords: ['avariat'] })).toBe(true);
  });

  it('applies seller visibility (and hides unknown sellers under a non-both pref)', () => {
    const priv = { ...base, sellerVisibility: 'private' as const };
    expect(snapshotHidden({ title: 'x', sellerPrivate: true }, priv)).toBe(false);
    expect(snapshotHidden({ title: 'x', sellerPrivate: false }, priv)).toBe(true);
    expect(snapshotHidden({ title: 'x' }, priv)).toBe(true); // unknown → hidden, mirrors the pipeline
  });

  it('hides a blocked seller name (case-insensitive)', () => {
    expect(snapshotHidden({ title: 'x', sellerName: 'Dealer X' }, { ...base, blockedSellers: ['dealer x'] })).toBe(true);
  });

  it('hides a blocked phone regardless of formatting', () => {
    const f = { ...base, blockedPhones: ['0712345678'] };
    expect(snapshotHidden({ title: 'x', phone: '+40 712 345 678' }, f)).toBe(true);
    expect(snapshotHidden({ title: 'x', phone: '0799999999' }, f)).toBe(false);
  });
});

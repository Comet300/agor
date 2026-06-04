import { describe, it, expect } from 'vitest';
import type { IScrapedItem } from '../src/contracts/index';
import {
  buildCallLink,
  offerAnchor,
  draftOffer,
} from '../src/features/contactOffer';

/** Minimal item factory so each test only overrides what it cares about. */
function makeItem(overrides: Partial<IScrapedItem> = {}): IScrapedItem {
  return {
    id: 'i1',
    title: 'VW Golf 5 1.9 TDI',
    price: 4300,
    currency: 'RON',
    url: 'https://example.com/i1',
    isPrivateOwner: true,
    inStock: true,
    ...overrides,
  };
}

describe('offerAnchor', () => {
  it('takes 10% off and rounds to the nearest 5', () => {
    expect(offerAnchor(1000)).toBe(900); // 900 -> 900
    expect(offerAnchor(4300)).toBe(3870); // 3870 -> 3870
  });

  it('rounds the boundary case to the nearest 5', () => {
    // 887 * 0.9 = 798.3 -> nearest 5 is 800.
    expect(offerAnchor(887)).toBe(800);
  });
});

describe('buildCallLink', () => {
  it('strips spaces, dashes and parentheses while keeping the leading +', () => {
    expect(buildCallLink('+40 712-345 (678)')).toBe('tel:+40712345678');
  });

  it('drops a non-leading-plus formatting but keeps digits', () => {
    expect(buildCallLink('0712 345 678')).toBe('tel:0712345678');
  });

  it('returns undefined for missing or empty input', () => {
    expect(buildCallLink(undefined)).toBeUndefined();
    expect(buildCallLink('')).toBeUndefined();
    expect(buildCallLink('   ')).toBeUndefined(); // no digits -> undefined
  });
});

describe('draftOffer', () => {
  it('defaults to Romanian and includes title, anchor, currency, wrapped in backticks', () => {
    const item = makeItem({ title: 'BMW E46', price: 4300, currency: 'EUR' });
    const out = draftOffer(item);

    expect(out.startsWith('`')).toBe(true);
    expect(out.endsWith('`')).toBe(true);
    expect(out).toContain('BMW E46');
    expect(out).toContain('EUR');
    expect(out).toContain(String(offerAnchor(item.price))); // 3870
  });

  it('produces a different message for the en variant', () => {
    const item = makeItem();
    const ro = draftOffer(item, 'ro');
    const en = draftOffer(item, 'en');

    expect(en).not.toBe(ro);
    // English variant still carries the load-bearing data.
    expect(en).toContain(item.title);
    expect(en).toContain(item.currency);
    expect(en).toContain(String(offerAnchor(item.price)));
    expect(en.startsWith('`') && en.endsWith('`')).toBe(true);
  });
});

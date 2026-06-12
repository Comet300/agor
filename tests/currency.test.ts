import { describe, it, expect } from 'vitest';
import { canonicalCurrency, inferCurrencyFromText, CURRENCY_MAP } from '../src/util/currency';

describe('canonicalCurrency', () => {
  it('upper-cases ISO codes and maps local words to ISO', () => {
    expect(canonicalCurrency('eur')).toBe('EUR');
    expect(canonicalCurrency('EUR')).toBe('EUR');
    expect(canonicalCurrency('lei')).toBe('RON');
    expect(canonicalCurrency('ron')).toBe('RON');
    expect(canonicalCurrency('euro')).toBe('EUR');
  });
  it('returns empty for a blank token', () => {
    expect(canonicalCurrency('')).toBe('');
    expect(canonicalCurrency('   ')).toBe('');
  });
  it('passes through an unknown token upper-cased (no silent loss)', () => {
    expect(canonicalCurrency('chf')).toBe('CHF');
  });
});

describe('inferCurrencyFromText', () => {
  it('infers from a trailing word token', () => {
    expect(inferCurrencyFromText('16.990 eur')).toBe('EUR');
    expect(inferCurrencyFromText('215,000 lei')).toBe('RON');
  });
  it('infers from a symbol', () => {
    expect(inferCurrencyFromText('124,000 €')).toBe('EUR');
    expect(inferCurrencyFromText('$1,200')).toBe('USD');
    expect(inferCurrencyFromText('£950')).toBe('GBP');
  });
  it('returns empty when nothing recognizable is present', () => {
    expect(inferCurrencyFromText('124000')).toBe('');
    expect(inferCurrencyFromText('')).toBe('');
  });
  it('does not false-match a word token embedded in another word', () => {
    // "leu" must not fire inside "valeur"; "eur" must not fire inside "valeur".
    expect(inferCurrencyFromText('valeur 100')).toBe('');
  });
  it('CURRENCY_MAP is the single source of truth (symbols + words present)', () => {
    expect(CURRENCY_MAP['€']).toBe('EUR');
    expect(CURRENCY_MAP['lei']).toBe('RON');
  });
});

/**
 * Per-vendor circuit breaker: stop hammering a vendor that is hard-blocked or
 * persistently failing. Deterministic — the threshold is injected, no clock.
 */
import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/scraping/circuitBreaker';

describe('CircuitBreaker', () => {
  it('stays closed below the failure threshold', () => {
    const cb = new CircuitBreaker(3);
    cb.record('mobile.de', { healthy: false });
    cb.record('mobile.de', { healthy: false });
    expect(cb.isOpen('mobile.de')).toBe(false);
  });

  it('opens after N consecutive unhealthy cycles', () => {
    const cb = new CircuitBreaker(3);
    cb.record('mobile.de', { healthy: false });
    cb.record('mobile.de', { healthy: false });
    const tripped = cb.record('mobile.de', { healthy: false });
    expect(cb.isOpen('mobile.de')).toBe(true);
    expect(tripped).toBe(true); // the record that crossed the threshold reports the trip
  });

  it('record returns false on cycles that do not newly trip the breaker', () => {
    const cb = new CircuitBreaker(2);
    expect(cb.record('v', { healthy: false })).toBe(false); // 1, below
    expect(cb.record('v', { healthy: false })).toBe(true); // 2, trips
    expect(cb.record('v', { healthy: false })).toBe(false); // already open, not a NEW trip
  });

  it('a healthy cycle resets the counter and keeps the breaker closed', () => {
    const cb = new CircuitBreaker(3);
    cb.record('olx.ro', { healthy: false });
    cb.record('olx.ro', { healthy: false });
    cb.record('olx.ro', { healthy: true }); // recovery
    cb.record('olx.ro', { healthy: false });
    expect(cb.isOpen('olx.ro')).toBe(false);
  });

  it('isolates vendors from each other', () => {
    const cb = new CircuitBreaker(2);
    cb.record('mobile.de', { healthy: false });
    cb.record('mobile.de', { healthy: false }); // mobile.de trips
    cb.record('olx.ro', { healthy: false }); // olx still fine
    expect(cb.isOpen('mobile.de')).toBe(true);
    expect(cb.isOpen('olx.ro')).toBe(false);
  });

  it('reset() re-enables a tripped vendor (manual re-enable)', () => {
    const cb = new CircuitBreaker(1);
    cb.record('mobile.de', { healthy: false });
    expect(cb.isOpen('mobile.de')).toBe(true);
    cb.reset('mobile.de');
    expect(cb.isOpen('mobile.de')).toBe(false);
  });

  it('a recorded healthy cycle on a NON-open vendor never reports a trip', () => {
    const cb = new CircuitBreaker(2);
    expect(cb.record('v', { healthy: true })).toBe(false);
  });

  it('exposes the set of currently-open vendors', () => {
    const cb = new CircuitBreaker(1);
    cb.record('mobile.de', { healthy: false });
    cb.record('carzz.ro', { healthy: false });
    expect(new Set(cb.openVendors())).toEqual(new Set(['mobile.de', 'carzz.ro']));
  });
});

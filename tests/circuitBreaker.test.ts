/**
 * Per-vendor circuit breaker with auto-healing (half-open) recovery.
 * Deterministic — the threshold + cooldown are injected and `now` is passed in.
 */
import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/scraping/circuitBreaker';

const COOL = 30 * 60_000; // 30 min cooldown for these tests

describe('CircuitBreaker — tripping', () => {
  it('stays closed below the failure threshold', () => {
    const cb = new CircuitBreaker(3, COOL);
    cb.record('mobile.de', { healthy: false }, 0);
    cb.record('mobile.de', { healthy: false }, 1);
    expect(cb.isOpen('mobile.de', 2)).toBe(false);
  });

  it('opens after N consecutive unhealthy cycles and reports the trip once', () => {
    const cb = new CircuitBreaker(3, COOL);
    expect(cb.record('mobile.de', { healthy: false }, 0)).toBe('none');
    expect(cb.record('mobile.de', { healthy: false }, 1)).toBe('none');
    expect(cb.record('mobile.de', { healthy: false }, 2)).toBe('tripped');
    expect(cb.isOpen('mobile.de', 3)).toBe(true);
    expect(cb.record('mobile.de', { healthy: false }, 4)).toBe('none'); // already open, not a NEW trip
  });

  it('a healthy cycle resets the counter and keeps the breaker closed', () => {
    const cb = new CircuitBreaker(3, COOL);
    cb.record('olx.ro', { healthy: false }, 0);
    cb.record('olx.ro', { healthy: false }, 1);
    cb.record('olx.ro', { healthy: true }, 2); // recovery (was closed → 'none')
    cb.record('olx.ro', { healthy: false }, 3);
    expect(cb.isOpen('olx.ro', 4)).toBe(false);
  });

  it('isolates vendors from each other', () => {
    const cb = new CircuitBreaker(2, COOL);
    cb.record('mobile.de', { healthy: false }, 0);
    cb.record('mobile.de', { healthy: false }, 1); // trips
    cb.record('olx.ro', { healthy: false }, 1);
    expect(cb.isOpen('mobile.de', 2)).toBe(true);
    expect(cb.isOpen('olx.ro', 2)).toBe(false);
  });
});

describe('CircuitBreaker — auto-healing (half-open)', () => {
  it('stays open during the cooldown, then authorizes exactly one probe', () => {
    const cb = new CircuitBreaker(1, COOL);
    cb.record('v', { healthy: false }, 0); // open at t=0
    expect(cb.isOpen('v', COOL - 1)).toBe(true); // still cooling down
    // Cooldown elapsed: first call authorizes the probe (false), the next blocks.
    expect(cb.isOpen('v', COOL)).toBe(false); // → half-open, probe authorized
    expect(cb.isOpen('v', COOL)).toBe(true); // probe already in flight
  });

  it('closes when the probe succeeds (healed)', () => {
    const cb = new CircuitBreaker(1, COOL);
    cb.record('v', { healthy: false }, 0);
    expect(cb.isOpen('v', COOL)).toBe(false); // half-open probe
    expect(cb.record('v', { healthy: true }, COOL)).toBe('healed');
    expect(cb.isOpen('v', COOL + 1)).toBe(false); // fully closed, resumes
  });

  it('re-opens with an exponentially longer cooldown when the probe fails', () => {
    const cb = new CircuitBreaker(1, COOL);
    cb.record('v', { healthy: false }, 0); // open, cooldown = COOL
    cb.isOpen('v', COOL); // → half-open probe
    expect(cb.record('v', { healthy: false }, COOL)).toBe('reopened'); // cooldown doubles → 2*COOL
    // After only one more COOL it is still cooling (needs 2*COOL from the re-open).
    expect(cb.isOpen('v', COOL + COOL - 1)).toBe(true);
    expect(cb.isOpen('v', COOL + 2 * COOL)).toBe(false); // next probe authorized
  });

  it('caps the backed-off cooldown at maxCooldownMs', () => {
    const cb = new CircuitBreaker(1, 100, 250); // base 100, cap 250
    let t = 0;
    cb.record('v', { healthy: false }, t); // open, cooldown 100
    // Fail three probes: 100 → 200 → 250 (capped) → 250.
    for (const expected of [200, 250, 250]) {
      t += 1_000; // well past any cooldown
      cb.isOpen('v', t); // half-open
      cb.record('v', { healthy: false }, t); // re-open, cooldown grows then caps
      expect(cb.isOpen('v', t + expected - 1)).toBe(true); // still cooling at expected-1
      expect(cb.isOpen('v', t + expected)).toBe(false); // probe at exactly the cooldown
    }
  });
});

describe('CircuitBreaker — manual + introspection', () => {
  it('reset() re-enables a tripped vendor (manual override)', () => {
    const cb = new CircuitBreaker(1, COOL);
    cb.record('mobile.de', { healthy: false }, 0);
    expect(cb.isOpen('mobile.de', 1)).toBe(true);
    cb.reset('mobile.de');
    expect(cb.isOpen('mobile.de', 2)).toBe(false);
  });

  it('a healthy cycle on a closed vendor reports no transition', () => {
    const cb = new CircuitBreaker(2, COOL);
    expect(cb.record('v', { healthy: true }, 0)).toBe('none');
  });

  it('exposes open + probing vendors as not-closed', () => {
    const cb = new CircuitBreaker(1, COOL);
    cb.record('mobile.de', { healthy: false }, 0);
    cb.record('carzz.ro', { healthy: false }, 0);
    expect(new Set(cb.openVendors())).toEqual(new Set(['mobile.de', 'carzz.ro']));
  });
});

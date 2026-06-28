/**
 * Per-vendor circuit breaker with auto-healing (half-open) recovery.
 *
 * A vendor that is hard-blocked (Akamai/DataDome) or persistently failing is
 * polled at full cadence for zero yield — pure cost and a fast track to a longer
 * IP ban. The breaker counts consecutive unhealthy cycles per vendor and, once a
 * threshold is crossed, OPENS so the orchestrator skips polling that vendor.
 *
 * Recovery is automatic: after a cooldown the breaker goes HALF-OPEN and lets a
 * single probe poll through. If the probe is healthy the breaker CLOSES (vendor
 * fully resumes); if it fails the breaker RE-OPENS with an exponentially longer
 * cooldown (capped). An operator can still force-close via {@link reset}.
 *
 * The breaker holds no clock of its own — `now` is injected — so it stays
 * deterministic and unit-testable.
 */

/** The health verdict of one cycle, as the breaker sees it. */
export interface CycleHealth {
  /** True when the cycle produced a usable result (not blocked, not failed). */
  healthy: boolean;
}

/** What a {@link CircuitBreaker.record} call changed, so the caller can log it once. */
export type BreakerEvent = 'none' | 'tripped' | 'healed' | 'reopened';

type Phase = 'closed' | 'open' | 'half_open';

interface VendorState {
  phase: Phase;
  consecutiveUnhealthy: number;
  /** Epoch ms the current open period began (for cooldown). */
  openedAt: number;
  /** Current cooldown before a probe is allowed (grows on repeated probe failure). */
  cooldownMs: number;
}

export class CircuitBreaker {
  private readonly state = new Map<string, VendorState>();

  /**
   * @param threshold       consecutive unhealthy cycles that trip the breaker.
   * @param baseCooldownMs  cooldown before the first auto-probe (default 30 min).
   * @param maxCooldownMs   cap on the backed-off cooldown (default 6 h).
   */
  constructor(
    private readonly threshold: number,
    private readonly baseCooldownMs: number = 30 * 60_000,
    private readonly maxCooldownMs: number = 6 * 60 * 60_000,
  ) {}

  private get(vendor: string): VendorState {
    let s = this.state.get(vendor);
    if (!s) {
      s = { phase: 'closed', consecutiveUnhealthy: 0, openedAt: 0, cooldownMs: this.baseCooldownMs };
      this.state.set(vendor, s);
    }
    return s;
  }

  /**
   * Record one cycle's health for `vendor` and return what it changed:
   *  - 'tripped'  — newly opened after crossing the threshold,
   *  - 'healed'   — a half-open probe succeeded; breaker closed,
   *  - 'reopened' — a half-open probe failed; breaker re-opened (longer cooldown),
   *  - 'none'     — no state transition worth surfacing.
   */
  record(vendor: string, health: CycleHealth, now: number): BreakerEvent {
    const s = this.get(vendor);

    if (health.healthy) {
      const wasProbing = s.phase === 'half_open';
      s.phase = 'closed';
      s.consecutiveUnhealthy = 0;
      s.cooldownMs = this.baseCooldownMs; // recovery resets the backoff
      return wasProbing ? 'healed' : 'none';
    }

    // A failed probe re-opens with an exponentially longer cooldown (capped).
    if (s.phase === 'half_open') {
      s.phase = 'open';
      s.openedAt = now;
      s.cooldownMs = Math.min(s.cooldownMs * 2, this.maxCooldownMs);
      return 'reopened';
    }

    s.consecutiveUnhealthy += 1;
    if (s.phase === 'closed' && s.consecutiveUnhealthy >= this.threshold) {
      s.phase = 'open';
      s.openedAt = now;
      s.cooldownMs = this.baseCooldownMs;
      return 'tripped';
    }
    return 'none';
  }

  /**
   * Whether `vendor` should be skipped right now. An open breaker whose cooldown
   * has elapsed transitions to half-open and returns `false` ONCE, authorizing a
   * single probe poll; further calls return `true` until that probe is recorded.
   */
  isOpen(vendor: string, now: number): boolean {
    const s = this.state.get(vendor);
    if (!s || s.phase === 'closed') return false;
    if (s.phase === 'half_open') return true; // a probe is already in flight
    if (now - s.openedAt >= s.cooldownMs) {
      s.phase = 'half_open'; // authorize exactly one probe
      return false;
    }
    return true;
  }

  /** Manually re-enable a vendor: close the breaker and clear its counters. */
  reset(vendor: string): void {
    const s = this.state.get(vendor);
    if (s) {
      s.phase = 'closed';
      s.consecutiveUnhealthy = 0;
      s.cooldownMs = this.baseCooldownMs;
    }
  }

  /** Vendors whose breaker is not closed (open or probing) — i.e. not fully healthy. */
  openVendors(): string[] {
    const out: string[] = [];
    for (const [vendor, s] of this.state) {
      if (s.phase !== 'closed') out.push(vendor);
    }
    return out;
  }
}

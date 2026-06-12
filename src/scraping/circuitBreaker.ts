/**
 * Per-vendor circuit breaker.
 *
 * A vendor that is hard-blocked (Akamai/DataDome) or persistently failing is
 * polled at full cadence for zero yield — pure cost and a fast track to a longer
 * IP ban. The breaker counts consecutive unhealthy cycles per vendor and, once a
 * threshold is crossed, reports "open" so the orchestrator can skip polling that
 * vendor until an operator re-enables it.
 *
 * Deterministic: the threshold is injected and the breaker holds no clock — a
 * healthy cycle resets the counter, an unhealthy one increments it.
 */

/** The health verdict of one cycle, as the breaker sees it. */
export interface CycleHealth {
  /** True when the cycle produced a usable result (not blocked, not failed). */
  healthy: boolean;
}

interface VendorState {
  consecutiveUnhealthy: number;
  open: boolean;
}

export class CircuitBreaker {
  private readonly state = new Map<string, VendorState>();

  /**
   * @param threshold consecutive unhealthy cycles that trip the breaker.
   */
  constructor(private readonly threshold: number) {}

  private get(vendor: string): VendorState {
    let s = this.state.get(vendor);
    if (!s) {
      s = { consecutiveUnhealthy: 0, open: false };
      this.state.set(vendor, s);
    }
    return s;
  }

  /**
   * Record one cycle's health for `vendor`. A healthy cycle resets the counter;
   * an unhealthy one increments it and may trip the breaker.
   *
   * @returns true ONLY on the record that newly trips the breaker (so the caller
   *          can surface the trip exactly once), false otherwise.
   */
  record(vendor: string, health: CycleHealth): boolean {
    const s = this.get(vendor);
    if (health.healthy) {
      s.consecutiveUnhealthy = 0;
      return false;
    }
    s.consecutiveUnhealthy += 1;
    if (!s.open && s.consecutiveUnhealthy >= this.threshold) {
      s.open = true;
      return true;
    }
    return false;
  }

  /** True when `vendor`'s breaker is open (polling should be skipped). */
  isOpen(vendor: string): boolean {
    return this.state.get(vendor)?.open ?? false;
  }

  /** Manually re-enable a vendor: close the breaker and clear its counter. */
  reset(vendor: string): void {
    const s = this.state.get(vendor);
    if (s) {
      s.open = false;
      s.consecutiveUnhealthy = 0;
    }
  }

  /** The vendors whose breaker is currently open. */
  openVendors(): string[] {
    const out: string[] = [];
    for (const [vendor, s] of this.state) {
      if (s.open) out.push(vendor);
    }
    return out;
  }
}

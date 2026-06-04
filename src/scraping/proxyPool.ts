/**
 * Round-robin proxy pool with a per-proxy cooldown ("bench").
 *
 * The scraping engine pulls a proxy with {@link ProxyPool.acquire}; when a proxy
 * earns a 429/403 the engine sidelines it with {@link ProxyPool.bench} so it is
 * skipped from rotation until `cooldownMs` has elapsed. All time is injected as
 * an explicit millisecond `now`, keeping the pool deterministic and testable.
 */
export class ProxyPool {
  /** Immutable rotation order. */
  private readonly urls: string[];
  /** ms epoch each proxy is benched until (absent ⇒ available). */
  private readonly benchedUntil = new Map<string, number>();
  /** Cursor into {@link urls} for round-robin acquisition. */
  private cursor = 0;

  constructor(urls: string[], private readonly cooldownMs: number) {
    // Defensive copy so external mutation cannot reshape the rotation.
    this.urls = [...urls];
  }

  /** Total number of proxies configured (benched or not). */
  get size(): number {
    return this.urls.length;
  }

  /** True when `url` is currently benched at instant `now`. */
  private isBenched(url: string, now: number): boolean {
    const until = this.benchedUntil.get(url);
    return until !== undefined && now < until;
  }

  /**
   * Return the next non-benched proxy in round-robin order, or `undefined` when
   * the pool is empty or every proxy is currently benched. The cursor advances
   * exactly one usable slot per successful acquisition so callers rotate fairly.
   */
  acquire(now: number): string | undefined {
    const n = this.urls.length;
    if (n === 0) return undefined;
    // Walk at most one full lap looking for an available proxy.
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const url = this.urls[idx]!;
      if (!this.isBenched(url, now)) {
        // Advance past the chosen slot so the next acquire rotates onward.
        this.cursor = (idx + 1) % n;
        return url;
      }
    }
    return undefined;
  }

  /** Sideline `url` until `now + cooldownMs`. */
  bench(url: string, now: number): void {
    this.benchedUntil.set(url, now + this.cooldownMs);
  }

  /** Count of proxies usable at instant `now`. */
  available(now: number): number {
    let count = 0;
    for (const url of this.urls) {
      if (!this.isBenched(url, now)) count++;
    }
    return count;
  }
}

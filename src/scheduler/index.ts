/**
 * Scheduler engine: the heartbeat that decides *when* each monitor polls.
 *
 * The scheduler owns no scraping logic. It pulls the set of monitors that are
 * due from persistence, hands each one to an injected `runMonitor` cycle runner
 * (supplied by the orchestrator), and re-arms the monitor's `next_due_at` so it
 * fires again later. Out-of-stock monitors ride a faster tier so a back-in-stock
 * transition is caught quickly.
 *
 * Time is never read from the wall clock in the hot paths — callers pass `now`
 * explicitly (and `start()` reads it through the injectable `now()` dep) so the
 * whole engine is deterministic under test.
 */

import type { Monitor } from '../contracts';
import type { Store } from '../persistence';
import { log } from '../logging/logger';

/** Everything the scheduler needs handed to it; nothing is imported globally. */
export interface SchedulerDeps {
  /** Persistence bundle; the scheduler only touches `store.monitors`. */
  store: Store;
  /**
   * The injected cycle runner. The orchestrator supplies the real scraping +
   * notification pipeline later; the scheduler just awaits it per due monitor.
   */
  runMonitor: (monitor: Monitor) => Promise<void>;
  /** Fallback cadence (ms) when a monitor carries no explicit `intervalMs`. */
  defaultIntervalMs: number;
  /** Faster cadence (ms) used while a monitor sits on the out-of-stock tier. */
  oosFastIntervalMs: number;
  /** Clock seam; defaults to the real epoch-ms wall clock for production use. */
  now?: () => number;
  /** Optional sink for per-monitor `runMonitor` failures (instead of throwing). */
  onError?: (monitor: Monitor, err: unknown) => void;
  /**
   * Hard ceiling (ms) on a single monitor's cycle. A cycle that exceeds it is
   * abandoned (its error routed to `onError`) so one wedged fetch/dispatch can
   * never block the re-entrancy guard and starve every other monitor. Generous
   * by default (networks can be slow); `0`/absent disables the timeout.
   */
  runTimeoutMs?: number;
  /**
   * Optional periodic housekeeping (e.g. DB wal_checkpoint), run every
   * {@link maintenanceIntervalTicks} ticks before that tick's monitors. Awaited,
   * so a slow maintenance delays the tick but never overlaps it.
   */
  onMaintenance?: () => Promise<void>;
  /** Ticks between `onMaintenance` runs (default 360). Ignored without the hook. */
  maintenanceIntervalTicks?: number;
  /**
   * Max monitor cycles run concurrently within a tick (default 5). Bounds the
   * fan-out so a Pi is not swamped while still keeping a tick's wall time near
   * the slowest single cycle rather than the sum of all due cycles.
   */
  concurrency?: number;
}

/**
 * Build the batching key for a monitor: identical `vendor|url` targets collapse
 * into one logical destination so the same page is processed as a single batch.
 */
function destinationKey(monitor: Monitor): string {
  return `${monitor.vendor}|${monitor.url}`;
}

/**
 * Group monitors by their destination (`vendor + '|' + url`). Monitors hitting
 * the exact same target land in the same bucket, preserving input order within
 * each bucket. Exported so the batching behavior can be unit-tested directly.
 */
export function groupByDestination(monitors: Monitor[]): Map<string, Monitor[]> {
  const groups = new Map<string, Monitor[]>();
  for (const monitor of monitors) {
    const key = destinationKey(monitor);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(monitor);
    } else {
      groups.set(key, [monitor]);
    }
  }
  return groups;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  /** Resolved clock seam — always defined after the constructor. */
  private readonly now: () => number;
  /** Handle for the `setInterval` driving `start()`, or null when stopped. */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard so a long tick is never overlapped by the next interval. */
  private ticking = false;
  /** Tick counter driving the periodic-maintenance cadence. */
  private tickCount = 0;
  /** Epoch ms of the last completed tick (null until the first), for /health. */
  private lastTickAt: number | null = null;
  /** Due-monitor count from the last tick (diagnostic, for /health). */
  private lastDueCount = 0;
  /** Max concurrent monitor cycles per tick wave (>= 1). */
  private readonly concurrency: number;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.concurrency = Math.max(1, deps.concurrency ?? 5);
  }

  /** Epoch ms of the last completed scheduler tick, or null if it never fired. */
  getLastTickAt(): number | null {
    return this.lastTickAt;
  }

  /** Number of monitors processed in the last tick (diagnostic). */
  getLastDueCount(): number {
    return this.lastDueCount;
  }

  /**
   * Re-arm a monitor's schedule. The next poll lands at `now` plus the cadence
   * appropriate to its tier: the fast (out-of-stock) interval when `fastTier`
   * is set, otherwise the monitor's own `intervalMs` (falling back to the
   * configured default when it is zero/absent). Persisted in one write.
   */
  reschedule(monitor: Monitor, now: number): void {
    const interval = monitor.fastTier
      ? this.deps.oosFastIntervalMs
      : monitor.intervalMs || this.deps.defaultIntervalMs;
    const nextDueAt = now + interval;
    this.deps.store.monitors.setSchedule(monitor.id, nextDueAt, monitor.fastTier);
  }

  /**
   * Run one scheduling pass for the supplied `now`:
   *  1. pull every monitor whose `next_due_at <= now` from persistence,
   *  2. group identical `vendor|url` targets into batches (so the same URL is
   *     processed once per pass conceptually),
   *  3. for each due monitor, await `runMonitor` guarded by try/catch — a
   *     failure is routed to `onError` instead of aborting the pass,
   *  4. reschedule every processed monitor regardless of success so a single
   *     bad monitor can never starve the others.
   * Resolves once all due monitors have been processed.
   */
  async tick(now: number): Promise<void> {
    // Periodic housekeeping runs before the due monitors (and even when none are
    // due) so DB maintenance keeps happening on an otherwise-idle bot. Awaited,
    // so it never overlaps the polling work in the same tick.
    this.tickCount += 1;
    const everyN = this.deps.maintenanceIntervalTicks ?? 360;
    if (this.deps.onMaintenance && this.tickCount % everyN === 0) {
      try {
        await this.deps.onMaintenance();
      } catch (err) {
        log('scheduler').warn({ err: (err as Error).message }, 'db maintenance failed');
      }
    }

    const due = this.deps.store.monitors.listDue(now);
    this.lastDueCount = due.length;
    if (due.length === 0) {
      this.lastTickAt = now;
      return;
    }

    // Group identical targets so each distinct destination is a batch. We still
    // process every monitor individually (each owns its own chat/filters), but
    // batching keeps the iteration aligned with one-target-one-batch semantics.
    const batches = groupByDestination(due);
    log('scheduler').debug({ due: due.length, batches: batches.size }, 'tick');

    // Process distinct destinations with bounded concurrency so a tick's wall
    // time stays near the slowest destination, not the sum of every cycle —
    // otherwise N due monitors serialize past the tick interval and the
    // re-entrancy guard starts dropping ticks, leaving the scheduler unable to
    // keep pace. Distinct destinations are independent (different targets), so
    // running them in parallel is safe; the monitors WITHIN a destination batch
    // run sequentially so the same URL is never hit concurrently.
    const limit = this.concurrency;
    const batchList = [...batches.values()];
    for (let i = 0; i < batchList.length; i += limit) {
      const wave = batchList.slice(i, i + limit);
      await Promise.all(wave.map((batch) => this.runBatch(batch, now)));
    }
    // Stamp last-tick AFTER all monitors finish, so /health reflects a completed pass.
    this.lastTickAt = now;
  }

  /** Run a destination batch's monitors sequentially (same URL, never concurrent). */
  private async runBatch(batch: Monitor[], now: number): Promise<void> {
    for (const monitor of batch) {
      await this.runAndReschedule(monitor, now);
    }
  }

  /**
   * Run one monitor's cycle (timeout-guarded) and always re-arm its schedule.
   * A cycle failure is routed to `onError`; a reschedule failure (disk full,
   * lock contention) is caught and logged rather than thrown so it can neither
   * abort the wave nor leave the loop in a rejected state. A monitor whose
   * reschedule failed keeps its stale `next_due_at` (visible in the log) and is
   * simply retried on a later tick.
   */
  private async runAndReschedule(monitor: Monitor, now: number): Promise<void> {
    try {
      await this.runWithTimeout(monitor);
    } catch (err) {
      // Isolate the failure: report it and keep going so siblings still run.
      log('scheduler').error({ monitorId: monitor.id, err: (err as Error).message }, 'monitor cycle threw');
      this.deps.onError?.(monitor, err);
    } finally {
      try {
        // Always re-arm — a failed cycle must not leave the monitor stuck due.
        this.reschedule(monitor, now);
      } catch (err) {
        log('scheduler').error(
          { monitorId: monitor.id, err: (err as Error).message },
          'reschedule failed; monitor next_due_at left stale (will retry next tick)',
        );
      }
    }
  }

  /**
   * Run a monitor's cycle under the configured hard timeout. The timeout does
   * not cancel the in-flight work (a hung fetch may still resolve later and is
   * harmless), but it unblocks the scheduler loop so the re-entrancy guard clears
   * and the remaining monitors are processed. With no timeout configured this is
   * a plain await.
   */
  private runWithTimeout(monitor: Monitor): Promise<void> {
    const ms = this.deps.runTimeoutMs;
    if (!ms || ms <= 0) return this.deps.runMonitor(monitor);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`monitor cycle exceeded ${ms}ms timeout`)),
        ms,
      );
      this.deps.runMonitor(monitor).then(
        () => { clearTimeout(timer); resolve(); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  /**
   * Begin driving `tick` on a fixed wall-clock interval. Each fire reads the
   * clock through the injectable `now()` dep. Overlapping ticks are skipped:
   * if a previous async tick is still in flight, this fire is a no-op so slow
   * cycles never pile up.
   */
  start(intervalMs: number): void {
    if (this.timer !== null) return; // already running; ignore re-entry
    this.timer = setInterval(() => {
      if (this.ticking) return; // a tick is still running — skip this fire
      this.ticking = true;
      // tick is async; clear the guard once it settles (success or failure).
      void this.tick(this.now()).finally(() => {
        this.ticking = false;
      });
    }, intervalMs);
  }

  /** Stop the interval loop. Safe to call when already stopped. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

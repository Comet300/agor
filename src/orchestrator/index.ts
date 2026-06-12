/**
 * Core orchestrator (Phase 7): the seam that wires registration, the polling
 * cycle, and the scheduler into one cohesive engine the bot layer drives.
 *
 * Responsibilities:
 *   - register(): Lifecycle A — turn a URL into a polling monitor (silent baseline).
 *   - runMonitorOnce(): Lifecycle B — run one cycle for a monitor and dispatch its
 *     notifications through the injected `notify` sink.
 *   - start()/stop(): hand the scheduler its heartbeat; each due monitor's cycle
 *     is run and its notifications delivered.
 *
 * The orchestrator owns the shared cross-cycle {@link DedupBuffer} and threads the
 * injectable clock (`now`) through every component so the whole engine stays
 * deterministic under test.
 */
import type { AppConfig } from '../config';
import type { MessageRef, Monitor, Notification } from '../contracts';
import type { Store } from '../persistence';
import type { PluginRegistry } from '../registry';
import type { ScrapingEngine } from '../scraping/engine';
import { CircuitBreaker } from '../scraping/circuitBreaker';
import { DedupBuffer } from '../pipeline';
import { Scheduler } from '../scheduler';
import { RegistrationService, type RegisterInput, type RegisterResult } from './registration';
import { MonitorCycle, type CycleResult } from './cycle';
import { log } from '../logging/logger';

export { RegistrationService } from './registration';
export type { RegisterInput, RegisterResult } from './registration';
export { MonitorCycle, type CycleResult } from './cycle';

/** Everything the orchestrator needs handed to it; nothing is read globally. */
export interface OrchestratorDeps {
  registry: PluginRegistry;
  store: Store;
  engine: ScrapingEngine;
  config: AppConfig;
  /**
   * Sink that delivers a ready notification (e.g. to Telegram). It SHOULD return
   * the sent message's {@link MessageRef} for `new_listing` notifications so the
   * orchestrator can later edit that alert to append cross-posted sources; any
   * other return (void) simply disables that enrichment for the notification.
   */
  notify: (n: Notification) => Promise<MessageRef | void>;
  /** Clock seam; defaults to the real epoch-ms wall clock for production use. */
  now?: () => number;
}

export class Orchestrator {
  /** Lifecycle A — registration. */
  readonly registration: RegistrationService;
  /** Lifecycle B — one polling cycle. */
  readonly cycle: MonitorCycle;
  /** The heartbeat that decides when each monitor polls. */
  readonly scheduler: Scheduler;

  private readonly deps: OrchestratorDeps;
  /** Resolved clock seam — always defined after the constructor. */
  private readonly now: () => number;
  /** Shared cross-cycle dedup buffer; also holds original alerts' message refs. */
  private readonly dedup: DedupBuffer;
  /** Per-vendor circuit breaker: pauses polling a hard-blocked/failing vendor. */
  private readonly breaker: CircuitBreaker;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());

    // Shared cross-cycle dedup buffer (search monitors notify a cross-posted
    // listing once per retention window).
    const dedup = new DedupBuffer(deps.config.dedupWindowMs);
    this.dedup = dedup;

    this.breaker = new CircuitBreaker(deps.config.circuitBreakerThreshold);

    this.registration = new RegistrationService({
      registry: deps.registry,
      store: deps.store,
      engine: deps.engine,
      defaultIntervalMs: deps.config.defaultCheckIntervalMs,
      oosFastIntervalMs: deps.config.oosFastIntervalMs,
      now: this.now,
    });

    this.cycle = new MonitorCycle({
      registry: deps.registry,
      store: deps.store,
      engine: deps.engine,
      minSample: deps.config.benchmarkMinSample,
      dedup,
      now: this.now,
    });

    // The scheduler runs each due monitor's cycle, delivers its notifications,
    // and tracks watch health.
    this.scheduler = new Scheduler({
      store: deps.store,
      runMonitor: async (m: Monitor) => {
        await this.runAndDispatch(m);
      },
      defaultIntervalMs: deps.config.defaultCheckIntervalMs,
      oosFastIntervalMs: deps.config.oosFastIntervalMs,
      now: this.now,
    });
  }

  /** Run a monitor's cycle, dispatch its notifications, and update its health. */
  private async runAndDispatch(monitor: Monitor): Promise<CycleResult> {
    // Circuit breaker: a vendor tripped open is not polled at all (it is blocked
    // or persistently failing — polling it is pure cost and ban risk). The watch
    // stays registered and resumes when the breaker is reset.
    if (this.breaker.isOpen(monitor.vendor)) {
      log('orchestrator').debug(
        { monitorId: monitor.id, vendor: monitor.vendor, event: 'CIRCUIT-OPEN' },
        'skipping poll — vendor circuit breaker is open',
      );
      return { notifications: [], ok: false, status: 0, itemsActive: 0, newItems: 0 };
    }

    const result = await this.cycle.run(monitor);
    await this.dispatch(result.notifications);
    await this.trackHealth(monitor, result);

    // Feed the breaker: a blocked or failed cycle is unhealthy. The user was
    // already told the watch is failing at `failureAlertThreshold` (a lower
    // count); the breaker is internal cost-control that pauses polling once a
    // higher threshold of consecutive failures is reached, so it only logs.
    const healthy = result.ok && !result.blocked;
    const tripped = this.breaker.record(monitor.vendor, { healthy });
    if (tripped) {
      log('orchestrator').warn(
        { monitorId: monitor.id, vendor: monitor.vendor, event: 'CIRCUIT-TRIPPED' },
        'vendor circuit breaker tripped — pausing polls until re-enabled',
      );
    }
    return result;
  }

  /**
   * Deliver each notification through `notify`, and for a `new_listing` record
   * the returned Telegram message against the dedup buffer so a later cross-post
   * can edit that original alert to append the alternative source.
   */
  private async dispatch(notifications: Notification[]): Promise<void> {
    for (const n of notifications) {
      const ref = await this.deps.notify(n);
      if (n.kind === 'new_listing' && ref && n.item) {
        const sig = this.dedup.signatureOf(n.item);
        this.dedup.setMessageRef(sig, ref);
        // Store the enriched original so a later cross-post edit keeps the badge.
        this.dedup.refreshOriginal(sig, n.item);
      }
    }
  }

  /**
   * Surface a failing watch to its chat — once when it reaches the failure
   * threshold, and once when it recovers. A cycle is unhealthy when the scrape
   * failed, or (for a search that previously had listings) it returned zero
   * items — covering blocks and manifest drift. Healthy cycles reset the count.
   */
  private async trackHealth(monitor: Monitor, result: CycleResult): Promise<void> {
    const priorListings = this.deps.store.items.knownIds(monitor.id).size;
    const unhealthy =
      !result.ok ||
      (monitor.type === 'search' && result.itemsActive === 0 && priorListings > 0);
    const threshold = this.deps.config.failureAlertThreshold;

    if (unhealthy) {
      monitor.consecutiveFailures += 1;
      if (monitor.consecutiveFailures === threshold) {
        await this.deps.notify(this.healthNotice('watch_failing', monitor));
      }
    } else {
      if (monitor.consecutiveFailures >= threshold) {
        await this.deps.notify(this.healthNotice('watch_recovered', monitor));
      }
      monitor.consecutiveFailures = 0;
    }
    this.deps.store.monitors.setFailures(monitor.id, monitor.consecutiveFailures);
  }

  private healthNotice(
    kind: 'watch_failing' | 'watch_recovered',
    monitor: Monitor,
  ): Notification {
    return {
      kind,
      chatId: monitor.chatId,
      health: {
        monitorId: monitor.id,
        vendor: monitor.vendor,
        url: monitor.url,
        consecutiveFailures: monitor.consecutiveFailures,
      },
    };
  }

  /** Lifecycle A: register a new monitor from a raw URL (silent baseline). */
  register(input: RegisterInput): Promise<RegisterResult> {
    return this.registration.register(input);
  }

  /**
   * Lifecycle B on demand (also powers `/check`): load a monitor, run one cycle,
   * dispatch its notifications, update health, and return the {@link CycleResult}.
   * Resolves to an empty failed result when the monitor no longer exists.
   */
  async runMonitorOnce(monitorId: number): Promise<CycleResult> {
    const monitor = this.deps.store.monitors.get(monitorId);
    if (!monitor) return { notifications: [], ok: false, status: 0, itemsActive: 0, newItems: 0 };
    return this.runAndDispatch(monitor);
  }

  /**
   * Begin the scheduler heartbeat. Ticks fire on the tighter of the two cadences
   * (fast OOS tier vs. default) so an out-of-stock monitor's quick interval is
   * always honoured.
   */
  start(): void {
    this.scheduler.start(
      Math.min(this.deps.config.oosFastIntervalMs, this.deps.config.defaultCheckIntervalMs),
    );
  }

  /** Stop the scheduler heartbeat. Safe to call when already stopped. */
  stop(): void {
    this.scheduler.stop();
  }

  /** Vendors whose circuit breaker is currently open (polling paused). */
  blockedVendors(): string[] {
    return this.breaker.openVendors();
  }

  /** Manually re-enable a circuit-broken vendor so its watches poll again. */
  resetCircuit(vendor: string): void {
    this.breaker.reset(vendor);
    log('orchestrator').info({ vendor, event: 'CIRCUIT-RESET' }, 'vendor circuit breaker reset');
  }
}

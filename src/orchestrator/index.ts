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
import { DedupBuffer } from '../pipeline';
import { Scheduler } from '../scheduler';
import { RegistrationService, type RegisterInput, type RegisterResult } from './registration';
import { MonitorCycle } from './cycle';

export { RegistrationService } from './registration';
export type { RegisterInput, RegisterResult } from './registration';
export { MonitorCycle } from './cycle';

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

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());

    // Shared cross-cycle dedup buffer (search monitors notify a cross-posted
    // listing once per retention window).
    const dedup = new DedupBuffer(deps.config.dedupWindowMs);
    this.dedup = dedup;

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

    // The scheduler runs each due monitor's cycle and delivers its notifications.
    this.scheduler = new Scheduler({
      store: deps.store,
      runMonitor: async (m: Monitor) => {
        await this.dispatch(await this.cycle.run(m));
      },
      defaultIntervalMs: deps.config.defaultCheckIntervalMs,
      oosFastIntervalMs: deps.config.oosFastIntervalMs,
      now: this.now,
    });
  }

  /**
   * Deliver each notification through `notify`, and for a `new_listing` record
   * the returned Telegram message against the dedup buffer so a later cross-post
   * can edit that original alert to append the alternative source.
   */
  private async dispatch(notifications: Notification[]): Promise<void> {
    for (const n of notifications) {
      const ref = await this.deps.notify(n);
      if (n.kind === 'new_listing' && ref) {
        const sig = this.dedup.signatureOf(n.item);
        this.dedup.setMessageRef(sig, ref);
        // Store the enriched original so a later cross-post edit keeps the badge.
        this.dedup.refreshOriginal(sig, n.item);
      }
    }
  }

  /** Lifecycle A: register a new monitor from a raw URL (silent baseline). */
  register(input: RegisterInput): Promise<RegisterResult> {
    return this.registration.register(input);
  }

  /**
   * Lifecycle B on demand: load a monitor, run one cycle, dispatch every
   * resulting notification through `notify`, and return them for the caller.
   * Resolves to an empty array when the monitor no longer exists.
   */
  async runMonitorOnce(monitorId: number): Promise<Notification[]> {
    const monitor = this.deps.store.monitors.get(monitorId);
    if (!monitor) return [];

    const notifications = await this.cycle.run(monitor);
    await this.dispatch(notifications);
    return notifications;
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
}

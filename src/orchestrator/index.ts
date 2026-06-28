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
import type { AppConfig } from "../config";
import type { MessageRef, Monitor, Notification, NotificationKind, DigestSummary } from "../contracts";
import { DIGEST_PERIOD_MS } from "../features/digest";
import type { Store } from "../persistence";
import { maintainDb } from "../persistence";
import type { PluginRegistry } from "../registry";
import type { ScrapingEngine } from "../scraping/engine";
import { CircuitBreaker } from "../scraping/circuitBreaker";
import { DedupBuffer } from "../pipeline";
import { Scheduler } from "../scheduler";
import {
  RegistrationService,
  type RegisterInput,
  type RegisterResult,
  type PreviewResult,
} from "./registration";
import { MonitorCycle, type CycleResult } from "./cycle";
import { log } from "../logging/logger";

export { RegistrationService } from "./registration";
export type { RegisterInput, RegisterResult, PreviewResult } from "./registration";
export { MonitorCycle, type CycleResult } from "./cycle";

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
  /**
   * Per-chat cross-cycle dedup buffers. Each chat gets its OWN buffer so the
   * intra-user cross-vendor dedup (same listing on two marketplaces → one alert)
   * works, while one user's listings can never suppress or cross-edit another
   * user's alerts (the buffer instance is the per-chat namespace).
   */
  private readonly dedupByChat = new Map<number, DedupBuffer>();
  /** Per-vendor circuit breaker: pauses polling a hard-blocked/failing vendor. */
  private readonly breaker: CircuitBreaker;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());

    this.breaker = new CircuitBreaker(deps.config.circuitBreakerThreshold);

    this.registration = new RegistrationService({
      registry: deps.registry,
      store: deps.store,
      engine: deps.engine,
      defaultIntervalMs: deps.config.defaultCheckIntervalMs,
      oosFastIntervalMs: deps.config.oosFastIntervalMs,
      maxMonitorsPerChat: deps.config.maxMonitorsPerChat,
      now: this.now,
    });

    this.cycle = new MonitorCycle({
      registry: deps.registry,
      store: deps.store,
      engine: deps.engine,
      minSample: deps.config.benchmarkMinSample,
      dedupFor: (chatId) => this.dedupFor(chatId),
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
      runTimeoutMs: deps.config.monitorCycleTimeoutMs,
      onMaintenance: async () =>
        maintainDb(deps.store.db, {
          now: this.now(),
          dedupMaxAgeMs: deps.config.dedupWindowMs,
          auditRetentionDays: deps.config.auditRetentionDays,
        }),
      maintenanceIntervalTicks: deps.config.dbMaintenanceIntervalTicks,
      onDigestFlush: async () => this.flushDigests(this.now()),
      now: this.now,
    });
  }

  /**
   * Whether the chat that owns a monitor is currently permitted to be polled.
   * Access control activates the moment the first admin exists (the same instant
   * the bot becomes deny-by-default). Before that — an empty access table — every
   * monitor runs. Once active, a monitor whose owner is not `allowed` (revoked /
   * pending) is paused — not polled, not notified — until the owner is allowed
   * again. (A monitor can only be created by an already-allowed owner, so this is
   * effectively the revocation gate.)
   */
  private ownerAllowed(chatId: number): boolean {
    if (!this.deps.store.access.hasAnyAdmin()) return true; // pre-bootstrap: nothing enforced
    // Single lookup resolves both allowed-status and admin.
    const rec = this.deps.store.access.get(chatId);
    return rec?.status === 'allowed' || rec?.isAdmin === true;
  }

  /**
   * The dedup buffer for a chat, created on first use (per-chat isolation). Bound
   * to the store so it rehydrates from disk and persists through — already-seen
   * listings are not re-alerted after a restart.
   */
  private dedupFor(chatId: number): DedupBuffer {
    let buf = this.dedupByChat.get(chatId);
    if (!buf) {
      buf = new DedupBuffer(this.deps.config.dedupWindowMs, {
        store: this.deps.store.dedup,
        chatId,
      });
      this.dedupByChat.set(chatId, buf);
    }
    return buf;
  }

  /** Run a monitor's cycle, dispatch its notifications, and update its health. */
  private async runAndDispatch(monitor: Monitor): Promise<CycleResult> {
    // Access gate: a revoked / non-allowed owner's monitors are paused (stateless
    // — re-allowing resumes instantly). The watch row stays; it just isn't polled.
    if (!this.ownerAllowed(monitor.chatId)) {
      log("orchestrator").debug(
        {
          monitorId: monitor.id,
          chatId: monitor.chatId,
          event: "OWNER-NOT-ALLOWED",
        },
        "skipping poll — monitor owner is not allowed",
      );
      return {
        notifications: [],
        ok: false,
        status: 0,
        itemsActive: 0,
        newItems: 0,
      };
    }

    // Circuit breaker: a vendor tripped open is not polled at all (it is blocked
    // or persistently failing — polling it is pure cost and ban risk). The watch
    // stays registered and resumes when the breaker is reset.
    if (this.breaker.isOpen(monitor.vendor)) {
      log("orchestrator").debug(
        {
          monitorId: monitor.id,
          vendor: monitor.vendor,
          event: "CIRCUIT-OPEN",
        },
        "skipping poll — vendor circuit breaker is open",
      );
      return {
        notifications: [],
        ok: false,
        status: 0,
        itemsActive: 0,
        newItems: 0,
      };
    }

    const result = await this.cycle.run(monitor);
    await this.dispatch(result.notifications, monitor);
    await this.trackHealth(monitor, result);

    // Feed the breaker: a blocked or failed cycle is unhealthy. The user was
    // already told the watch is failing at `failureAlertThreshold` (a lower
    // count); the breaker is internal cost-control that pauses polling once a
    // higher threshold of consecutive failures is reached, so it only logs.
    const healthy = result.ok && !result.blocked;
    const tripped = this.breaker.record(monitor.vendor, { healthy });
    if (tripped) {
      log("orchestrator").warn(
        {
          monitorId: monitor.id,
          vendor: monitor.vendor,
          event: "CIRCUIT-TRIPPED",
        },
        "vendor circuit breaker tripped — pausing polls until re-enabled",
      );
    }
    return result;
  }

  /**
   * Deliver each notification through `notify`, and for a `new_listing` record
   * the returned Telegram message against the dedup buffer so a later cross-post
   * can edit that original alert to append the alternative source.
   */
  private async dispatch(notifications: Notification[], monitor: Monitor): Promise<void> {
    // Group/shared watch: a listing alert fans out to the owner PLUS every
    // subscriber chat. Operational and cross-post edits stay owner-only — a
    // subscriber neither cares about the owner's watch health nor holds the
    // original message a cross-post would edit.
    const subscribers = this.deps.store.watchSubscribers
      .listChats(monitor.id)
      .filter((c) => c !== monitor.chatId);
    const ownerOnly = (k: NotificationKind): boolean =>
      k === "cross_post" || k === "watch_failing" || k === "watch_recovered";

    // Suppress alerts for listings a chat has dismissed (per-chat cache).
    const dismissedByChat = new Map<number, Set<string>>();
    const isDismissed = (chatId: number, itemId: string): boolean => {
      let set = dismissedByChat.get(chatId);
      if (!set) dismissedByChat.set(chatId, (set = this.deps.store.itemFlags.dismissedIds(chatId)));
      return set.has(itemId);
    };

    for (const n of notifications) {
      const targets = ownerOnly(n.kind) ? [monitor.chatId] : [monitor.chatId, ...subscribers];
      for (const chatId of targets) {
        if (n.item && isDismissed(chatId, n.item.id)) continue;
        // Digest mode: park new-listing alerts for a batched daily/weekly summary
        // instead of pinging them in real time (other kinds still alert live).
        if (n.kind === "new_listing" && monitor.filters.digest && n.item) {
          this.deps.store.digestQueue.enqueue(monitor.id, chatId, {
            itemId: n.item.id,
            title: n.item.title,
            price: n.item.price,
            currency: n.item.currency,
            url: n.item.url,
            ...(n.item.dealTag ? { dealTag: n.item.dealTag } : {}),
            ...(n.fairValue ? { deltaPct: n.fairValue.deltaPct } : {}),
          }, this.now());
          continue;
        }
        // Re-target a copy for subscribers; the owner keeps the original object.
        const delivery: Notification = chatId === monitor.chatId ? n : { ...n, chatId };
        // Isolate each delivery: a single failing notify() (Telegram hiccup,
        // blocked chat) must not abort the rest of the batch or short-circuit the
        // caller's health tracking. Log and continue.
        let ref: MessageRef | void;
        try {
          ref = await this.deps.notify(delivery);
        } catch (err) {
          log("orchestrator").warn(
            { chatId, kind: n.kind, err: (err as Error).message },
            "notification delivery failed",
          );
          continue;
        }
        if (chatId === monitor.chatId && n.kind === "new_listing" && ref && n.item) {
          // Record the message ref on the OWNER's buffer (per-chat isolation) so a
          // later cross-post can edit that original alert. Subscriber sends are
          // fresh and untracked by design.
          const dedup = this.dedupFor(chatId);
          const sig = dedup.signatureOf(n.item);
          dedup.setMessageRef(sig, ref);
          // Store the enriched original so a later cross-post edit keeps the badge.
          dedup.refreshOriginal(sig, n.item);
        }
      }
    }
  }

  /**
   * Flush every digest-mode (watch, chat) group whose window has elapsed: render
   * a ranked best-deals-first summary, deliver it, and clear the queue. A group
   * whose watch lost its digest setting or was removed is dropped without sending.
   * Idempotent and cheap to call every tick — `pending()` is one grouped query.
   */
  async flushDigests(now: number): Promise<void> {
    for (const g of this.deps.store.digestQueue.pending()) {
      const monitor = this.deps.store.monitors.get(g.monitorId);
      const mode = monitor?.filters.digest;
      if (!monitor || mode === undefined) {
        this.deps.store.digestQueue.clear(g.monitorId, g.chatId); // stale → drop
        continue;
      }
      if (now - g.oldest < DIGEST_PERIOD_MS[mode]) continue; // window not elapsed
      const rows = this.deps.store.digestQueue.items(g.monitorId, g.chatId);
      if (rows.length === 0) {
        this.deps.store.digestQueue.clear(g.monitorId, g.chatId);
        continue;
      }
      const digest: DigestSummary = { vendor: monitor.vendor, period: mode, entries: rows };
      try {
        await this.deps.notify({ kind: "digest", chatId: g.chatId, digest });
      } catch (err) {
        log("orchestrator").warn(
          { chatId: g.chatId, err: (err as Error).message },
          "digest delivery failed",
        );
        continue; // keep the queue; retry on a later tick
      }
      this.deps.store.digestQueue.clear(g.monitorId, g.chatId);
    }
  }

  /**
   * Surface a failing watch to its chat — once when it reaches the failure
   * threshold, and once when it recovers. A cycle is unhealthy when the scrape
   * failed, or (for a search that previously had listings) it returned zero
   * items — covering blocks and manifest drift. Healthy cycles reset the count.
   */
  private async trackHealth(
    monitor: Monitor,
    result: CycleResult,
  ): Promise<void> {
    const priorListings = this.deps.store.items.knownIds(monitor.id).size;
    const unhealthy =
      !result.ok ||
      (monitor.type === "search" &&
        result.itemsActive === 0 &&
        priorListings > 0);
    const threshold = this.deps.config.failureAlertThreshold;

    // Health notices are best-effort: a delivery failure (blocked chat, Telegram
    // hiccup) must NOT prevent the new failure count from being persisted, or the
    // in-memory counter and the DB drift and the threshold mis-fires after a
    // restart. Isolate the send so `setFailures` below always runs.
    if (unhealthy) {
      monitor.consecutiveFailures += 1;
      if (monitor.consecutiveFailures === threshold) {
        await this.notifyHealth("watch_failing", monitor);
      }
    } else {
      if (monitor.consecutiveFailures >= threshold) {
        await this.notifyHealth("watch_recovered", monitor);
      }
      monitor.consecutiveFailures = 0;
    }
    this.deps.store.monitors.setFailures(
      monitor.id,
      monitor.consecutiveFailures,
    );
  }

  /** Deliver a health notice, swallowing+logging a delivery failure so the
   *  caller can still persist the failure counter (see {@link trackHealth}). */
  private async notifyHealth(
    kind: "watch_failing" | "watch_recovered",
    monitor: Monitor,
  ): Promise<void> {
    try {
      await this.deps.notify(this.healthNotice(kind, monitor));
    } catch (err) {
      log("orchestrator").warn(
        { monitorId: monitor.id, kind, err: (err as Error).message },
        "health notice delivery failed",
      );
    }
  }

  private healthNotice(
    kind: "watch_failing" | "watch_recovered",
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

  /** One-shot scrape of a URL (no watch created) — powers /rate. */
  previewItem(rawUrl: string): Promise<PreviewResult> {
    return this.registration.previewItem(rawUrl);
  }

  /**
   * Lifecycle B on demand (also powers `/check`): load a monitor, run one cycle,
   * dispatch its notifications, update health, and return the {@link CycleResult}.
   * Resolves to an empty failed result when the monitor no longer exists.
   */
  async runMonitorOnce(monitorId: number): Promise<CycleResult> {
    const monitor = this.deps.store.monitors.get(monitorId);
    if (!monitor)
      return {
        notifications: [],
        ok: false,
        status: 0,
        itemsActive: 0,
        newItems: 0,
      };
    return this.runAndDispatch(monitor);
  }

  /**
   * Begin the scheduler heartbeat. Ticks fire on the tighter of the two cadences
   * (fast OOS tier vs. default) so an out-of-stock monitor's quick interval is
   * always honoured.
   */
  start(): void {
    // Prune expired dedup rows on boot: in-memory pruning only fires while a
    // chat's monitors poll, so idle/removed monitors would otherwise leave rows
    // to be reloaded forever. This is the durable backstop (maintenance repeats it).
    try {
      this.deps.store.dedup.pruneExpired(
        this.now(),
        this.deps.config.dedupWindowMs,
      );
    } catch (err) {
      log("orchestrator").warn(
        { err: (err as Error).message },
        "boot dedup prune failed",
      );
    }
    this.scheduler.start(
      Math.min(
        this.deps.config.oosFastIntervalMs,
        this.deps.config.defaultCheckIntervalMs,
      ),
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
    log("orchestrator").info(
      { vendor, event: "CIRCUIT-RESET" },
      "vendor circuit breaker reset",
    );
  }
}

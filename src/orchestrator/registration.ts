/**
 * Orchestrator — Lifecycle A: monitor registration (Phase 7).
 *
 * Turns a raw user URL into a durable, polling-ready {@link Monitor}. The flow is
 * deliberately *silent*: the very first scrape only establishes a baseline of
 * the listings/price/stock already present, so the user is never spammed with a
 * notification for everything that existed at the moment they hit "watch this".
 *
 * Time is injected (`now()`), keeping registration deterministic under test.
 */
import type { Monitor, MonitorType } from '../contracts';
import type { Store } from '../persistence';
import type { PluginRegistry } from '../registry';
import type { ScrapingEngine } from '../scraping/engine';
import { normalizeItems } from '../pipeline';
import { scrubUrl } from '../util/url';

/** What the caller supplies to register a new watch. */
export interface RegisterInput {
  /** Owning Telegram chat id. */
  chatId: number;
  /** The URL the user pasted (telemetry not yet stripped). */
  rawUrl: string;
  /** Optional explicit kind; defaults to a search-results watch. */
  type?: MonitorType;
}

/**
 * Outcome of a registration attempt. On success the freshly-created monitor and
 * the size of its silent baseline are returned; on failure a user-facing reason.
 */
export type RegisterResult =
  | { ok: true; monitor: Monitor; baselineCount: number }
  | { ok: false; error: string };

/** Dependencies the registration service needs; nothing is read globally. */
interface RegistrationDeps {
  registry: PluginRegistry;
  store: Store;
  engine: ScrapingEngine;
  /** Base polling cadence stamped onto every new monitor. */
  defaultIntervalMs: number;
  /** Accelerated cadence for a product whose baseline is already out of stock. */
  oosFastIntervalMs: number;
  /** Clock seam; defaults to the real epoch-ms wall clock for production use. */
  now?: () => number;
}

export class RegistrationService {
  private readonly deps: RegistrationDeps;
  /** Resolved clock seam — always defined after the constructor. */
  private readonly now: () => number;

  constructor(deps: RegistrationDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Register a new monitor (Lifecycle A):
   *   1. scrub the URL (reject anything unparseable / non-HTTP),
   *   2. resolve the owning vendor plugin (reject unsupported domains),
   *   3. create the monitor row FIRST so we have its id for persistence,
   *   4. run one baseline scrape and record every item's state + price,
   *   5. return the monitor and baseline size — firing NO notifications.
   */
  async register(input: RegisterInput): Promise<RegisterResult> {
    // 1. Scrub telemetry and validate the URL shape.
    let scrubbed: string;
    try {
      scrubbed = scrubUrl(input.rawUrl);
    } catch {
      return { ok: false, error: 'Invalid URL' };
    }

    // 2. Resolve the vendor plugin that claims this domain.
    const plugin = this.deps.registry.matchUrl(scrubbed);
    if (!plugin) {
      return {
        ok: false,
        error: 'Unsupported site — no plugin matches this domain.',
      };
    }

    const type: MonitorType = input.type ?? 'search';
    const startedAt = this.now();

    // 3. Create the monitor first so we have an id to key items/prices against.
    const monitor = this.deps.store.monitors.create({
      type,
      chatId: input.chatId,
      vendor: plugin.vendor,
      url: scrubbed,
      filters: { sellerVisibility: 'both', exclusionKeywords: [] },
      intervalMs: this.deps.defaultIntervalMs,
      nextDueAt: startedAt + this.deps.defaultIntervalMs,
    });

    // 4. Baseline scrape — the silent snapshot of what already exists.
    const outcome =
      type === 'search'
        ? await this.deps.engine.scrapeSearch(plugin, scrubbed, startedAt)
        : await this.deps.engine.scrapeProduct(plugin, scrubbed, startedAt);

    // A failed/empty baseline is not fatal: the monitor still exists and will
    // pick up listings on its first real cycle (with no false "new" backlog,
    // since whatever it sees then will simply be unknown ids).
    if (!outcome.ok) {
      return { ok: true, monitor, baselineCount: 0 };
    }

    // Normalize the raw nodes with this monitor's mapping and seed persistence.
    const items = normalizeItems(outcome.rawNodes, plugin, type);
    for (const item of items) {
      this.deps.store.items.upsert(monitor.id, item, startedAt);
      this.deps.store.priceHistory.append({
        monitorId: monitor.id,
        itemId: item.id,
        price: item.price,
        currency: item.currency,
        observedAt: startedAt,
      });
    }

    // Back-in-stock escalation at the baseline: per the spec, scheduling priority
    // short-circuits to the fast tier *whenever* a tracked item's inStock baseline
    // reports false. A product registered while already out of stock must therefore
    // start on the fast tier rather than wait a full default interval for its first poll.
    let registered = monitor;
    if (type === 'product' && items.some((i) => i.inStock === false)) {
      const fastDueAt = startedAt + this.deps.oosFastIntervalMs;
      this.deps.store.monitors.setSchedule(monitor.id, fastDueAt, true);
      registered = { ...monitor, fastTier: true, nextDueAt: fastDueAt };
    }

    // 5. Return success — explicitly firing no notifications.
    return { ok: true, monitor: registered, baselineCount: items.length };
  }
}

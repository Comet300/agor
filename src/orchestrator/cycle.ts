/**
 * Orchestrator — Lifecycle B: one polling cycle for a single monitor (Phase 7).
 *
 * This is where change detection produces the three notification kinds:
 *   - search monitors  -> `new_listing` for genuinely new, deduped, enriched ads
 *     (Feature 9.1),
 *   - product monitors -> `price_drop` when the price falls (Feature 9.2) and
 *     `back_in_stock` on a false→true stock transition (Feature 9.3).
 *
 * The cycle is the only orchestration component that *both* reads the network
 * (via the engine) and writes persistence (item state + price history). It never
 * dispatches anything itself — it returns the notifications for the caller (the
 * scheduler/orchestrator) to deliver. Time is injected for determinism.
 */
import type { Monitor, Notification } from '../contracts';
import type { Store } from '../persistence';
import type { PluginRegistry } from '../registry';
import type { ScrapingEngine } from '../scraping/engine';
import {
  runPipeline,
  normalizeItems,
  applySellerFilter,
  applyExclusion,
  DedupBuffer,
} from '../pipeline';

/** Dependencies a cycle run needs; nothing is read globally. */
interface CycleDeps {
  registry: PluginRegistry;
  store: Store;
  engine: ScrapingEngine;
  /** Min listings before a benchmark is confident enough to deal-tag items. */
  minSample: number;
  /** Optional cross-cycle dedup buffer shared across runs (search monitors). */
  dedup?: DedupBuffer;
  /** Clock seam; defaults to the real epoch-ms wall clock for production use. */
  now?: () => number;
}

export class MonitorCycle {
  private readonly deps: CycleDeps;
  /** Resolved clock seam — always defined after the constructor. */
  private readonly now: () => number;

  constructor(deps: CycleDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Run one polling cycle for `monitor` and return the notifications it produced.
   *
   * NOTE on `fastTier`: for product monitors this method MUTATES
   * `monitor.fastTier` in place to reflect the latest stock (out-of-stock => the
   * faster polling tier). It does NOT persist that flag — the scheduler does, via
   * `reschedule`, when it re-arms the monitor after this cycle returns.
   */
  async run(monitor: Monitor): Promise<Notification[]> {
    // Resolve the plugin from the monitor's own URL (fall back to its vendor
    // domain mapping if the URL no longer matches a manifest).
    const plugin =
      this.deps.registry.matchUrl(monitor.url) ??
      this.deps.registry.getByDomain(monitor.vendor);
    if (!plugin) return [];

    return monitor.type === 'search'
      ? this.runSearch(monitor, plugin)
      : this.runProduct(monitor, plugin);
  }

  /** Search monitor: emit `new_listing` for each genuinely new, enriched ad. */
  private async runSearch(
    monitor: Monitor,
    plugin: NonNullable<ReturnType<PluginRegistry['matchUrl']>>,
  ): Promise<Notification[]> {
    const at = this.now();
    const outcome = await this.deps.engine.scrapeSearch(plugin, monitor.url, at);
    if (!outcome.ok) return [];

    // The pipeline does the heavy lifting: normalize -> exclude -> seller filter
    // (=> active) -> delta vs known ids -> dedup -> benchmark/deal-tag.
    const out = runPipeline({
      rawNodes: outcome.rawNodes,
      plugin,
      mapping: 'search',
      filters: monitor.filters,
      historicalIds: this.deps.store.items.knownIds(monitor.id),
      minSample: this.deps.minSample,
      dedup: this.deps.dedup,
      now: at,
    });

    // One notification per genuinely new (already enriched) listing.
    const notifications: Notification[] = out.newEnriched.map((item) => ({
      kind: 'new_listing',
      chatId: monitor.chatId,
      item,
    }));

    // Cross-batch duplicates: the new alert is suppressed; instead we edit the
    // ORIGINAL alert to append the alternative source. Only possible when the
    // original's Telegram message was recorded (same-session); otherwise the
    // source is still kept on the buffer entry for any future edit.
    for (const cross of out.crossPosts) {
      const ref = cross.entry.messageRef;
      if (ref) {
        notifications.push({
          kind: 'cross_post',
          chatId: ref.chatId,
          messageRef: ref,
          item: cross.entry.item,
        });
      }
    }

    // Persist every active item; the NEW ones also get a first price point.
    // (Determine "new" via the pre-cycle known set so already-stored ids that
    // re-appear this cycle don't double-log a price.)
    const newIds = new Set(out.newEnriched.map((i) => i.id));
    for (const item of out.active) {
      this.deps.store.items.upsert(monitor.id, item, at);
      if (newIds.has(item.id)) {
        this.deps.store.priceHistory.append({
          monitorId: monitor.id,
          itemId: item.id,
          price: item.price,
          currency: item.currency,
          observedAt: at,
        });
      }
    }

    return notifications;
  }

  /** Product monitor: detect `price_drop` and `back_in_stock` for the one ad. */
  private async runProduct(
    monitor: Monitor,
    plugin: NonNullable<ReturnType<PluginRegistry['matchUrl']>>,
  ): Promise<Notification[]> {
    const at = this.now();
    const outcome = await this.deps.engine.scrapeProduct(plugin, monitor.url, at);
    if (!outcome.ok) return [];

    // A product page yields exactly one node; bail if it failed to normalize.
    const item = normalizeItems(outcome.rawNodes, plugin, 'product')[0];
    if (!item) return [];

    // Honour the user's filters even for a single product: a seller-type or
    // exclusion-keyword change can make a previously-watched item irrelevant.
    // When it is filtered out we still refresh stored state (so we don't later
    // emit a false transition) but emit nothing.
    const afterExclusion = applyExclusion([item], monitor.filters.exclusionKeywords);
    const visible = applySellerFilter(afterExclusion, monitor.filters.sellerVisibility);
    if (visible.length === 0) {
      this.deps.store.items.upsert(monitor.id, item, at);
      return [];
    }

    // Compare against the last known snapshot to detect transitions.
    const prev = this.deps.store.items.getState(monitor.id, item.id);
    const prevPrice =
      this.deps.store.priceHistory.lastPrice(monitor.id, item.id) ?? prev?.lastPrice;

    const notifications: Notification[] = [];

    // Price drop: a strictly lower price than what we last recorded.
    if (prevPrice !== undefined && item.price < prevPrice) {
      notifications.push({
        kind: 'price_drop',
        chatId: monitor.chatId,
        item,
        priceDrop: {
          previousPrice: prevPrice,
          currentPrice: item.price,
          savings: prevPrice - item.price,
        },
      });
    }

    // Back in stock: a false -> true stock transition (needs a prior snapshot).
    if (prev && prev.inStock === false && item.inStock === true) {
      notifications.push({
        kind: 'back_in_stock',
        chatId: monitor.chatId,
        item,
      });
    }

    // Always record the new price point and refresh stored state.
    this.deps.store.priceHistory.append({
      monitorId: monitor.id,
      itemId: item.id,
      price: item.price,
      currency: item.currency,
      observedAt: at,
    });
    this.deps.store.items.upsert(monitor.id, item, at);

    // Reflect current stock onto the in-memory monitor so the scheduler can
    // place it on the fast (out-of-stock) tier when it re-arms the schedule.
    monitor.fastTier = item.inStock === false;

    return notifications;
  }
}

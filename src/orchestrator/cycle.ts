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
import type { IScrapedItem, Monitor, Notification } from '../contracts';
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
import { marketInsight } from '../features/marketInsight';
import { ratePrice } from '../features/priceRating';
import {
  parseNumericAttrs, inferCategory, featureVector, targetValue,
  emptyState, addObservation, FEATURE_K, type RidgeState,
} from '../features/fairValue';
import { log } from '../logging/logger';

/** Cap on the comparable pool loaded when rating a tracked item for became-a-deal. */
const RATING_POOL_CAP = 200;

/** Dependencies a cycle run needs; nothing is read globally. */
interface CycleDeps {
  registry: PluginRegistry;
  store: Store;
  engine: ScrapingEngine;
  /** Min listings before a benchmark is confident enough to deal-tag items. */
  minSample: number;
  /** Resolve the per-chat cross-cycle dedup buffer (search monitors). */
  dedupFor?: (chatId: number) => DedupBuffer;
  /** Clock seam; defaults to the real epoch-ms wall clock for production use. */
  now?: () => number;
}

/** The outcome of one polling cycle — notifications plus the health-relevant stats. */
export interface CycleResult {
  notifications: Notification[];
  ok: boolean;
  status: number;
  itemsActive: number;
  newItems: number;
  /** True when the scrape was a recognised anti-bot hard block (circuit breaker). */
  blocked?: boolean;
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
   * Run one polling cycle for `monitor` and return its {@link CycleResult} — the
   * notifications it produced plus ok/status/item counts the orchestrator uses
   * for dispatch, failure surfacing, and `/check`.
   *
   * NOTE on `fastTier`: for product monitors this method MUTATES
   * `monitor.fastTier` in place to reflect the latest stock (out-of-stock => the
   * faster polling tier). It does NOT persist that flag — the scheduler does, via
   * `reschedule`, when it re-arms the monitor after this cycle returns.
   */
  async run(monitor: Monitor): Promise<CycleResult> {
    // Resolve the plugin from the monitor's own URL (fall back to its vendor
    // domain mapping if the URL no longer matches a manifest).
    const plugin =
      this.deps.registry.matchUrl(monitor.url) ??
      this.deps.registry.getByDomain(monitor.vendor);
    if (!plugin) {
      log('cycle').warn(
        { monitorId: monitor.id, vendor: monitor.vendor, type: monitor.type, ok: false, reason: 'no_plugin' },
        'poll failed',
      );
      return { notifications: [], ok: false, status: 0, itemsActive: 0, newItems: 0 };
    }

    return monitor.type === 'search'
      ? this.runSearch(monitor, plugin)
      : this.runProduct(monitor, plugin);
  }

  /** Emit exactly one structured event per poll (info on success, warn on failure). */
  private logPoll(
    monitor: Monitor,
    startedAt: number,
    fields: { ok: boolean; status?: number; itemsActive?: number; newItems?: number; notifications?: number; reason?: string },
  ): void {
    const event = {
      monitorId: monitor.id,
      vendor: monitor.vendor,
      type: monitor.type,
      durationMs: this.now() - startedAt,
      ...fields,
    };
    if (fields.ok) log('cycle').info(event, 'poll');
    else log('cycle').warn(event, 'poll failed');
  }

  /** Search monitor: emit `new_listing` for each genuinely new, enriched ad. */
  private async runSearch(
    monitor: Monitor,
    plugin: NonNullable<ReturnType<PluginRegistry['matchUrl']>>,
  ): Promise<CycleResult> {
    const at = this.now();
    const outcome = await this.deps.engine.scrapeSearch(plugin, monitor.url, at);
    if (!outcome.ok) {
      this.logPoll(monitor, at, { ok: false, status: outcome.status, reason: outcome.blocked ? 'blocked' : 'scrape_failed' });
      return { notifications: [], ok: false, status: outcome.status, itemsActive: 0, newItems: 0, blocked: outcome.blocked };
    }

    // The pipeline does the heavy lifting: normalize -> exclude -> seller filter
    // (=> active) -> delta vs known ids -> dedup -> benchmark/deal-tag.
    const out = runPipeline({
      rawNodes: outcome.rawNodes,
      plugin,
      mapping: 'search',
      filters: monitor.filters,
      historicalIds: this.deps.store.items.knownIds(monitor.id),
      minSample: this.deps.minSample,
      dedup: this.deps.dedupFor?.(monitor.chatId),
      now: at,
    });

    // Currency could not be resolved for some items (no declared field, no symbol
    // in the price text, and no other item to infer a SERP-dominant currency
    // from). They are still benchmarked as one implicit bucket, but surface the
    // gap so a manifest currency-path issue isn't invisible.
    const blankCurrency = out.active.filter((i) => i.currency === '').length;
    if (blankCurrency > 0) {
      log('cycle').warn(
        { monitorId: monitor.id, vendor: monitor.vendor, blankCurrency, active: out.active.length },
        'items with unresolved currency (benchmarked as one bucket)',
      );
    }

    // Deals-only: drop new listings the benchmark is CONFIDENT are above median.
    // When the sample is too small to judge (not confident), nothing is dropped,
    // so a fresh watch still alerts until it has enough data to call a deal.
    const fresh = monitor.filters.dealsOnly
      ? out.newEnriched.filter(
          (item) => !(item.benchmark?.confident && item.price > item.benchmark.median),
        )
      : out.newEnriched;

    // One notification per genuinely new (already enriched) listing.
    const notifications: Notification[] = fresh.map((item) => ({
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

    // Persist every active item AND log its price (store-on-change, so an
    // unchanged price is a no-op). This gives search-collected items a full price
    // trajectory — not just the new ones — so /history and market insight work
    // for them too. Wrapped in one transaction so a mid-cycle crash can't leave an
    // item stored without its price (or vice versa), committing as a single fsync.
    this.deps.store.transaction(() => {
      for (const item of out.active) {
        this.deps.store.items.upsert(monitor.id, item, at);
        this.deps.store.priceHistory.append({
          monitorId: monitor.id,
          itemId: item.id,
          price: item.price,
          currency: item.currency,
          observedAt: at,
        });
      }
    });

    // Feed the fair-value models with this batch's attributes (v2).
    this.feedValuation(out.active, at);

    this.logPoll(monitor, at, {
      ok: true,
      status: outcome.status,
      itemsActive: out.active.length,
      newItems: out.newEnriched.length,
      notifications: notifications.length,
    });
    return {
      notifications,
      ok: true,
      status: outcome.status,
      itemsActive: out.active.length,
      newItems: out.newEnriched.length,
    };
  }

  /** Product monitor: detect `price_drop` and `back_in_stock` for the one ad. */
  private async runProduct(
    monitor: Monitor,
    plugin: NonNullable<ReturnType<PluginRegistry['matchUrl']>>,
  ): Promise<CycleResult> {
    const at = this.now();
    const outcome = await this.deps.engine.scrapeProduct(plugin, monitor.url, at);
    if (!outcome.ok) {
      this.logPoll(monitor, at, { ok: false, status: outcome.status, reason: outcome.blocked ? 'blocked' : 'scrape_failed' });
      return { notifications: [], ok: false, status: outcome.status, itemsActive: 0, newItems: 0, blocked: outcome.blocked };
    }

    // A product page yields exactly one node; bail if it failed to normalize.
    const item = normalizeItems(outcome.rawNodes, plugin, 'product')[0];
    if (!item) {
      this.logPoll(monitor, at, { ok: false, status: outcome.status, reason: 'normalize_empty' });
      return { notifications: [], ok: false, status: outcome.status, itemsActive: 0, newItems: 0 };
    }

    // Honour the user's filters even for a single product: a seller-type or
    // exclusion-keyword change can make a previously-watched item irrelevant.
    // When it is filtered out we still refresh stored state (so we don't later
    // emit a false transition) but emit nothing.
    const afterExclusion = applyExclusion([item], monitor.filters.exclusionKeywords);
    const visible = applySellerFilter(afterExclusion, monitor.filters.sellerVisibility);
    if (visible.length === 0) {
      this.deps.store.items.upsert(monitor.id, item, at);
      this.logPoll(monitor, at, {
        ok: true,
        status: outcome.status,
        itemsActive: 0,
        newItems: 0,
        notifications: 0,
      });
      return { notifications: [], ok: true, status: outcome.status, itemsActive: 0, newItems: 0 };
    }

    // Compare against the last known snapshot to detect transitions.
    const prev = this.deps.store.items.getState(monitor.id, item.id);
    // The price_history last price specifically (may be undefined); reused below
    // to avoid a second identical SELECT inside append().
    const historyLastPrice = this.deps.store.priceHistory.lastPrice(monitor.id, item.id);
    const prevPrice = historyLastPrice ?? prev?.lastPrice;

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

    // Target price reached: fire once when the price first crosses to at-or-below
    // the user's target (prevPrice unknown or above target). Re-arms only if the
    // price later climbs back above target, so a flat sub-target price won't spam.
    const target = monitor.filters.targetPrice;
    if (
      target !== undefined &&
      item.price <= target &&
      (prevPrice === undefined || prevPrice > target)
    ) {
      notifications.push({
        kind: 'target_hit',
        chatId: monitor.chatId,
        item,
        target: { targetPrice: target, currentPrice: item.price },
      });
    }

    // Always record the new price point and refresh stored state — atomically,
    // so a crash between the two writes can't desynchronize price vs. state.
    this.deps.store.transaction(() => {
      this.deps.store.priceHistory.append({
        monitorId: monitor.id,
        itemId: item.id,
        price: item.price,
        currency: item.currency,
        observedAt: at,
        lastPrice: historyLastPrice, // reuse the value already fetched above
      });
      this.deps.store.items.upsert(monitor.id, item, at);
    });

    // Feed the fair-value models with this listing's attributes (v2).
    this.feedValuation([item], at);

    // Became-a-deal: rate the item against the chat's collected pool and alert
    // once when it crosses INTO a great deal (wasn't great last cycle). Runs after
    // the upsert so the pool is current; ratePrice excludes the item itself.
    const rating = ratePrice(
      { itemId: item.id, title: item.title, price: item.price, currency: item.currency, ...(item.url ? { url: item.url } : {}) },
      this.deps.store.items.browse(monitor.chatId, RATING_POOL_CAP, 0),
    );
    if (rating.tag !== 'unknown') {
      const priorTag = this.deps.store.items.getRating(monitor.id, item.id);
      if (rating.tag === 'great_deal' && priorTag !== 'great_deal' && rating.percentile !== undefined) {
        notifications.push({
          kind: 'became_deal',
          chatId: monitor.chatId,
          item,
          becameDeal: { percentile: rating.percentile, n: rating.n },
        });
      }
      this.deps.store.items.setRating(monitor.id, item.id, rating.tag);
    }

    // Attach market insight (time-on-market, price cuts) to every item-bearing
    // alert — computed AFTER the append so the history includes this price.
    if (notifications.some((n) => n.item)) {
      const insight = marketInsight(
        item.postedAt,
        this.deps.store.priceHistory.history(monitor.id, item.id),
        at,
      );
      for (const n of notifications) if (n.item) n.insight = insight;
    }

    // Reflect current stock onto the in-memory monitor so the scheduler can
    // place it on the fast (out-of-stock) tier when it re-arms the schedule.
    monitor.fastTier = item.inStock === false;

    this.logPoll(monitor, at, {
      ok: true,
      status: outcome.status,
      itemsActive: 1,
      newItems: notifications.length,
      notifications: notifications.length,
    });
    return {
      notifications,
      ok: true,
      status: outcome.status,
      itemsActive: 1,
      newItems: notifications.length,
    };
  }

  /**
   * Fold a batch of scraped items into the fair-value (v2) ridge accumulators,
   * grouped by (category, currency): parse numeric attributes, infer the
   * category, build the feature row, and accumulate `ln(price)` against it. One
   * load + one save per group keeps DB churn low. Items with no usable category
   * or a non-positive price are skipped.
   */
  private feedValuation(items: IScrapedItem[], at: number): void {
    const updates = new Map<string, RidgeState>();
    for (const item of items) {
      if (item.price <= 0 || item.currency === '') continue;
      const attrs = parseNumericAttrs(item.attributes);
      const category = inferCategory(attrs);
      if (!category) continue;
      const x = featureVector(category, attrs, at);
      if (!x) continue;
      const key = `${category}|${item.currency}`;
      let state = updates.get(key);
      if (!state) {
        state = this.deps.store.valuation.get(category, item.currency) ?? emptyState(FEATURE_K[category]);
        updates.set(key, state);
      }
      if (state.k !== x.length) continue;
      addObservation(state, x, targetValue(item.price));
    }
    for (const [key, state] of updates) {
      const [category, currency] = key.split('|');
      this.deps.store.valuation.save(category!, currency!, state, at);
    }
  }
}

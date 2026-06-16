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
import type { EnrichedItem, Monitor, Notification } from '../contracts';
import type { ItemSnapshot, Store } from '../persistence';
import type { PluginRegistry } from '../registry';
import type { ScrapingEngine } from '../scraping/engine';
import {
  runPipeline,
  normalizeItems,
  applySellerFilter,
  applyExclusion,
  DedupBuffer,
} from '../pipeline';
import { log } from '../logging/logger';

/** Dependencies a cycle run needs; nothing is read globally. */
interface CycleDeps {
  registry: PluginRegistry;
  store: Store;
  engine: ScrapingEngine;
  /** Min listings before a benchmark is confident enough to deal-tag items. */
  minSample: number;
  /** Resolve the per-chat cross-cycle dedup buffer (search monitors). */
  dedupFor?: (chatId: number) => DedupBuffer;
  /** Consecutive absent cycles before a search item is treated as de-listed (default 2). */
  delistThreshold?: number;
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

    // ── De-listing bookkeeping (read BEFORE the upsert clears the flags) ──────
    // An active item that was previously delisted (within memory) is a re-listing.
    const reListed: Notification[] = [];
    for (const item of out.active) {
      const prior = this.deps.store.items.delistState(monitor.id, item.id);
      if (prior?.delistedAt !== undefined) {
        reListed.push({ kind: 're_listed', chatId: monitor.chatId, item });
      }
    }
    // Items previously known but absent from THIS scrape (pre-filter, so a merely
    // filtered-out item still on the page is not mistaken for a removal).
    const known = this.deps.store.items.knownIds(monitor.id);
    const present = new Set(out.presentIds);
    const absentIds = [...known].filter((id) => !present.has(id));

    // Persist every active item (NEW ones also get a first price point) AND mark
    // absent items' de-list counter — all in ONE transaction so a mid-cycle crash
    // can't leave an item stored without its price, or clear a re-sighted item's
    // flag while failing to increment a vanished one (state stays consistent).
    // The upsert clears gone_count/delisted_at for every re-sighted item.
    //
    // Absent-diff guard: only run it when the scrape actually returned items. An
    // all-empty result (presentIds empty) would otherwise mark EVERY known item
    // absent and mass-de-list the whole watch — but an empty page is far more
    // likely a transient/layout glitch (already surfaced by watch-health), not
    // the simultaneous removal of every listing. A genuine single removal always
    // leaves other items present, so this never suppresses a real drop.
    const newIds = new Set(out.newEnriched.map((i) => i.id));
    const threshold = this.deps.delistThreshold ?? 2;
    const crossed = this.deps.store.transaction(() => {
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
      return out.presentIds.length > 0
        ? this.deps.store.items.markAbsent(monitor.id, absentIds, at, threshold)
        : [];
    });

    // Items crossing the grace threshold this cycle are collected into ONE
    // roll-up (search SERPs churn, so per-item de-list alerts would be noise).
    if (crossed.length > 0) {
      const titles = crossed
        .map((cid) => this.deps.store.items.getSnapshot(monitor.id, cid)?.title)
        .filter((t): t is string => Boolean(t));
      notifications.push({
        kind: 'listings_dropped',
        chatId: monitor.chatId,
        dropped: { monitorId: monitor.id, vendor: monitor.vendor, count: crossed.length, titles },
      });
    }
    notifications.push(...reListed);

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

  /**
   * Mark a product monitor's tracked item(s) absent this cycle and, for any that
   * cross the grace threshold, return an `item_delisted` notification carrying the
   * last-seen price from the stored snapshot. Empty when the monitor has no stored
   * item yet (a baseline that never succeeded) or the threshold isn't reached.
   */
  private markProductGone(monitor: Monitor, at: number): Notification[] {
    const known = [...this.deps.store.items.knownIds(monitor.id)];
    if (known.length === 0) return [];
    const threshold = this.deps.delistThreshold ?? 2;
    const crossed = this.deps.store.items.markAbsent(monitor.id, known, at, threshold);
    return crossed.map((itemId) => {
      const snap = this.deps.store.items.getSnapshot(monitor.id, itemId);
      const item = snapshotToItem(snap, monitor, itemId);
      return {
        kind: 'item_delisted',
        chatId: monitor.chatId,
        item,
        delist: {
          reason: 'product_gone',
          ...(snap?.lastPrice !== undefined ? { lastSeenPrice: snap.lastPrice } : {}),
        },
      };
    });
  }

  /** Product monitor: detect `price_drop` and `back_in_stock` for the one ad. */
  private async runProduct(
    monitor: Monitor,
    plugin: NonNullable<ReturnType<PluginRegistry['matchUrl']>>,
  ): Promise<CycleResult> {
    const at = this.now();
    const outcome = await this.deps.engine.scrapeProduct(plugin, monitor.url, at);
    if (!outcome.ok) {
      // A non-block client error (404/410) on an ESTABLISHED product watch means
      // the listing was removed — emit a one-off item_delisted (the page is gone,
      // distinct from a transient 5xx/block which stays a plain failure). Crossing
      // the absent threshold guards against a single fluke 404.
      const gone =
        !outcome.blocked && outcome.status >= 400 && outcome.status < 500;
      if (gone) {
        const delistNotes = this.markProductGone(monitor, at);
        if (delistNotes.length > 0) {
          this.logPoll(monitor, at, { ok: false, status: outcome.status, reason: 'delisted', notifications: delistNotes.length });
          return { notifications: delistNotes, ok: false, status: outcome.status, itemsActive: 0, newItems: 0 };
        }
      }
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
    // Read the de-listing flag BEFORE the upsert clears it (for re-listing).
    const wasDelisted = this.deps.store.items.delistState(monitor.id, item.id)?.delistedAt !== undefined;

    const notifications: Notification[] = [];

    // Re-listing: the watched item is back after having been marked delisted.
    if (wasDelisted) {
      notifications.push({ kind: 're_listed', chatId: monitor.chatId, item });
    }

    if (monitor.origin === 'tracked') {
      // A tracked item alerts on ANY price move (the user chose to watch THIS
      // item, so a rise matters too), not only drops.
      if (prevPrice !== undefined && item.price !== prevPrice) {
        notifications.push({
          kind: 'price_change',
          chatId: monitor.chatId,
          item,
          priceChange: {
            previousPrice: prevPrice,
            currentPrice: item.price,
            direction: item.price < prevPrice ? 'down' : 'up',
          },
        });
      }
    } else if (prevPrice !== undefined && item.price < prevPrice) {
      // Classic product watch: only a price DROP is notified.
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
}

/**
 * Reconstruct a renderable {@link EnrichedItem} from a stored snapshot for a
 * de-listed product (the live scrape failed, so we render from what we last saw).
 * Falls back to the monitor's URL/vendor when a legacy row lacks them.
 */
function snapshotToItem(snap: ItemSnapshot | undefined, monitor: Monitor, itemId: string): EnrichedItem {
  return {
    id: itemId,
    title: snap?.title ?? itemId,
    price: snap?.lastPrice ?? 0,
    currency: snap?.currency ?? '',
    url: snap?.url ?? monitor.url,
    isPrivateOwner: snap?.sellerPrivate ?? true,
    inStock: snap?.inStock ?? false,
    vendor: monitor.vendor,
    ...(snap?.imageUrl ? { imageUrl: snap.imageUrl } : {}),
    ...(snap?.location ? { location: snap.location } : {}),
    ...(snap?.description ? { description: snap.description } : {}),
    ...(snap?.postedAt !== undefined ? { postedAt: snap.postedAt } : {}),
    ...(snap?.attributes ? { attributes: snap.attributes } : {}),
  };
}

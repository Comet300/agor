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
import type { Monitor, MonitorOrigin, MonitorType } from '../contracts';
import type { Store } from '../persistence';
import type { PluginRegistry } from '../registry';
import type { ScrapingEngine } from '../scraping/engine';
import { normalizeItems } from '../pipeline';
import { scrubUrl, extractDomain } from '../util/url';
import { log } from '../logging/logger';

/** What the caller supplies to register a new watch. */
export interface RegisterInput {
  /** Owning Telegram chat id. */
  chatId: number;
  /** The URL the user pasted (telemetry not yet stripped). */
  rawUrl: string;
  /** Optional explicit kind; defaults to a search-results watch. */
  type?: MonitorType;
  /** How the watch was created; defaults to 'user'. 'tracked' marks a browse-Track. */
  origin?: MonitorOrigin;
}

/**
 * Outcome of a registration attempt. On success the freshly-created monitor and
 * the size of its silent baseline are returned; on failure a user-facing reason.
 */
export type RegisterResult =
  | { ok: true; monitor: Monitor; baselineCount: number }
  | { ok: false; error: string; reason?: 'quota' };

/** Dependencies the registration service needs; nothing is read globally. */
interface RegistrationDeps {
  registry: PluginRegistry;
  store: Store;
  engine: ScrapingEngine;
  /** Base polling cadence stamped onto every new monitor. */
  defaultIntervalMs: number;
  /** Accelerated cadence for a product whose baseline is already out of stock. */
  oosFastIntervalMs: number;
  /** Max monitors a non-admin chat may hold (0 = unlimited). Admins are exempt. */
  maxMonitorsPerChat?: number;
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

    // 2b. Enforce the per-chat monitor quota (flood protection). Admins are
    // exempt; 0/absent means unlimited. Checked before any scrape so a refused
    // registration costs nothing.
    const limit = this.deps.maxMonitorsPerChat ?? 0;
    if (limit > 0 && !this.deps.store.access.isAdmin(input.chatId)) {
      const existing = this.deps.store.monitors.listByChat(input.chatId).length;
      if (existing >= limit) {
        log('registration').debug(
          { chatId: input.chatId, existing, limit, event: 'QUOTA-REACHED' },
          'registration refused — chat at monitor quota',
        );
        return { ok: false, error: 'Monitor limit reached.', reason: 'quota' };
      }
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
      origin: input.origin ?? 'user',
    });

    // 4. Baseline scrape — the silent snapshot of what already exists.
    const outcome =
      type === 'search'
        ? await this.deps.engine.scrapeSearch(plugin, scrubbed, startedAt)
        : await this.deps.engine.scrapeProduct(plugin, scrubbed, startedAt);

    // A 4xx (but NOT a recognised anti-bot block) means the URL itself is wrong
    // or dead — a 404/410 maintenance stub or a mistyped path that will never
    // yield listings (the live carzz apex-404 and imoradar24 wrong-path cases).
    // Reject at add-time and drop the transient monitor row rather than register
    // a watch that polls nothing forever.
    const status = outcome.status;
    if (status >= 400 && status < 500 && !outcome.blocked) {
      this.deps.store.monitors.delete(monitor.id);
      log('registration').debug(
        { vendor: plugin.vendor, url: scrubbed, status, chatId: input.chatId, event: 'REGISTER-REJECTED' },
        'registration rejected — URL returned a client error',
      );
      return {
        ok: false,
        error: 'That URL is not reachable (it returned an error) — check it points at a results or product page.',
      };
    }

    // Any other failed baseline is NOT fatal when the cause is transient or
    // environmental (a hard block, a 5xx, no proxy): the URL may be perfectly
    // valid, so the monitor stays and picks up listings once the condition clears.
    if (!outcome.ok) {
      return { ok: true, monitor, baselineCount: 0 };
    }

    // Canonicalize: if the baseline followed a redirect to a URL still owned by
    // the SAME vendor plugin, persist that final URL so future polls skip the
    // redirect. A cross-domain redirect is NOT trusted (open-redirect guard).
    let effectiveUrl = scrubbed;
    if (outcome.finalUrl && outcome.finalUrl !== scrubbed) {
      const sameVendor = this.deps.registry.matchUrl(outcome.finalUrl)?.vendor === plugin.vendor;
      let sameRegistrableDomain = false;
      try {
        sameRegistrableDomain = extractDomain(outcome.finalUrl) === extractDomain(scrubbed);
      } catch {
        sameRegistrableDomain = false;
      }
      if (sameVendor && sameRegistrableDomain) {
        effectiveUrl = scrubUrl(outcome.finalUrl);
        monitor.url = effectiveUrl;
        this.deps.store.monitors.update(monitor);
        log('registration').debug(
          { vendor: plugin.vendor, from: scrubbed, to: effectiveUrl, event: 'CANONICAL-URL' },
          'persisted canonical post-redirect URL',
        );
      }
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
    log('registration').info(
      {
        monitorId: registered.id,
        vendor: plugin.vendor,
        type,
        chatId: input.chatId,
        baselineCount: items.length,
        fastTier: registered.fastTier,
      },
      'monitor registered',
    );
    return { ok: true, monitor: registered, baselineCount: items.length };
  }
}

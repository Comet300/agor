/**
 * Telegram message rendering (Phase 8) — PURE.
 *
 * These functions turn the domain's {@link Notification} / registration result
 * into a `{ text, keyboard }` pair the bot layer ships verbatim. They touch no
 * Bot, no network, and no clock, so the whole render surface is unit-testable.
 *
 * All user-facing words come from the typed message catalog via `tr(lang)`;
 * formatting (money, emoji, the offer code-span) is shared across languages — only
 * the words differ.
 *
 * Markdown note: the bot layer is expected to send these with HTML/Markdown
 * disabled OR with the same parse mode the offer draft assumes (single-backtick
 * code span). We keep formatting minimal and rely on emoji + plain text so the
 * output is robust regardless of parse mode.
 */
import type { EnrichedItem, Notification, DealTag, SellerVisibility } from '../contracts';
import type { ItemSnapshot } from '../persistence';
import type { InlineKeyboard } from 'grammy';
import { formatMoney } from '../util/money';
import { draftOffer } from '../features/contactOffer';
import {
  quickActionsKeyboard,
  registrationKeyboard,
  openOnlyKeyboard,
  browseKeyboard,
  browseScopeKeyboard,
  type BrowseScope,
} from './keyboards';
import { type Lang, tr, type Catalog } from './strings';

/** A fully-rendered message: display text and an optional inline keyboard. */
export interface RenderedMessage {
  text: string;
  /** Absent for button-less notices (e.g. watch health). */
  keyboard?: InlineKeyboard;
}

/** A browse view: the card text + carousel keyboard + an optional photo to attach. */
export interface BrowseView extends RenderedMessage {
  /** The listing image to send as a photo, when the snapshot carries one. */
  photoUrl?: string;
}

/** Catalog key for each deal tag's badge (undefined => no badge line). */
const DEAL_BADGE_KEY: Record<DealTag, keyof Catalog> = {
  great_deal: 'badge_great_deal',
  fair_price: 'badge_fair_price',
  overpriced: 'badge_overpriced',
};

/** Seller descriptor line (P2P vs corporate), localized. */
function sellerLine(item: EnrichedItem, lang: Lang): string {
  return item.isPrivateOwner ? tr(lang).seller_private : tr(lang).seller_company;
}

/** Max specs shown on a card, and the description snippet length. */
const MAX_SPECS = 5;
const DESCRIPTION_SNIPPET = 140;

/** Join an item's attributes into a compact "k: v · k: v" specs string, or ''. */
function specsText(item: EnrichedItem): string {
  if (!item.attributes) return '';
  const parts = Object.entries(item.attributes)
    .filter(([, v]) => v !== '')
    .slice(0, MAX_SPECS)
    .map(([k, v]) => `${k}: ${v}`);
  return parts.join(' · ');
}

/** A single-line, length-capped description snippet, or '' when absent. */
function descriptionSnippet(item: EnrichedItem): string {
  if (!item.description) return '';
  const oneLine = item.description.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= DESCRIPTION_SNIPPET) return oneLine;
  return oneLine.slice(0, DESCRIPTION_SNIPPET).trimEnd() + '…';
}

/** Render an epoch-ms timestamp as a stable ISO date (YYYY-MM-DD), or ''. */
function postedDate(item: EnrichedItem): string {
  if (item.postedAt === undefined) return '';
  const d = new Date(item.postedAt);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Render a brand-new listing as a rich card. */
function renderNewListing(item: EnrichedItem, lang: Lang): RenderedMessage {
  const t = tr(lang);
  const lines: string[] = [];

  // Title + headline price.
  lines.push(`🆕 ${item.title}`);
  lines.push(`💰 ${formatMoney(item.price, item.currency)}`);

  // Deal-tag badge (only when the pipeline tagged it).
  if (item.dealTag) lines.push(t[DEAL_BADGE_KEY[item.dealTag]] as string);

  // Seller type + optional location.
  lines.push(sellerLine(item, lang));
  if (item.location) lines.push(`📍 ${item.location}`);

  // Structured specs + posted date, when present.
  const specs = specsText(item);
  if (specs) lines.push(t.specs_line(specs));
  const posted = postedDate(item);
  if (posted) lines.push(t.posted_line(posted));

  // A short description teaser, when the vendor exposed one.
  const snippet = descriptionSnippet(item);
  if (snippet) lines.push(snippet);

  // Cross-platform alternatives, when dedup merged any in.
  if (item.alternativeSources && item.alternativeSources.length > 0) {
    const also = item.alternativeSources
      .map((s) => `${s.vendor} (${s.url})`)
      .join(', ');
    lines.push(t.also_on(also));
  }

  // The copy-paste negotiation draft (already backtick-wrapped by draftOffer).
  lines.push('');
  lines.push(draftOffer(item, lang));

  return { text: lines.join('\n'), keyboard: quickActionsKeyboard(item, lang) };
}

/** Render a price drop as a single-line delta with the savings. */
function renderPriceDrop(
  item: EnrichedItem,
  drop: Notification['priceDrop'],
  lang: Lang,
): RenderedMessage {
  const t = tr(lang);

  // Defensive: a price_drop without its info still renders something sensible.
  const text = drop
    ? t.price_drop({
        title: item.title,
        oldPrice: formatMoney(drop.previousPrice, item.currency),
        newPrice: formatMoney(drop.currentPrice, item.currency),
        savings: formatMoney(drop.savings, item.currency),
      })
    : t.price_drop({
        title: item.title,
        oldPrice: formatMoney(item.price, item.currency),
        newPrice: formatMoney(item.price, item.currency),
        savings: formatMoney(0, item.currency),
      });

  return { text, keyboard: quickActionsKeyboard(item, lang) };
}

/** Render a back-in-stock alert card. */
function renderBackInStock(item: EnrichedItem, lang: Lang): RenderedMessage {
  const lines: string[] = [
    tr(lang).back_in_stock_title,
    item.title,
    `💰 ${formatMoney(item.price, item.currency)}`,
  ];
  if (item.location) lines.push(`📍 ${item.location}`);

  return { text: lines.join('\n'), keyboard: quickActionsKeyboard(item, lang) };
}

/**
 * Render any {@link Notification} into a ready-to-send message. Dispatches on
 * the notification kind; every branch attaches the same quick-action keyboard.
 */
export function renderNotification(n: Notification, lang: Lang): RenderedMessage {
  switch (n.kind) {
    case 'new_listing':
      return renderNewListing(n.item!, lang);
    case 'price_drop':
      return renderPriceDrop(n.item!, n.priceDrop, lang);
    case 'back_in_stock':
      return renderBackInStock(n.item!, lang);
    case 'cross_post':
      // Re-render the original listing card; its item now carries the appended
      // alternativeSources, so the edited message shows the new "Also on:" line.
      return renderNewListing(n.item!, lang);
    case 'watch_failing':
      // Button-less health notice (no item).
      return { text: tr(lang).watch_failing(n.health!) };
    case 'watch_recovered':
      return { text: tr(lang).watch_recovered(n.health!) };
    case 'price_change':
      return renderPriceChange(n.item!, n.priceChange, lang);
    case 'item_delisted':
      return renderDelisted(n.item!, n.delist, lang);
    case 'listings_dropped':
      return renderListingsDropped(n.dropped, lang);
    case 're_listed':
      return renderReListed(n.item!, lang);
  }
}

/** Render a bidirectional price change for a tracked item. */
function renderPriceChange(
  item: EnrichedItem,
  change: Notification['priceChange'],
  lang: Lang,
): RenderedMessage {
  const t = tr(lang);
  const prev = change ? change.previousPrice : item.price;
  const cur = change ? change.currentPrice : item.price;
  const dir = change?.direction ?? (cur < prev ? 'down' : 'up');
  const text = t.price_change({
    title: item.title,
    oldPrice: formatMoney(prev, item.currency),
    newPrice: formatMoney(cur, item.currency),
    direction: dir,
  });
  return { text, keyboard: quickActionsKeyboard(item, lang) };
}

/** Render a per-item de-listing alert (product page gone / item dropped). */
function renderDelisted(
  item: EnrichedItem,
  delist: Notification['delist'],
  lang: Lang,
): RenderedMessage {
  const t = tr(lang);
  const lines: string[] = [
    t.delisted_title,
    item.title,
    delist?.reason === 'product_gone' ? t.delisted_reason_product_gone : t.delisted_reason_search_dropped,
  ];
  const last = delist?.lastSeenPrice;
  if (last !== undefined) lines.push(t.delisted_last_price(formatMoney(last, item.currency)));
  return { text: lines.join('\n'), keyboard: openOnlyKeyboard(item, lang) };
}

/** Render a search monitor's roll-up of listings that dropped off this cycle. */
function renderListingsDropped(dropped: Notification['dropped'], lang: Lang): RenderedMessage {
  const t = tr(lang);
  if (!dropped) return { text: t.listings_dropped_title(0, '') };
  const sample = dropped.titles.slice(0, 5).map((x) => `• ${x}`).join('\n');
  return { text: t.listings_dropped_title(dropped.count, dropped.vendor) + (sample ? `\n${sample}` : '') };
}

/** Render a re-listing alert (a delisted item reappeared). */
function renderReListed(item: EnrichedItem, lang: Lang): RenderedMessage {
  const lines: string[] = [
    tr(lang).re_listed_title,
    item.title,
    `💰 ${formatMoney(item.price, item.currency)}`,
  ];
  if (item.location) lines.push(`📍 ${item.location}`);
  return { text: lines.join('\n'), keyboard: quickActionsKeyboard(item, lang) };
}

/**
 * Render the post-registration tuning card the user sees right after a watch is
 * created. Inline toggles let them set seller visibility, check frequency and
 * exclusion keywords before flipping the monitor live with "Start monitoring".
 *
 * Callback data layout:
 *   - seller visibility -> `sv:<monitorId>:<private|company|both>`
 *   - check frequency   -> `fq:<monitorId>:<minutes>`
 *   - exclusion prompt  -> `ex:<monitorId>`
 *   - remove monitor    -> `rm:<monitorId>`
 *   - start monitoring  -> `go:<monitorId>`
 */
export function renderRegistrationCard(
  r: {
    monitorId: number;
    vendor: string;
    summary: string;
    baselineCount: number;
    sellerVisibility: SellerVisibility;
    intervalMinutes: number;
  },
  lang: Lang,
): RenderedMessage {
  const t = tr(lang);
  const lines: string[] = [
    t.reg_watching(r.vendor),
    r.summary,
    t.reg_baseline(r.baselineCount),
    '',
    t.reg_tune_prompt,
  ];

  return {
    text: lines.join('\n'),
    keyboard: registrationKeyboard(r.monitorId, lang, r.sellerVisibility, r.intervalMinutes),
  };
}

/** Compact "k: v · k: v" specs from a snapshot's attributes (capped), or ''. */
function snapshotSpecs(snap: ItemSnapshot): string {
  if (!snap.attributes) return '';
  return Object.entries(snap.attributes)
    .filter(([, v]) => v !== '')
    .slice(0, MAX_SPECS)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
}

/** Single-line, length-capped description snippet from a snapshot, or ''. */
function snapshotSnippet(snap: ItemSnapshot): string {
  if (!snap.description) return '';
  const oneLine = snap.description.replace(/\s+/g, ' ').trim();
  return oneLine.length <= DESCRIPTION_SNIPPET ? oneLine : oneLine.slice(0, DESCRIPTION_SNIPPET).trimEnd() + '…';
}

/**
 * Render one browse card from a stored {@link ItemSnapshot} at `index` of
 * `total`, with the carousel keyboard. Mirrors a new-listing card (photo +
 * title, price/stock, attribute bullets, location + seller, posted date,
 * description snippet) minus the 🆕 and the offer draft. The photo (when the
 * snapshot has an image) is returned for the caller to send as an attachment.
 */
export function renderBrowseCard(
  snap: ItemSnapshot,
  index: number,
  total: number,
  lang: Lang,
  canSwitch = false,
): BrowseView {
  const t = tr(lang);
  const lines: string[] = [];
  lines.push(`🏷️ ${snap.title ?? snap.itemId}`);
  const stock = snap.inStock ? t.browse_in_stock : t.browse_out_of_stock;
  lines.push(`💰 ${formatMoney(snap.lastPrice, snap.currency)} · ${stock}`);

  const specs = snapshotSpecs(snap);
  if (specs) lines.push(t.specs_line(specs));

  const sellerBits: string[] = [];
  if (snap.location) sellerBits.push(`📍 ${snap.location}`);
  if (snap.sellerPrivate !== undefined) {
    sellerBits.push(snap.sellerPrivate ? t.seller_private : t.seller_company);
  }
  if (sellerBits.length > 0) lines.push(sellerBits.join(' · '));

  if (snap.postedAt !== undefined) {
    const d = new Date(snap.postedAt);
    if (!Number.isNaN(d.getTime())) lines.push(t.posted_line(d.toISOString().slice(0, 10)));
  }

  const snippet = snapshotSnippet(snap);
  if (snippet) lines.push(snippet);

  lines.push('');
  lines.push(t.browse_position(index + 1, total));

  // A legacy row may lack a url; fall back to '' (the keyboard's Open button is
  // only added by the caller when a url exists — see browseKeyboard usage).
  const url = snap.url ?? '';
  const view: BrowseView = {
    text: lines.join('\n'),
    keyboard: browseKeyboard(index, total, url, lang, canSwitch),
  };
  if (snap.imageUrl) view.photoUrl = snap.imageUrl;
  return view;
}

/**
 * Render the /browse scope picker — a prompt plus one button per scope
 * ("All listings" first, then each watch with browsable items). Shown when a
 * chat has more than one watch so the user can browse a single watch instead of
 * the chat-wide union. The `bs:` callbacks load the chosen scope.
 */
export function renderBrowseScope(scopes: readonly BrowseScope[], lang: Lang): RenderedMessage {
  return {
    text: tr(lang).browse_scope_prompt,
    keyboard: browseScopeKeyboard(scopes, lang),
  };
}

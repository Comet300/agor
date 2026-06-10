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
import type { InlineKeyboard } from 'grammy';
import { formatMoney } from '../util/money';
import { draftOffer } from '../features/contactOffer';
import { quickActionsKeyboard, registrationKeyboard } from './keyboards';
import { type Lang, tr, type Catalog } from './strings';

/** A fully-rendered message: display text and an optional inline keyboard. */
export interface RenderedMessage {
  text: string;
  /** Absent for button-less notices (e.g. watch health). */
  keyboard?: InlineKeyboard;
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
  }
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

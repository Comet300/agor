/**
 * Telegram message rendering (Phase 8) — PURE.
 *
 * These functions turn the domain's {@link Notification} / registration result
 * into a `{ text, keyboard }` pair the bot layer ships verbatim. They touch no
 * Bot, no network, and no clock, so the whole render surface is unit-testable.
 *
 * Markdown note: the bot layer is expected to send these with HTML/Markdown
 * disabled OR with the same parse mode the offer draft assumes (single-backtick
 * code span). We keep formatting minimal and rely on emoji + plain text so the
 * output is robust regardless of parse mode.
 */
import type { EnrichedItem, Notification, DealTag } from '../contracts';
import type { InlineKeyboard } from 'grammy';
import { formatMoney } from '../util/money';
import { draftOffer } from '../features/contactOffer';
import { quickActionsKeyboard, registrationKeyboard } from './keyboards';

/** A fully-rendered message: display text plus its inline keyboard. */
export interface RenderedMessage {
  text: string;
  keyboard: InlineKeyboard;
}

/** Human-readable badge for each deal tag (undefined => no badge line). */
const DEAL_BADGE: Record<DealTag, string> = {
  great_deal: '🔥 Great Deal',
  fair_price: '📊 Fair Market Price',
  overpriced: '📈 Overpriced',
};

/** Seller descriptor line (P2P vs corporate), with a leading emoji. */
function sellerLine(item: EnrichedItem): string {
  return item.isPrivateOwner ? '👤 Private seller' : '🏢 Company';
}

/** Render a brand-new listing as a rich card. */
function renderNewListing(item: EnrichedItem): RenderedMessage {
  const lines: string[] = [];

  // Title + headline price.
  lines.push(`🆕 ${item.title}`);
  lines.push(`💰 ${formatMoney(item.price, item.currency)}`);

  // Deal-tag badge (only when the pipeline tagged it).
  if (item.dealTag) lines.push(DEAL_BADGE[item.dealTag]);

  // Seller type + optional location.
  lines.push(sellerLine(item));
  if (item.location) lines.push(`📍 ${item.location}`);

  // Cross-platform alternatives, when dedup merged any in.
  if (item.alternativeSources && item.alternativeSources.length > 0) {
    const also = item.alternativeSources
      .map((s) => `${s.vendor} (${s.url})`)
      .join(', ');
    lines.push(`Also on: ${also}`);
  }

  // The copy-paste negotiation draft (already backtick-wrapped by draftOffer).
  lines.push('');
  lines.push(draftOffer(item));

  return { text: lines.join('\n'), keyboard: quickActionsKeyboard(item) };
}

/** Render a price drop as a single-line delta with the savings. */
function renderPriceDrop(n: Notification): RenderedMessage {
  const { item } = n;
  const drop = n.priceDrop;

  // Defensive: a price_drop without its info still renders something sensible.
  const text = drop
    ? `📉 Price drop on ${item.title}: ` +
      `${formatMoney(drop.previousPrice, item.currency)} → ` +
      `${formatMoney(drop.currentPrice, item.currency)} ` +
      `(save ${formatMoney(drop.savings, item.currency)})`
    : `📉 Price drop on ${item.title}: now ${formatMoney(item.price, item.currency)}`;

  return { text, keyboard: quickActionsKeyboard(item) };
}

/** Render a back-in-stock alert card. */
function renderBackInStock(item: EnrichedItem): RenderedMessage {
  const lines: string[] = [
    '🟢 BACK IN STOCK',
    item.title,
    `💰 ${formatMoney(item.price, item.currency)}`,
  ];
  if (item.location) lines.push(`📍 ${item.location}`);

  return { text: lines.join('\n'), keyboard: quickActionsKeyboard(item) };
}

/**
 * Render any {@link Notification} into a ready-to-send message. Dispatches on
 * the notification kind; every branch attaches the same quick-action keyboard.
 */
export function renderNotification(n: Notification): RenderedMessage {
  switch (n.kind) {
    case 'new_listing':
      return renderNewListing(n.item);
    case 'price_drop':
      return renderPriceDrop(n);
    case 'back_in_stock':
      return renderBackInStock(n.item);
    case 'cross_post':
      // Re-render the original listing card; its item now carries the appended
      // alternativeSources, so the edited message shows the new "Also on:" line.
      return renderNewListing(n.item);
  }
}

/**
 * Render the post-registration tuning card the user sees right after a watch is
 * created. Inline toggles let them set seller visibility and exclusion keywords
 * before flipping the monitor live with "Start monitoring".
 *
 * Callback data layout:
 *   - seller visibility -> `sv:<monitorId>:<private|company|both>`
 *   - exclusion prompt  -> `ex:<monitorId>`
 *   - start monitoring  -> `go:<monitorId>`
 */
export function renderRegistrationCard(r: {
  monitorId: number;
  vendor: string;
  summary: string;
  baselineCount: number;
}): RenderedMessage {
  const lines: string[] = [
    `✅ Watching ${r.vendor}`,
    r.summary,
    `📦 Baseline: ${r.baselineCount} listing${r.baselineCount === 1 ? '' : 's'} recorded.`,
    '',
    'Tune the watch, then start monitoring:',
  ];

  return { text: lines.join('\n'), keyboard: registrationKeyboard(r.monitorId) };
}

/**
 * Instant Contact & Offer Generator (Feature 9, task 9.5).
 *
 * Pure functions that turn a scraped listing into copy-paste ready outreach:
 *  - a `tel:` deep link for one-tap calling,
 *  - an anchored opening offer (10% below ask, rounded to nearest 5),
 *  - a localized, backtick-wrapped negotiation message.
 *
 * No I/O, no clocks — everything is derived from the inputs.
 */

import type { IScrapedItem } from '../contracts/index';
import { roundToNearest5 } from '../util/money';

/**
 * Build a `tel:` deep link from a (possibly messy) seller phone string.
 *
 * Returns `undefined` for missing/empty phones. Otherwise strips everything
 * except digits and a single leading `+` (international prefix), so spaces,
 * dashes, parentheses and other formatting characters are removed.
 */
export function buildCallLink(phone: string | undefined): string | undefined {
  if (!phone) return undefined;

  // Preserve a leading '+' if present, then keep only digits from the rest.
  const hasPlus = phone.trimStart().startsWith('+');
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return undefined;

  const normalized = (hasPlus ? '+' : '') + digits;
  return `tel:${normalized}`;
}

/**
 * Compute the anchored opening offer: 10% below the asking price, rounded to
 * the nearest multiple of 5. This is the number we put in the draft message.
 */
export function offerAnchor(price: number): number {
  return roundToNearest5(price * 0.9);
}

/** Localized copy templates for the negotiation draft. */
const TEMPLATES = {
  ro: (title: string, anchor: number, currency: string) =>
    `Bună ziua! Sunt interesat de "${title}". Aș oferi ${anchor} ${currency}. Este disponibil?`,
  en: (title: string, anchor: number, currency: string) =>
    `Hello! I'm interested in "${title}". I'd offer ${anchor} ${currency}. Is it still available?`,
} as const;

/**
 * Draft a natural, copy-paste ready negotiation message for an item.
 *
 * The message references the item title and the computed {@link offerAnchor}
 * in the item's currency. It is wrapped in a single-backtick Markdown code
 * span so it renders as a tap-to-copy block in chat clients.
 *
 * @param item  The scraped listing to negotiate on.
 * @param lang  Output language; defaults to Romanian (`'ro'`).
 */
export function draftOffer(item: IScrapedItem, lang: 'ro' | 'en' = 'ro'): string {
  const anchor = offerAnchor(item.price);
  const body = TEMPLATES[lang](item.title, anchor, item.currency);
  // Single-backtick code span -> renders as a copyable inline block.
  return `\`${body}\``;
}

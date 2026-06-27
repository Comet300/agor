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
import type { Lang } from '../gateway/strings';
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
const TEMPLATES: Record<Lang, (title: string, anchor: number, currency: string) => string> = {
  ro: (title, anchor, currency) =>
    `Bună ziua! Sunt interesat de "${title}". Aș oferi ${anchor} ${currency}. Este disponibil?`,
  en: (title, anchor, currency) =>
    `Hello! I'm interested in "${title}". I'd offer ${anchor} ${currency}. Is it still available?`,
  de: (title, anchor, currency) =>
    `Hallo! Ich interessiere mich für "${title}". Ich würde ${anchor} ${currency} bieten. Ist es noch verfügbar?`,
  fr: (title, anchor, currency) =>
    `Bonjour ! Je suis intéressé par "${title}". Je proposerais ${anchor} ${currency}. Est-il toujours disponible ?`,
  it: (title, anchor, currency) =>
    `Salve! Sono interessato a "${title}". Offrirei ${anchor} ${currency}. È ancora disponibile?`,
  es: (title, anchor, currency) =>
    `¡Hola! Me interesa "${title}". Ofrecería ${anchor} ${currency}. ¿Sigue disponible?`,
};

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
export function draftOffer(item: IScrapedItem, lang: Lang = 'ro'): string {
  const anchor = offerAnchor(item.price);
  // Sanitize the title for the single-line code span: a code span cannot span
  // lines (newlines break it) and a bare backtick would close it early. Collapse
  // any whitespace run (incl. newlines) to a space and drop backticks. Some
  // vendors (e.g. publi24) ship literal newlines in titles.
  const safeTitle = item.title.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  const body = TEMPLATES[lang](safeTitle, anchor, item.currency);
  // Single-backtick code span -> renders as a copyable inline block.
  return `\`${body}\``;
}

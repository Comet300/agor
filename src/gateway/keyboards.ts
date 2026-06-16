/**
 * Pure inline-keyboard builders (Phase 8).
 *
 * Factored out of {@link ../gateway/render} so the button layouts can be reused
 * and reasoned about in isolation. Everything here is pure: it only constructs
 * {@link InlineKeyboard} instances from plain data — no Bot, no I/O.
 *
 * Labels come from the typed message catalog via `tr(lang)`; the callback-data
 * wire format is fixed (colon-delimited ASCII, numeric ids, < 64 bytes) and does
 * NOT vary by language.
 */
import type { EnrichedItem, SellerVisibility } from '../contracts';
import { InlineKeyboard } from 'grammy';
import { buildCallLink } from '../features/contactOffer';
import { type Lang, tr } from './strings';

/** Telegram hard-caps callback_data at 64 bytes. */
const CALLBACK_DATA_LIMIT = 64;

/** The fixed set of check-frequency presets, in minutes. */
export const FREQUENCY_PRESETS: readonly number[] = [5, 10, 30, 60];

/**
 * Two-tap confirmation keyboard for a destructive action. The confirm button
 * carries `cf:<action>:<id>` (the handler re-validates before acting); cancel is
 * a fixed `cx`. `action` is a short token: `rm` (remove watch), `dn` (deny
 * access), `dm` (demote admin).
 */
export function confirmKeyboard(action: 'rm' | 'dn' | 'dm', id: number, lang: Lang): InlineKeyboard {
  const t = tr(lang);
  return new InlineKeyboard()
    .text(t.btn_confirm, `cf:${action}:${id}`)
    .text(t.btn_cancel, 'cx');
}

/**
 * Callback data for the "Price history" button: `pg:<vendor>:<id>`.
 *
 * Telegram limits callback_data to 64 bytes; when the verbose form would exceed
 * that we fall back to the vendor-less `pg:<id>` form (the bot re-derives the
 * vendor from the stored monitor when handling the callback).
 */
export function priceHistoryData(item: EnrichedItem): string {
  const full = ['pg', item.vendor ?? '', item.id].join(':');
  if (Buffer.byteLength(full, 'utf8') <= CALLBACK_DATA_LIMIT) return full;
  return `pg:${item.id}`;
}

/**
 * Build the shared quick-action keyboard for a listing notification:
 *   - 🔗 Open  (URL button to the listing),
 *   - 📞 Call  (tel: URL button, only when a phone is present & parseable),
 *   - 📊 Price history (callback button -> {@link priceHistoryData}).
 */
export function quickActionsKeyboard(item: EnrichedItem, lang: Lang): InlineKeyboard {
  const t = tr(lang);
  const kb = new InlineKeyboard();
  kb.url(t.btn_open, item.url);

  const tel = buildCallLink(item.phone);
  if (tel) kb.url(t.btn_call, tel);

  kb.text(t.btn_price_history, priceHistoryData(item));
  return kb;
}

/**
 * A minimal keyboard with only the "🔗 Open" link — for a de-listed item, where
 * Call and Price-history no longer make sense (the listing is gone).
 */
export function openOnlyKeyboard(item: EnrichedItem, lang: Lang): InlineKeyboard {
  return new InlineKeyboard().url(tr(lang).btn_open, item.url);
}

/**
 * Browse carousel keyboard for the item at `index` of `total`:
 *   row 1: [◀ Prev] [📌 Track] [Next ▶]  — Prev/Next omitted at the ends,
 *   row 2: [🔗 Open]  (URL to the listing).
 * Nav callbacks are `br:<index>` (the bot edits the message to that item); track
 * is `tk:<index>`. The index resolves against the chat's browse session, so the
 * payload stays tiny and well under Telegram's 64-byte callback limit.
 */
export function browseKeyboard(index: number, total: number, url: string, lang: Lang): InlineKeyboard {
  const t = tr(lang);
  const kb = new InlineKeyboard();
  if (index > 0) kb.text(t.btn_prev, `br:${index - 1}`);
  kb.text(t.btn_track, `tk:${index}`);
  if (index < total - 1) kb.text(t.btn_next, `br:${index + 1}`);
  return kb.row().url(t.btn_open, url);
}

/**
 * Build the post-registration tuning keyboard. The currently-selected seller
 * visibility AND check frequency are marked with a check so the keyboard reflects
 * state after a toggle (and so re-rendering after a change produces a real markup
 * diff rather than Telegram's "message is not modified" error).
 *
 * Callback data layout:
 *   - seller visibility -> `sv:<monitorId>:<private|company|both>`
 *   - check frequency   -> `fq:<monitorId>:<minutes>`
 *   - exclusion prompt  -> `ex:<monitorId>`
 *   - remove monitor    -> `rm:<monitorId>`
 *   - start monitoring  -> `go:<monitorId>`
 */
export function registrationKeyboard(
  monitorId: number,
  lang: Lang,
  activeVisibility: SellerVisibility = 'both',
  activeMinutes = 0,
): InlineKeyboard {
  const t = tr(lang);
  const markSeller = (label: string, value: SellerVisibility): string =>
    value === activeVisibility ? `✅ ${label}` : label;
  const markFreq = (label: string, minutes: number): string =>
    minutes === activeMinutes ? `✅ ${label}` : label;

  const kb = new InlineKeyboard()
    // Seller visibility row (active option marked).
    .text(markSeller(t.btn_private, 'private'), `sv:${monitorId}:private`)
    .text(markSeller(t.btn_company, 'company'), `sv:${monitorId}:company`)
    .text(markSeller(t.btn_both, 'both'), `sv:${monitorId}:both`)
    .row();

  // Frequency presets row (active minutes marked).
  for (const minutes of FREQUENCY_PRESETS) {
    kb.text(markFreq(t.btn_freq(minutes), minutes), `fq:${monitorId}:${minutes}`);
  }

  return kb
    .row()
    // Exclusion keywords prompt + remove monitor.
    .text(t.btn_exclusion, `ex:${monitorId}`)
    .text(t.btn_remove, `rm:${monitorId}`)
    .row()
    // Go live.
    .text(t.btn_start, `go:${monitorId}`);
}

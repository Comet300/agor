/**
 * Pure inline-keyboard builders (Phase 8).
 *
 * Factored out of {@link ../gateway/render} so the button layouts can be reused
 * and reasoned about in isolation. Everything here is pure: it only constructs
 * {@link InlineKeyboard} instances from plain data — no Bot, no I/O.
 */
import type { EnrichedItem, SellerVisibility } from '../contracts';
import { InlineKeyboard } from 'grammy';
import { buildCallLink } from '../features/contactOffer';

/** Telegram hard-caps callback_data at 64 bytes. */
const CALLBACK_DATA_LIMIT = 64;

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
export function quickActionsKeyboard(item: EnrichedItem): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.url('🔗 Open', item.url);

  const tel = buildCallLink(item.phone);
  if (tel) kb.url('📞 Call', tel);

  kb.text('📊 Price history', priceHistoryData(item));
  return kb;
}

/**
 * Build the post-registration tuning keyboard. The currently-selected seller
 * visibility is marked with a check so the keyboard reflects state after a
 * toggle (and so re-rendering after a change produces a real markup diff rather
 * than Telegram's "message is not modified" error).
 *
 * Callback data layout:
 *   - seller visibility -> `sv:<monitorId>:<private|company|both>`
 *   - exclusion prompt  -> `ex:<monitorId>`
 *   - start monitoring  -> `go:<monitorId>`
 */
export function registrationKeyboard(
  monitorId: number,
  activeVisibility: SellerVisibility = 'both',
): InlineKeyboard {
  const mark = (label: string, value: SellerVisibility): string =>
    value === activeVisibility ? `✅ ${label}` : label;
  return new InlineKeyboard()
    // Seller visibility row (active option marked).
    .text(mark('👤 Private', 'private'), `sv:${monitorId}:private`)
    .text(mark('🏢 Company', 'company'), `sv:${monitorId}:company`)
    .text(mark('👥 Both', 'both'), `sv:${monitorId}:both`)
    .row()
    // Exclusion keywords prompt.
    .text('🚫 Exclusion keywords', `ex:${monitorId}`)
    .row()
    // Go live.
    .text('▶️ Start monitoring', `go:${monitorId}`);
}

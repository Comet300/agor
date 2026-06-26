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
import type { EnrichedItem, Monitor, SellerVisibility } from '../contracts';
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
 *   row 2: [🔢 Jump to #] [🔀 Switch]? [🔗 Open].
 * Nav callbacks are `br:<index>` (the bot sends that item); track is `tk:<index>`;
 * `bj` opens the jump-to-number prompt; `bw` re-opens the scope picker (only when
 * `canSwitch`, i.e. the chat has more than one watch). The index resolves against
 * the chat's browse session, so the payload stays tiny and well under Telegram's
 * 64-byte callback limit.
 */
export function browseKeyboard(
  index: number,
  total: number,
  url: string,
  lang: Lang,
  canSwitch = false,
): InlineKeyboard {
  const t = tr(lang);
  const kb = new InlineKeyboard();
  if (index > 0) kb.text(t.btn_prev, `br:${index - 1}`);
  kb.text(t.btn_track, `tk:${index}`);
  if (index < total - 1) kb.text(t.btn_next, `br:${index + 1}`);
  kb.row();
  // Jump is only meaningful when there is more than one item to jump between.
  if (total > 1) kb.text(t.btn_jump, 'bj');
  if (canSwitch) kb.text(t.btn_switch, 'bw');
  // Open is a URL button: only add it when a url exists. A legacy snapshot stored
  // before the url column may have none, and Telegram rejects an empty-url button
  // (BUTTON_URL_INVALID) — which would fail the whole send.
  if (url) kb.url(t.btn_open, url);
  return kb;
}

/**
 * The action row under a /list watch line: [✏️ Edit] [⏸/▶️ Pause-Resume] [🗑 Remove].
 * Edit opens the edit card (`le:`), pause toggles in place (`lp:`), remove reuses
 * the confirm flow (`rm:`).
 */
export function listRowKeyboard(monitor: Monitor, lang: Lang): InlineKeyboard {
  const t = tr(lang);
  return new InlineKeyboard()
    .text(t.btn_edit, `le:${monitor.id}`)
    .text(monitor.paused ? t.btn_resume : t.btn_pause, `lp:${monitor.id}`)
    .text(t.btn_remove, `rm:${monitor.id}`);
}

/** A selectable browse scope: "all listings", or one of the chat's watches. */
export interface BrowseScope {
  /** Callback target: `all` for the chat-wide union, else the monitor id. */
  target: 'all' | number;
  /** Display label (already localized / vendor-derived). */
  label: string;
  /** Browsable item count shown in parentheses. */
  count: number;
}

/**
 * The /browse scope picker: one button per row, "All listings (N)" first, then a
 * button per watch that has browsable items. Selecting emits `bs:all` or
 * `bs:<monitorId>`, which loads that scope into the chat's browse session.
 */
export function browseScopeKeyboard(scopes: readonly BrowseScope[], lang: Lang): InlineKeyboard {
  void lang; // labels are pre-localized by the caller
  const kb = new InlineKeyboard();
  for (const s of scopes) {
    kb.text(`${s.label} (${s.count})`, `bs:${s.target}`).row();
  }
  return kb;
}

/**
 * A short, human label for a watch in the scope picker: the vendor plus a query
 * hint pulled from the watch URL when one is recognisable (the `q-<slug>` path
 * segment OLX-style URLs use, or a `q`/`query`/`search`/`text` query param),
 * de-hyphenated and length-capped. Falls back to the vendor alone.
 */
export function browseScopeLabel(vendor: string, url: string): string {
  const HINT_CAP = 28;
  let hint = '';
  try {
    const u = new URL(url);
    const param =
      u.searchParams.get('q') ??
      u.searchParams.get('query') ??
      u.searchParams.get('search') ??
      u.searchParams.get('text');
    if (param) {
      hint = param;
    } else {
      const seg = u.pathname.split('/').find((p) => p.startsWith('q-'));
      if (seg) hint = seg.slice(2);
    }
  } catch {
    // Unparseable URL → vendor only.
  }
  hint = hint.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (hint.length > HINT_CAP) hint = hint.slice(0, HINT_CAP).trimEnd() + '…';
  return hint ? `${vendor} · ${hint}` : vendor;
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

/**
 * Build the /edit tuning keyboard for an EXISTING watch. Mirrors the registration
 * card's controls minus the "Start" button (the watch is already live), and
 * tailored to the watch type:
 *   - search  -> seller-visibility row, frequency row, [exclusions][remove], [done]
 *   - product -> frequency row, [remove], [done]  (seller & exclusions don't apply
 *                to a single tracked listing)
 *
 * Reuses the `ex:`/`rm:` callbacks (identical behaviour to registration) and adds
 * edit-specific `esv:`/`efq:` so a change re-renders THIS keyboard (not the
 * registration card); `ed` closes the editor.
 */
export function editKeyboard(monitor: Monitor, lang: Lang): InlineKeyboard {
  const t = tr(lang);
  const id = monitor.id;
  const isSearch = monitor.type === 'search';
  const activeMinutes = Math.round(monitor.intervalMs / 60000);
  const mark = (on: boolean, label: string): string => (on ? `✅ ${label}` : label);
  const markSeller = (label: string, value: SellerVisibility): string =>
    mark(value === monitor.filters.sellerVisibility, label);

  const kb = new InlineKeyboard();
  if (isSearch) {
    kb.text(markSeller(t.btn_private, 'private'), `esv:${id}:private`)
      .text(markSeller(t.btn_company, 'company'), `esv:${id}:company`)
      .text(markSeller(t.btn_both, 'both'), `esv:${id}:both`)
      .row();
  }
  for (const minutes of FREQUENCY_PRESETS) {
    kb.text(mark(minutes === activeMinutes, t.btn_freq(minutes)), `efq:${id}:${minutes}`);
  }
  kb.row();
  // Filters that only make sense for a multi-result search.
  if (isSearch) {
    kb.text(t.btn_exclusion, `ex:${id}`)
      .text(t.btn_required, `eq:${id}`)
      .row()
      .text(mark(monitor.filters.dealsOnly === true, t.btn_deals_only), `eo:${id}`)
      .text(t.btn_block, `eb:${id}`)
      .row();
  } else {
    // A single tracked listing: a target-price alert is the meaningful control.
    kb.text(mark(monitor.filters.targetPrice !== undefined, t.btn_target), `et:${id}`).row();
  }
  // Rename + pause/resume on their own row, then remove + done.
  kb.text(t.btn_rename, `er:${id}`)
    .text(monitor.paused ? t.btn_resume : t.btn_pause, `ep:${id}`)
    .row()
    .text(t.btn_remove, `rm:${id}`)
    .text(t.btn_done, 'ed');
  return kb;
}

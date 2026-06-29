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
import { type Lang, tr, LANGS } from './strings';

/** Telegram hard-caps callback_data at 64 bytes. */
const CALLBACK_DATA_LIMIT = 64;

/** The fixed set of check-frequency presets, in minutes. */
export const FREQUENCY_PRESETS: readonly number[] = [5, 10, 15, 30, 60, 120, 360, 720, 1440];

/** Chunk size for laying frequency presets across keyboard rows. */
const FREQ_PER_ROW = 5;

/** Compact interval label without the clock emoji, e.g. 30 → "30m", 120 → "2h". */
export function fmtInterval(minutes: number): string {
  return minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
}

/**
 * The collapsed frequency picker, opened from the single "Interval" button on the
 * registration / edit card (keeps those cards uncluttered). `scope` chooses the
 * set callback ('reg' → fq:, 'edit' → efq:, each re-renders its own card), and
 * the back button returns to that card.
 */
export function frequencyPickerKeyboard(id: number, activeMinutes: number, lang: Lang, scope: 'reg' | 'edit'): InlineKeyboard {
  const t = tr(lang);
  const setCb = scope === 'edit' ? 'efq' : 'fq';
  const backCb = scope === 'edit' ? 'efb' : 'fqb';
  const kb = new InlineKeyboard();
  FREQUENCY_PRESETS.forEach((m, i) => {
    if (i > 0 && i % FREQ_PER_ROW === 0) kb.row();
    kb.text(`${m === activeMinutes ? '✅ ' : ''}${t.btn_freq(m)}`, `${setCb}:${id}:${m}`);
  });
  return kb.row().text('◀️', `${backCb}:${id}`);
}

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
  const kb = new InlineKeyboard();
  // Telegram rejects an empty-url button; a de-listed legacy item may lack a url.
  if (item.url) kb.url(tr(lang).btn_open, item.url);
  return kb;
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
/**
 * The /start home/index menu: one button per top-level action, routing via
 * idx:<action>. The "request access" button shows only when the chat isn't
 * allowed yet (an allowed chat has nothing to request).
 */
export function homeKeyboard(lang: Lang, allowed: boolean): InlineKeyboard {
  const t = tr(lang);
  const kb = new InlineKeyboard()
    .text(t.home_watches, 'idx:list')
    .text(t.home_browse, 'idx:browse')
    .text(t.home_saved, 'idx:saved')
    .row()
    .text(t.home_stats, 'idx:stats')
    .text(t.home_lang, 'idx:lang')
    .text(t.home_help, 'idx:help');
  if (!allowed) kb.row().text(t.home_access, 'idx:access');
  return kb;
}

/**
 * Language picker shown from the home menu's "Limbă" button. Each language in
 * its own name (Română / English / …), the active one ticked, 2 per row, plus a
 * back arrow to the home index. Tapping sets the language (setlang:<code>) — no
 * text input needed.
 */
export function langPickerKeyboard(current: Lang): InlineKeyboard {
  const kb = new InlineKeyboard();
  LANGS.forEach((code, i) => {
    const label = code === current ? `✅ ${tr(code).lang_name}` : tr(code).lang_name;
    kb.text(label, `setlang:${code}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('◀️', 'idx:home');
  return kb;
}

/**
 * Navigation-only carousel for the de-listing review: prev/next across the gone
 * listings. No track/save/dismiss — the items are already removed; the prev/next
 * post a fresh card (dlb:<index>) like /browse.
 */
export function delistBrowseKeyboard(index: number, total: number, lang: Lang): InlineKeyboard {
  const t = tr(lang);
  const kb = new InlineKeyboard();
  if (index > 0) kb.text(t.btn_prev, `dlb:${index - 1}`);
  if (index < total - 1) kb.text(t.btn_next, `dlb:${index + 1}`);
  return kb;
}

export function browseKeyboard(
  index: number,
  total: number,
  url: string,
  lang: Lang,
  canSwitch = false,
  saved = false,
): InlineKeyboard {
  const t = tr(lang);
  const kb = new InlineKeyboard();
  if (index > 0) kb.text(t.btn_prev, `br:${index - 1}`);
  if (index < total - 1) kb.text(t.btn_next, `br:${index + 1}`);
  if (index > 0 || index < total - 1) kb.row();
  // Jump is only meaningful when there is more than one item to jump between.
  if (total > 1) kb.text(t.btn_jump, 'bj');
  if (canSwitch) kb.text(t.btn_switch, 'bw');
  // Open is a URL button: only add it when a url exists. A legacy snapshot stored
  // before the url column may have none, and Telegram rejects an empty-url button
  // (BUTTON_URL_INVALID) — which would fail the whole send.
  if (url) kb.url(t.btn_open, url);
  // Shortlist + note + dismiss row.
  kb.row()
    .text(saved ? t.btn_saved : t.btn_save, `bsv:${index}`)
    .text(t.btn_note, `bnt:${index}`)
    .text(t.btn_dismiss, `bdm:${index}`);
  // Done → back to the /start home index.
  kb.row().text(t.btn_done, 'bdone');
  return kb;
}

/**
 * The /list watch picker: one button per watch (its summary line), routing to
 * `lw:<id>` which opens that watch's detail + action row. Replaces the old
 * one-card-per-watch spam with a single compact, app-style index.
 */
export function listKeyboard(rows: ReadonlyArray<{ id: number; label: string }>, lang: Lang): InlineKeyboard {
  void lang;
  const kb = new InlineKeyboard();
  for (const r of rows) kb.text(r.label, `lw:${r.id}`).row();
  kb.text('◀️', 'idx:home'); // back to the /start home index
  return kb;
}


/** Max options per picker page (paginated when more). */
export const PICKER_PAGE_SIZE = 15;


/** Every command that accepts an id — a no-arg invocation opens an id picker. */
export type IdCommand =
  | 'edit' | 'remove' | 'check' | 'history' | 'cheaper'
  | 'share' | 'unshare' | 'report'
  | 'allow' | 'deny' | 'promote' | 'demote' | 'userinfo' | 'setname' | 'setemail';

/**
 * What a picker is choosing:
 *   - 'command' — pick an id, then run {@link PickerSession.command} against it,
 *   - 'block'/'exclude'/'require' — toggle the picked value in a watch's filter.
 */
export type PickerKind = 'command' | 'block' | 'exclude' | 'require';

/** One selectable option in a picker. `value` is the payload acted on when tapped. */
export interface PickerOption {
  label: string;
  value: string;
  /** Shown with a ✅ and toggled off on re-tap (exclude/require/block). */
  selected?: boolean;
}

/** State of an open picker, keyed per chat. */
export interface PickerSession {
  kind: PickerKind;
  /** Header prompt (already localized). */
  prompt: string;
  /** For kind 'command': the command to run on the picked id. */
  command?: IdCommand;
  /** The watch being edited (toggle pickers); 0 for command pickers. */
  monitorId: number;
  options: PickerOption[];
  page: number;
  /** When true, offer a "type one" escape to the free-text prompt. */
  allowType: boolean;
}

/**
 * Build one page of a picker keyboard: up to {@link PICKER_PAGE_SIZE} option
 * buttons (each `ki:<globalIndex>`, ✅-marked when selected), a Prev/Next row when
 * paginated (`kp:<page>`), and a footer with an optional "Type one" (`kt`) and
 * Done (`kc`).
 */
export function pickerKeyboard(session: PickerSession, lang: Lang): InlineKeyboard {
  const t = tr(lang);
  const kb = new InlineKeyboard();
  const pages = Math.max(1, Math.ceil(session.options.length / PICKER_PAGE_SIZE));
  const page = Math.min(Math.max(0, session.page), pages - 1);
  const start = page * PICKER_PAGE_SIZE;
  session.options.slice(start, start + PICKER_PAGE_SIZE).forEach((opt, i) => {
    kb.text(`${opt.selected ? '✅ ' : ''}${opt.label}`, `ki:${start + i}`).row();
  });
  if (pages > 1) {
    if (page > 0) kb.text(t.btn_prev, `kp:${page - 1}`);
    if (page < pages - 1) kb.text(t.btn_next, `kp:${page + 1}`);
    kb.row();
  }
  if (session.allowType) kb.text(t.btn_type, 'kt');
  kb.text(t.btn_done, 'kc');
  return kb;
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
  void lang; // scope labels are pre-localized by the caller
  const kb = new InlineKeyboard();
  for (const s of scopes) {
    kb.text(`${s.label} (${s.count})`, `bs:${s.target}`).row();
  }
  kb.text('◀️', 'idx:home'); // back to the /start home index
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

  const kb = new InlineKeyboard()
    // Seller visibility row (active option marked).
    .text(markSeller(t.btn_private, 'private'), `sv:${monitorId}:private`)
    .text(markSeller(t.btn_company, 'company'), `sv:${monitorId}:company`)
    .text(markSeller(t.btn_both, 'both'), `sv:${monitorId}:both`)
    .row();

  // Check interval — collapsed behind one button (opens the freq picker).
  kb.text(t.btn_interval(fmtInterval(activeMinutes)), `fqi:${monitorId}`);

  return kb
    .row()
    // Exclusion keywords prompt + group (reuses the edit-card egr: flow) + remove.
    .text(t.btn_exclusion, `ex:${monitorId}`)
    .text(t.btn_group, `egr:${monitorId}`)
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
/** The localized seller-visibility label for the current value. */
function sellerLabel(v: SellerVisibility, lang: Lang): string {
  const t = tr(lang);
  return v === 'private' ? t.btn_private : v === 'company' ? t.btn_company : t.btn_both;
}

/** Seller-visibility submenu (3 options marked) + back to the edit card. */
export function sellerMenuKeyboard(monitor: Monitor, lang: Lang): InlineKeyboard {
  const t = tr(lang);
  const id = monitor.id;
  const v = monitor.filters.sellerVisibility;
  const mk = (label: string, val: SellerVisibility): string => (val === v ? `✅ ${label}` : label);
  return new InlineKeyboard()
    .text(mk(t.btn_private, 'private'), `esv:${id}:private`)
    .text(mk(t.btn_company, 'company'), `esv:${id}:company`)
    .text(mk(t.btn_both, 'both'), `esv:${id}:both`)
    .row()
    .text('◀️', `efb:${id}`);
}

/** Reports submenu: Rezumat (off/1d/7d) + Raport (on/off) toggles + back. */
export function reportsMenuKeyboard(monitor: Monitor, lang: Lang): InlineKeyboard {
  const t = tr(lang);
  const id = monitor.id;
  const dg = monitor.filters.digest ? (monitor.filters.digest === 'weekly' ? '7d' : '1d') : '✖️';
  const rp = monitor.filters.weeklyReport === true ? '✅' : '✖️';
  return new InlineKeyboard()
    .text(`${t.btn_digest}: ${dg}`, `edg:${id}`)
    .row()
    .text(`${t.btn_report}: ${rp}`, `erp:${id}`)
    .row()
    .text('◀️', `efb:${id}`);
}

/**
 * Group picker for the edit card. Lists the chat's existing collections as
 * buttons (the active one ticked) so a watch joins a group with one tap; only
 * "➕ new group" (egn:) drops to a text prompt. `groups` must be the same sorted
 * distinct-name list the egs: handler re-derives, since selection is by index.
 */
export function groupPickerKeyboard(monitor: Monitor, groups: readonly string[], lang: Lang): InlineKeyboard {
  const t = tr(lang);
  const id = monitor.id;
  const cur = monitor.collection;
  const kb = new InlineKeyboard();
  groups.forEach((name, i) => {
    kb.text(name === cur ? `✅ 📁 ${name}` : `📁 ${name}`, `egs:${id}:${i}`).row();
  });
  if (cur) kb.text(t.btn_group_clear, `egs:${id}:-1`).row();
  kb.text(t.btn_group_new, `egn:${id}`).row();
  kb.text('◀️', `efb:${id}`);
  return kb;
}

export function editKeyboard(monitor: Monitor, lang: Lang): InlineKeyboard {
  const t = tr(lang);
  const id = monitor.id;
  const isSearch = monitor.type === 'search';
  const activeMinutes = Math.round(monitor.intervalMs / 60000);
  const mark = (on: boolean, label: string): string => (on ? `✅ ${label}` : label);

  const kb = new InlineKeyboard();
  if (isSearch) {
    // Seller visibility — collapsed behind one button (opens the seller submenu).
    kb.text(t.btn_seller_menu(sellerLabel(monitor.filters.sellerVisibility, lang)), `esm:${id}`).row();
  }
  // Check interval — collapsed behind one button (opens the freq picker).
  kb.text(t.btn_interval(fmtInterval(activeMinutes)), `efi:${id}`).row();
  // Pause/resume sits right under the interval (cadence controls together).
  kb.text(monitor.paused ? t.btn_resume : t.btn_pause, `ep:${id}`).row();
  // Filters that only make sense for a multi-result search.
  if (isSearch) {
    kb.text(t.btn_exclusion, `ex:${id}`)
      .text(t.btn_required, `eq:${id}`)
      .text(t.btn_block, `eb:${id}`)
      .row()
      // Rezumat (digest) + Raport (report) collapsed into one Reports submenu.
      .text(t.btn_reports_menu, `erm:${id}`)
      .row();
  } else {
    // A single tracked listing: a target-price alert is the meaningful control.
    kb.text(mark(monitor.filters.targetPrice !== undefined, t.btn_target), `et:${id}`).row();
  }
  // Rename + group, then remove + back (◀️ → the /list picker).
  kb.text(t.btn_rename, `er:${id}`)
    .text(t.btn_group, `egr:${id}`)
    .row()
    .text(t.btn_remove, `rm:${id}`)
    .text('◀️', 'lw:back');
  return kb;
}

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
export const FREQUENCY_PRESETS: readonly number[] = [5, 10, 15, 30, 60, 120, 360, 720, 1440];

/** Chunk size for laying frequency presets across keyboard rows. */
const FREQ_PER_ROW = 5;

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
  // Shortlist + note + dismiss row.
  kb.row()
    .text(saved ? t.btn_saved : t.btn_save, `bsv:${index}`)
    .text(t.btn_note, `bnt:${index}`)
    .text(t.btn_dismiss, `bdm:${index}`);
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

/** Max options per picker page (paginated when more). */
export const PICKER_PAGE_SIZE = 15;

/**
 * Interactive numeric-attribute presets (year/km/area) for a one-tap range
 * filter. year/area are lower bounds (≥); km is an upper bound (≤). Tapping a
 * value sets that bound; `0` clears the attribute. Language-neutral: the buttons
 * are the filter key + a number, so no catalog string is needed.
 */
export const ATTR_PRESETS: Record<'year' | 'km' | 'area', number[]> = {
  year: [2015, 2018, 2020, 2022],
  km: [250000, 150000, 100000, 50000],
  area: [40, 60, 80, 100],
};

/** Step 1 of the specs wizard: choose which attribute to range, or type one. */
export function specChooserKeyboard(id: number, lang: Lang): InlineKeyboard {
  const t = tr(lang);
  return new InlineKeyboard()
    .text('📅 year', `ec:${id}:year`)
    .text('🛣 km', `ec:${id}:km`)
    .text('📐 area', `ec:${id}:area`)
    .row()
    .text('✏️', `ec:${id}:type`)
    .text(t.btn_done, 'ed');
}

/** Step 2: one-tap preset bounds for `attr`; `current` is the active bound (✅). */
export function attrPresetKeyboard(id: number, attr: 'year' | 'km' | 'area', current: number | undefined, lang: Lang): InlineKeyboard {
  const isMax = attr === 'km';
  const sym = isMax ? '≤' : '≥';
  const fmt = (v: number): string => (attr === 'km' ? `${v / 1000}k` : `${v}`);
  const kb = new InlineKeyboard();
  ATTR_PRESETS[attr].forEach((v, i) => {
    if (i > 0 && i % 2 === 0) kb.row();
    kb.text(`${current === v ? '✅ ' : ''}${sym}${fmt(v)}`, `ecp:${id}:${attr}:${v}`);
  });
  kb.row().text('✖️', `ecp:${id}:${attr}:0`).text('◀️', `ec:${id}:back`);
  return kb;
}

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

  // Frequency presets (active minutes marked), wrapped across rows.
  FREQUENCY_PRESETS.forEach((minutes, i) => {
    if (i > 0 && i % FREQ_PER_ROW === 0) kb.row();
    kb.text(markFreq(t.btn_freq(minutes), minutes), `fq:${monitorId}:${minutes}`);
  });

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
  FREQUENCY_PRESETS.forEach((minutes, i) => {
    if (i > 0 && i % FREQ_PER_ROW === 0) kb.row();
    kb.text(mark(minutes === activeMinutes, t.btn_freq(minutes)), `efq:${id}:${minutes}`);
  });
  kb.row();
  // Filters that only make sense for a multi-result search.
  if (isSearch) {
    kb.text(t.btn_exclusion, `ex:${id}`)
      .text(t.btn_required, `eq:${id}`)
      .row()
      .text(mark(monitor.filters.dealsOnly === true, t.btn_deals_only), `eo:${id}`)
      .text(t.btn_block, `eb:${id}`)
      .row()
      .text(mark(monitor.filters.priceMin !== undefined || monitor.filters.priceMax !== undefined, t.btn_price_range), `epr:${id}`)
      .text(mark(monitor.filters.attrRanges !== undefined && Object.keys(monitor.filters.attrRanges).length > 0, t.btn_specs), `ear:${id}`)
      .row()
      // Digest cycles off → daily (1d) → weekly (7d). The period suffix is
      // language-neutral so it needs no extra catalog string.
      .text(
        monitor.filters.digest
          ? `✅ ${t.btn_digest} · ${monitor.filters.digest === 'weekly' ? '7d' : '1d'}`
          : t.btn_digest,
        `edg:${id}`,
      )
      .text(mark(monitor.filters.weeklyReport === true, t.btn_report), `erp:${id}`)
      .row();
  } else {
    // A single tracked listing: a target-price alert is the meaningful control.
    kb.text(mark(monitor.filters.targetPrice !== undefined, t.btn_target), `et:${id}`).row();
  }
  // Rename + group + pause/resume on their own row, then remove + done.
  kb.text(t.btn_rename, `er:${id}`)
    .text(t.btn_group, `egr:${id}`)
    .text(monitor.paused ? t.btn_resume : t.btn_pause, `ep:${id}`)
    .row()
    .text(t.btn_remove, `rm:${id}`)
    .text(t.btn_done, 'ed');
  return kb;
}

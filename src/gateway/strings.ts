/**
 * Localized message catalog (RO default, EN on request).
 *
 * Every user-facing string lives here — commands, cards, notifications, errors,
 * and button labels. The {@link Catalog} interface makes completeness a COMPILE
 * error: a key missing from either language fails `tsc`. Callers read copy via
 * `tr(lang).<key>` (a plain string, or a function for parameterized messages).
 */

import type { WatchHealth } from '../contracts';

export type Lang = 'ro' | 'en' | 'de' | 'fr' | 'it' | 'es';

export const LANGS: readonly Lang[] = ['ro', 'en', 'de', 'fr', 'it', 'es'];

export function isLang(v: unknown): v is Lang {
  return (LANGS as readonly string[]).includes(v as string);
}

/**
 * The full set of message keys. String members are static; function members
 * take runtime parameters. Both language maps must implement every member.
 */
export interface Catalog {
  // ── Commands / conversational ────────────────────────────────────────────
  start_welcome: string;
  help_body: string;
  // /start home/index menu buttons.
  home_watches: string;
  home_browse: string;
  home_saved: string;
  home_stats: string;
  home_lang: string;
  home_help: string;
  home_access: string;
  track_usage: string;
  track_error: string;
  list_empty: string;
  list_intro: string;
  list_item: (p: {
    id: number;
    vendor: string;
    type: string;
    seller: string;
    url: string;
    /** Comma-joined exclusion keywords; empty string when none. */
    exclusions: string;
    /** True for a watch created by tapping Track on a browsed item. */
    tracked: boolean;
    /** Optional user-given label, shown in place of the vendor·query when set. */
    label?: string;
    /** True when the watch is paused (scheduler skips it). */
    paused: boolean;
    /** Comma-joined required keywords; empty when none. */
    required: string;
    /** Count of blocked sellers + phones; 0 when none. */
    blocked: number;
  }) => string;
  remove_usage: string;
  remove_done: (id: number) => string;
  remove_not_found: string;
  /** Portfolio summary for /stats. */
  stats_summary: (p: {
    watches: number;
    search: number;
    product: number;
    paused: number;
    tracked: number;
    items: number;
    vendors: string;
  }) => string;
  /** Caption on the exported CSV document. */
  export_caption: (rows: number) => string;
  /** Reply when there's nothing to export. */
  export_empty: string;
  rate_usage: string;
  rate_unsupported: string;
  rate_failed: string;
  rate_no_comps: string;
  rate_result: (p: { title: string; price: string }) => string;
  history_usage: string;
  history_not_found: string;
  /** Caption/text summary under a /history price chart. */
  history_summary: (p: { title: string; first: string; last: string; low: string; cuts: number; points: number; days: number }) => string;
  cheaper_usage: string;
  cheaper_not_found: string;
  cheaper_none: string;
  cheaper_intro: (title: string) => string;
  cheaper_item: (p: { title: string; price: string; url: string }) => string;
  edit_usage: string;
  edit_not_found: string;
  rename_prompt: string;
  rename_done: (label: string) => string;
  rename_cleared: string;
  // Watch groups / collections.
  btn_group: string;
  btn_group_new: string; // "new group" entry in the edit-card group picker (drops to a text prompt)
  btn_group_clear: string; // "remove from group" entry in the edit-card group picker
  group_prompt: string;
  group_set: (name: string) => string;
  group_cleared: string;
  group_usage: string;
  group_done: (a: { count: number }) => string;
  /** Header of the /edit tuning card for an existing watch. */
  edit_card: (p: {
    id: number;
    vendor: string;
    type: string;
    minutes: number;
    label?: string;
    paused: boolean;
  }) => string;
  lang_current: (langName: string) => string;
  lang_set: (langName: string) => string;
  lang_usage: string;
  lang_name: string; // this language's own name, e.g. "Română" / "English"
  lang_pick_intro: string; // header above the home-menu language button picker
  /** Admin DM when a dom-selector self-heals; prompts a manifest fix. */
  admin_selector_healed: (p: { vendor: string; from: string; to: string }) => string;
  // Group/shared watches: fan a watch's alerts out to other chats.
  share_prompt: string;
  share_added: (a: { chatId: number; count: number }) => string;
  share_removed: (a: { count: number }) => string;
  share_none: string;
  share_invalid: string;
  unshare_prompt: (a: { list: string }) => string;
  chat_id_line: (id: number) => string;
  unknown_command: string;
  send_link_hint: string;
  generic_error: string;
  check_usage: string;
  check_ok: (p: { items: number; new: number }) => string;
  check_failed: string;
  check_not_found: string;
  /** Refused: this chat already holds the max number of watches. */
  quota_reached: (limit: number) => string;
  /** Refused: /check used again before its per-chat cooldown elapsed. */
  check_rate_limited: string;
  /** Refused: a URL pasted again before its per-chat cooldown elapsed. */
  url_rate_limited: string;
  watch_failing: (h: WatchHealth) => string;
  watch_recovered: (h: WatchHealth) => string;
  /** Tracked-item bidirectional price change. */
  price_change: (p: { title: string; oldPrice: string; newPrice: string; direction: 'up' | 'down' }) => string;
  /** De-listing alert. */
  delisted_title: string;
  delisted_reason_product_gone: string;
  delisted_reason_search_dropped: string;
  delisted_last_price: (price: string) => string;
  /** Search monitor's per-cycle drop-off roll-up header. */
  listings_dropped_title: (count: number, vendor: string) => string;
  /** Title atop each de-listed item's browse card. */
  delisted_card_title: string;
  /** A delisted item reappeared. */
  re_listed_title: string;

  // ── Registration tuning card ──────────────────────────────────────────────
  reg_watching: (vendor: string) => string;
  reg_baseline: (count: number) => string;
  reg_tune_prompt: string;

  // ── Inline button labels ──────────────────────────────────────────────────
  btn_private: string;
  btn_company: string;
  btn_both: string;
  btn_exclusion: string;
  btn_start: string;
  btn_done: string;
  btn_remove: string;
  btn_digest: string;
  btn_report: string;
  btn_required: string;
  btn_block: string;
  btn_rename: string;
  btn_pause: string;
  btn_resume: string;
  btn_edit: string;
  btn_target: string;
  btn_type: string;
  /** Picker prompts (paginated button choosers). */
  picker_choose_watch: string;
  picker_choose_user: string;
  picker_block_prompt: string;
  picker_exclude_prompt: string;
  picker_require_prompt: string;
  btn_open: string;
  btn_call: string;
  btn_price_history: string;
  btn_freq: (minutes: number) => string;
  /** Collapsed check-interval button on the registration / edit card (current value). */
  btn_interval: (current: string) => string;
  /** Edit-card seller submenu opener (shows current visibility). */
  btn_seller_menu: (current: string) => string;
  /** Edit-card reports submenu opener (digest + weekly report). */
  btn_reports_menu: string;
  /** Explainer shown atop the reports submenu (what rezumat vs raport mean). */
  reports_menu_intro: string;
  // Browse carousel.
  btn_prev: string;
  btn_next: string;
  btn_jump: string;
  btn_switch: string;
  btn_browse_all: string;
  btn_save: string;
  btn_saved: string;
  btn_dismiss: string;
  btn_note: string;
  cb_saved: string;
  cb_unsaved: string;
  cb_dismissed: string;
  note_prompt: string;
  note_set: string;
  note_cleared: string;
  saved_empty: string;
  saved_intro: string;
  saved_item: (p: { title: string; price: string; url: string }) => string;
  browse_in_stock: string;
  browse_out_of_stock: string;
  /** One-line price rating vs comparable listings; '' for an unknown verdict. */
  price_rating: (p: { tag: 'great_deal' | 'fair_price' | 'overpriced' | 'unknown'; percentile: number; n: number; suspicious?: boolean }) => string;
  /** Model-predicted fair price line (v2). */
  fair_value_line: (p: { fair: string; deltaAbs: string; under: boolean }) => string;
  /** Strong flag on a new listing priced clearly under predicted fair value. */
  fair_value_under: (p: { fair: string; pct: number }) => string;
  browse_position: (n: number, total: number) => string;
  browse_empty: string;
  browse_gone: string;
  /** Header of the scope picker (browse a single watch vs all). */
  browse_scope_prompt: string;
  /** Prompt asking the user to type an item number to jump to. */
  browse_jump_prompt: (total: number) => string;
  /** Re-prompt when the typed jump target is out of range / not a number. */
  browse_jump_invalid: (total: number) => string;

  // ── Callback answers / prompts ────────────────────────────────────────────
  cb_seller_set: (visibility: string) => string;
  cb_monitoring_started: string;
  cb_watch_gone: string;
  cb_unknown_option: string;
  cb_setting_error: string;
  cb_removed: string;
  cb_freq_set: (minutes: number) => string;
  cb_edit_done: string;
  cb_paused: string;
  cb_resumed: string;
  cb_digest_set: string;
  cb_report_set: string;
  exclusion_prompt: string;
  exclusion_set: (keywords: string) => string;
  exclusion_cleared: string;
  required_prompt: string;
  required_set: (keywords: string) => string;
  required_cleared: string;
  target_prompt: string;
  target_set: (price: number) => string;
  target_cleared: string;
  target_invalid: string;
  /** Title + line of a target-price-hit alert. */
  target_hit_title: string;
  target_hit_line: (target: string) => string;
  /** Title of a "became a great deal" alert. */
  became_deal_title: string;
  /** Market-insight footer on a product alert (time-on-market, price cuts, low). */
  insight_line: (p: { days?: number; cuts: number; low: string }) => string;
  /** Price-direction outlook lines for a tracked item. */
  price_outlook_falling: string;
  price_outlook_stable: string;
  block_prompt: string;
  block_added_seller: (name: string) => string;
  block_added_phone: (phone: string) => string;
  block_cleared: string;
  price_history_insufficient: string;
  price_history_error: string;

  // ── Notification cards ────────────────────────────────────────────────────
  seller_private: string;
  seller_company: string;
  /** Joins a listing's spec attributes into one card line (label included). */
  specs_line: (specs: string) => string;
  /** Prefixes the posted date on the card. */
  posted_line: (date: string) => string;
  badge_great_deal: string;
  badge_fair_price: string;
  badge_overpriced: string;
  also_on: (sources: string) => string;
  price_drop: (p: { title: string; oldPrice: string; newPrice: string; savings: string }) => string;
  back_in_stock_title: string;
  /** Banner prepended to a new-listing card when multiple "hot" signals coincide. */
  hot_lead_title: string;
  /** Warning on a listing whose too-good price coincides with weak seller signals. */
  scam_warn: string;
  /** Seller-reputation badges shown on a card when the seller has a track record. */
  seller_trust_good: string;
  seller_trust_caution: string;
  /** Digest summary header (count + vendor) and the market-stats line. */
  digest_intro: (a: { count: number; vendor: string }) => string;
  digest_stats: (a: { median: string; range: string }) => string;
  /** Weekly market report header, stat lines, and best-deals section header. */
  report_title: (vendor: string) => string;
  report_inventory: (a: { count: number; delta: string }) => string;
  report_velocity: (a: { n: number }) => string;
  report_best: string;
  /** Seasonal "best time to buy" hint (month abbrev + percent below the yearly mean). */
  report_seasonal: (a: { month: string; pct: number }) => string;

  // ── Access control ────────────────────────────────────────────────────────
  access_denied: string; // shown to a non-allowed chat that tries to use the bot
  access_request_intro: string; // /request_access kicks off; ask for name
  access_ask_name: string;
  access_ask_email: string;
  access_email_invalid: string; // re-prompt on a malformed email
  access_request_sent: string; // confirmation to the requester
  access_request_pending: string; // already pending
  access_granted_user: string; // told to the requester when allowed
  access_denied_user: string; // told to the requester when denied
  access_first_admin: string; // first requester auto-approved as admin
  access_request_too_soon: (days: number) => string; // denied < 7d ago, re-apply later
  access_admin_new_request: (p: { id: number; name: string; email: string }) => string; // to admins
  access_admin_only: string; // non-admin tried an admin command
  access_allow_usage: string;
  access_deny_usage: string;
  access_allow_done: (p: { id: number; name: string }) => string;
  access_deny_done: (p: { id: number; name: string }) => string;
  access_user_not_found: string;
  access_users_intro: string;
  access_users_item: (p: { id: number; status: string; isAdmin: boolean; name: string; email: string }) => string;
  access_users_empty: string;
  access_userinfo_usage: string;
  access_userinfo: (p: { id: number; status: string; isAdmin: boolean; name: string; email: string }) => string;
  access_setname_usage: string;
  access_setemail_usage: string;
  access_setname_prompt: (p: { id: number }) => string;
  access_setemail_prompt: (p: { id: number }) => string;
  access_setname_done: (p: { id: number; name: string }) => string;
  access_setemail_done: (p: { id: number; email: string }) => string;
  access_promote_usage: string;
  access_demote_usage: string;
  access_promote_done: (p: { id: number }) => string;
  access_demote_done: (p: { id: number }) => string;
  access_demote_last_admin: string; // refused: would leave the bot with no admin
  access_promoted_user: string; // told to a chat when it becomes admin
  access_demoted_user: string; // told to a chat when its admin is removed
  btn_allow: string;
  btn_deny: string;
  cb_allow_done: (p: { id: number }) => string;
  cb_deny_done: (p: { id: number }) => string;

  // ── Destructive-action confirmation ───────────────────────────────────────
  confirm_remove: (id: number) => string; // "Stop watch #id? This can't be undone."
  confirm_deny: (p: { id: number; name: string }) => string;
  confirm_demote: (id: number) => string;
  btn_confirm: string;
  btn_cancel: string;
  cb_cancelled: string;

  // ── Audit log ─────────────────────────────────────────────────────────────
  audit_intro: string;
  audit_empty: string;
  audit_item: (p: { action: string; targetId: number; actorId: number; at: string }) => string;
  // ── Backup & restore (admin) ──────────────────────────────────────────────
  backup_caption: string;
  backup_failed: string;
  restore_usage: string;
  restore_invalid: string;
  restore_staged: string;
}

const ro: Catalog = {
  start_welcome:
    'Bun venit la agor! 👋\n\n' +
    'Trimite-mi un link de căutare sau de produs (OLX, AutoVit, Storia…) ' +
    'și îl voi urmări pentru anunțuri noi, scăderi de preț și reveniri în stoc.\n\n' +
    'Scrie /help pentru lista completă de comenzi.',
  help_body:
    'Cum folosești agor:\n\n' +
    '• Trimite orice link http(s) de anunț, sau folosește /track <link>, ca să pornești o urmărire.\n' +
    '• După înregistrare, reglează tipul de vânzător, frecvența și cuvintele excluse, apoi apasă „Pornește”.\n' +
    '• /list — arată toate urmăririle din acest chat.\n' +
    '• /browse — răsfoiește anunțurile colectate; apasă „📌 Urmărește” ca să urmărești un anunț.\n' +
    '• /edit <id> — modifică frecvența, vânzătorul sau cuvintele excluse ale unei urmăriri.\n' +
    '• /stats — rezumatul urmăririlor · /export — anunțurile colectate ca CSV.\n' +
    '• /rate <link> — evaluează prețul unui anunț fără să-l urmărești.\n' +
    '• /history <id> — grafic de preț pentru o urmărire.\n' +
    '• /cheaper <id> — echivalente mai ieftine pentru un produs urmărit.\n' +
    '• Redirecționează (forward) un anunț ca să-l urmărești automat.\n' +
    '• /remove <id> — oprește o urmărire.\n' +
    '• /lang ro|en|de|fr|it|es — schimbă limba.\n' +
    '• Apasă „Istoric preț” pe orice alertă pentru un grafic.',
  track_usage: 'Folosire: /track <link>',
  home_watches: '📋 Urmăriri',
  home_browse: '🔎 Răsfoiește',
  home_saved: '⭐ Salvate',
  home_stats: '📊 Statistici',
  home_lang: '🌐 Limbă',
  home_help: '❓ Ajutor',
  home_access: '🔓 Cere acces',
  track_error: 'Nu am putut înregistra urmărirea. Te rog încearcă din nou.',
  list_empty: 'Nicio urmărire încă. Trimite un link de anunț ca să creezi una.',
  list_intro: 'Urmăririle tale:',
  list_item: ({ id, vendor, type, seller, url, exclusions, tracked, label, paused, required, blocked }) =>
    `#${id} · ${tracked ? '📌 ' : ''}${paused ? '⏸ ' : ''}${label ? `„${label}” (${vendor})` : vendor} · ${type}` +
    // Seller filter, deals-only & keyword filters only apply to search watches; a
    // product watch tracks one listing, so they'd be meaningless noise.
    (type === 'search' ? ` · vânzător=${seller}` : '') +
    (type === 'search' && required ? ` · necesită: ${required}` : '') +
    (type === 'search' && exclusions ? ` · excluse: ${exclusions}` : '') +
    (type === 'search' && blocked > 0 ? ` · blocați: ${blocked}` : '') +
    `\n${url}`,
  remove_usage: 'Folosire: /remove <id>',
  remove_done: (id) => `Urmărirea #${id} a fost oprită.`,
  remove_not_found: 'Urmărirea nu există sau nu îți aparține.',
  stats_summary: ({ watches, search, product, paused, tracked, items, vendors }) =>
    `📊 Rezumat\n` +
    `• Urmăriri: ${watches} (${search} căutări, ${product} produse)\n` +
    `• Urmărite (📌): ${tracked} · pe pauză (⏸): ${paused}\n` +
    `• Anunțuri colectate: ${items}\n` +
    (vendors ? `• Site-uri: ${vendors}` : ''),
  export_caption: (rows) => `📄 ${rows} anunț${rows === 1 ? '' : 'uri'} exportate.`,
  export_empty: 'Niciun anunț de exportat încă.',
  rate_usage: 'Folosire: /rate <link>',
  rate_unsupported: 'Site neacceptat sau link invalid.',
  rate_failed: 'Nu am putut citi anunțul (site blocat sau indisponibil).',
  rate_no_comps: 'Nu am încă destule anunțuri similare ca să-l evaluez.',
  rate_result: ({ title, price }) => `🏷️ ${title}\n💰 ${price}`,
  history_usage: 'Folosire: /history <id>',
  history_not_found: 'Urmărirea nu există, nu îți aparține sau nu are istoric de preț.',
  history_summary: ({ title, first, last, low, cuts, points, days }) =>
    `📈 ${title}\nDe la ${first} → acum ${last}\nMinim ${low} · ${cuts} reducer${cuts === 1 ? 'e' : 'i'} · ${points} puncte · ${days}z`,
  cheaper_usage: 'Folosire: /cheaper <id> (id-ul unei urmăriri de produs)',
  cheaper_not_found: 'Urmărirea nu există, nu îți aparține sau nu are încă un anunț.',
  cheaper_none: 'Niciun echivalent mai ieftin în anunțurile tale colectate.',
  cheaper_intro: (title) => `🔎 Mai ieftine, similare cu „${title}”:`,
  cheaper_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  edit_usage: 'Folosire: /edit <id>',
  edit_not_found: 'Urmărirea nu există sau nu îți aparține.',
  rename_prompt: 'Trimite o denumire pentru această urmărire (sau „-” ca să o ștergi).',
  rename_done: (label) => `Denumire setată: „${label}”.`,
  rename_cleared: 'Denumirea a fost ștearsă.',
  btn_group: '📁 Grup',
  btn_group_new: '➕ Grup nou',
  btn_group_clear: '✖️ Scoate din grup',
  group_prompt: 'Trimite numele grupului pentru această urmărire (sau „-” pentru a-l elimina).',
  group_set: (name) => `Grup setat: „${name}”.`,
  group_cleared: 'Grup eliminat.',
  group_usage: 'Folosire: /group <pause|resume|remove> <nume>',
  group_done: ({ count }) => `${count} urmăriri actualizate.`,
  edit_card: ({ id, vendor, type, minutes, label, paused }) =>
    `✏️ Editezi urmărirea #${id} · ${label ? `„${label}” (${vendor})` : vendor} · ${type}${paused ? ' · ⏸ pe pauză' : ''}\n` +
    `Verificare la fiecare ${minutes} min. Ajustează mai jos:`,
  lang_current: (n) => `Limba curentă: ${n}. Schimbă cu /lang ro|en|de|fr|it|es.`,
  lang_set: (n) => `Limba a fost setată: ${n}.`,
  lang_usage: 'Folosire: /lang ro|en|de|fr|it|es',
  lang_name: 'Română',
  lang_pick_intro: '🌐 Alege limba:',
  admin_selector_healed: ({ vendor, from, to }) =>
    `⚠️ Selector auto-reparat pentru ${vendor}.\nSelectorul fixat „${from}” nu mai potrivea; relocalizat la „${to}”.\nActualizează manifestul ca să fie permanent.`,
  share_prompt: 'Trimite id-ul chatului cu care să partajez această urmărire (folosește /chatid în celălalt chat ca să-l afli). „-” anulează.',
  share_added: ({ chatId, count }) => `Partajat cu ${chatId}. Urmărirea trimite acum alerte și către ${count} chat(uri) suplimentare.`,
  share_removed: ({ count }) => `Oprit. Urmărirea mai este partajată cu ${count} chat(uri).`,
  share_none: 'Această urmărire nu este partajată cu niciun chat.',
  share_invalid: 'Trimite un id de chat valid (un număr, ex. -1001234567890).',
  unshare_prompt: ({ list }) => `Trimite id-ul chatului cu care să nu mai partajez. Acum: ${list}. „-” anulează.`,
  chat_id_line: (id) => `Id-ul acestui chat: ${id}`,
  unknown_command: 'Comandă necunoscută. Încearcă /help.',
  send_link_hint: 'Trimite-mi un link de anunț pentru urmărire, sau /help.',
  generic_error: 'Ceva nu a mers bine. Te rog încearcă din nou.',
  check_usage: 'Folosire: /check <id>',
  check_ok: ({ items, new: n }) =>
    `✅ Verificat: ${items} anunț${items === 1 ? '' : 'uri'} găsit${items === 1 ? '' : 'e'}, ${n} nou${n === 1 ? '' : 'i'}.`,
  check_failed: '⚠️ Verificare eșuată — site-ul nu a răspuns sau pare blocat.',
  check_not_found: 'Urmărirea nu există sau nu îți aparține.',
  quota_reached: (limit) =>
    `Ai atins limita de ${limit} urmăriri. Șterge una (/remove <id>) înainte de a adăuga alta.`,
  check_rate_limited: 'Prea repede — așteaptă câteva secunde înainte de o nouă verificare.',
  url_rate_limited: 'Prea repede — așteaptă câteva secunde înainte de a adăuga alt link.',
  watch_failing: (h) =>
    `⚠️ Urmărirea #${h.monitorId} (${h.vendor}) pare blocată sau nu mai găsește nimic (${h.consecutiveFailures} verificări eșuate la rând). Voi anunța când revine.`,
  watch_recovered: (h) => `✅ Urmărirea #${h.monitorId} (${h.vendor}) funcționează din nou.`,
  price_change: ({ title, oldPrice, newPrice, direction }) =>
    `${direction === 'down' ? '📉' : '📈'} Preț modificat la ${title}: ${oldPrice} → ${newPrice}`,
  delisted_title: '🗑️ Anunț eliminat',
  delisted_reason_product_gone: 'Pagina anunțului nu mai există (a fost ștearsă).',
  delisted_reason_search_dropped: 'Anunțul a dispărut din rezultatele urmărite.',
  delisted_last_price: (price) => `Ultimul preț văzut: ${price}`,
  listings_dropped_title: (count, vendor) =>
    `🗑️ ${count} ${count === 1 ? 'anunț a dispărut' : 'anunțuri au dispărut'} de pe ${vendor}`,
  re_listed_title: '♻️ Anunț reapărut',
  delisted_card_title: '🔻 Anunț retras 🔻',

  reg_watching: (v) => `✅ Urmăresc ${v}`,
  reg_baseline: (c) => `📦 Bază: ${c} anunț${c === 1 ? '' : 'uri'} înregistrat${c === 1 ? '' : 'e'}.`,
  reg_tune_prompt: 'Reglează urmărirea, apoi pornește monitorizarea:',

  btn_private: '👤 Privat',
  btn_company: '🏢 Firmă',
  btn_both: '👥 Ambele',
  btn_exclusion: '🚫 Cuvinte excluse',
  btn_start: '▶️ Pornește',
  btn_done: '✅ Gata',
  btn_remove: '🗑 Șterge',
  btn_digest: '📰 Rezumat',
  btn_report: '📅 Raport săptămânal',
  btn_required: '✅ Cuvinte necesare',
  btn_block: '⛔ Blochează vânzător',
  btn_rename: '✏️ Redenumește',
  btn_pause: '⏸ Pauză',
  btn_resume: '▶️ Reia',
  btn_edit: '✏️ Editează',
  btn_target: '🎯 Preț țintă',
  btn_type: '✏️ Scrie',
  picker_choose_watch: 'Care urmărire?',
  picker_choose_user: 'Care utilizator?',
  picker_block_prompt: 'Ce vânzător vrei să blochezi? (apasă; din nou = deblochezi)',
  picker_exclude_prompt: 'Ce cuvinte să exclud? (apasă; din nou = scoți)',
  picker_require_prompt: 'Ce cuvinte sunt necesare? (apasă; din nou = scoți)',
  btn_open: '🔗 Deschide',
  btn_call: '📞 Sună',
  btn_price_history: '📊 Istoric preț',
  btn_freq: (m) => m < 60 ? `⏱ ${m}m` : `⏱ ${m / 60}h`,
  btn_interval: (current) => `⏱ Interval verificare: ${current}`,
  btn_seller_menu: (current) => `👤 Vânzător: ${current}`,
  btn_reports_menu: '📊 Rapoarte',
  reports_menu_intro: '📊 Rapoarte\n\n• Rezumat — în loc de notificări individuale, primești toate anunțurile noi grupate o dată pe zi sau pe săptămână.\n• Raport săptămânal — sinteză de piață: număr de anunțuri, preț mediu și tendință pe ultima săptămână.',
  btn_prev: '◀️ Înapoi',
  btn_next: 'Înainte ▶️',
  btn_save: '⭐ Salvează',
  btn_saved: '⭐ Salvat',
  btn_dismiss: '🚫 Ascunde',
  btn_note: '📝 Notează',
  cb_saved: '⭐ Salvat și urmărit. Te anunț la schimbări de preț și eliminare.',
  cb_unsaved: 'Scos din salvate. Nu mai urmăresc acest anunț.',
  cb_dismissed: 'Anunț ascuns.',
  note_prompt: 'Trimite o notiță pentru acest anunț (sau „-” pentru a o șterge).',
  note_set: 'Notiță salvată.',
  note_cleared: 'Notiță ștearsă.',
  saved_empty: 'Niciun anunț salvat. Apasă ⭐ Salvează în /browse.',
  saved_intro: '⭐ Anunțuri salvate:',
  saved_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  btn_jump: '🔢 Sari la #',
  btn_switch: '🔀 Schimbă',
  btn_browse_all: '📂 Toate anunțurile',
  browse_in_stock: '🟢 disponibil',
  browse_out_of_stock: '🔴 indisponibil',
  price_rating: ({ tag, percentile, n, suspicious }) => {
    if (suspicious) return `⚠️ Prea ieftin — verifică (mult sub ${n} similare)`;
    if (tag === 'great_deal') return `🟢 Ofertă bună — mai ieftin ca ${Math.round((1 - percentile) * 100)}% din ${n} similare`;
    if (tag === 'overpriced') return `🔴 Peste piață — mai scump ca ${Math.round(percentile * 100)}% din ${n} similare`;
    if (tag === 'fair_price') return `🟡 Preț corect — în jurul mediei (${n} similare)`;
    return '';
  },
  fair_value_line: ({ fair, deltaAbs, under }) =>
    `💡 Preț estimat ≈ ${fair} (${deltaAbs} ${under ? 'sub' : 'peste'})`,
  fair_value_under: ({ fair, pct }) => `🔥 ${pct}% sub prețul estimat (≈ ${fair})`,
  browse_position: (n, total) => `articolul ${n} din ${total}`,
  browse_empty: 'Niciun anunț colectat încă. Adaugă o urmărire cu un link, apoi revino.',
  browse_gone: 'Acest anunț nu mai este disponibil.',
  browse_scope_prompt: 'Ce vrei să răsfoiești?',
  browse_jump_prompt: (total) => `Trimite un număr între 1 și ${total} ca să sari la acel anunț.`,
  browse_jump_invalid: (total) => `Trimite un număr între 1 și ${total}.`,

  cb_seller_set: (v) => `Filtru vânzător: ${v}`,
  cb_monitoring_started: 'Monitorizare pornită',
  cb_watch_gone: 'Urmărirea nu mai există.',
  cb_unknown_option: 'Opțiune necunoscută.',
  cb_setting_error: 'Nu am putut actualiza setarea.',
  cb_removed: 'Urmărire ștearsă.',
  cb_freq_set: (m) => `Frecvență: ${m} min`,
  cb_edit_done: 'Modificări salvate.',
  cb_paused: 'Urmărire pusă pe pauză.',
  cb_resumed: 'Urmărire reluată.',
  cb_digest_set: 'Mod rezumat actualizat.',
  cb_report_set: 'Raport săptămânal actualizat.',
  exclusion_prompt: 'Trimite cuvintele de exclus, separate prin virgulă (ex.: lovit, piese, dube).',
  exclusion_set: (kw) => `Exclud: ${kw}`,
  exclusion_cleared: 'Toate cuvintele excluse au fost șterse.',
  required_prompt: 'Trimite cuvintele necesare, separate prin virgulă (anunțul trebuie să conțină cel puțin unul). „-” le șterge.',
  required_set: (kw) => `Necesită: ${kw}`,
  required_cleared: 'Toate cuvintele necesare au fost șterse.',
  target_prompt: 'Trimite prețul țintă (doar numărul, în moneda anunțului). Te anunț când scade până la el. „-” îl șterge.',
  target_set: (price) => `Preț țintă setat: ${price}`,
  target_cleared: 'Prețul țintă a fost șters.',
  target_invalid: 'Trimite un număr valid (ex.: 12000).',
  target_hit_title: '🎯 Preț țintă atins!',
  target_hit_line: (target) => `Țintă: ${target}`,
  became_deal_title: '🔥 A devenit o ofertă bună!',
  price_outlook_falling: '🔮 Prețul va scădea probabil mai mult',
  price_outlook_stable: '🔮 Prețul pare să se stabilizeze',
  insight_line: ({ days, cuts, low }) => {
    const parts: string[] = [];
    if (days !== undefined) parts.push(`📅 listat de ${days}z`);
    if (cuts > 0) parts.push(`📉 ${cuts} reducer${cuts === 1 ? 'e' : 'i'}`);
    if (low) parts.push(`min ${low}`);
    return parts.join(' · ');
  },
  block_prompt: 'Trimite numele vânzătorului sau un număr de telefon de blocat. „-” golește lista.',
  block_added_seller: (name) => `Vânzător blocat: ${name}`,
  block_added_phone: (phone) => `Telefon blocat: ${phone}`,
  block_cleared: 'Lista de vânzători blocați a fost golită.',
  price_history_insufficient: 'Încă nu sunt suficiente date de preț.',
  price_history_error: 'Nu am putut genera istoricul de preț.',

  seller_private: '👤 Vânzător privat',
  seller_company: '🏢 Firmă',
  specs_line: (s) => `📋 ${s}`,
  posted_line: (d) => `🕒 Postat: ${d}`,
  badge_great_deal: '🔥 Chilipir',
  badge_fair_price: '📊 Preț corect',
  badge_overpriced: '📈 Supraevaluat',
  also_on: (s) => `Și pe: ${s}`,
  price_drop: ({ title, oldPrice, newPrice, savings }) =>
    `📉 Scădere de preț la ${title}: ${oldPrice} → ${newPrice} (economisești ${savings})`,
  back_in_stock_title: '🟢 REVENIT ÎN STOC',
  hot_lead_title: '🔥 OFERTĂ FIERBINTE — semnale multiple',
  scam_warn: '⚠️ Posibilă înșelătorie — preț prea mic și semnale slabe de vânzător. Verifică înainte de plată.',
  seller_trust_good: '🟢 Vânzător de încredere (istoric stabil)',
  seller_trust_caution: '🟠 Atenție la vânzător (relistări/reveniri frecvente)',
  digest_intro: ({ count, vendor }) => `📰 Rezumat — ${count} anunțuri noi pe ${vendor}`,
  digest_stats: ({ median, range }) => `Mediană ${median} · interval ${range}`,
  report_title: (vendor) => `📅 Raport săptămânal — ${vendor}`,
  report_inventory: ({ count, delta }) => `Anunțuri urmărite: ${count} (${delta} față de săptămâna trecută)`,
  report_velocity: ({ n }) => `Anunțuri noi săptămâna aceasta: ${n}`,
  report_best: 'Cele mai bune oferte:',
  report_seasonal: ({ month, pct }) => `🗓 Cel mai ieftin în jur de ${month} (~${pct}% sub medie)`,

  access_denied:
    'Nu ai acces la acest bot. Folosește /request_access ca să ceri accesul.',
  access_request_intro: 'Hai să cerem acces. ',
  access_ask_name: 'Cum te numești? (nume și prenume)',
  access_ask_email: 'Care este adresa ta de email?',
  access_email_invalid: 'Adresa de email nu pare validă. Te rog trimite o adresă corectă.',
  access_request_sent:
    '✅ Cererea ta a fost trimisă. Te anunț când un administrator decide.',
  access_request_pending: 'Ai deja o cerere în așteptare. Te anunț când se decide.',
  access_granted_user: '🎉 Ai primit acces! Trimite-mi un link de anunț ca să începi.',
  access_denied_user:
    '⛔ Cererea ta de acces a fost respinsă. Poți cere din nou peste 7 zile.',
  access_first_admin:
    '👑 Ai acces și ești administrator (primul utilizator). Poți gestiona accesul cu /users, /allow, /deny.',
  access_request_too_soon: (days) =>
    `Cererea ta a fost respinsă recent. Poți cere din nou peste ${days} zi${days === 1 ? '' : 'le'}.`,
  access_admin_new_request: ({ id, name, email }) =>
    `🔔 Cerere de acces nouă:\n${name} · ${email}\nchat id: ${id}`,
  access_admin_only: 'Comandă disponibilă doar administratorilor.',
  access_allow_usage: 'Folosire: /allow <chat_id>',
  access_deny_usage: 'Folosire: /deny <chat_id>',
  access_allow_done: ({ id, name }) => `✅ Acces acordat pentru ${name || id} (${id}).`,
  access_deny_done: ({ id, name }) => `⛔ Acces respins pentru ${name || id} (${id}).`,
  access_user_not_found: 'Nu există niciun utilizator cu acest chat id.',
  access_users_intro: 'Utilizatori:',
  access_users_item: ({ id, status, isAdmin, name, email }) =>
    `${id} · ${status}${isAdmin ? ' · admin' : ''} · ${name || '—'} · ${email || '—'}`,
  access_users_empty: 'Niciun utilizator înregistrat încă.',
  access_userinfo_usage: 'Folosire: /userinfo <chat_id>',
  access_userinfo: ({ id, status, isAdmin, name, email }) =>
    `Utilizator ${id}\nstatus: ${status}${isAdmin ? ' (admin)' : ''}\nnume: ${name || '—'}\nemail: ${email || '—'}`,
  access_setname_usage: 'Folosire: /setname <chat_id> <nume>',
  access_setemail_usage: 'Folosire: /setemail <chat_id> <email>',
  access_setname_prompt: ({ id }) => `Trimite numele pentru utilizatorul ${id}.`,
  access_setemail_prompt: ({ id }) => `Trimite emailul pentru utilizatorul ${id}.`,
  access_setname_done: ({ id, name }) => `✅ Nume actualizat pentru ${id}: ${name}`,
  access_setemail_done: ({ id, email }) => `✅ Email actualizat pentru ${id}: ${email}`,
  access_promote_usage: 'Folosire: /promote <chat_id>',
  access_demote_usage: 'Folosire: /demote <chat_id>',
  access_promote_done: ({ id }) => `👑 ${id} este acum administrator.`,
  access_demote_done: ({ id }) => `${id} nu mai este administrator.`,
  access_demote_last_admin: 'Nu poți retrage ultimul administrator.',
  access_promoted_user: '👑 Ai fost făcut administrator. Poți gestiona accesul cu /users.',
  access_demoted_user: 'Drepturile tale de administrator au fost retrase.',
  btn_allow: '✅ Permite',
  btn_deny: '⛔ Respinge',
  cb_allow_done: ({ id }) => `Acces acordat pentru ${id}.`,
  cb_deny_done: ({ id }) => `Acces respins pentru ${id}.`,
  confirm_remove: (id) => `Sigur oprești urmărirea #${id}? Acțiunea nu poate fi anulată.`,
  confirm_deny: ({ id, name }) => `Sigur respingi accesul pentru ${name || id} (${id})?`,
  confirm_demote: (id) => `Sigur retragi drepturile de administrator pentru ${id}?`,
  btn_confirm: '✅ Da, confirm',
  btn_cancel: '✖️ Anulează',
  cb_cancelled: 'Anulat.',
  audit_intro: 'Jurnal de acces (recente):',
  audit_empty: 'Nicio decizie de acces înregistrată încă.',
  audit_item: ({ action, targetId, actorId, at }) =>
    `${at} · ${action} · țintă ${targetId} · de către ${actorId}`,
  backup_caption: 'Copie de rezervă agor',
  backup_failed: 'Copierea de rezervă a eșuat.',
  restore_usage: 'Folosire: /restore <cale-fișier> (se aplică la repornire).',
  restore_invalid: 'Fișierul nu este o copie de rezervă agor validă.',
  restore_staged: 'Copie pregătită. Repornește botul pentru a o aplica.',
};

const en: Catalog = {
  start_welcome:
    'Welcome to agor! 👋\n\n' +
    'Send me a marketplace search or product link (OLX, AutoVit, Storia…) ' +
    'and I will watch it for new listings, price drops and stock changes.\n\n' +
    'Type /help for the full command list.',
  help_body:
    'How to use agor:\n\n' +
    '• Send any http(s) listing link, or use /track <url>, to start a watch.\n' +
    '• After registering, tune the seller type, frequency and exclusion keywords, then tap “Start”.\n' +
    '• /list — show every watch in this chat.\n' +
    '• /browse — browse collected listings; tap “📌 Track” to watch an item.\n' +
    '• /edit <id> — change a watch’s frequency, seller filter or exclusion keywords.\n' +
    '• /stats — summary of your watches · /export — collected listings as CSV.\n' +
    '• /rate <url> — rate a listing’s price without tracking it.\n' +
    '• /history <id> — price chart for a watch.\n' +
    '• /cheaper <id> — cheaper equivalents for a tracked product.\n' +
    '• Forward a listing message to track it automatically.\n' +
    '• /remove <id> — stop a watch.\n' +
    '• /lang ro|en|de|fr|it|es — change language.\n' +
    '• Tap “Price history” on any alert for a chart.',
  track_usage: 'Usage: /track <url>',
  home_watches: '📋 Watches',
  home_browse: '🔎 Browse',
  home_saved: '⭐ Saved',
  home_stats: '📊 Stats',
  home_lang: '🌐 Language',
  home_help: '❓ Help',
  home_access: '🔓 Request access',
  track_error: 'Sorry — I could not register that watch. Please try again.',
  list_empty: 'No watches yet. Send a listing link to create one.',
  list_intro: 'Your watches:',
  list_item: ({ id, vendor, type, seller, url, exclusions, tracked, label, paused, required, blocked }) =>
    `#${id} · ${tracked ? '📌 ' : ''}${paused ? '⏸ ' : ''}${label ? `“${label}” (${vendor})` : vendor} · ${type}` +
    // Seller filter, deals-only & keyword filters only apply to search watches; a
    // product watch tracks one listing, so they'd be meaningless noise.
    (type === 'search' ? ` · seller=${seller}` : '') +
    (type === 'search' && required ? ` · requires: ${required}` : '') +
    (type === 'search' && exclusions ? ` · excluded: ${exclusions}` : '') +
    (type === 'search' && blocked > 0 ? ` · blocked: ${blocked}` : '') +
    `\n${url}`,
  remove_usage: 'Usage: /remove <id>',
  remove_done: (id) => `Watch #${id} stopped.`,
  remove_not_found: 'That watch does not exist or is not yours.',
  stats_summary: ({ watches, search, product, paused, tracked, items, vendors }) =>
    `📊 Summary\n` +
    `• Watches: ${watches} (${search} searches, ${product} products)\n` +
    `• Tracked (📌): ${tracked} · paused (⏸): ${paused}\n` +
    `• Listings collected: ${items}\n` +
    (vendors ? `• Sites: ${vendors}` : ''),
  export_caption: (rows) => `📄 Exported ${rows} listing${rows === 1 ? '' : 's'}.`,
  export_empty: 'Nothing to export yet.',
  rate_usage: 'Usage: /rate <url>',
  rate_unsupported: 'Unsupported site or invalid link.',
  rate_failed: 'Could not read that listing (site blocked or down).',
  rate_no_comps: 'Not enough similar listings collected yet to rate it.',
  rate_result: ({ title, price }) => `🏷️ ${title}\n💰 ${price}`,
  history_usage: 'Usage: /history <id>',
  history_not_found: 'That watch does not exist, is not yours, or has no price history.',
  history_summary: ({ title, first, last, low, cuts, points, days }) =>
    `📈 ${title}\nFrom ${first} → now ${last}\nLow ${low} · ${cuts} cut${cuts === 1 ? '' : 's'} · ${points} points · ${days}d`,
  cheaper_usage: 'Usage: /cheaper <id> (id of a product watch)',
  cheaper_not_found: 'That watch does not exist, is not yours, or has no listing yet.',
  cheaper_none: 'No cheaper equivalents in your collected listings.',
  cheaper_intro: (title) => `🔎 Cheaper, similar to “${title}”:`,
  cheaper_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  edit_usage: 'Usage: /edit <id>',
  edit_not_found: 'That watch does not exist or is not yours.',
  rename_prompt: 'Send a name for this watch (or “-” to clear it).',
  rename_done: (label) => `Label set: “${label}”.`,
  rename_cleared: 'Label cleared.',
  btn_group: '📁 Group',
  btn_group_new: '➕ New group',
  btn_group_clear: '✖️ Remove from group',
  group_prompt: 'Send the group name for this watch (or "-" to remove it).',
  group_set: (name) => `Group set: "${name}".`,
  group_cleared: 'Group removed.',
  group_usage: 'Usage: /group <pause|resume|remove> <name>',
  group_done: ({ count }) => `${count} watches updated.`,
  edit_card: ({ id, vendor, type, minutes, label, paused }) =>
    `✏️ Editing watch #${id} · ${label ? `“${label}” (${vendor})` : vendor} · ${type}${paused ? ' · ⏸ paused' : ''}\n` +
    `Checks every ${minutes} min. Adjust below:`,
  lang_current: (n) => `Current language: ${n}. Change with /lang ro|en|de|fr|it|es.`,
  lang_set: (n) => `Language set to ${n}.`,
  lang_usage: 'Usage: /lang ro|en|de|fr|it|es',
  lang_name: 'English',
  lang_pick_intro: '🌐 Choose your language:',
  admin_selector_healed: ({ vendor, from, to }) =>
    `⚠️ Self-healed selector for ${vendor}.\nThe pinned selector "${from}" stopped matching; relocated to "${to}".\nUpdate the manifest to make this permanent.`,
  share_prompt: 'Send the chat id to share this watch with (use /chatid in the other chat to get it). “-” cancels.',
  share_added: ({ chatId, count }) => `Shared with ${chatId}. This watch now also alerts ${count} extra chat(s).`,
  share_removed: ({ count }) => `Stopped. This watch is now shared with ${count} chat(s).`,
  share_none: 'This watch isn’t shared with any chat.',
  share_invalid: 'Send a valid chat id (a number, e.g. -1001234567890).',
  unshare_prompt: ({ list }) => `Send the chat id to stop sharing with. Currently: ${list}. “-” cancels.`,
  chat_id_line: (id) => `This chat’s id: ${id}`,
  unknown_command: 'Unknown command. Try /help.',
  send_link_hint: 'Send me a listing link to watch, or /help.',
  generic_error: 'Sorry — something went wrong. Please try again.',
  check_usage: 'Usage: /check <id>',
  check_ok: ({ items, new: n }) =>
    `✅ Checked: ${items} listing${items === 1 ? '' : 's'} found, ${n} new.`,
  check_failed: '⚠️ Check failed — the site did not respond or appears blocked.',
  check_not_found: 'That watch does not exist or is not yours.',
  quota_reached: (limit) =>
    `You've reached the limit of ${limit} watches. Remove one (/remove <id>) before adding another.`,
  check_rate_limited: 'Too fast — wait a few seconds before checking again.',
  url_rate_limited: 'Too fast — wait a few seconds before adding another link.',
  watch_failing: (h) =>
    `⚠️ Watch #${h.monitorId} (${h.vendor}) looks blocked or is finding nothing (${h.consecutiveFailures} failed checks in a row). I'll tell you when it recovers.`,
  watch_recovered: (h) => `✅ Watch #${h.monitorId} (${h.vendor}) is working again.`,
  price_change: ({ title, oldPrice, newPrice, direction }) =>
    `${direction === 'down' ? '📉' : '📈'} Price changed on ${title}: ${oldPrice} → ${newPrice}`,
  delisted_title: '🗑️ Listing removed',
  delisted_reason_product_gone: 'The listing page no longer exists (it was deleted).',
  delisted_reason_search_dropped: 'The listing dropped out of the tracked results.',
  delisted_last_price: (price) => `Last seen price: ${price}`,
  listings_dropped_title: (count, vendor) =>
    `🗑️ ${count} ${count === 1 ? 'listing dropped' : 'listings dropped'} off ${vendor}`,
  re_listed_title: '♻️ Listing reappeared',
  delisted_card_title: '🔻 Listing removed 🔻',

  reg_watching: (v) => `✅ Watching ${v}`,
  reg_baseline: (c) => `📦 Baseline: ${c} listing${c === 1 ? '' : 's'} recorded.`,
  reg_tune_prompt: 'Tune the watch, then start monitoring:',

  btn_private: '👤 Private',
  btn_company: '🏢 Company',
  btn_both: '👥 Both',
  btn_exclusion: '🚫 Exclusion keywords',
  btn_start: '▶️ Start',
  btn_done: '✅ Done',
  btn_remove: '🗑 Remove',
  btn_digest: '📰 Digest',
  btn_report: '📅 Weekly report',
  btn_required: '✅ Required words',
  btn_block: '⛔ Block seller',
  btn_rename: '✏️ Rename',
  btn_pause: '⏸ Pause',
  btn_resume: '▶️ Resume',
  btn_edit: '✏️ Edit',
  btn_target: '🎯 Target price',
  btn_type: '✏️ Type',
  picker_choose_watch: 'Which watch?',
  picker_choose_user: 'Which user?',
  picker_block_prompt: 'Block which seller? (tap; tap again to unblock)',
  picker_exclude_prompt: 'Exclude which words? (tap; tap again to remove)',
  picker_require_prompt: 'Require which words? (tap; tap again to remove)',
  btn_open: '🔗 Open',
  btn_call: '📞 Call',
  btn_price_history: '📊 Price history',
  btn_freq: (m) => m < 60 ? `⏱ ${m}m` : `⏱ ${m / 60}h`,
  btn_interval: (current) => `⏱ Check interval: ${current}`,
  btn_seller_menu: (current) => `👤 Seller: ${current}`,
  btn_reports_menu: '📊 Reports',
  reports_menu_intro: '📊 Reports\n\n• Digest — instead of individual alerts, get all new listings bundled once a day or week.\n• Weekly report — market summary: listing count, average price and trend over the past week.',
  btn_prev: '◀️ Prev',
  btn_next: 'Next ▶️',
  btn_save: '⭐ Save',
  btn_saved: '⭐ Saved',
  btn_dismiss: '🚫 Dismiss',
  btn_note: '📝 Note',
  cb_saved: '⭐ Saved & tracking. Alerts on price changes and de-listing.',
  cb_unsaved: 'Removed from saved. No longer tracking this item.',
  cb_dismissed: 'Listing hidden.',
  note_prompt: 'Send a note for this listing (or "-" to clear).',
  note_set: 'Note saved.',
  note_cleared: 'Note cleared.',
  saved_empty: 'Nothing saved yet. Tap ⭐ Save in /browse.',
  saved_intro: '⭐ Saved listings:',
  saved_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  btn_jump: '🔢 Jump to #',
  btn_switch: '🔀 Switch',
  btn_browse_all: '📂 All listings',
  browse_in_stock: '🟢 available',
  browse_out_of_stock: '🔴 unavailable',
  price_rating: ({ tag, percentile, n, suspicious }) => {
    if (suspicious) return `⚠️ Too cheap — verify (far below ${n} similar)`;
    if (tag === 'great_deal') return `🟢 Great deal — cheaper than ${Math.round((1 - percentile) * 100)}% of ${n} similar`;
    if (tag === 'overpriced') return `🔴 Above market — pricier than ${Math.round(percentile * 100)}% of ${n} similar`;
    if (tag === 'fair_price') return `🟡 Fair price — around the going rate (${n} similar)`;
    return '';
  },
  fair_value_line: ({ fair, deltaAbs, under }) =>
    `💡 Est. fair ≈ ${fair} (${deltaAbs} ${under ? 'under' : 'over'})`,
  fair_value_under: ({ fair, pct }) => `🔥 ${pct}% under predicted (≈ ${fair})`,
  browse_position: (n, total) => `item ${n} of ${total}`,
  browse_empty: 'No items collected yet. Add a watch with a link, then come back.',
  browse_gone: 'This item is no longer available.',
  browse_scope_prompt: 'What would you like to browse?',
  browse_jump_prompt: (total) => `Send a number from 1 to ${total} to jump to that item.`,
  browse_jump_invalid: (total) => `Please send a number from 1 to ${total}.`,

  cb_seller_set: (v) => `Seller filter: ${v}`,
  cb_monitoring_started: 'Monitoring started',
  cb_watch_gone: 'That watch no longer exists.',
  cb_unknown_option: 'Unknown option.',
  cb_setting_error: 'Could not update that setting.',
  cb_removed: 'Watch removed.',
  cb_freq_set: (m) => `Frequency: ${m} min`,
  cb_edit_done: 'Changes saved.',
  cb_paused: 'Watch paused.',
  cb_resumed: 'Watch resumed.',
  cb_digest_set: 'Digest mode updated.',
  cb_report_set: 'Weekly report updated.',
  exclusion_prompt: 'Send a comma-separated list of keywords to exclude (e.g. damaged, parts, salvage).',
  exclusion_set: (kw) => `Excluding: ${kw}`,
  exclusion_cleared: 'Cleared all exclusion keywords.',
  required_prompt: 'Send comma-separated required keywords (a listing must contain at least one). “-” clears them.',
  required_set: (kw) => `Requiring: ${kw}`,
  required_cleared: 'Cleared all required keywords.',
  target_prompt: 'Send the target price (number only, in the listing’s currency). I’ll alert when it drops to it. “-” clears it.',
  target_set: (price) => `Target price set: ${price}`,
  target_cleared: 'Target price cleared.',
  target_invalid: 'Send a valid number (e.g. 12000).',
  target_hit_title: '🎯 Target price reached!',
  target_hit_line: (target) => `Target: ${target}`,
  became_deal_title: '🔥 Just became a great deal!',
  price_outlook_falling: '🔮 Price will likely drop further',
  price_outlook_stable: '🔮 Price looks to be stabilizing',
  insight_line: ({ days, cuts, low }) => {
    const parts: string[] = [];
    if (days !== undefined) parts.push(`📅 listed ${days}d`);
    if (cuts > 0) parts.push(`📉 ${cuts} cut${cuts === 1 ? '' : 's'}`);
    if (low) parts.push(`low ${low}`);
    return parts.join(' · ');
  },
  block_prompt: 'Send a seller name or a phone number to block. “-” empties the list.',
  block_added_seller: (name) => `Blocked seller: ${name}`,
  block_added_phone: (phone) => `Blocked phone: ${phone}`,
  block_cleared: 'Blocked-sellers list emptied.',
  price_history_insufficient: 'Not enough price history yet.',
  price_history_error: 'Could not render the price history.',

  seller_private: '👤 Private seller',
  seller_company: '🏢 Company',
  specs_line: (s) => `📋 ${s}`,
  posted_line: (d) => `🕒 Posted: ${d}`,
  badge_great_deal: '🔥 Great Deal',
  badge_fair_price: '📊 Fair Market Price',
  badge_overpriced: '📈 Overpriced',
  also_on: (s) => `Also on: ${s}`,
  price_drop: ({ title, oldPrice, newPrice, savings }) =>
    `📉 Price drop on ${title}: ${oldPrice} → ${newPrice} (save ${savings})`,
  back_in_stock_title: '🟢 BACK IN STOCK',
  hot_lead_title: '🔥 HOT LEAD — multiple signals',
  scam_warn: '⚠️ Possible scam — too cheap with weak seller signals. Verify before paying.',
  seller_trust_good: '🟢 Trusted seller (stable history)',
  seller_trust_caution: '🟠 Seller caution (frequent relisting/churn)',
  digest_intro: ({ count, vendor }) => `📰 Digest — ${count} new listings on ${vendor}`,
  digest_stats: ({ median, range }) => `Median ${median} · range ${range}`,
  report_title: (vendor) => `📅 Weekly report — ${vendor}`,
  report_inventory: ({ count, delta }) => `Listings tracked: ${count} (${delta} vs last week)`,
  report_velocity: ({ n }) => `New this week: ${n}`,
  report_best: 'Best deals:',
  report_seasonal: ({ month, pct }) => `🗓 Cheapest around ${month} (~${pct}% below average)`,

  access_denied: 'You do not have access to this bot. Use /request_access to ask for it.',
  access_request_intro: "Let's request access. ",
  access_ask_name: 'What is your name? (first and last)',
  access_ask_email: 'What is your email address?',
  access_email_invalid: 'That email does not look valid. Please send a correct address.',
  access_request_sent: '✅ Your request was sent. I will let you know when an admin decides.',
  access_request_pending: 'You already have a pending request. I will let you know when it is decided.',
  access_granted_user: '🎉 You have been granted access! Send me a listing link to begin.',
  access_denied_user: '⛔ Your access request was declined. You can request again in 7 days.',
  access_first_admin:
    '👑 You are in, and you are the admin (first user). Manage access with /users, /allow, /deny.',
  access_request_too_soon: (days) =>
    `Your request was declined recently. You can request again in ${days} day${days === 1 ? '' : 's'}.`,
  access_admin_new_request: ({ id, name, email }) =>
    `🔔 New access request:\n${name} · ${email}\nchat id: ${id}`,
  access_admin_only: 'That command is available to admins only.',
  access_allow_usage: 'Usage: /allow <chat_id>',
  access_deny_usage: 'Usage: /deny <chat_id>',
  access_allow_done: ({ id, name }) => `✅ Access granted for ${name || id} (${id}).`,
  access_deny_done: ({ id, name }) => `⛔ Access declined for ${name || id} (${id}).`,
  access_user_not_found: 'No user with that chat id.',
  access_users_intro: 'Users:',
  access_users_item: ({ id, status, isAdmin, name, email }) =>
    `${id} · ${status}${isAdmin ? ' · admin' : ''} · ${name || '—'} · ${email || '—'}`,
  access_users_empty: 'No users recorded yet.',
  access_userinfo_usage: 'Usage: /userinfo <chat_id>',
  access_userinfo: ({ id, status, isAdmin, name, email }) =>
    `User ${id}\nstatus: ${status}${isAdmin ? ' (admin)' : ''}\nname: ${name || '—'}\nemail: ${email || '—'}`,
  access_setname_usage: 'Usage: /setname <chat_id> <name>',
  access_setemail_usage: 'Usage: /setemail <chat_id> <email>',
  access_setname_prompt: ({ id }) => `Send the name for user ${id}.`,
  access_setemail_prompt: ({ id }) => `Send the email for user ${id}.`,
  access_setname_done: ({ id, name }) => `✅ Name updated for ${id}: ${name}`,
  access_setemail_done: ({ id, email }) => `✅ Email updated for ${id}: ${email}`,
  access_promote_usage: 'Usage: /promote <chat_id>',
  access_demote_usage: 'Usage: /demote <chat_id>',
  access_promote_done: ({ id }) => `👑 ${id} is now an admin.`,
  access_demote_done: ({ id }) => `${id} is no longer an admin.`,
  access_demote_last_admin: 'You cannot remove the last admin.',
  access_promoted_user: '👑 You have been made an admin. Manage access with /users.',
  access_demoted_user: 'Your admin rights have been removed.',
  btn_allow: '✅ Allow',
  btn_deny: '⛔ Deny',
  cb_allow_done: ({ id }) => `Access granted for ${id}.`,
  cb_deny_done: ({ id }) => `Access declined for ${id}.`,
  confirm_remove: (id) => `Stop watch #${id}? This can't be undone.`,
  confirm_deny: ({ id, name }) => `Decline access for ${name || id} (${id})?`,
  confirm_demote: (id) => `Remove admin rights from ${id}?`,
  btn_confirm: '✅ Yes, confirm',
  btn_cancel: '✖️ Cancel',
  cb_cancelled: 'Cancelled.',
  audit_intro: 'Access log (recent):',
  audit_empty: 'No access decisions recorded yet.',
  audit_item: ({ action, targetId, actorId, at }) =>
    `${at} · ${action} · target ${targetId} · by ${actorId}`,
  backup_caption: 'agor backup',
  backup_failed: 'Backup failed.',
  restore_usage: 'Usage: /restore <file-path> (applied on restart).',
  restore_invalid: 'That file is not a valid agor backup.',
  restore_staged: 'Backup staged. Restart the bot to apply it.',
};

const de: Catalog = {
  start_welcome:
    'Willkommen bei agor! 👋\n\n' +
    'Schicke mir einen Marktplatz-Such- oder Produktlink (OLX, AutoVit, Storia…) ' +
    'und ich beobachte ihn auf neue Anzeigen, Preissenkungen und Bestandsänderungen.\n\n' +
    'Tippe /help für die vollständige Befehlsliste.',
  help_body:
    'So benutzt du agor:\n\n' +
    '• Schicke einen beliebigen http(s)-Anzeigenlink oder nutze /track <url>, um eine Beobachtung zu starten.\n' +
    '• Nach dem Registrieren kannst du Verkäufertyp, Häufigkeit und Ausschluss-Stichwörter einstellen und dann auf „Start“ tippen.\n' +
    '• /list — alle Beobachtungen in diesem Chat anzeigen.\n' +
    '• /browse — gesammelte Anzeigen durchstöbern; tippe „📌 Verfolgen“, um eine Anzeige zu beobachten.\n' +
    '• /edit <id> — Häufigkeit, Verkäuferfilter oder Ausschluss-Stichwörter einer Beobachtung ändern.\n' +
    '• /stats — Übersicht deiner Beobachtungen · /export — gesammelte Anzeigen als CSV.\n' +
    '• /rate <url> — den Preis einer Anzeige bewerten, ohne sie zu verfolgen.\n' +
    '• /history <id> — Preisdiagramm für eine Beobachtung.\n' +
    '• /cheaper <id> — günstigere Alternativen für ein verfolgtes Produkt.\n' +
    '• Leite eine Anzeigen-Nachricht weiter, um sie automatisch zu verfolgen.\n' +
    '• /remove <id> — eine Beobachtung stoppen.\n' +
    '• /lang ro|en|de|fr|it|es — Sprache ändern.\n' +
    '• Tippe bei jeder Benachrichtigung auf „Preisverlauf“ für ein Diagramm.',
  track_usage: 'Verwendung: /track <url>',
  home_watches: '📋 Beobachtungen',
  home_browse: '🔎 Stöbern',
  home_saved: '⭐ Gemerkt',
  home_stats: '📊 Statistik',
  home_lang: '🌐 Sprache',
  home_help: '❓ Hilfe',
  home_access: '🔓 Zugang anfragen',
  track_error: 'Entschuldigung — diese Beobachtung konnte nicht registriert werden. Bitte versuche es erneut.',
  list_empty: 'Noch keine Beobachtungen. Schicke einen Anzeigenlink, um eine zu erstellen.',
  list_intro: 'Deine Beobachtungen:',
  list_item: ({ id, vendor, type, seller, url, exclusions, tracked, label, paused, required, blocked }) =>
    `#${id} · ${tracked ? '📌 ' : ''}${paused ? '⏸ ' : ''}${label ? `„${label}“ (${vendor})` : vendor} · ${type}` +
    (type === 'search' ? ` · Verkäufer=${seller}` : '') +
    (type === 'search' && required ? ` · erfordert: ${required}` : '') +
    (type === 'search' && exclusions ? ` · ausgeschlossen: ${exclusions}` : '') +
    (type === 'search' && blocked > 0 ? ` · blockiert: ${blocked}` : '') +
    `\n${url}`,
  remove_usage: 'Verwendung: /remove <id>',
  remove_done: (id) => `Beobachtung #${id} gestoppt.`,
  remove_not_found: 'Diese Beobachtung existiert nicht oder gehört dir nicht.',
  stats_summary: ({ watches, search, product, paused, tracked, items, vendors }) =>
    `📊 Übersicht\n` +
    `• Beobachtungen: ${watches} (${search} Suchen, ${product} Produkte)\n` +
    `• Verfolgt (📌): ${tracked} · pausiert (⏸): ${paused}\n` +
    `• Gesammelte Anzeigen: ${items}\n` +
    (vendors ? `• Seiten: ${vendors}` : ''),
  export_caption: (rows) => `📄 ${rows} Anzeige${rows === 1 ? '' : 'n'} exportiert.`,
  export_empty: 'Noch nichts zum Exportieren.',
  rate_usage: 'Verwendung: /rate <url>',
  rate_unsupported: 'Nicht unterstützte Seite oder ungültiger Link.',
  rate_failed: 'Diese Anzeige konnte nicht gelesen werden (Seite blockiert oder nicht erreichbar).',
  rate_no_comps: 'Noch nicht genügend ähnliche Anzeigen gesammelt, um sie zu bewerten.',
  rate_result: ({ title, price }) => `🏷️ ${title}\n💰 ${price}`,
  history_usage: 'Verwendung: /history <id>',
  history_not_found: 'Diese Beobachtung existiert nicht, gehört dir nicht oder hat keinen Preisverlauf.',
  history_summary: ({ title, first, last, low, cuts, points, days }) =>
    `📈 ${title}\nVon ${first} → jetzt ${last}\nTief ${low} · ${cuts} Senkung${cuts === 1 ? '' : 'en'} · ${points} Punkte · ${days}T`,
  cheaper_usage: 'Verwendung: /cheaper <id> (id einer Produktbeobachtung)',
  cheaper_not_found: 'Diese Beobachtung existiert nicht, gehört dir nicht oder hat noch keine Anzeige.',
  cheaper_none: 'Keine günstigeren Alternativen in deinen gesammelten Anzeigen.',
  cheaper_intro: (title) => `🔎 Günstiger, ähnlich wie „${title}“:`,
  cheaper_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  edit_usage: 'Verwendung: /edit <id>',
  edit_not_found: 'Diese Beobachtung existiert nicht oder gehört dir nicht.',
  rename_prompt: 'Schicke einen Namen für diese Beobachtung (oder „-“ zum Löschen).',
  rename_done: (label) => `Bezeichnung gesetzt: „${label}“.`,
  rename_cleared: 'Bezeichnung gelöscht.',
  btn_group: '📁 Gruppe',
  btn_group_new: '➕ Neue Gruppe',
  btn_group_clear: '✖️ Aus Gruppe entfernen',
  group_prompt: 'Schicke den Gruppennamen für diese Beobachtung (oder „-“ zum Entfernen).',
  group_set: (name) => `Gruppe gesetzt: „${name}“.`,
  group_cleared: 'Gruppe entfernt.',
  group_usage: 'Verwendung: /group <pause|resume|remove> <Name>',
  group_done: ({ count }) => `${count} Beobachtungen aktualisiert.`,
  edit_card: ({ id, vendor, type, minutes, label, paused }) =>
    `✏️ Beobachtung #${id} bearbeiten · ${label ? `„${label}“ (${vendor})` : vendor} · ${type}${paused ? ' · ⏸ pausiert' : ''}\n` +
    `Prüft alle ${minutes} Min. Unten anpassen:`,
  lang_current: (n) => `Aktuelle Sprache: ${n}. Ändern mit /lang ro|en|de|fr|it|es.`,
  lang_set: (n) => `Sprache auf ${n} gesetzt.`,
  lang_usage: 'Verwendung: /lang ro|en|de|fr|it|es',
  lang_name: 'Deutsch',
  lang_pick_intro: '🌐 Sprache wählen:',
  admin_selector_healed: ({ vendor, from, to }) =>
    `⚠️ Selbstreparierter Selektor für ${vendor}.\nDer fixierte Selektor „${from}“ passte nicht mehr; verlegt auf „${to}“.\nManifest aktualisieren, damit es dauerhaft wird.`,
  share_prompt: 'Schicke die Chat-ID, mit der diese Beobachtung geteilt werden soll (nutze /chatid im anderen Chat, um sie zu erhalten). „-“ bricht ab.',
  share_added: ({ chatId, count }) => `Geteilt mit ${chatId}. Diese Beobachtung benachrichtigt jetzt auch ${count} weitere(n) Chat(s).`,
  share_removed: ({ count }) => `Gestoppt. Diese Beobachtung ist jetzt mit ${count} Chat(s) geteilt.`,
  share_none: 'Diese Beobachtung ist mit keinem Chat geteilt.',
  share_invalid: 'Schicke eine gültige Chat-ID (eine Zahl, z. B. -1001234567890).',
  unshare_prompt: ({ list }) => `Schicke die Chat-ID, mit der nicht mehr geteilt werden soll. Aktuell: ${list}. „-“ bricht ab.`,
  chat_id_line: (id) => `ID dieses Chats: ${id}`,
  unknown_command: 'Unbekannter Befehl. Versuche /help.',
  send_link_hint: 'Schicke mir einen Anzeigenlink zum Beobachten oder /help.',
  generic_error: 'Entschuldigung — etwas ist schiefgelaufen. Bitte versuche es erneut.',
  check_usage: 'Verwendung: /check <id>',
  check_ok: ({ items, new: n }) =>
    `✅ Geprüft: ${items} Anzeige${items === 1 ? '' : 'n'} gefunden, ${n} neu.`,
  check_failed: '⚠️ Prüfung fehlgeschlagen — die Seite hat nicht geantwortet oder scheint blockiert.',
  check_not_found: 'Diese Beobachtung existiert nicht oder gehört dir nicht.',
  quota_reached: (limit) =>
    `Du hast das Limit von ${limit} Beobachtungen erreicht. Entferne eine (/remove <id>), bevor du eine weitere hinzufügst.`,
  check_rate_limited: 'Zu schnell — warte ein paar Sekunden, bevor du erneut prüfst.',
  url_rate_limited: 'Zu schnell — warte ein paar Sekunden, bevor du einen weiteren Link hinzufügst.',
  watch_failing: (h) =>
    `⚠️ Beobachtung #${h.monitorId} (${h.vendor}) scheint blockiert oder findet nichts (${h.consecutiveFailures} fehlgeschlagene Prüfungen in Folge). Ich melde mich, wenn sie sich erholt.`,
  watch_recovered: (h) => `✅ Beobachtung #${h.monitorId} (${h.vendor}) funktioniert wieder.`,
  price_change: ({ title, oldPrice, newPrice, direction }) =>
    `${direction === 'down' ? '📉' : '📈'} Preis geändert bei ${title}: ${oldPrice} → ${newPrice}`,
  delisted_title: '🗑️ Anzeige entfernt',
  delisted_reason_product_gone: 'Die Anzeigenseite existiert nicht mehr (sie wurde gelöscht).',
  delisted_reason_search_dropped: 'Die Anzeige ist aus den verfolgten Ergebnissen verschwunden.',
  delisted_last_price: (price) => `Zuletzt gesehener Preis: ${price}`,
  listings_dropped_title: (count, vendor) =>
    `🗑️ ${count} ${count === 1 ? 'Anzeige entfernt' : 'Anzeigen entfernt'} bei ${vendor}`,
  re_listed_title: '♻️ Anzeige wieder da',
  delisted_card_title: '🔻 Anzeige entfernt 🔻',

  reg_watching: (v) => `✅ Beobachte ${v}`,
  reg_baseline: (c) => `📦 Ausgangsbestand: ${c} Anzeige${c === 1 ? '' : 'n'} erfasst.`,
  reg_tune_prompt: 'Stelle die Beobachtung ein und starte dann die Überwachung:',

  btn_private: '👤 Privat',
  btn_company: '🏢 Gewerblich',
  btn_both: '👥 Beide',
  btn_exclusion: '🚫 Ausschluss-Stichwörter',
  btn_start: '▶️ Start',
  btn_done: '✅ Fertig',
  btn_remove: '🗑 Entfernen',
  btn_digest: '📰 Zusammenfassung',
  btn_report: '📅 Wochenbericht',
  btn_required: '✅ Pflichtwörter',
  btn_block: '⛔ Verkäufer blockieren',
  btn_rename: '✏️ Umbenennen',
  btn_pause: '⏸ Pausieren',
  btn_resume: '▶️ Fortsetzen',
  btn_edit: '✏️ Bearbeiten',
  btn_target: '🎯 Zielpreis',
  btn_type: '✏️ Typ',
  picker_choose_watch: 'Welche Beobachtung?',
  picker_choose_user: 'Welcher Nutzer?',
  picker_block_prompt: 'Welchen Verkäufer blockieren? (tippen; erneut tippen zum Entsperren)',
  picker_exclude_prompt: 'Welche Wörter ausschließen? (tippen; erneut tippen zum Entfernen)',
  picker_require_prompt: 'Welche Wörter erfordern? (tippen; erneut tippen zum Entfernen)',
  btn_open: '🔗 Öffnen',
  btn_call: '📞 Anrufen',
  btn_price_history: '📊 Preisverlauf',
  btn_freq: (m) => m < 60 ? `⏱ ${m}m` : `⏱ ${m / 60}h`,
  btn_interval: (current) => `⏱ Prüfintervall: ${current}`,
  btn_seller_menu: (current) => `👤 Verkäufer: ${current}`,
  btn_reports_menu: '📊 Berichte',
  reports_menu_intro: '📊 Berichte\n\n• Zusammenfassung — statt einzelner Benachrichtigungen alle neuen Anzeigen einmal täglich oder wöchentlich gebündelt.\n• Wochenbericht — Marktüberblick: Anzahl der Anzeigen, Durchschnittspreis und Trend der letzten Woche.',
  btn_prev: '◀️ Zurück',
  btn_next: 'Weiter ▶️',
  btn_save: '⭐ Merken',
  btn_saved: '⭐ Gemerkt',
  btn_dismiss: '🚫 Verwerfen',
  btn_note: '📝 Notiz',
  cb_saved: '⭐ Gemerkt & verfolgt. Hinweise bei Preisänderungen und Entfernung.',
  cb_unsaved: 'Aus Merkliste entfernt. Verfolge diese Anzeige nicht mehr.',
  cb_dismissed: 'Anzeige ausgeblendet.',
  note_prompt: 'Schicke eine Notiz zu dieser Anzeige (oder „-“ zum Löschen).',
  note_set: 'Notiz gespeichert.',
  note_cleared: 'Notiz gelöscht.',
  saved_empty: 'Noch nichts gemerkt. Tippe ⭐ Merken in /browse.',
  saved_intro: '⭐ Gemerkte Anzeigen:',
  saved_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  btn_jump: '🔢 Springe zu #',
  btn_switch: '🔀 Wechseln',
  btn_browse_all: '📂 Alle Anzeigen',
  browse_in_stock: '🟢 verfügbar',
  browse_out_of_stock: '🔴 nicht verfügbar',
  price_rating: ({ tag, percentile, n, suspicious }) => {
    if (suspicious) return `⚠️ Zu günstig — prüfen (weit unter ${n} ähnlichen)`;
    if (tag === 'great_deal') return `🟢 Top-Angebot — günstiger als ${Math.round((1 - percentile) * 100)}% von ${n} ähnlichen`;
    if (tag === 'overpriced') return `🔴 Über Marktwert — teurer als ${Math.round(percentile * 100)}% von ${n} ähnlichen`;
    if (tag === 'fair_price') return `🟡 Fairer Preis — etwa marktüblich (${n} ähnliche)`;
    return '';
  },
  fair_value_line: ({ fair, deltaAbs, under }) =>
    `💡 Gesch. fair ≈ ${fair} (${deltaAbs} ${under ? 'darunter' : 'darüber'})`,
  fair_value_under: ({ fair, pct }) => `🔥 ${pct}% unter Schätzwert (≈ ${fair})`,
  browse_position: (n, total) => `Anzeige ${n} von ${total}`,
  browse_empty: 'Noch keine Anzeigen gesammelt. Füge eine Beobachtung mit einem Link hinzu und komm dann zurück.',
  browse_gone: 'Diese Anzeige ist nicht mehr verfügbar.',
  browse_scope_prompt: 'Was möchtest du durchstöbern?',
  browse_jump_prompt: (total) => `Schicke eine Zahl von 1 bis ${total}, um zu dieser Anzeige zu springen.`,
  browse_jump_invalid: (total) => `Bitte schicke eine Zahl von 1 bis ${total}.`,

  cb_seller_set: (v) => `Verkäuferfilter: ${v}`,
  cb_monitoring_started: 'Überwachung gestartet',
  cb_watch_gone: 'Diese Beobachtung existiert nicht mehr.',
  cb_unknown_option: 'Unbekannte Option.',
  cb_setting_error: 'Diese Einstellung konnte nicht aktualisiert werden.',
  cb_removed: 'Beobachtung entfernt.',
  cb_freq_set: (m) => `Häufigkeit: ${m} Min`,
  cb_edit_done: 'Änderungen gespeichert.',
  cb_paused: 'Beobachtung pausiert.',
  cb_resumed: 'Beobachtung fortgesetzt.',
  cb_digest_set: 'Zusammenfassungsmodus aktualisiert.',
  cb_report_set: 'Wochenbericht aktualisiert.',
  exclusion_prompt: 'Schicke eine kommagetrennte Liste von Stichwörtern zum Ausschließen (z. B. beschädigt, Teile, Bastler).',
  exclusion_set: (kw) => `Ausgeschlossen: ${kw}`,
  exclusion_cleared: 'Alle Ausschluss-Stichwörter gelöscht.',
  required_prompt: 'Schicke kommagetrennte Pflicht-Stichwörter (eine Anzeige muss mindestens eines enthalten). „-“ löscht sie.',
  required_set: (kw) => `Erforderlich: ${kw}`,
  required_cleared: 'Alle Pflicht-Stichwörter gelöscht.',
  target_prompt: 'Schicke den Zielpreis (nur Zahl, in der Währung der Anzeige). Ich melde mich, wenn er darauf fällt. „-“ löscht ihn.',
  target_set: (price) => `Zielpreis gesetzt: ${price}`,
  target_cleared: 'Zielpreis gelöscht.',
  target_invalid: 'Schicke eine gültige Zahl (z. B. 12000).',
  target_hit_title: '🎯 Zielpreis erreicht!',
  target_hit_line: (target) => `Ziel: ${target}`,
  became_deal_title: '🔥 Gerade zum Top-Angebot geworden!',
  price_outlook_falling: '🔮 Preis fällt wahrscheinlich weiter',
  price_outlook_stable: '🔮 Preis scheint sich zu stabilisieren',
  insight_line: ({ days, cuts, low }) => {
    const parts: string[] = [];
    if (days !== undefined) parts.push(`📅 seit ${days}T inseriert`);
    if (cuts > 0) parts.push(`📉 ${cuts} Senkung${cuts === 1 ? '' : 'en'}`);
    if (low) parts.push(`Tief ${low}`);
    return parts.join(' · ');
  },
  block_prompt: 'Schicke einen Verkäufernamen oder eine Telefonnummer zum Blockieren. „-“ leert die Liste.',
  block_added_seller: (name) => `Verkäufer blockiert: ${name}`,
  block_added_phone: (phone) => `Telefonnummer blockiert: ${phone}`,
  block_cleared: 'Liste blockierter Verkäufer geleert.',
  price_history_insufficient: 'Noch nicht genügend Preisverlauf.',
  price_history_error: 'Der Preisverlauf konnte nicht erstellt werden.',

  seller_private: '👤 Privatverkäufer',
  seller_company: '🏢 Gewerblich',
  specs_line: (s) => `📋 ${s}`,
  posted_line: (d) => `🕒 Inseriert: ${d}`,
  badge_great_deal: '🔥 Top-Angebot',
  badge_fair_price: '📊 Fairer Marktpreis',
  badge_overpriced: '📈 Überteuert',
  also_on: (s) => `Auch auf: ${s}`,
  price_drop: ({ title, oldPrice, newPrice, savings }) =>
    `📉 Preissenkung bei ${title}: ${oldPrice} → ${newPrice} (spare ${savings})`,
  back_in_stock_title: '🟢 WIEDER VERFÜGBAR',
  hot_lead_title: '🔥 HEISSER TIPP — mehrere Signale',
  scam_warn: '⚠️ Möglicher Betrug — zu billig bei schwachen Verkäufersignalen. Vor Zahlung prüfen.',
  seller_trust_good: '🟢 Vertrauenswürdiger Verkäufer (stabile Historie)',
  seller_trust_caution: '🟠 Verkäufer-Vorsicht (häufiges Neueinstellen/Churn)',
  digest_intro: ({ count, vendor }) => `📰 Zusammenfassung — ${count} neue Anzeigen auf ${vendor}`,
  digest_stats: ({ median, range }) => `Median ${median} · Spanne ${range}`,
  report_title: (vendor) => `📅 Wochenbericht — ${vendor}`,
  report_inventory: ({ count, delta }) => `Beobachtete Anzeigen: ${count} (${delta} ggü. Vorwoche)`,
  report_velocity: ({ n }) => `Neu diese Woche: ${n}`,
  report_best: 'Top-Angebote:',
  report_seasonal: ({ month, pct }) => `🗓 Am günstigsten um ${month} (~${pct}% unter dem Mittel)`,

  access_denied: 'Du hast keinen Zugang zu diesem Bot. Nutze /request_access, um ihn anzufragen.',
  access_request_intro: 'Lass uns Zugang anfragen. ',
  access_ask_name: 'Wie heißt du? (Vor- und Nachname)',
  access_ask_email: 'Wie lautet deine E-Mail-Adresse?',
  access_email_invalid: 'Diese E-Mail sieht ungültig aus. Bitte schicke eine korrekte Adresse.',
  access_request_sent: '✅ Deine Anfrage wurde gesendet. Ich melde mich, wenn ein Admin entscheidet.',
  access_request_pending: 'Du hast bereits eine offene Anfrage. Ich melde mich, wenn sie entschieden ist.',
  access_granted_user: '🎉 Dir wurde Zugang gewährt! Schicke mir einen Anzeigenlink zum Starten.',
  access_denied_user: '⛔ Deine Zugangsanfrage wurde abgelehnt. Du kannst es in 7 Tagen erneut anfragen.',
  access_first_admin:
    '👑 Du bist dabei und du bist der Admin (erster Nutzer). Verwalte Zugänge mit /users, /allow, /deny.',
  access_request_too_soon: (days) =>
    `Deine Anfrage wurde kürzlich abgelehnt. Du kannst sie in ${days} Tag${days === 1 ? '' : 'en'} erneut stellen.`,
  access_admin_new_request: ({ id, name, email }) =>
    `🔔 Neue Zugangsanfrage:\n${name} · ${email}\nChat-ID: ${id}`,
  access_admin_only: 'Dieser Befehl ist nur für Admins verfügbar.',
  access_allow_usage: 'Verwendung: /allow <chat_id>',
  access_deny_usage: 'Verwendung: /deny <chat_id>',
  access_allow_done: ({ id, name }) => `✅ Zugang gewährt für ${name || id} (${id}).`,
  access_deny_done: ({ id, name }) => `⛔ Zugang abgelehnt für ${name || id} (${id}).`,
  access_user_not_found: 'Kein Nutzer mit dieser Chat-ID.',
  access_users_intro: 'Nutzer:',
  access_users_item: ({ id, status, isAdmin, name, email }) =>
    `${id} · ${status}${isAdmin ? ' · Admin' : ''} · ${name || '—'} · ${email || '—'}`,
  access_users_empty: 'Noch keine Nutzer erfasst.',
  access_userinfo_usage: 'Verwendung: /userinfo <chat_id>',
  access_userinfo: ({ id, status, isAdmin, name, email }) =>
    `Nutzer ${id}\nStatus: ${status}${isAdmin ? ' (Admin)' : ''}\nName: ${name || '—'}\nE-Mail: ${email || '—'}`,
  access_setname_usage: 'Verwendung: /setname <chat_id> <name>',
  access_setemail_usage: 'Verwendung: /setemail <chat_id> <email>',
  access_setname_prompt: ({ id }) => `Schicke den Namen für Nutzer ${id}.`,
  access_setemail_prompt: ({ id }) => `Schicke die E-Mail für Nutzer ${id}.`,
  access_setname_done: ({ id, name }) => `✅ Name aktualisiert für ${id}: ${name}`,
  access_setemail_done: ({ id, email }) => `✅ E-Mail aktualisiert für ${id}: ${email}`,
  access_promote_usage: 'Verwendung: /promote <chat_id>',
  access_demote_usage: 'Verwendung: /demote <chat_id>',
  access_promote_done: ({ id }) => `👑 ${id} ist jetzt Admin.`,
  access_demote_done: ({ id }) => `${id} ist nicht mehr Admin.`,
  access_demote_last_admin: 'Du kannst den letzten Admin nicht entfernen.',
  access_promoted_user: '👑 Du wurdest zum Admin gemacht. Verwalte Zugänge mit /users.',
  access_demoted_user: 'Deine Admin-Rechte wurden entfernt.',
  btn_allow: '✅ Erlauben',
  btn_deny: '⛔ Ablehnen',
  cb_allow_done: ({ id }) => `Zugang gewährt für ${id}.`,
  cb_deny_done: ({ id }) => `Zugang abgelehnt für ${id}.`,
  confirm_remove: (id) => `Beobachtung #${id} stoppen? Das kann nicht rückgängig gemacht werden.`,
  confirm_deny: ({ id, name }) => `Zugang ablehnen für ${name || id} (${id})?`,
  confirm_demote: (id) => `Admin-Rechte von ${id} entfernen?`,
  btn_confirm: '✅ Ja, bestätigen',
  btn_cancel: '✖️ Abbrechen',
  cb_cancelled: 'Abgebrochen.',
  audit_intro: 'Zugangsprotokoll (kürzlich):',
  audit_empty: 'Noch keine Zugangsentscheidungen erfasst.',
  audit_item: ({ action, targetId, actorId, at }) =>
    `${at} · ${action} · Ziel ${targetId} · von ${actorId}`,
  backup_caption: 'agor-Backup',
  backup_failed: 'Backup fehlgeschlagen.',
  restore_usage: 'Verwendung: /restore <Dateipfad> (wird beim Neustart angewendet).',
  restore_invalid: 'Diese Datei ist kein gültiges agor-Backup.',
  restore_staged: 'Backup bereitgestellt. Starte den Bot neu, um es anzuwenden.',
};

const it: Catalog = {
  start_welcome:
    'Benvenuto su agor! 👋\n\n' +
    'Inviami un link di ricerca o di prodotto da un marketplace (OLX, AutoVit, Storia…) ' +
    'e lo monitorerò per nuovi annunci, cali di prezzo e variazioni di disponibilità.\n\n' +
    'Scrivi /help per la lista completa dei comandi.',
  help_body:
    'Come usare agor:\n\n' +
    '• Invia un link http(s) di un annuncio, oppure usa /track <url>, per avviare un monitoraggio.\n' +
    '• Dopo la registrazione, regola il tipo di venditore, la frequenza e le parole da escludere, poi tocca „Avvia“.\n' +
    '• /list — mostra tutti i monitoraggi di questa chat.\n' +
    '• /browse — sfoglia gli annunci raccolti; tocca „📌 Monitora“ per seguire un elemento.\n' +
    '• /edit <id> — cambia la frequenza di un monitoraggio, il filtro venditore o le parole da escludere.\n' +
    '• /stats — riepilogo dei tuoi monitoraggi · /export — annunci raccolti in CSV.\n' +
    '• /rate <url> — valuta il prezzo di un annuncio senza monitorarlo.\n' +
    '• /history <id> — grafico dei prezzi di un monitoraggio.\n' +
    '• /cheaper <id> — equivalenti più economici per un prodotto monitorato.\n' +
    '• Inoltra il messaggio di un annuncio per monitorarlo automaticamente.\n' +
    '• /remove <id> — interrompi un monitoraggio.\n' +
    '• /lang ro|en|de|fr|it|es — cambia lingua.\n' +
    '• Tocca „Cronologia prezzi“ su qualsiasi avviso per un grafico.',
  track_usage: 'Uso: /track <url>',
  home_watches: '📋 Monitoraggi',
  home_browse: '🔎 Sfoglia',
  home_saved: '⭐ Salvati',
  home_stats: '📊 Statistiche',
  home_lang: '🌐 Lingua',
  home_help: '❓ Aiuto',
  home_access: '🔓 Richiedi accesso',
  track_error: 'Spiacente — non sono riuscito a registrare il monitoraggio. Riprova.',
  list_empty: 'Nessun monitoraggio. Invia il link di un annuncio per crearne uno.',
  list_intro: 'I tuoi monitoraggi:',
  list_item: ({ id, vendor, type, seller, url, exclusions, tracked, label, paused, required, blocked }) =>
    `#${id} · ${tracked ? '📌 ' : ''}${paused ? '⏸ ' : ''}${label ? `„${label}“ (${vendor})` : vendor} · ${type}` +
    (type === 'search' ? ` · venditore=${seller}` : '') +
    (type === 'search' && required ? ` · richiede: ${required}` : '') +
    (type === 'search' && exclusions ? ` · esclusi: ${exclusions}` : '') +
    (type === 'search' && blocked > 0 ? ` · bloccati: ${blocked}` : '') +
    `\n${url}`,
  remove_usage: 'Uso: /remove <id>',
  remove_done: (id) => `Monitoraggio #${id} interrotto.`,
  remove_not_found: 'Quel monitoraggio non esiste o non è tuo.',
  stats_summary: ({ watches, search, product, paused, tracked, items, vendors }) =>
    `📊 Riepilogo\n` +
    `• Monitoraggi: ${watches} (${search} ricerche, ${product} prodotti)\n` +
    `• Monitorati (📌): ${tracked} · in pausa (⏸): ${paused}\n` +
    `• Annunci raccolti: ${items}\n` +
    (vendors ? `• Siti: ${vendors}` : ''),
  export_caption: (rows) => `📄 Esportati ${rows} ${rows === 1 ? 'annuncio' : 'annunci'}.`,
  export_empty: 'Niente da esportare per ora.',
  rate_usage: 'Uso: /rate <url>',
  rate_unsupported: 'Sito non supportato o link non valido.',
  rate_failed: 'Impossibile leggere questo annuncio (sito bloccato o non raggiungibile).',
  rate_no_comps: 'Non ci sono ancora abbastanza annunci simili raccolti per valutarlo.',
  rate_result: ({ title, price }) => `🏷️ ${title}\n💰 ${price}`,
  history_usage: 'Uso: /history <id>',
  history_not_found: 'Quel monitoraggio non esiste, non è tuo o non ha una cronologia prezzi.',
  history_summary: ({ title, first, last, low, cuts, points, days }) =>
    `📈 ${title}\nDa ${first} → ora ${last}\nMin ${low} · ${cuts} ${cuts === 1 ? 'taglio' : 'tagli'} · ${points} punti · ${days}g`,
  cheaper_usage: 'Uso: /cheaper <id> (id di un monitoraggio prodotto)',
  cheaper_not_found: 'Quel monitoraggio non esiste, non è tuo o non ha ancora un annuncio.',
  cheaper_none: 'Nessun equivalente più economico tra gli annunci raccolti.',
  cheaper_intro: (title) => `🔎 Più economici, simili a „${title}“:`,
  cheaper_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  edit_usage: 'Uso: /edit <id>',
  edit_not_found: 'Quel monitoraggio non esiste o non è tuo.',
  rename_prompt: 'Invia un nome per questo monitoraggio (oppure „-“ per rimuoverlo).',
  rename_done: (label) => `Etichetta impostata: „${label}“.`,
  rename_cleared: 'Etichetta rimossa.',
  btn_group: '📁 Gruppo',
  btn_group_new: '➕ Nuovo gruppo',
  btn_group_clear: '✖️ Rimuovi dal gruppo',
  group_prompt: 'Invia il nome del gruppo per questo monitoraggio (oppure „-“ per rimuoverlo).',
  group_set: (name) => `Gruppo impostato: „${name}“.`,
  group_cleared: 'Gruppo rimosso.',
  group_usage: 'Uso: /group <pause|resume|remove> <nome>',
  group_done: ({ count }) => `${count} monitoraggi aggiornati.`,
  edit_card: ({ id, vendor, type, minutes, label, paused }) =>
    `✏️ Modifica monitoraggio #${id} · ${label ? `„${label}“ (${vendor})` : vendor} · ${type}${paused ? ' · ⏸ in pausa' : ''}\n` +
    `Controlla ogni ${minutes} min. Regola qui sotto:`,
  lang_current: (n) => `Lingua attuale: ${n}. Cambia con /lang ro|en|de|fr|it|es.`,
  lang_set: (n) => `Lingua impostata su ${n}.`,
  lang_usage: 'Uso: /lang ro|en|de|fr|it|es',
  lang_name: 'Italiano',
  lang_pick_intro: '🌐 Scegli la lingua:',
  admin_selector_healed: ({ vendor, from, to }) =>
    `⚠️ Selettore auto-riparato per ${vendor}.\nIl selettore fissato “${from}” non corrispondeva più; rilocato su “${to}”.\nAggiorna il manifest per renderlo permanente.`,
  share_prompt: 'Invia l’id della chat con cui condividere questo monitoraggio (usa /chatid nell’altra chat per ottenerlo). „-“ annulla.',
  share_added: ({ chatId, count }) => `Condiviso con ${chatId}. Questo monitoraggio ora avvisa anche ${count} chat in più.`,
  share_removed: ({ count }) => `Interrotto. Questo monitoraggio è ora condiviso con ${count} chat.`,
  share_none: 'Questo monitoraggio non è condiviso con nessuna chat.',
  share_invalid: 'Invia un id chat valido (un numero, es. -1001234567890).',
  unshare_prompt: ({ list }) => `Invia l’id della chat con cui smettere di condividere. Attuali: ${list}. „-“ annulla.`,
  chat_id_line: (id) => `Id di questa chat: ${id}`,
  unknown_command: 'Comando sconosciuto. Prova /help.',
  send_link_hint: 'Inviami il link di un annuncio da monitorare, oppure /help.',
  generic_error: 'Spiacente — qualcosa è andato storto. Riprova.',
  check_usage: 'Uso: /check <id>',
  check_ok: ({ items, new: n }) =>
    `✅ Controllato: ${items} ${items === 1 ? 'annuncio trovato' : 'annunci trovati'}, ${n} nuovi.`,
  check_failed: '⚠️ Controllo fallito — il sito non ha risposto o sembra bloccato.',
  check_not_found: 'Quel monitoraggio non esiste o non è tuo.',
  quota_reached: (limit) =>
    `Hai raggiunto il limite di ${limit} monitoraggi. Rimuovine uno (/remove <id>) prima di aggiungerne un altro.`,
  check_rate_limited: 'Troppo veloce — attendi qualche secondo prima di controllare di nuovo.',
  url_rate_limited: 'Troppo veloce — attendi qualche secondo prima di aggiungere un altro link.',
  watch_failing: (h) =>
    `⚠️ Il monitoraggio #${h.monitorId} (${h.vendor}) sembra bloccato o non trova nulla (${h.consecutiveFailures} controlli falliti di seguito). Ti avviserò quando si ripristina.`,
  watch_recovered: (h) => `✅ Il monitoraggio #${h.monitorId} (${h.vendor}) funziona di nuovo.`,
  price_change: ({ title, oldPrice, newPrice, direction }) =>
    `${direction === 'down' ? '📉' : '📈'} Prezzo cambiato per ${title}: ${oldPrice} → ${newPrice}`,
  delisted_title: '🗑️ Annuncio rimosso',
  delisted_reason_product_gone: 'La pagina del prodotto non esiste più (è stata eliminata).',
  delisted_reason_search_dropped: 'Questo annuncio è uscito dai risultati monitorati.',
  delisted_last_price: (price) => `Ultimo prezzo visto: ${price}`,
  listings_dropped_title: (count, vendor) =>
    `🗑️ ${count} ${count === 1 ? 'annuncio rimosso' : 'annunci rimossi'} da ${vendor}`,
  re_listed_title: '♻️ Annuncio ricomparso',
  delisted_card_title: '🔻 Annuncio rimosso 🔻',

  reg_watching: (v) => `✅ Sto monitorando ${v}`,
  reg_baseline: (c) => `📦 Base: ${c} ${c === 1 ? 'annuncio registrato' : 'annunci registrati'}.`,
  reg_tune_prompt: 'Regola il monitoraggio, poi avvia il controllo:',

  btn_private: '👤 Privato',
  btn_company: '🏢 Azienda',
  btn_both: '👥 Entrambi',
  btn_exclusion: '🚫 Parole da escludere',
  btn_start: '▶️ Avvia',
  btn_done: '✅ Fatto',
  btn_remove: '🗑 Rimuovi',
  btn_digest: '📰 Riepilogo',
  btn_report: '📅 Report settimanale',
  btn_required: '✅ Parole obbligatorie',
  btn_block: '⛔ Blocca venditore',
  btn_rename: '✏️ Rinomina',
  btn_pause: '⏸ Pausa',
  btn_resume: '▶️ Riprendi',
  btn_edit: '✏️ Modifica',
  btn_target: '🎯 Prezzo obiettivo',
  btn_type: '✏️ Tipo',
  picker_choose_watch: 'Quale monitoraggio?',
  picker_choose_user: 'Quale utente?',
  picker_block_prompt: 'Quale venditore bloccare? (tocca; tocca di nuovo per sbloccare)',
  picker_exclude_prompt: 'Quali parole escludere? (tocca; tocca di nuovo per rimuovere)',
  picker_require_prompt: 'Quali parole richiedere? (tocca; tocca di nuovo per rimuovere)',
  btn_open: '🔗 Apri',
  btn_call: '📞 Chiama',
  btn_price_history: '📊 Cronologia prezzi',
  btn_freq: (m) => m < 60 ? `⏱ ${m}m` : `⏱ ${m / 60}h`,
  btn_interval: (current) => `⏱ Intervallo di controllo: ${current}`,
  btn_seller_menu: (current) => `👤 Venditore: ${current}`,
  btn_reports_menu: '📊 Report',
  reports_menu_intro: '📊 Report\n\n• Riepilogo — invece di avvisi singoli, ricevi tutti i nuovi annunci raggruppati una volta al giorno o alla settimana.\n• Report settimanale — sintesi di mercato: numero di annunci, prezzo medio e tendenza dell’ultima settimana.',
  btn_prev: '◀️ Indietro',
  btn_next: 'Avanti ▶️',
  btn_save: '⭐ Salva',
  btn_saved: '⭐ Salvato',
  btn_dismiss: '🚫 Ignora',
  btn_note: '📝 Nota',
  cb_saved: '⭐ Salvato e monitorato. Avvisi su variazioni di prezzo ed eliminazione.',
  cb_unsaved: 'Rimosso dai salvati. Non monitoro più questo annuncio.',
  cb_dismissed: 'Annuncio nascosto.',
  note_prompt: 'Invia una nota per questo annuncio (oppure „-“ per rimuoverla).',
  note_set: 'Nota salvata.',
  note_cleared: 'Nota rimossa.',
  saved_empty: 'Niente salvato per ora. Tocca ⭐ Salva in /browse.',
  saved_intro: '⭐ Annunci salvati:',
  saved_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  btn_jump: '🔢 Vai al #',
  btn_switch: '🔀 Cambia',
  btn_browse_all: '📂 Tutti gli annunci',
  browse_in_stock: '🟢 disponibile',
  browse_out_of_stock: '🔴 non disponibile',
  price_rating: ({ tag, percentile, n, suspicious }) => {
    if (suspicious) return `⚠️ Troppo economico — verifica (molto sotto ${n} simili)`;
    if (tag === 'great_deal') return `🟢 Ottimo affare — più economico del ${Math.round((1 - percentile) * 100)}% di ${n} simili`;
    if (tag === 'overpriced') return `🔴 Sopra mercato — più caro del ${Math.round(percentile * 100)}% di ${n} simili`;
    if (tag === 'fair_price') return `🟡 Prezzo equo — in linea con il mercato (${n} simili)`;
    return '';
  },
  fair_value_line: ({ fair, deltaAbs, under }) =>
    `💡 Equo stimato ≈ ${fair} (${deltaAbs} ${under ? 'sotto' : 'sopra'})`,
  fair_value_under: ({ fair, pct }) => `🔥 ${pct}% sotto il previsto (≈ ${fair})`,
  browse_position: (n, total) => `elemento ${n} di ${total}`,
  browse_empty: 'Nessun elemento raccolto per ora. Aggiungi un monitoraggio con un link, poi torna qui.',
  browse_gone: 'Questo elemento non è più disponibile.',
  browse_scope_prompt: 'Cosa vuoi sfogliare?',
  browse_jump_prompt: (total) => `Invia un numero da 1 a ${total} per saltare a quella posizione.`,
  browse_jump_invalid: (total) => `Invia un numero da 1 a ${total}.`,

  cb_seller_set: (v) => `Filtro venditore: ${v}`,
  cb_monitoring_started: 'Monitoraggio avviato',
  cb_watch_gone: 'Quel monitoraggio non esiste più.',
  cb_unknown_option: 'Opzione sconosciuta.',
  cb_setting_error: 'Impossibile aggiornare questa impostazione.',
  cb_removed: 'Monitoraggio rimosso.',
  cb_freq_set: (m) => `Frequenza: ${m} min`,
  cb_edit_done: 'Modifiche salvate.',
  cb_paused: 'Monitoraggio in pausa.',
  cb_resumed: 'Monitoraggio ripreso.',
  cb_digest_set: 'Modalità riepilogo aggiornata.',
  cb_report_set: 'Report settimanale aggiornato.',
  exclusion_prompt: 'Invia una lista di parole separate da virgola da escludere (es. danneggiato, ricambi, incidentato).',
  exclusion_set: (kw) => `Escludo: ${kw}`,
  exclusion_cleared: 'Tutte le parole da escludere rimosse.',
  required_prompt: 'Invia le parole obbligatorie separate da virgola (un annuncio deve contenerne almeno una). „-“ le rimuove.',
  required_set: (kw) => `Richiedo: ${kw}`,
  required_cleared: 'Tutte le parole obbligatorie rimosse.',
  target_prompt: 'Invia il prezzo obiettivo (solo numero, nella stessa valuta). Ti avviserò quando scende a quel valore. „-“ lo rimuove.',
  target_set: (price) => `Prezzo obiettivo impostato: ${price}`,
  target_cleared: 'Prezzo obiettivo rimosso.',
  target_invalid: 'Invia un numero valido (es. 12000).',
  target_hit_title: '🎯 Prezzo obiettivo raggiunto!',
  target_hit_line: (target) => `Obiettivo: ${target}`,
  became_deal_title: '🔥 Ora è un ottimo affare!',
  price_outlook_falling: '🔮 Il prezzo calerà probabilmente ancora',
  price_outlook_stable: '🔮 Il prezzo sembra stabilizzarsi',
  insight_line: ({ days, cuts, low }) => {
    const parts: string[] = [];
    if (days !== undefined) parts.push(`📅 online da ${days}g`);
    if (cuts > 0) parts.push(`📉 ${cuts} ${cuts === 1 ? 'taglio' : 'tagli'}`);
    if (low) parts.push(`min ${low}`);
    return parts.join(' · ');
  },
  block_prompt: 'Invia il nome di un venditore o un numero di telefono da bloccare. „-“ svuota la lista.',
  block_added_seller: (name) => `Venditore bloccato: ${name}`,
  block_added_phone: (phone) => `Numero bloccato: ${phone}`,
  block_cleared: 'Lista dei venditori bloccati svuotata.',
  price_history_insufficient: 'Cronologia prezzi ancora insufficiente.',
  price_history_error: 'Impossibile generare la cronologia prezzi.',

  seller_private: '👤 Venditore privato',
  seller_company: '🏢 Azienda',
  specs_line: (s) => `📋 ${s}`,
  posted_line: (d) => `🕒 Pubblicato: ${d}`,
  badge_great_deal: '🔥 Ottimo affare',
  badge_fair_price: '📊 Prezzo di mercato equo',
  badge_overpriced: '📈 Sopra mercato',
  also_on: (s) => `Anche su: ${s}`,
  price_drop: ({ title, oldPrice, newPrice, savings }) =>
    `📉 Calo di prezzo su ${title}: ${oldPrice} → ${newPrice} (risparmi ${savings})`,
  back_in_stock_title: '🟢 DI NUOVO DISPONIBILE',
  hot_lead_title: '🔥 OCCASIONE CALDA — più segnali',
  scam_warn: '⚠️ Possibile truffa — troppo economico con segnali venditore deboli. Verifica prima di pagare.',
  seller_trust_good: '🟢 Venditore affidabile (storico stabile)',
  seller_trust_caution: '🟠 Venditore da verificare (ripubblicazioni frequenti)',
  digest_intro: ({ count, vendor }) => `📰 Riepilogo — ${count} nuovi annunci su ${vendor}`,
  digest_stats: ({ median, range }) => `Mediana ${median} · intervallo ${range}`,
  report_title: (vendor) => `📅 Report settimanale — ${vendor}`,
  report_inventory: ({ count, delta }) => `Annunci monitorati: ${count} (${delta} rispetto alla settimana scorsa)`,
  report_velocity: ({ n }) => `Nuovi questa settimana: ${n}`,
  report_best: 'Migliori offerte:',
  report_seasonal: ({ month, pct }) => `🗓 Più economico intorno a ${month} (~${pct}% sotto la media)`,

  access_denied: 'Non hai accesso a questo bot. Usa /request_access per richiederlo.',
  access_request_intro: 'Procediamo con la richiesta di accesso. ',
  access_ask_name: 'Come ti chiami? (nome e cognome)',
  access_ask_email: 'Qual è il tuo indirizzo email?',
  access_email_invalid: 'Questa email non sembra valida. Invia un indirizzo corretto.',
  access_request_sent: '✅ La tua richiesta è stata inviata. Ti avviserò quando un admin deciderà.',
  access_request_pending: 'Hai già una richiesta in attesa. Ti avviserò quando verrà decisa.',
  access_granted_user: '🎉 Accesso concesso! Inviami il link di un annuncio per iniziare.',
  access_denied_user: '⛔ La tua richiesta di accesso è stata rifiutata. Puoi richiederlo di nuovo tra 7 giorni.',
  access_first_admin:
    '👑 Sei dentro e sei il primo amministratore. Gestisci gli accessi con /users, /allow, /deny.',
  access_request_too_soon: (days) =>
    `La tua richiesta è stata rifiutata di recente. Puoi richiederlo di nuovo tra ${days} ${days === 1 ? 'giorno' : 'giorni'}.`,
  access_admin_new_request: ({ id, name, email }) =>
    `🔔 Nuova richiesta di accesso:\n${name} · ${email}\nchat id: ${id}`,
  access_admin_only: 'Questo comando è disponibile solo per gli amministratori.',
  access_allow_usage: 'Uso: /allow <chat_id>',
  access_deny_usage: 'Uso: /deny <chat_id>',
  access_allow_done: ({ id, name }) => `✅ Accesso concesso a ${name || id} (${id}).`,
  access_deny_done: ({ id, name }) => `⛔ Accesso rifiutato a ${name || id} (${id}).`,
  access_user_not_found: 'Nessun utente con quel chat id.',
  access_users_intro: 'Utenti:',
  access_users_item: ({ id, status, isAdmin, name, email }) =>
    `${id} · ${status}${isAdmin ? ' · admin' : ''} · ${name || '—'} · ${email || '—'}`,
  access_users_empty: 'Nessun utente registrato per ora.',
  access_userinfo_usage: 'Uso: /userinfo <chat_id>',
  access_userinfo: ({ id, status, isAdmin, name, email }) =>
    `Utente ${id}\nstato: ${status}${isAdmin ? ' (admin)' : ''}\nnome: ${name || '—'}\nemail: ${email || '—'}`,
  access_setname_usage: 'Uso: /setname <chat_id> <name>',
  access_setemail_usage: 'Uso: /setemail <chat_id> <email>',
  access_setname_prompt: ({ id }) => `Invia il nome per utente ${id}.`,
  access_setemail_prompt: ({ id }) => `Invia un indirizzo email per utente ${id}.`,
  access_setname_done: ({ id, name }) => `✅ Nome aggiornato per ${id}: ${name}`,
  access_setemail_done: ({ id, email }) => `✅ Email aggiornata per ${id}: ${email}`,
  access_promote_usage: 'Uso: /promote <chat_id>',
  access_demote_usage: 'Uso: /demote <chat_id>',
  access_promote_done: ({ id }) => `👑 ${id} è ora un amministratore.`,
  access_demote_done: ({ id }) => `${id} non è più un amministratore.`,
  access_demote_last_admin: 'Deve restare almeno un amministratore.',
  access_promoted_user: '👑 Sei stato nominato amministratore. Gestisci gli accessi con /users.',
  access_demoted_user: 'I tuoi diritti di amministratore sono stati rimossi.',
  btn_allow: '✅ Consenti',
  btn_deny: '⛔ Rifiuta',
  cb_allow_done: ({ id }) => `Accesso concesso a ${id}.`,
  cb_deny_done: ({ id }) => `Accesso rifiutato a ${id}.`,
  confirm_remove: (id) => `Interrompere il monitoraggio #${id}? Non si può annullare.`,
  confirm_deny: ({ id, name }) => `Rifiutare la richiesta di ${name || id} (${id})?`,
  confirm_demote: (id) => `Rimuovere i diritti di amministratore da ${id}?`,
  btn_confirm: '✅ Sì, conferma',
  btn_cancel: '✖️ Annulla',
  cb_cancelled: 'Annullato.',
  audit_intro: 'Registro accessi (recenti):',
  audit_empty: 'Nessuna decisione di accesso registrata per ora.',
  audit_item: ({ action, targetId, actorId, at }) =>
    `${at} · ${action} · target ${targetId} · da ${actorId}`,
  backup_caption: 'Backup agor',
  backup_failed: 'Backup non riuscito.',
  restore_usage: 'Uso: /restore <percorso-file> (applicato al riavvio).',
  restore_invalid: 'Il file non è un backup agor valido.',
  restore_staged: 'Backup preparato. Riavvia il bot per applicarlo.',
};

const es: Catalog = {
  start_welcome:
    '¡Bienvenido a agor! 👋\n\n' +
    'Envíame un enlace de búsqueda o de producto de un marketplace (OLX, AutoVit, Storia…) ' +
    'y lo vigilaré para detectar nuevos anuncios, bajadas de precio y cambios de stock.\n\n' +
    'Escribe /help para ver la lista completa de comandos.',
  help_body:
    'Cómo usar agor:\n\n' +
    '• Envía cualquier enlace http(s) de un anuncio, o usa /track <url>, para iniciar un seguimiento.\n' +
    '• Tras registrarlo, ajusta el tipo de vendedor, la frecuencia y las palabras de exclusión, luego pulsa „Iniciar“.\n' +
    '• /list — muestra todos los seguimientos de este chat.\n' +
    '• /browse — explora los anuncios recopilados; pulsa „📌 Seguir“ para vigilar un artículo.\n' +
    '• /edit <id> — cambia la frecuencia, el filtro de vendedor o las palabras de exclusión de un seguimiento.\n' +
    '• /stats — resumen de tus seguimientos · /export — anuncios recopilados en CSV.\n' +
    '• /rate <url> — evalúa el precio de un anuncio sin seguirlo.\n' +
    '• /history <id> — gráfico de precios de un seguimiento.\n' +
    '• /cheaper <id> — equivalentes más baratos de un producto seguido.\n' +
    '• Reenvía el mensaje de un anuncio para seguirlo automáticamente.\n' +
    '• /remove <id> — detiene un seguimiento.\n' +
    '• /lang ro|en|de|fr|it|es — cambia el idioma.\n' +
    '• Pulsa „Historial de precios“ en cualquier alerta para ver un gráfico.',
  track_usage: 'Uso: /track <url>',
  home_watches: '📋 Seguimientos',
  home_browse: '🔎 Explorar',
  home_saved: '⭐ Guardados',
  home_stats: '📊 Estadísticas',
  home_lang: '🌐 Idioma',
  home_help: '❓ Ayuda',
  home_access: '🔓 Solicitar acceso',
  track_error: 'Lo siento — no pude registrar ese seguimiento. Inténtalo de nuevo.',
  list_empty: 'Aún no hay seguimientos. Envía un enlace de anuncio para crear uno.',
  list_intro: 'Tus seguimientos:',
  list_item: ({ id, vendor, type, seller, url, exclusions, tracked, label, paused, required, blocked }) =>
    `#${id} · ${tracked ? '📌 ' : ''}${paused ? '⏸ ' : ''}${label ? `„${label}“ (${vendor})` : vendor} · ${type}` +
    (type === 'search' ? ` · vendedor=${seller}` : '') +
    (type === 'search' && required ? ` · requiere: ${required}` : '') +
    (type === 'search' && exclusions ? ` · excluido: ${exclusions}` : '') +
    (type === 'search' && blocked > 0 ? ` · bloqueados: ${blocked}` : '') +
    `\n${url}`,
  remove_usage: 'Uso: /remove <id>',
  remove_done: (id) => `Seguimiento #${id} detenido.`,
  remove_not_found: 'Ese seguimiento no existe o no es tuyo.',
  stats_summary: ({ watches, search, product, paused, tracked, items, vendors }) =>
    `📊 Resumen\n` +
    `• Seguimientos: ${watches} (${search} búsquedas, ${product} productos)\n` +
    `• Seguidos (📌): ${tracked} · pausados (⏸): ${paused}\n` +
    `• Anuncios recopilados: ${items}\n` +
    (vendors ? `• Sitios: ${vendors}` : ''),
  export_caption: (rows) => `📄 Exportado${rows === 1 ? '' : 's'} ${rows} anuncio${rows === 1 ? '' : 's'}.`,
  export_empty: 'Aún no hay nada que exportar.',
  rate_usage: 'Uso: /rate <url>',
  rate_unsupported: 'Sitio no compatible o enlace no válido.',
  rate_failed: 'No pude leer ese anuncio (sitio bloqueado o caído).',
  rate_no_comps: 'Aún no hay suficientes anuncios similares recopilados para evaluarlo.',
  rate_result: ({ title, price }) => `🏷️ ${title}\n💰 ${price}`,
  history_usage: 'Uso: /history <id>',
  history_not_found: 'Ese seguimiento no existe, no es tuyo, o no tiene historial de precios.',
  history_summary: ({ title, first, last, low, cuts, points, days }) =>
    `📈 ${title}\nDe ${first} → ahora ${last}\nMínimo ${low} · ${cuts} bajada${cuts === 1 ? '' : 's'} · ${points} puntos · ${days}d`,
  cheaper_usage: 'Uso: /cheaper <id> (id de un seguimiento de producto)',
  cheaper_not_found: 'Ese seguimiento no existe, no es tuyo, o aún no tiene anuncio.',
  cheaper_none: 'No hay equivalentes más baratos en tus anuncios recopilados.',
  cheaper_intro: (title) => `🔎 Más baratos, similares a „${title}“:`,
  cheaper_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  edit_usage: 'Uso: /edit <id>',
  edit_not_found: 'Ese seguimiento no existe o no es tuyo.',
  rename_prompt: 'Envía un nombre para este seguimiento (o „-“ para borrarlo).',
  rename_done: (label) => `Etiqueta establecida: „${label}“.`,
  rename_cleared: 'Etiqueta borrada.',
  btn_group: '📁 Grupo',
  btn_group_new: '➕ Nuevo grupo',
  btn_group_clear: '✖️ Quitar del grupo',
  group_prompt: 'Envía el nombre del grupo para este seguimiento (o "-" para quitarlo).',
  group_set: (name) => `Grupo establecido: "${name}".`,
  group_cleared: 'Grupo quitado.',
  group_usage: 'Uso: /group <pause|resume|remove> <nombre>',
  group_done: ({ count }) => `${count} seguimientos actualizados.`,
  edit_card: ({ id, vendor, type, minutes, label, paused }) =>
    `✏️ Editando seguimiento #${id} · ${label ? `„${label}“ (${vendor})` : vendor} · ${type}${paused ? ' · ⏸ pausado' : ''}\n` +
    `Comprueba cada ${minutes} min. Ajusta abajo:`,
  lang_current: (n) => `Idioma actual: ${n}. Cambiar con /lang ro|en|de|fr|it|es.`,
  lang_set: (n) => `Idioma establecido en ${n}.`,
  lang_usage: 'Uso: /lang ro|en|de|fr|it|es',
  lang_name: 'Español',
  lang_pick_intro: '🌐 Elige el idioma:',
  admin_selector_healed: ({ vendor, from, to }) =>
    `⚠️ Selector auto-reparado para ${vendor}.\nEl selector fijado «${from}» dejó de coincidir; reubicado a «${to}».\nActualiza el manifest para hacerlo permanente.`,
  share_prompt: 'Envía el id del chat con el que compartir este seguimiento (usa /chatid en el otro chat para obtenerlo). “-” cancela.',
  share_added: ({ chatId, count }) => `Compartido con ${chatId}. Este seguimiento ahora también avisa a ${count} chat(s) más.`,
  share_removed: ({ count }) => `Detenido. Este seguimiento ahora se comparte con ${count} chat(s).`,
  share_none: 'Este seguimiento no se comparte con ningún chat.',
  share_invalid: 'Envía un id de chat válido (un número, p. ej. -1001234567890).',
  unshare_prompt: ({ list }) => `Envía el id del chat con el que dejar de compartir. Actuales: ${list}. “-” cancela.`,
  chat_id_line: (id) => `Id de este chat: ${id}`,
  unknown_command: 'Comando desconocido. Prueba /help.',
  send_link_hint: 'Envíame un enlace de anuncio para vigilarlo, o /help.',
  generic_error: 'Lo siento — algo salió mal. Inténtalo de nuevo.',
  check_usage: 'Uso: /check <id>',
  check_ok: ({ items, new: n }) =>
    `✅ Comprobado: ${items} anuncio${items === 1 ? '' : 's'} encontrado${items === 1 ? '' : 's'}, ${n} nuevo${n === 1 ? '' : 's'}.`,
  check_failed: '⚠️ La comprobación falló — el sitio no respondió o parece bloqueado.',
  check_not_found: 'Ese seguimiento no existe o no es tuyo.',
  quota_reached: (limit) =>
    `Has alcanzado el límite de ${limit} seguimientos. Elimina uno (/remove <id>) antes de añadir otro.`,
  check_rate_limited: 'Demasiado rápido — espera unos segundos antes de volver a comprobar.',
  url_rate_limited: 'Demasiado rápido — espera unos segundos antes de añadir otro enlace.',
  watch_failing: (h) =>
    `⚠️ El seguimiento #${h.monitorId} (${h.vendor}) parece bloqueado o no encuentra nada (${h.consecutiveFailures} comprobaciones fallidas seguidas). Te avisaré cuando se recupere.`,
  watch_recovered: (h) => `✅ El seguimiento #${h.monitorId} (${h.vendor}) vuelve a funcionar.`,
  price_change: ({ title, oldPrice, newPrice, direction }) =>
    `${direction === 'down' ? '📉' : '📈'} Cambio de precio en ${title}: ${oldPrice} → ${newPrice}`,
  delisted_title: '🗑️ Anuncio eliminado',
  delisted_reason_product_gone: 'La página del anuncio ya no existe (fue eliminada).',
  delisted_reason_search_dropped: 'El anuncio desapareció de los resultados seguidos.',
  delisted_last_price: (price) => `Último precio visto: ${price}`,
  listings_dropped_title: (count, vendor) =>
    `🗑️ ${count} ${count === 1 ? 'anuncio desaparecido' : 'anuncios desaparecidos'} de ${vendor}`,
  re_listed_title: '♻️ Anuncio reaparecido',
  delisted_card_title: '🔻 Anuncio retirado 🔻',

  reg_watching: (v) => `✅ Vigilando ${v}`,
  reg_baseline: (c) => `📦 Base inicial: ${c} anuncio${c === 1 ? '' : 's'} registrado${c === 1 ? '' : 's'}.`,
  reg_tune_prompt: 'Ajusta el seguimiento y luego inicia la monitorización:',

  btn_private: '👤 Particular',
  btn_company: '🏢 Empresa',
  btn_both: '👥 Ambos',
  btn_exclusion: '🚫 Palabras de exclusión',
  btn_start: '▶️ Iniciar',
  btn_done: '✅ Hecho',
  btn_remove: '🗑 Eliminar',
  btn_digest: '📰 Resumen',
  btn_report: '📅 Informe semanal',
  btn_required: '✅ Palabras obligatorias',
  btn_block: '⛔ Bloquear vendedor',
  btn_rename: '✏️ Renombrar',
  btn_pause: '⏸ Pausar',
  btn_resume: '▶️ Reanudar',
  btn_edit: '✏️ Editar',
  btn_target: '🎯 Precio objetivo',
  btn_type: '✏️ Tipo',
  picker_choose_watch: '¿Qué seguimiento?',
  picker_choose_user: '¿Qué usuario?',
  picker_block_prompt: '¿Qué vendedor bloquear? (pulsa; pulsa de nuevo para desbloquear)',
  picker_exclude_prompt: '¿Qué palabras excluir? (pulsa; pulsa de nuevo para quitar)',
  picker_require_prompt: '¿Qué palabras exigir? (pulsa; pulsa de nuevo para quitar)',
  btn_open: '🔗 Abrir',
  btn_call: '📞 Llamar',
  btn_price_history: '📊 Historial de precios',
  btn_freq: (m) => m < 60 ? `⏱ ${m}m` : `⏱ ${m / 60}h`,
  btn_interval: (current) => `⏱ Intervalo de comprobación: ${current}`,
  btn_seller_menu: (current) => `👤 Vendedor: ${current}`,
  btn_reports_menu: '📊 Informes',
  reports_menu_intro: '📊 Informes\n\n• Resumen — en lugar de avisos individuales, recibe todos los anuncios nuevos agrupados una vez al día o a la semana.\n• Informe semanal — síntesis de mercado: número de anuncios, precio medio y tendencia de la última semana.',
  btn_prev: '◀️ Anterior',
  btn_next: 'Siguiente ▶️',
  btn_save: '⭐ Guardar',
  btn_saved: '⭐ Guardado',
  btn_dismiss: '🚫 Descartar',
  btn_note: '📝 Nota',
  cb_saved: '⭐ Guardado y siguiendo. Avisos de cambios de precio y retirada.',
  cb_unsaved: 'Quitado de guardados. Ya no sigo este anuncio.',
  cb_dismissed: 'Anuncio oculto.',
  note_prompt: 'Envía una nota para este anuncio (o "-" para borrarla).',
  note_set: 'Nota guardada.',
  note_cleared: 'Nota borrada.',
  saved_empty: 'Aún no has guardado nada. Pulsa ⭐ Guardar en /browse.',
  saved_intro: '⭐ Anuncios guardados:',
  saved_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  btn_jump: '🔢 Ir al #',
  btn_switch: '🔀 Cambiar',
  btn_browse_all: '📂 Todos los anuncios',
  browse_in_stock: '🟢 disponible',
  browse_out_of_stock: '🔴 no disponible',
  price_rating: ({ tag, percentile, n, suspicious }) => {
    if (suspicious) return `⚠️ Demasiado barato — verifica (muy por debajo de ${n} similares)`;
    if (tag === 'great_deal') return `🟢 Gran chollo — más barato que el ${Math.round((1 - percentile) * 100)}% de ${n} similares`;
    if (tag === 'overpriced') return `🔴 Por encima del mercado — más caro que el ${Math.round(percentile * 100)}% de ${n} similares`;
    if (tag === 'fair_price') return `🟡 Precio justo — en torno al precio habitual (${n} similares)`;
    return '';
  },
  fair_value_line: ({ fair, deltaAbs, under }) =>
    `💡 Valor justo est. ≈ ${fair} (${deltaAbs} ${under ? 'por debajo' : 'por encima'})`,
  fair_value_under: ({ fair, pct }) => `🔥 ${pct}% por debajo de lo previsto (≈ ${fair})`,
  browse_position: (n, total) => `artículo ${n} de ${total}`,
  browse_empty: 'Aún no hay artículos recopilados. Añade un seguimiento con un enlace y vuelve.',
  browse_gone: 'Este artículo ya no está disponible.',
  browse_scope_prompt: '¿Qué te gustaría explorar?',
  browse_jump_prompt: (total) => `Envía un número del 1 al ${total} para saltar a ese artículo.`,
  browse_jump_invalid: (total) => `Por favor, envía un número del 1 al ${total}.`,

  cb_seller_set: (v) => `Filtro de vendedor: ${v}`,
  cb_monitoring_started: 'Monitorización iniciada',
  cb_watch_gone: 'Ese seguimiento ya no existe.',
  cb_unknown_option: 'Opción desconocida.',
  cb_setting_error: 'No se pudo actualizar ese ajuste.',
  cb_removed: 'Seguimiento eliminado.',
  cb_freq_set: (m) => `Frecuencia: ${m} min`,
  cb_edit_done: 'Cambios guardados.',
  cb_paused: 'Seguimiento pausado.',
  cb_resumed: 'Seguimiento reanudado.',
  cb_digest_set: 'Modo resumen actualizado.',
  cb_report_set: 'Informe semanal actualizado.',
  exclusion_prompt: 'Envía una lista de palabras clave separadas por comas para excluir (p. ej. dañado, piezas, siniestro).',
  exclusion_set: (kw) => `Excluyendo: ${kw}`,
  exclusion_cleared: 'Se borraron todas las palabras de exclusión.',
  required_prompt: 'Envía palabras clave obligatorias separadas por comas (un anuncio debe contener al menos una). „-“ las borra.',
  required_set: (kw) => `Exigiendo: ${kw}`,
  required_cleared: 'Se borraron todas las palabras obligatorias.',
  target_prompt: 'Envía el precio objetivo (solo el número, en la moneda del anuncio). Te avisaré cuando baje hasta él. „-“ lo borra.',
  target_set: (price) => `Precio objetivo establecido: ${price}`,
  target_cleared: 'Precio objetivo borrado.',
  target_invalid: 'Envía un número válido (p. ej. 12000).',
  target_hit_title: '🎯 ¡Precio objetivo alcanzado!',
  target_hit_line: (target) => `Objetivo: ${target}`,
  became_deal_title: '🔥 ¡Acaba de convertirse en un gran chollo!',
  price_outlook_falling: '🔮 El precio probablemente bajará más',
  price_outlook_stable: '🔮 El precio parece estabilizarse',
  insight_line: ({ days, cuts, low }) => {
    const parts: string[] = [];
    if (days !== undefined) parts.push(`📅 publicado hace ${days}d`);
    if (cuts > 0) parts.push(`📉 ${cuts} bajada${cuts === 1 ? '' : 's'}`);
    if (low) parts.push(`mínimo ${low}`);
    return parts.join(' · ');
  },
  block_prompt: 'Envía un nombre de vendedor o un número de teléfono para bloquear. „-“ vacía la lista.',
  block_added_seller: (name) => `Vendedor bloqueado: ${name}`,
  block_added_phone: (phone) => `Teléfono bloqueado: ${phone}`,
  block_cleared: 'Lista de vendedores bloqueados vaciada.',
  price_history_insufficient: 'Aún no hay suficiente historial de precios.',
  price_history_error: 'No se pudo generar el historial de precios.',

  seller_private: '👤 Vendedor particular',
  seller_company: '🏢 Empresa',
  specs_line: (s) => `📋 ${s}`,
  posted_line: (d) => `🕒 Publicado: ${d}`,
  badge_great_deal: '🔥 Gran chollo',
  badge_fair_price: '📊 Precio justo de mercado',
  badge_overpriced: '📈 Sobreprecio',
  also_on: (s) => `También en: ${s}`,
  price_drop: ({ title, oldPrice, newPrice, savings }) =>
    `📉 Bajada de precio en ${title}: ${oldPrice} → ${newPrice} (ahorra ${savings})`,
  back_in_stock_title: '🟢 DE NUEVO EN STOCK',
  hot_lead_title: '🔥 CHOLLO CALIENTE — varias señales',
  scam_warn: '⚠️ Posible estafa — demasiado barato con señales de vendedor débiles. Verifica antes de pagar.',
  seller_trust_good: '🟢 Vendedor de confianza (historial estable)',
  seller_trust_caution: '🟠 Vendedor con precaución (republicaciones frecuentes)',
  digest_intro: ({ count, vendor }) => `📰 Resumen — ${count} anuncios nuevos en ${vendor}`,
  digest_stats: ({ median, range }) => `Mediana ${median} · rango ${range}`,
  report_title: (vendor) => `📅 Informe semanal — ${vendor}`,
  report_inventory: ({ count, delta }) => `Anuncios seguidos: ${count} (${delta} frente a la semana pasada)`,
  report_velocity: ({ n }) => `Nuevos esta semana: ${n}`,
  report_best: 'Mejores ofertas:',
  report_seasonal: ({ month, pct }) => `🗓 Más barato en torno a ${month} (~${pct}% por debajo de la media)`,

  access_denied: 'No tienes acceso a este bot. Usa /request_access para solicitarlo.',
  access_request_intro: 'Vamos a solicitar acceso. ',
  access_ask_name: '¿Cómo te llamas? (nombre y apellido)',
  access_ask_email: '¿Cuál es tu dirección de correo electrónico?',
  access_email_invalid: 'Ese correo no parece válido. Por favor, envía una dirección correcta.',
  access_request_sent: '✅ Tu solicitud se envió. Te avisaré cuando un administrador decida.',
  access_request_pending: 'Ya tienes una solicitud pendiente. Te avisaré cuando se decida.',
  access_granted_user: '🎉 ¡Se te ha concedido acceso! Envíame un enlace de anuncio para empezar.',
  access_denied_user: '⛔ Tu solicitud de acceso fue rechazada. Puedes volver a solicitarlo en 7 días.',
  access_first_admin:
    '👑 Estás dentro, y eres el administrador (primer usuario). Gestiona el acceso con /users, /allow, /deny.',
  access_request_too_soon: (days) =>
    `Tu solicitud fue rechazada recientemente. Puedes volver a solicitarlo en ${days} día${days === 1 ? '' : 's'}.`,
  access_admin_new_request: ({ id, name, email }) =>
    `🔔 Nueva solicitud de acceso:\n${name} · ${email}\nid de chat: ${id}`,
  access_admin_only: 'Ese comando solo está disponible para administradores.',
  access_allow_usage: 'Uso: /allow <chat_id>',
  access_deny_usage: 'Uso: /deny <chat_id>',
  access_allow_done: ({ id, name }) => `✅ Acceso concedido a ${name || id} (${id}).`,
  access_deny_done: ({ id, name }) => `⛔ Acceso rechazado a ${name || id} (${id}).`,
  access_user_not_found: 'No hay ningún usuario con ese id de chat.',
  access_users_intro: 'Usuarios:',
  access_users_item: ({ id, status, isAdmin, name, email }) =>
    `${id} · ${status}${isAdmin ? ' · admin' : ''} · ${name || '—'} · ${email || '—'}`,
  access_users_empty: 'Aún no hay usuarios registrados.',
  access_userinfo_usage: 'Uso: /userinfo <chat_id>',
  access_userinfo: ({ id, status, isAdmin, name, email }) =>
    `Usuario ${id}\nestado: ${status}${isAdmin ? ' (admin)' : ''}\nnombre: ${name || '—'}\ncorreo: ${email || '—'}`,
  access_setname_usage: 'Uso: /setname <chat_id> <name>',
  access_setemail_usage: 'Uso: /setemail <chat_id> <email>',
  access_setname_prompt: ({ id }) => `Envía el nombre para el usuario ${id}.`,
  access_setemail_prompt: ({ id }) => `Envía el correo para el usuario ${id}.`,
  access_setname_done: ({ id, name }) => `✅ Nombre actualizado para ${id}: ${name}`,
  access_setemail_done: ({ id, email }) => `✅ Correo actualizado para ${id}: ${email}`,
  access_promote_usage: 'Uso: /promote <chat_id>',
  access_demote_usage: 'Uso: /demote <chat_id>',
  access_promote_done: ({ id }) => `👑 ${id} ahora es administrador.`,
  access_demote_done: ({ id }) => `${id} ya no es administrador.`,
  access_demote_last_admin: 'No puedes quitar al último administrador.',
  access_promoted_user: '👑 Se te ha hecho administrador. Gestiona el acceso con /users.',
  access_demoted_user: 'Se te han retirado los derechos de administrador.',
  btn_allow: '✅ Permitir',
  btn_deny: '⛔ Denegar',
  cb_allow_done: ({ id }) => `Acceso concedido a ${id}.`,
  cb_deny_done: ({ id }) => `Acceso rechazado a ${id}.`,
  confirm_remove: (id) => `¿Detener el seguimiento #${id}? Esto no se puede deshacer.`,
  confirm_deny: ({ id, name }) => `¿Denegar el acceso a ${name || id} (${id})?`,
  confirm_demote: (id) => `¿Quitar los derechos de administrador a ${id}?`,
  btn_confirm: '✅ Sí, confirmar',
  btn_cancel: '✖️ Cancelar',
  cb_cancelled: 'Cancelado.',
  audit_intro: 'Registro de acceso (reciente):',
  audit_empty: 'Aún no hay decisiones de acceso registradas.',
  audit_item: ({ action, targetId, actorId, at }) =>
    `${at} · ${action} · objetivo ${targetId} · por ${actorId}`,
  backup_caption: 'Copia de seguridad agor',
  backup_failed: 'La copia de seguridad falló.',
  restore_usage: 'Uso: /restore <ruta-archivo> (se aplica al reiniciar).',
  restore_invalid: 'Ese archivo no es una copia de seguridad válida de agor.',
  restore_staged: 'Copia preparada. Reinicia el bot para aplicarla.',
};

const fr: Catalog = {
  start_welcome:
    'Bienvenue sur agor ! 👋\n\n' +
    'Envoyez-moi un lien de recherche ou d’annonce (OLX, AutoVit, Storia…) ' +
    'et je la surveillerai pour les nouvelles annonces, baisses de prix et changements de stock.\n\n' +
    'Tapez /help pour la liste complète des commandes.',
  help_body:
    'Comment utiliser agor :\n\n' +
    '• Envoyez un lien d’annonce http(s), ou utilisez /track <url>, pour lancer un suivi.\n' +
    '• Après l’enregistrement, réglez le type de vendeur, la fréquence et les mots-clés exclus, puis tapez “Démarrer”.\n' +
    '• /list — affiche tous les suivis de ce chat.\n' +
    '• /browse — parcourez les annonces collectées ; tapez “📌 Suivre” pour surveiller une annonce.\n' +
    '• /edit <id> — modifiez la fréquence d’un suivi, le filtre vendeur ou les mots-clés exclus.\n' +
    '• /stats — résumé de vos suivis · /export — annonces collectées au format CSV.\n' +
    '• /rate <url> — évaluez le prix d’une annonce sans la suivre.\n' +
    '• /history <id> — graphique de prix d’un suivi.\n' +
    '• /cheaper <id> — équivalents moins chers pour un produit suivi.\n' +
    '• Transférez un message d’annonce pour la suivre automatiquement.\n' +
    '• /remove <id> — arrête un suivi.\n' +
    '• /lang ro|en|de|fr|it|es — change la langue.\n' +
    '• Tapez “Historique des prix” sur une alerte pour un graphique.',
  track_usage: 'Utilisation : /track <url>',
  home_watches: '📋 Suivis',
  home_browse: '🔎 Parcourir',
  home_saved: '⭐ Enregistrés',
  home_stats: '📊 Statistiques',
  home_lang: '🌐 Langue',
  home_help: '❓ Aide',
  home_access: '🔓 Demander l’accès',
  track_error: 'Désolé — je n’ai pas pu enregistrer ce suivi. Veuillez réessayer.',
  list_empty: 'Aucun suivi pour l’instant. Envoyez un lien d’annonce pour en créer un.',
  list_intro: 'Vos suivis :',
  list_item: ({ id, vendor, type, seller, url, exclusions, tracked, label, paused, required, blocked }) =>
    `#${id} · ${tracked ? '📌 ' : ''}${paused ? '⏸ ' : ''}${label ? `“${label}” (${vendor})` : vendor} · ${type}` +
    (type === 'search' ? ` · vendeur=${seller}` : '') +
    (type === 'search' && required ? ` · requis : ${required}` : '') +
    (type === 'search' && exclusions ? ` · exclus : ${exclusions}` : '') +
    (type === 'search' && blocked > 0 ? ` · bloqués : ${blocked}` : '') +
    `\n${url}`,
  remove_usage: 'Utilisation : /remove <id>',
  remove_done: (id) => `Suivi #${id} arrêté.`,
  remove_not_found: 'Ce suivi n’existe pas ou ne vous appartient pas.',
  stats_summary: ({ watches, search, product, paused, tracked, items, vendors }) =>
    `📊 Résumé\n` +
    `• Suivis : ${watches} (${search} recherches, ${product} produits)\n` +
    `• Épinglés (📌) : ${tracked} · en pause (⏸) : ${paused}\n` +
    `• Annonces collectées : ${items}\n` +
    (vendors ? `• Sites : ${vendors}` : ''),
  export_caption: (rows) => `📄 Export de ${rows} annonce${rows === 1 ? '' : 's'}.`,
  export_empty: 'Rien à exporter pour l’instant.',
  rate_usage: 'Utilisation : /rate <url>',
  rate_unsupported: 'Site non pris en charge ou lien invalide.',
  rate_failed: 'Impossible de lire cette annonce (site bloqué ou indisponible).',
  rate_no_comps: 'Pas encore assez d’annonces similaires collectées pour l’évaluer.',
  rate_result: ({ title, price }) => `🏷️ ${title}\n💰 ${price}`,
  history_usage: 'Utilisation : /history <id>',
  history_not_found: 'Ce suivi n’existe pas, ne vous appartient pas, ou n’a pas d’historique de prix.',
  history_summary: ({ title, first, last, low, cuts, points, days }) =>
    `📈 ${title}\nDe ${first} → maintenant ${last}\nMin ${low} · ${cuts} baisse${cuts === 1 ? '' : 's'} · ${points} points · ${days}j`,
  cheaper_usage: 'Utilisation : /cheaper <id> (id d’un suivi de produit)',
  cheaper_not_found: 'Ce suivi n’existe pas, ne vous appartient pas, ou n’a pas encore d’annonce.',
  cheaper_none: 'Aucun équivalent moins cher dans vos annonces collectées.',
  cheaper_intro: (title) => `🔎 Moins cher, similaire à “${title}” :`,
  cheaper_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  edit_usage: 'Utilisation : /edit <id>',
  edit_not_found: 'Ce suivi n’existe pas ou ne vous appartient pas.',
  rename_prompt: 'Envoyez un nom pour ce suivi (ou “-” pour l’effacer).',
  rename_done: (label) => `Étiquette définie : “${label}”.`,
  rename_cleared: 'Étiquette effacée.',
  btn_group: '📁 Groupe',
  btn_group_new: '➕ Nouveau groupe',
  btn_group_clear: '✖️ Retirer du groupe',
  group_prompt: 'Envoyez le nom du groupe pour ce suivi (ou « - » pour le retirer).',
  group_set: (name) => `Groupe défini : « ${name} ».`,
  group_cleared: 'Groupe retiré.',
  group_usage: 'Utilisation : /group <pause|resume|remove> <nom>',
  group_done: ({ count }) => `${count} suivis mis à jour.`,
  edit_card: ({ id, vendor, type, minutes, label, paused }) =>
    `✏️ Modification du suivi #${id} · ${label ? `“${label}” (${vendor})` : vendor} · ${type}${paused ? ' · ⏸ en pause' : ''}\n` +
    `Vérifie toutes les ${minutes} min. Ajustez ci-dessous :`,
  lang_current: (n) => `Langue actuelle : ${n}. Changer avec /lang ro|en|de|fr|it|es.`,
  lang_set: (n) => `Langue définie sur ${n}.`,
  lang_usage: 'Utilisation : /lang ro|en|de|fr|it|es',
  lang_name: 'Français',
  lang_pick_intro: '🌐 Choisissez la langue :',
  admin_selector_healed: ({ vendor, from, to }) =>
    `⚠️ Sélecteur auto-réparé pour ${vendor}.\nLe sélecteur fixé « ${from} » ne correspondait plus ; relocalisé vers « ${to} ».\nMettez à jour le manifeste pour le rendre permanent.`,
  share_prompt: 'Envoyez l’id du chat avec lequel partager ce suivi (utilisez /chatid dans l’autre chat pour l’obtenir). « - » annule.',
  share_added: ({ chatId, count }) => `Partagé avec ${chatId}. Ce suivi alerte désormais aussi ${count} chat(s) supplémentaire(s).`,
  share_removed: ({ count }) => `Arrêté. Ce suivi est désormais partagé avec ${count} chat(s).`,
  share_none: 'Ce suivi n’est partagé avec aucun chat.',
  share_invalid: 'Envoyez un id de chat valide (un nombre, ex. -1001234567890).',
  unshare_prompt: ({ list }) => `Envoyez l’id du chat avec lequel ne plus partager. Actuels : ${list}. « - » annule.`,
  chat_id_line: (id) => `Id de ce chat : ${id}`,
  unknown_command: 'Commande inconnue. Essayez /help.',
  send_link_hint: 'Envoyez-moi un lien d’annonce à surveiller, ou /help.',
  generic_error: 'Désolé — une erreur est survenue. Veuillez réessayer.',
  check_usage: 'Utilisation : /check <id>',
  check_ok: ({ items, new: n }) =>
    `✅ Vérifié : ${items} annonce${items === 1 ? '' : 's'} trouvée${items === 1 ? '' : 's'}, ${n} nouvelle${n === 1 ? '' : 's'}.`,
  check_failed: '⚠️ Échec de la vérification — le site n’a pas répondu ou semble bloqué.',
  check_not_found: 'Ce suivi n’existe pas ou ne vous appartient pas.',
  quota_reached: (limit) =>
    `Vous avez atteint la limite de ${limit} suivis. Supprimez-en un (/remove <id>) avant d’en ajouter un autre.`,
  check_rate_limited: 'Trop rapide — attendez quelques secondes avant de revérifier.',
  url_rate_limited: 'Trop rapide — attendez quelques secondes avant d’ajouter un autre lien.',
  watch_failing: (h) =>
    `⚠️ Le suivi #${h.monitorId} (${h.vendor}) semble bloqué ou ne trouve rien (${h.consecutiveFailures} échecs consécutifs). Je vous préviendrai quand il sera rétabli.`,
  watch_recovered: (h) => `✅ Le suivi #${h.monitorId} (${h.vendor}) fonctionne à nouveau.`,
  price_change: ({ title, oldPrice, newPrice, direction }) =>
    `${direction === 'down' ? '📉' : '📈'} Prix modifié sur ${title} : ${oldPrice} → ${newPrice}`,
  delisted_title: '🗑️ Annonce supprimée',
  delisted_reason_product_gone: 'La page de l’annonce n’existe plus (elle a été supprimée).',
  delisted_reason_search_dropped: 'L’annonce a disparu des résultats suivis.',
  delisted_last_price: (price) => `Dernier prix vu : ${price}`,
  listings_dropped_title: (count, vendor) =>
    `🗑️ ${count} ${count === 1 ? 'annonce disparue' : 'annonces disparues'} sur ${vendor}`,
  re_listed_title: '♻️ Annonce réapparue',
  delisted_card_title: '🔻 Annonce retirée 🔻',

  reg_watching: (v) => `✅ Surveillance de ${v}`,
  reg_baseline: (c) => `📦 Référence : ${c} annonce${c === 1 ? '' : 's'} enregistrée${c === 1 ? '' : 's'}.`,
  reg_tune_prompt: 'Réglez le suivi, puis démarrez la surveillance :',

  btn_private: '👤 Particulier',
  btn_company: '🏢 Professionnel',
  btn_both: '👥 Les deux',
  btn_exclusion: '🚫 Mots-clés exclus',
  btn_start: '▶️ Démarrer',
  btn_done: '✅ Terminé',
  btn_remove: '🗑 Supprimer',
  btn_digest: '📰 Résumé',
  btn_report: '📅 Rapport hebdomadaire',
  btn_required: '✅ Mots requis',
  btn_block: '⛔ Bloquer le vendeur',
  btn_rename: '✏️ Renommer',
  btn_pause: '⏸ Pause',
  btn_resume: '▶️ Reprendre',
  btn_edit: '✏️ Modifier',
  btn_target: '🎯 Prix cible',
  btn_type: '✏️ Type',
  picker_choose_watch: 'Quel suivi ?',
  picker_choose_user: 'Quel utilisateur ?',
  picker_block_prompt: 'Bloquer quel vendeur ? (tapez ; tapez à nouveau pour débloquer)',
  picker_exclude_prompt: 'Exclure quels mots ? (tapez ; tapez à nouveau pour retirer)',
  picker_require_prompt: 'Exiger quels mots ? (tapez ; tapez à nouveau pour retirer)',
  btn_open: '🔗 Ouvrir',
  btn_call: '📞 Appeler',
  btn_price_history: '📊 Historique des prix',
  btn_freq: (m) => m < 60 ? `⏱ ${m}m` : `⏱ ${m / 60}h`,
  btn_interval: (current) => `⏱ Intervalle de vérification : ${current}`,
  btn_seller_menu: (current) => `👤 Vendeur : ${current}`,
  btn_reports_menu: '📊 Rapports',
  reports_menu_intro: '📊 Rapports\n\n• Résumé — au lieu d’alertes individuelles, recevez toutes les nouvelles annonces regroupées une fois par jour ou par semaine.\n• Rapport hebdomadaire — synthèse du marché : nombre d’annonces, prix moyen et tendance de la semaine écoulée.',
  btn_prev: '◀️ Préc.',
  btn_next: 'Suiv. ▶️',
  btn_save: '⭐ Enregistrer',
  btn_saved: '⭐ Enregistré',
  btn_dismiss: '🚫 Ignorer',
  btn_note: '📝 Note',
  cb_saved: '⭐ Enregistré et suivi. Alertes sur les prix et le retrait.',
  cb_unsaved: 'Retiré des enregistrés. Je ne suis plus cette annonce.',
  cb_dismissed: 'Annonce masquée.',
  note_prompt: 'Envoyez une note pour cette annonce (ou « - » pour l’effacer).',
  note_set: 'Note enregistrée.',
  note_cleared: 'Note effacée.',
  saved_empty: 'Rien d’enregistré pour l’instant. Tapez ⭐ Enregistrer dans /browse.',
  saved_intro: '⭐ Annonces enregistrées :',
  saved_item: ({ title, price, url }) => `• ${price} — ${title}\n${url}`,
  btn_jump: '🔢 Aller au #',
  btn_switch: '🔀 Changer',
  btn_browse_all: '📂 Toutes les annonces',
  browse_in_stock: '🟢 disponible',
  browse_out_of_stock: '🔴 indisponible',
  price_rating: ({ tag, percentile, n, suspicious }) => {
    if (suspicious) return `⚠️ Trop bas — à vérifier (bien en dessous de ${n} similaires)`;
    if (tag === 'great_deal') return `🟢 Bonne affaire — moins cher que ${Math.round((1 - percentile) * 100)}% de ${n} similaires`;
    if (tag === 'overpriced') return `🔴 Au-dessus du marché — plus cher que ${Math.round(percentile * 100)}% de ${n} similaires`;
    if (tag === 'fair_price') return `🟡 Prix correct — proche du tarif courant (${n} similaires)`;
    return '';
  },
  fair_value_line: ({ fair, deltaAbs, under }) =>
    `💡 Prix juste estimé ≈ ${fair} (${deltaAbs} ${under ? 'en dessous' : 'au-dessus'})`,
  fair_value_under: ({ fair, pct }) => `🔥 ${pct}% sous le prix prévu (≈ ${fair})`,
  browse_position: (n, total) => `annonce ${n} sur ${total}`,
  browse_empty: 'Aucune annonce collectée pour l’instant. Ajoutez un suivi avec un lien, puis revenez.',
  browse_gone: 'Cette annonce n’est plus disponible.',
  browse_scope_prompt: 'Que souhaitez-vous parcourir ?',
  browse_jump_prompt: (total) => `Envoyez un nombre de 1 à ${total} pour aller à cette annonce.`,
  browse_jump_invalid: (total) => `Veuillez envoyer un nombre de 1 à ${total}.`,

  cb_seller_set: (v) => `Filtre vendeur : ${v}`,
  cb_monitoring_started: 'Surveillance démarrée',
  cb_watch_gone: 'Ce suivi n’existe plus.',
  cb_unknown_option: 'Option inconnue.',
  cb_setting_error: 'Impossible de mettre à jour ce réglage.',
  cb_removed: 'Suivi supprimé.',
  cb_freq_set: (m) => `Fréquence : ${m} min`,
  cb_edit_done: 'Modifications enregistrées.',
  cb_paused: 'Suivi mis en pause.',
  cb_resumed: 'Suivi repris.',
  cb_digest_set: 'Mode résumé mis à jour.',
  cb_report_set: 'Rapport hebdomadaire mis à jour.',
  exclusion_prompt: 'Envoyez une liste de mots-clés à exclure, séparés par des virgules (ex. : endommagé, pièces, épave).',
  exclusion_set: (kw) => `Exclus : ${kw}`,
  exclusion_cleared: 'Tous les mots-clés exclus ont été effacés.',
  required_prompt: 'Envoyez des mots-clés requis séparés par des virgules (une annonce doit en contenir au moins un). “-” les efface.',
  required_set: (kw) => `Requis : ${kw}`,
  required_cleared: 'Tous les mots-clés requis ont été effacés.',
  target_prompt: 'Envoyez le prix cible (nombre uniquement, dans la devise de l’annonce). Je vous alerterai quand il l’atteindra. “-” l’efface.',
  target_set: (price) => `Prix cible défini : ${price}`,
  target_cleared: 'Prix cible effacé.',
  target_invalid: 'Envoyez un nombre valide (ex. : 12000).',
  target_hit_title: '🎯 Prix cible atteint !',
  target_hit_line: (target) => `Cible : ${target}`,
  became_deal_title: '🔥 Vient de devenir une bonne affaire !',
  price_outlook_falling: '🔮 Le prix va probablement encore baisser',
  price_outlook_stable: '🔮 Le prix semble se stabiliser',
  insight_line: ({ days, cuts, low }) => {
    const parts: string[] = [];
    if (days !== undefined) parts.push(`📅 en ligne ${days}j`);
    if (cuts > 0) parts.push(`📉 ${cuts} baisse${cuts === 1 ? '' : 's'}`);
    if (low) parts.push(`min ${low}`);
    return parts.join(' · ');
  },
  block_prompt: 'Envoyez un nom de vendeur ou un numéro de téléphone à bloquer. “-” vide la liste.',
  block_added_seller: (name) => `Vendeur bloqué : ${name}`,
  block_added_phone: (phone) => `Téléphone bloqué : ${phone}`,
  block_cleared: 'Liste des vendeurs bloqués vidée.',
  price_history_insufficient: 'Pas encore assez d’historique de prix.',
  price_history_error: 'Impossible d’afficher l’historique des prix.',

  seller_private: '👤 Vendeur particulier',
  seller_company: '🏢 Professionnel',
  specs_line: (s) => `📋 ${s}`,
  posted_line: (d) => `🕒 Publié : ${d}`,
  badge_great_deal: '🔥 Bonne affaire',
  badge_fair_price: '📊 Prix du marché',
  badge_overpriced: '📈 Surévalué',
  also_on: (s) => `Aussi sur : ${s}`,
  price_drop: ({ title, oldPrice, newPrice, savings }) =>
    `📉 Baisse de prix sur ${title} : ${oldPrice} → ${newPrice} (économie ${savings})`,
  back_in_stock_title: '🟢 DE RETOUR EN STOCK',
  hot_lead_title: '🔥 BON PLAN — plusieurs signaux',
  scam_warn: '⚠️ Arnaque possible — trop bon marché avec de faibles signaux vendeur. Vérifiez avant de payer.',
  seller_trust_good: '🟢 Vendeur de confiance (historique stable)',
  seller_trust_caution: '🟠 Vendeur à vérifier (republications fréquentes)',
  digest_intro: ({ count, vendor }) => `📰 Résumé — ${count} nouvelles annonces sur ${vendor}`,
  digest_stats: ({ median, range }) => `Médiane ${median} · plage ${range}`,
  report_title: (vendor) => `📅 Rapport hebdomadaire — ${vendor}`,
  report_inventory: ({ count, delta }) => `Annonces suivies : ${count} (${delta} vs la semaine dernière)`,
  report_velocity: ({ n }) => `Nouvelles cette semaine : ${n}`,
  report_best: 'Meilleures affaires :',
  report_seasonal: ({ month, pct }) => `🗓 Le moins cher autour de ${month} (~${pct}% sous la moyenne)`,

  access_denied: 'Vous n’avez pas accès à ce bot. Utilisez /request_access pour le demander.',
  access_request_intro: 'Demandons l’accès. ',
  access_ask_name: 'Quel est votre nom ? (prénom et nom)',
  access_ask_email: 'Quelle est votre adresse e-mail ?',
  access_email_invalid: 'Cette adresse e-mail ne semble pas valide. Veuillez envoyer une adresse correcte.',
  access_request_sent: '✅ Votre demande a été envoyée. Je vous préviendrai dès qu’un administrateur aura décidé.',
  access_request_pending: 'Vous avez déjà une demande en attente. Je vous préviendrai dès qu’elle sera traitée.',
  access_granted_user: '🎉 L’accès vous a été accordé ! Envoyez-moi un lien d’annonce pour commencer.',
  access_denied_user: '⛔ Votre demande d’accès a été refusée. Vous pourrez redemander dans 7 jours.',
  access_first_admin:
    '👑 Vous êtes admis, et vous êtes l’administrateur (premier utilisateur). Gérez les accès avec /users, /allow, /deny.',
  access_request_too_soon: (days) =>
    `Votre demande a été refusée récemment. Vous pourrez redemander dans ${days} jour${days === 1 ? '' : 's'}.`,
  access_admin_new_request: ({ id, name, email }) =>
    `🔔 Nouvelle demande d’accès :\n${name} · ${email}\nid du chat : ${id}`,
  access_admin_only: 'Cette commande est réservée aux administrateurs.',
  access_allow_usage: 'Utilisation : /allow <chat_id>',
  access_deny_usage: 'Utilisation : /deny <chat_id>',
  access_allow_done: ({ id, name }) => `✅ Accès accordé pour ${name || id} (${id}).`,
  access_deny_done: ({ id, name }) => `⛔ Accès refusé pour ${name || id} (${id}).`,
  access_user_not_found: 'Aucun utilisateur avec cet id de chat.',
  access_users_intro: 'Utilisateurs :',
  access_users_item: ({ id, status, isAdmin, name, email }) =>
    `${id} · ${status}${isAdmin ? ' · admin' : ''} · ${name || '—'} · ${email || '—'}`,
  access_users_empty: 'Aucun utilisateur enregistré pour l’instant.',
  access_userinfo_usage: 'Utilisation : /userinfo <chat_id>',
  access_userinfo: ({ id, status, isAdmin, name, email }) =>
    `Utilisateur ${id}\nstatut : ${status}${isAdmin ? ' (admin)' : ''}\nnom : ${name || '—'}\ne-mail : ${email || '—'}`,
  access_setname_usage: 'Utilisation : /setname <chat_id> <name>',
  access_setemail_usage: 'Utilisation : /setemail <chat_id> <email>',
  access_setname_prompt: ({ id }) => `Envoyez le nom de l’utilisateur ${id}.`,
  access_setemail_prompt: ({ id }) => `Envoyez l’e-mail de l’utilisateur ${id}.`,
  access_setname_done: ({ id, name }) => `✅ Nom mis à jour pour ${id} : ${name}`,
  access_setemail_done: ({ id, email }) => `✅ E-mail mis à jour pour ${id} : ${email}`,
  access_promote_usage: 'Utilisation : /promote <chat_id>',
  access_demote_usage: 'Utilisation : /demote <chat_id>',
  access_promote_done: ({ id }) => `👑 ${id} est désormais administrateur.`,
  access_demote_done: ({ id }) => `${id} n’est plus administrateur.`,
  access_demote_last_admin: 'Vous ne pouvez pas retirer le dernier administrateur.',
  access_promoted_user: '👑 Vous avez été nommé administrateur. Gérez les accès avec /users.',
  access_demoted_user: 'Vos droits d’administrateur ont été retirés.',
  btn_allow: '✅ Autoriser',
  btn_deny: '⛔ Refuser',
  cb_allow_done: ({ id }) => `Accès accordé pour ${id}.`,
  cb_deny_done: ({ id }) => `Accès refusé pour ${id}.`,
  confirm_remove: (id) => `Arrêter le suivi #${id} ? Cette action est irréversible.`,
  confirm_deny: ({ id, name }) => `Refuser l’accès pour ${name || id} (${id}) ?`,
  confirm_demote: (id) => `Retirer les droits d’administrateur à ${id} ?`,
  btn_confirm: '✅ Oui, confirmer',
  btn_cancel: '✖️ Annuler',
  cb_cancelled: 'Annulé.',
  audit_intro: 'Journal d’accès (récent) :',
  audit_empty: 'Aucune décision d’accès enregistrée pour l’instant.',
  audit_item: ({ action, targetId, actorId, at }) =>
    `${at} · ${action} · cible ${targetId} · par ${actorId}`,
  backup_caption: 'Sauvegarde agor',
  backup_failed: 'La sauvegarde a échoué.',
  restore_usage: 'Utilisation : /restore <chemin-fichier> (appliqué au redémarrage).',
  restore_invalid: 'Ce fichier n’est pas une sauvegarde agor valide.',
  restore_staged: 'Sauvegarde préparée. Redémarrez le bot pour l’appliquer.',
};

/**
 * The Telegram command menu (the `/` autocomplete) per language, registered via
 * setMyCommands. Command tokens are shared; only descriptions are localized.
 */
export interface CommandMenuEntry {
  command: string;
  description: string;
}

export const commandMenu: Record<Lang, CommandMenuEntry[]> = {
  ro: [
    { command: 'start', description: 'Pornește botul' },
    { command: 'track', description: 'Urmărește un link de anunț' },
    { command: 'list', description: 'Arată urmăririle din acest chat' },
    { command: 'browse', description: 'Răsfoiește anunțurile colectate' },
    { command: 'saved', description: 'Anunțurile salvate (⭐)' },
    { command: 'check', description: 'Verifică o urmărire acum (/check <id>)' },
    { command: 'edit', description: 'Modifică o urmărire (/edit <id>)' },
    { command: 'stats', description: 'Rezumatul urmăririlor tale' },
    { command: 'rate', description: 'Evaluează prețul unui link (/rate <link>)' },
    { command: 'history', description: 'Grafic preț pentru o urmărire (/history <id>)' },
    { command: 'group', description: 'Acțiune pe grup (/group pause|resume|remove <nume>)' },
    { command: 'report', description: 'Raport săptămânal de piață (/report <id>)' },
    { command: 'export', description: 'Exportă anunțurile colectate (CSV)' },
    { command: 'remove', description: 'Oprește o urmărire (/remove <id>)' },
    { command: 'share', description: 'Partajează o urmărire cu alt chat (/share <id>)' },
    { command: 'unshare', description: 'Oprește partajarea unei urmăriri (/unshare <id>)' },
    { command: 'chatid', description: 'Arată id-ul acestui chat' },
    { command: 'lang', description: 'Schimbă limba (/lang ro|en|de|fr|it|es)' },
    { command: 'request_access', description: 'Cere acces la bot' },
    { command: 'help', description: 'Cum se folosește botul' },
  ],
  en: [
    { command: 'start', description: 'Start the bot' },
    { command: 'track', description: 'Watch a listing link' },
    { command: 'list', description: 'Show this chat’s watches' },
    { command: 'browse', description: 'Browse collected listings' },
    { command: 'saved', description: 'Your saved listings (⭐)' },
    { command: 'check', description: 'Check a watch now (/check <id>)' },
    { command: 'edit', description: 'Edit a watch (/edit <id>)' },
    { command: 'stats', description: 'Summary of your watches' },
    { command: 'rate', description: 'Rate a link’s price (/rate <url>)' },
    { command: 'history', description: 'Price chart for a watch (/history <id>)' },
    { command: 'group', description: 'Bulk group action (/group pause|resume|remove <name>)' },
    { command: 'report', description: 'Weekly market report (/report <id>)' },
    { command: 'export', description: 'Export collected listings (CSV)' },
    { command: 'remove', description: 'Stop a watch (/remove <id>)' },
    { command: 'share', description: 'Share a watch with another chat (/share <id>)' },
    { command: 'unshare', description: 'Stop sharing a watch (/unshare <id>)' },
    { command: 'chatid', description: 'Show this chat’s id' },
    { command: 'lang', description: 'Change language (/lang ro|en|de|fr|it|es)' },
    { command: 'request_access', description: 'Request access to the bot' },
    { command: 'help', description: 'How to use the bot' },
  ],
  de: [
    { command: 'start', description: 'Bot starten' },
    { command: 'track', description: 'Einen Anzeigenlink beobachten' },
    { command: 'list', description: 'Beobachtungen dieses Chats anzeigen' },
    { command: 'browse', description: 'Gesammelte Anzeigen durchstöbern' },
    { command: 'saved', description: 'Deine gemerkten Anzeigen (⭐)' },
    { command: 'check', description: 'Eine Beobachtung jetzt prüfen (/check <id>)' },
    { command: 'edit', description: 'Eine Beobachtung bearbeiten (/edit <id>)' },
    { command: 'stats', description: 'Übersicht deiner Beobachtungen' },
    { command: 'rate', description: 'Den Preis eines Links bewerten (/rate <url>)' },
    { command: 'history', description: 'Preisdiagramm für eine Beobachtung (/history <id>)' },
    { command: 'group', description: 'Gruppenaktion (/group pause|resume|remove <Name>)' },
    { command: 'report', description: 'Wöchentlicher Marktbericht (/report <id>)' },
    { command: 'export', description: 'Gesammelte Anzeigen exportieren (CSV)' },
    { command: 'remove', description: 'Eine Beobachtung stoppen (/remove <id>)' },
    { command: 'share', description: 'Eine Beobachtung mit einem anderen Chat teilen (/share <id>)' },
    { command: 'unshare', description: 'Teilen einer Beobachtung beenden (/unshare <id>)' },
    { command: 'chatid', description: 'Die ID dieses Chats anzeigen' },
    { command: 'lang', description: 'Sprache ändern (/lang ro|en|de|fr|it|es)' },
    { command: 'request_access', description: 'Zugang zum Bot anfragen' },
    { command: 'help', description: 'So benutzt du den Bot' },
  ],
  fr: [
    { command: 'start', description: 'Démarrer le bot' },
    { command: 'track', description: 'Surveiller un lien d’annonce' },
    { command: 'list', description: 'Afficher les suivis de ce chat' },
    { command: 'browse', description: 'Parcourir les annonces collectées' },
    { command: 'saved', description: 'Vos annonces enregistrées (⭐)' },
    { command: 'check', description: 'Vérifier un suivi maintenant (/check <id>)' },
    { command: 'edit', description: 'Modifier un suivi (/edit <id>)' },
    { command: 'stats', description: 'Résumé de vos suivis' },
    { command: 'rate', description: 'Évaluer le prix d’un lien (/rate <url>)' },
    { command: 'history', description: 'Graphique de prix d’un suivi (/history <id>)' },
    { command: 'group', description: 'Action de groupe (/group pause|resume|remove <nom>)' },
    { command: 'report', description: 'Rapport de marché hebdomadaire (/report <id>)' },
    { command: 'export', description: 'Exporter les annonces collectées (CSV)' },
    { command: 'remove', description: 'Arrêter un suivi (/remove <id>)' },
    { command: 'share', description: 'Partager un suivi avec un autre chat (/share <id>)' },
    { command: 'unshare', description: 'Arrêter de partager un suivi (/unshare <id>)' },
    { command: 'chatid', description: 'Afficher l’id de ce chat' },
    { command: 'lang', description: 'Changer la langue (/lang ro|en|de|fr|it|es)' },
    { command: 'request_access', description: 'Demander l’accès au bot' },
    { command: 'help', description: 'Comment utiliser le bot' },
  ],
  it: [
    { command: 'start', description: 'Avvia il bot' },
    { command: 'track', description: 'Monitora il link di un annuncio' },
    { command: 'list', description: 'Mostra i monitoraggi di questa chat' },
    { command: 'browse', description: 'Sfoglia gli annunci raccolti' },
    { command: 'saved', description: 'I tuoi annunci salvati (⭐)' },
    { command: 'check', description: 'Controlla ora un monitoraggio (/check <id>)' },
    { command: 'edit', description: 'Modifica un monitoraggio (/edit <id>)' },
    { command: 'stats', description: 'Riepilogo dei tuoi monitoraggi' },
    { command: 'rate', description: 'Valuta il prezzo di un link (/rate <url>)' },
    { command: 'history', description: 'Grafico dei prezzi di un monitoraggio (/history <id>)' },
    { command: 'group', description: 'Azione sul gruppo (/group pause|resume|remove <nome>)' },
    { command: 'report', description: 'Report di mercato settimanale (/report <id>)' },
    { command: 'export', description: 'Esporta gli annunci raccolti (CSV)' },
    { command: 'remove', description: 'Interrompi un monitoraggio (/remove <id>)' },
    { command: 'share', description: 'Condividi un monitoraggio con un’altra chat (/share <id>)' },
    { command: 'unshare', description: 'Smetti di condividere un monitoraggio (/unshare <id>)' },
    { command: 'chatid', description: 'Mostra l’id di questa chat' },
    { command: 'lang', description: 'Cambia lingua (/lang ro|en|de|fr|it|es)' },
    { command: 'request_access', description: 'Richiedi accesso al bot' },
    { command: 'help', description: 'Come usare il bot' },
  ],
  es: [
    { command: 'start', description: 'Iniciar el bot' },
    { command: 'track', description: 'Vigilar un enlace de anuncio' },
    { command: 'list', description: 'Mostrar los seguimientos de este chat' },
    { command: 'browse', description: 'Explorar los anuncios recopilados' },
    { command: 'saved', description: 'Tus anuncios guardados (⭐)' },
    { command: 'check', description: 'Comprobar un seguimiento ahora (/check <id>)' },
    { command: 'edit', description: 'Editar un seguimiento (/edit <id>)' },
    { command: 'stats', description: 'Resumen de tus seguimientos' },
    { command: 'rate', description: 'Evaluar el precio de un enlace (/rate <url>)' },
    { command: 'history', description: 'Gráfico de precios de un seguimiento (/history <id>)' },
    { command: 'group', description: 'Acción de grupo (/group pause|resume|remove <nombre>)' },
    { command: 'report', description: 'Informe de mercado semanal (/report <id>)' },
    { command: 'export', description: 'Exportar los anuncios recopilados (CSV)' },
    { command: 'remove', description: 'Detener un seguimiento (/remove <id>)' },
    { command: 'share', description: 'Compartir un seguimiento con otro chat (/share <id>)' },
    { command: 'unshare', description: 'Dejar de compartir un seguimiento (/unshare <id>)' },
    { command: 'chatid', description: 'Mostrar el id de este chat' },
    { command: 'lang', description: 'Cambiar idioma (/lang ro|en|de|fr|it|es)' },
    { command: 'request_access', description: 'Solicitar acceso al bot' },
    { command: 'help', description: 'Cómo usar el bot' },
  ],
};

/** All catalogs, keyed by language. */
export const messages: Record<Lang, Catalog> = { ro, en, de, fr, it, es };

/** Convenience accessor: the catalog for `lang`. */
export function tr(lang: Lang): Catalog {
  return messages[lang];
}

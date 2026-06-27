/**
 * Localized message catalog (RO default, EN on request).
 *
 * Every user-facing string lives here — commands, cards, notifications, errors,
 * and button labels. The {@link Catalog} interface makes completeness a COMPILE
 * error: a key missing from either language fails `tsc`. Callers read copy via
 * `tr(lang).<key>` (a plain string, or a function for parameterized messages).
 */

import type { WatchHealth } from '../contracts';

export type Lang = 'ro' | 'en';

export const LANGS: readonly Lang[] = ['ro', 'en'];

export function isLang(v: unknown): v is Lang {
  return v === 'ro' || v === 'en';
}

/**
 * The full set of message keys. String members are static; function members
 * take runtime parameters. Both language maps must implement every member.
 */
export interface Catalog {
  // ── Commands / conversational ────────────────────────────────────────────
  start_welcome: string;
  help_body: string;
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
    /** True when a search watch only alerts on at-or-below-median listings. */
    dealsOnly: boolean;
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
  btn_deals_only: string;
  btn_required: string;
  btn_block: string;
  btn_rename: string;
  btn_pause: string;
  btn_resume: string;
  btn_edit: string;
  btn_target: string;
  btn_open: string;
  btn_call: string;
  btn_price_history: string;
  btn_freq: (minutes: number) => string;
  // Browse carousel.
  btn_prev: string;
  btn_next: string;
  btn_track: string;
  btn_jump: string;
  btn_switch: string;
  btn_browse_all: string;
  browse_in_stock: string;
  browse_out_of_stock: string;
  /** One-line price rating vs comparable listings; '' for an unknown verdict. */
  price_rating: (p: { tag: 'great_deal' | 'fair_price' | 'overpriced' | 'unknown'; percentile: number; n: number }) => string;
  browse_position: (n: number, total: number) => string;
  browse_empty: string;
  browse_track_done: (title: string) => string;
  browse_track_exists: string;
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
  cb_deals_on: string;
  cb_deals_off: string;
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
  /** Market-insight footer on a product alert (time-on-market, price cuts, low). */
  insight_line: (p: { days?: number; cuts: number; low: string }) => string;
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
    '• /lang ro|en — schimbă limba.\n' +
    '• Apasă „Istoric preț” pe orice alertă pentru un grafic.',
  track_usage: 'Folosire: /track <link>',
  track_error: 'Nu am putut înregistra urmărirea. Te rog încearcă din nou.',
  list_empty: 'Nicio urmărire încă. Trimite un link de anunț ca să creezi una.',
  list_intro: 'Urmăririle tale:',
  list_item: ({ id, vendor, type, seller, url, exclusions, tracked, label, paused, dealsOnly, required, blocked }) =>
    `#${id} · ${tracked ? '📌 ' : ''}${paused ? '⏸ ' : ''}${label ? `„${label}” (${vendor})` : vendor} · ${type}` +
    // Seller filter, deals-only & keyword filters only apply to search watches; a
    // product watch tracks one listing, so they'd be meaningless noise.
    (type === 'search' ? ` · vânzător=${seller}` : '') +
    (type === 'search' && dealsOnly ? ' · doar oferte' : '') +
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
  edit_card: ({ id, vendor, type, minutes, label, paused }) =>
    `✏️ Editezi urmărirea #${id} · ${label ? `„${label}” (${vendor})` : vendor} · ${type}${paused ? ' · ⏸ pe pauză' : ''}\n` +
    `Verificare la fiecare ${minutes} min. Ajustează mai jos:`,
  lang_current: (n) => `Limba curentă: ${n}. Schimbă cu /lang ro|en.`,
  lang_set: (n) => `Limba a fost setată: ${n}.`,
  lang_usage: 'Folosire: /lang ro|en',
  lang_name: 'Română',
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
  btn_deals_only: '🔥 Doar oferte',
  btn_required: '✅ Cuvinte necesare',
  btn_block: '⛔ Blochează vânzător',
  btn_rename: '✏️ Redenumește',
  btn_pause: '⏸ Pauză',
  btn_resume: '▶️ Reia',
  btn_edit: '✏️ Editează',
  btn_target: '🎯 Preț țintă',
  btn_open: '🔗 Deschide',
  btn_call: '📞 Sună',
  btn_price_history: '📊 Istoric preț',
  btn_freq: (m) => `⏱ ${m} min`,
  btn_prev: '◀️ Înapoi',
  btn_next: 'Înainte ▶️',
  btn_track: '📌 Urmărește',
  btn_jump: '🔢 Sari la #',
  btn_switch: '🔀 Schimbă',
  btn_browse_all: '📂 Toate anunțurile',
  browse_in_stock: '🟢 disponibil',
  browse_out_of_stock: '🔴 indisponibil',
  price_rating: ({ tag, percentile, n }) => {
    if (tag === 'great_deal') return `🟢 Ofertă bună — mai ieftin ca ${Math.round((1 - percentile) * 100)}% din ${n} similare`;
    if (tag === 'overpriced') return `🔴 Peste piață — mai scump ca ${Math.round(percentile * 100)}% din ${n} similare`;
    if (tag === 'fair_price') return `🟡 Preț corect — în jurul mediei (${n} similare)`;
    return '';
  },
  browse_position: (n, total) => `articolul ${n} din ${total}`,
  browse_empty: 'Niciun anunț colectat încă. Adaugă o urmărire cu un link, apoi revino.',
  browse_track_done: (title) => `📌 Urmăresc acum „${title}". Te anunț la schimbări de preț și la eliminare.`,
  browse_track_exists: 'Urmărești deja acest anunț.',
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
  cb_deals_on: 'Doar oferte bune: pornit.',
  cb_deals_off: 'Doar oferte bune: oprit.',
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
    '• /lang ro|en — change language.\n' +
    '• Tap “Price history” on any alert for a chart.',
  track_usage: 'Usage: /track <url>',
  track_error: 'Sorry — I could not register that watch. Please try again.',
  list_empty: 'No watches yet. Send a listing link to create one.',
  list_intro: 'Your watches:',
  list_item: ({ id, vendor, type, seller, url, exclusions, tracked, label, paused, dealsOnly, required, blocked }) =>
    `#${id} · ${tracked ? '📌 ' : ''}${paused ? '⏸ ' : ''}${label ? `“${label}” (${vendor})` : vendor} · ${type}` +
    // Seller filter, deals-only & keyword filters only apply to search watches; a
    // product watch tracks one listing, so they'd be meaningless noise.
    (type === 'search' ? ` · seller=${seller}` : '') +
    (type === 'search' && dealsOnly ? ' · deals only' : '') +
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
  edit_card: ({ id, vendor, type, minutes, label, paused }) =>
    `✏️ Editing watch #${id} · ${label ? `“${label}” (${vendor})` : vendor} · ${type}${paused ? ' · ⏸ paused' : ''}\n` +
    `Checks every ${minutes} min. Adjust below:`,
  lang_current: (n) => `Current language: ${n}. Change with /lang ro|en.`,
  lang_set: (n) => `Language set to ${n}.`,
  lang_usage: 'Usage: /lang ro|en',
  lang_name: 'English',
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
  btn_deals_only: '🔥 Deals only',
  btn_required: '✅ Required words',
  btn_block: '⛔ Block seller',
  btn_rename: '✏️ Rename',
  btn_pause: '⏸ Pause',
  btn_resume: '▶️ Resume',
  btn_edit: '✏️ Edit',
  btn_target: '🎯 Target price',
  btn_open: '🔗 Open',
  btn_call: '📞 Call',
  btn_price_history: '📊 Price history',
  btn_freq: (m) => `⏱ ${m} min`,
  btn_prev: '◀️ Prev',
  btn_next: 'Next ▶️',
  btn_track: '📌 Track',
  btn_jump: '🔢 Jump to #',
  btn_switch: '🔀 Switch',
  btn_browse_all: '📂 All listings',
  browse_in_stock: '🟢 available',
  browse_out_of_stock: '🔴 unavailable',
  price_rating: ({ tag, percentile, n }) => {
    if (tag === 'great_deal') return `🟢 Great deal — cheaper than ${Math.round((1 - percentile) * 100)}% of ${n} similar`;
    if (tag === 'overpriced') return `🔴 Above market — pricier than ${Math.round(percentile * 100)}% of ${n} similar`;
    if (tag === 'fair_price') return `🟡 Fair price — around the going rate (${n} similar)`;
    return '';
  },
  browse_position: (n, total) => `item ${n} of ${total}`,
  browse_empty: 'No items collected yet. Add a watch with a link, then come back.',
  browse_track_done: (title) => `📌 Now tracking "${title}". I'll alert you on price changes and de-listing.`,
  browse_track_exists: "You're already tracking this item.",
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
  cb_deals_on: 'Deals only: on.',
  cb_deals_off: 'Deals only: off.',
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
    { command: 'check', description: 'Verifică o urmărire acum (/check <id>)' },
    { command: 'edit', description: 'Modifică o urmărire (/edit <id>)' },
    { command: 'stats', description: 'Rezumatul urmăririlor tale' },
    { command: 'rate', description: 'Evaluează prețul unui link (/rate <link>)' },
    { command: 'history', description: 'Grafic preț pentru o urmărire (/history <id>)' },
    { command: 'export', description: 'Exportă anunțurile colectate (CSV)' },
    { command: 'remove', description: 'Oprește o urmărire (/remove <id>)' },
    { command: 'lang', description: 'Schimbă limba (/lang ro|en)' },
    { command: 'request_access', description: 'Cere acces la bot' },
    { command: 'help', description: 'Cum se folosește botul' },
  ],
  en: [
    { command: 'start', description: 'Start the bot' },
    { command: 'track', description: 'Watch a listing link' },
    { command: 'list', description: 'Show this chat’s watches' },
    { command: 'browse', description: 'Browse collected listings' },
    { command: 'check', description: 'Check a watch now (/check <id>)' },
    { command: 'edit', description: 'Edit a watch (/edit <id>)' },
    { command: 'stats', description: 'Summary of your watches' },
    { command: 'rate', description: 'Rate a link’s price (/rate <url>)' },
    { command: 'history', description: 'Price chart for a watch (/history <id>)' },
    { command: 'export', description: 'Export collected listings (CSV)' },
    { command: 'remove', description: 'Stop a watch (/remove <id>)' },
    { command: 'lang', description: 'Change language (/lang ro|en)' },
    { command: 'request_access', description: 'Request access to the bot' },
    { command: 'help', description: 'How to use the bot' },
  ],
};

/** All catalogs, keyed by language. */
export const messages: Record<Lang, Catalog> = { ro, en };

/** Convenience accessor: the catalog for `lang`. */
export function tr(lang: Lang): Catalog {
  return messages[lang];
}

/**
 * Localized message catalog (RO default, EN on request).
 *
 * Every user-facing string lives here — commands, cards, notifications, errors,
 * and button labels. The {@link Catalog} interface makes completeness a COMPILE
 * error: a key missing from either language fails `tsc`. Callers read copy via
 * `tr(lang).<key>` (a plain string, or a function for parameterized messages).
 */

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
  list_item: (p: { id: number; vendor: string; type: string; seller: string; url: string }) => string;
  remove_usage: string;
  remove_done: (id: number) => string;
  remove_not_found: string;
  lang_current: (langName: string) => string;
  lang_set: (langName: string) => string;
  lang_usage: string;
  lang_name: string; // this language's own name, e.g. "Română" / "English"
  unknown_command: string;
  send_link_hint: string;
  generic_error: string;

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
  btn_remove: string;
  btn_open: string;
  btn_call: string;
  btn_price_history: string;
  btn_freq: (minutes: number) => string;

  // ── Callback answers / prompts ────────────────────────────────────────────
  cb_seller_set: (visibility: string) => string;
  cb_monitoring_started: string;
  cb_watch_gone: string;
  cb_unknown_option: string;
  cb_setting_error: string;
  cb_removed: string;
  cb_freq_set: (minutes: number) => string;
  exclusion_prompt: string;
  exclusion_set: (keywords: string) => string;
  exclusion_cleared: string;
  price_history_insufficient: string;
  price_history_error: string;

  // ── Notification cards ────────────────────────────────────────────────────
  seller_private: string;
  seller_company: string;
  badge_great_deal: string;
  badge_fair_price: string;
  badge_overpriced: string;
  also_on: (sources: string) => string;
  price_drop: (p: { title: string; oldPrice: string; newPrice: string; savings: string }) => string;
  back_in_stock_title: string;
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
    '• /remove <id> — oprește o urmărire.\n' +
    '• /lang ro|en — schimbă limba.\n' +
    '• Apasă „Istoric preț” pe orice alertă pentru un grafic.',
  track_usage: 'Folosire: /track <link>',
  track_error: 'Nu am putut înregistra urmărirea. Te rog încearcă din nou.',
  list_empty: 'Nicio urmărire încă. Trimite un link de anunț ca să creezi una.',
  list_intro: 'Urmăririle tale:',
  list_item: ({ id, vendor, type, seller, url }) =>
    `#${id} · ${vendor} · ${type} · vânzător=${seller}\n${url}`,
  remove_usage: 'Folosire: /remove <id>',
  remove_done: (id) => `Urmărirea #${id} a fost oprită.`,
  remove_not_found: 'Urmărirea nu există sau nu îți aparține.',
  lang_current: (n) => `Limba curentă: ${n}. Schimbă cu /lang ro|en.`,
  lang_set: (n) => `Limba a fost setată: ${n}.`,
  lang_usage: 'Folosire: /lang ro|en',
  lang_name: 'Română',
  unknown_command: 'Comandă necunoscută. Încearcă /help.',
  send_link_hint: 'Trimite-mi un link de anunț pentru urmărire, sau /help.',
  generic_error: 'Ceva nu a mers bine. Te rog încearcă din nou.',

  reg_watching: (v) => `✅ Urmăresc ${v}`,
  reg_baseline: (c) => `📦 Bază: ${c} anunț${c === 1 ? '' : 'uri'} înregistrat${c === 1 ? '' : 'e'}.`,
  reg_tune_prompt: 'Reglează urmărirea, apoi pornește monitorizarea:',

  btn_private: '👤 Privat',
  btn_company: '🏢 Firmă',
  btn_both: '👥 Ambele',
  btn_exclusion: '🚫 Cuvinte excluse',
  btn_start: '▶️ Pornește',
  btn_remove: '🗑 Șterge',
  btn_open: '🔗 Deschide',
  btn_call: '📞 Sună',
  btn_price_history: '📊 Istoric preț',
  btn_freq: (m) => `⏱ ${m} min`,

  cb_seller_set: (v) => `Filtru vânzător: ${v}`,
  cb_monitoring_started: 'Monitorizare pornită',
  cb_watch_gone: 'Urmărirea nu mai există.',
  cb_unknown_option: 'Opțiune necunoscută.',
  cb_setting_error: 'Nu am putut actualiza setarea.',
  cb_removed: 'Urmărire ștearsă.',
  cb_freq_set: (m) => `Frecvență: ${m} min`,
  exclusion_prompt: 'Trimite cuvintele de exclus, separate prin virgulă (ex.: lovit, piese, dube).',
  exclusion_set: (kw) => `Exclud: ${kw}`,
  exclusion_cleared: 'Toate cuvintele excluse au fost șterse.',
  price_history_insufficient: 'Încă nu sunt suficiente date de preț.',
  price_history_error: 'Nu am putut genera istoricul de preț.',

  seller_private: '👤 Vânzător privat',
  seller_company: '🏢 Firmă',
  badge_great_deal: '🔥 Chilipir',
  badge_fair_price: '📊 Preț corect',
  badge_overpriced: '📈 Supraevaluat',
  also_on: (s) => `Și pe: ${s}`,
  price_drop: ({ title, oldPrice, newPrice, savings }) =>
    `📉 Scădere de preț la ${title}: ${oldPrice} → ${newPrice} (economisești ${savings})`,
  back_in_stock_title: '🟢 REVENIT ÎN STOC',
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
    '• /remove <id> — stop a watch.\n' +
    '• /lang ro|en — change language.\n' +
    '• Tap “Price history” on any alert for a chart.',
  track_usage: 'Usage: /track <url>',
  track_error: 'Sorry — I could not register that watch. Please try again.',
  list_empty: 'No watches yet. Send a listing link to create one.',
  list_intro: 'Your watches:',
  list_item: ({ id, vendor, type, seller, url }) =>
    `#${id} · ${vendor} · ${type} · seller=${seller}\n${url}`,
  remove_usage: 'Usage: /remove <id>',
  remove_done: (id) => `Watch #${id} stopped.`,
  remove_not_found: 'That watch does not exist or is not yours.',
  lang_current: (n) => `Current language: ${n}. Change with /lang ro|en.`,
  lang_set: (n) => `Language set to ${n}.`,
  lang_usage: 'Usage: /lang ro|en',
  lang_name: 'English',
  unknown_command: 'Unknown command. Try /help.',
  send_link_hint: 'Send me a listing link to watch, or /help.',
  generic_error: 'Sorry — something went wrong. Please try again.',

  reg_watching: (v) => `✅ Watching ${v}`,
  reg_baseline: (c) => `📦 Baseline: ${c} listing${c === 1 ? '' : 's'} recorded.`,
  reg_tune_prompt: 'Tune the watch, then start monitoring:',

  btn_private: '👤 Private',
  btn_company: '🏢 Company',
  btn_both: '👥 Both',
  btn_exclusion: '🚫 Exclusion keywords',
  btn_start: '▶️ Start',
  btn_remove: '🗑 Remove',
  btn_open: '🔗 Open',
  btn_call: '📞 Call',
  btn_price_history: '📊 Price history',
  btn_freq: (m) => `⏱ ${m} min`,

  cb_seller_set: (v) => `Seller filter: ${v}`,
  cb_monitoring_started: 'Monitoring started',
  cb_watch_gone: 'That watch no longer exists.',
  cb_unknown_option: 'Unknown option.',
  cb_setting_error: 'Could not update that setting.',
  cb_removed: 'Watch removed.',
  cb_freq_set: (m) => `Frequency: ${m} min`,
  exclusion_prompt: 'Send a comma-separated list of keywords to exclude (e.g. damaged, parts, salvage).',
  exclusion_set: (kw) => `Excluding: ${kw}`,
  exclusion_cleared: 'Cleared all exclusion keywords.',
  price_history_insufficient: 'Not enough price history yet.',
  price_history_error: 'Could not render the price history.',

  seller_private: '👤 Private seller',
  seller_company: '🏢 Company',
  badge_great_deal: '🔥 Great Deal',
  badge_fair_price: '📊 Fair Market Price',
  badge_overpriced: '📈 Overpriced',
  also_on: (s) => `Also on: ${s}`,
  price_drop: ({ title, oldPrice, newPrice, savings }) =>
    `📉 Price drop on ${title}: ${oldPrice} → ${newPrice} (save ${savings})`,
  back_in_stock_title: '🟢 BACK IN STOCK',
};

/** All catalogs, keyed by language. */
export const messages: Record<Lang, Catalog> = { ro, en };

/** Convenience accessor: the catalog for `lang`. */
export function tr(lang: Lang): Catalog {
  return messages[lang];
}

/**
 * Per-chat language resolution — Romanian-first.
 *
 * An explicitly stored chat preference wins; otherwise the Romanian default
 * applies. The Telegram client locale is intentionally NOT consulted: this is a
 * Romanian-audience bot, and English is an explicit opt-in via `/lang en`.
 */
import { type Lang, isLang } from './strings';

export const DEFAULT_LANG: Lang = 'ro';

/** @param stored The chat's saved preference, if any (`undefined` = unset). */
export function resolveLang(stored: string | undefined): Lang {
  return isLang(stored) ? stored : DEFAULT_LANG;
}

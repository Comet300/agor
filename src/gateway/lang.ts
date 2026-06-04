/**
 * Per-chat language resolution.
 *
 * Order: an explicitly stored chat preference wins; otherwise the Telegram
 * `language_code` (anything starting with `en` ⇒ English) decides; otherwise the
 * Romanian default for the target market.
 */
import { type Lang, isLang } from './strings';

export const DEFAULT_LANG: Lang = 'ro';

/**
 * @param stored        The chat's saved preference, if any (`undefined` = unset).
 * @param telegramCode  `ctx.from?.language_code` from the incoming update.
 */
export function resolveLang(stored: string | undefined, telegramCode?: string): Lang {
  if (isLang(stored)) return stored;
  if (telegramCode && telegramCode.toLowerCase().startsWith('en')) return 'en';
  return DEFAULT_LANG;
}

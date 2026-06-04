/**
 * Per-chat preference persistence.
 *
 * Stores the chat's chosen language, keyed by chat id. A chat may have a
 * preference before it owns any monitor (language is a chat property, not a
 * monitor property), so it lives in its own `chat_prefs` table rather than being
 * overloaded onto `monitors`.
 */

import type { DB } from './db';

/** Raw shape of a `chat_prefs` table row. */
interface ChatPrefRow {
  chat_id: number;
  lang: string;
}

export class ChatPrefsRepo {
  constructor(private readonly db: DB) {}

  /** The chat's stored language, or `undefined` when never set. */
  getLang(chatId: number): string | undefined {
    const row = this.db
      .prepare(`SELECT chat_id, lang FROM chat_prefs WHERE chat_id = ?`)
      .get(chatId) as ChatPrefRow | undefined;
    return row?.lang ?? undefined;
  }

  /** Upsert the chat's language preference. */
  setLang(chatId: number, lang: string): void {
    this.db
      .prepare(
        `INSERT INTO chat_prefs (chat_id, lang)
         VALUES (@chatId, @lang)
         ON CONFLICT(chat_id) DO UPDATE SET lang = excluded.lang`,
      )
      .run({ chatId, lang });
  }
}

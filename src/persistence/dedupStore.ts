/**
 * Persistence for the cross-cycle dedup buffer, so already-seen listings are not
 * re-alerted after a restart/deploy. Each row is one dedup entry for one chat,
 * stored as JSON (the entry holds the signature, first-seen time, the original
 * enriched item, and the Telegram message ref for later cross-post edits).
 *
 * The {@link DedupBuffer} talks to this through the small {@link DedupStore}
 * seam, keeping the buffer itself pure and unit-testable without a database.
 */

import type { DB } from './db';

/** One persisted dedup entry, serialized verbatim from the buffer. */
export interface PersistedDedupEntry {
  signature: string;
  firstSeenAt: number;
  /** The buffer's DedupEntry, structured-cloneable; stored as JSON. */
  entry: unknown;
}

/** The seam the {@link DedupBuffer} uses to survive restarts. Per-chat keyed. */
export interface DedupStore {
  /** All entries for a chat (used to rehydrate a buffer on construction). */
  load(chatId: number): PersistedDedupEntry[];
  /** Upsert one entry for a chat. */
  save(chatId: number, e: PersistedDedupEntry): void;
  /** Delete one entry (a pruned/expired signature). */
  remove(chatId: number, signature: string): void;
  /** Delete every entry older than `maxAgeMs` across ALL chats. */
  pruneExpired(now: number, maxAgeMs: number): void;
}

export class DedupRepo implements DedupStore {
  constructor(private readonly db: DB) {}

  load(chatId: number): PersistedDedupEntry[] {
    const rows = this.db
      .prepare(`SELECT signature, first_seen_at, entry_json FROM dedup WHERE chat_id = ?`)
      .all(chatId) as Array<{ signature: string; first_seen_at: number; entry_json: string }>;
    const out: PersistedDedupEntry[] = [];
    for (const r of rows) {
      try {
        out.push({ signature: r.signature, firstSeenAt: r.first_seen_at, entry: JSON.parse(r.entry_json) });
      } catch {
        // A corrupt row is skipped rather than crashing rehydration.
      }
    }
    return out;
  }

  save(chatId: number, e: PersistedDedupEntry): void {
    this.db
      .prepare(
        `INSERT INTO dedup (chat_id, signature, first_seen_at, entry_json)
         VALUES (@chatId, @signature, @firstSeenAt, @entryJson)
         ON CONFLICT(chat_id, signature) DO UPDATE SET
           first_seen_at = excluded.first_seen_at,
           entry_json    = excluded.entry_json`,
      )
      .run({
        chatId,
        signature: e.signature,
        firstSeenAt: e.firstSeenAt,
        entryJson: JSON.stringify(e.entry),
      });
  }

  remove(chatId: number, signature: string): void {
    this.db.prepare(`DELETE FROM dedup WHERE chat_id = ? AND signature = ?`).run(chatId, signature);
  }

  /**
   * Delete every entry first-seen before `now - maxAgeMs`, across all chats.
   * In-memory pruning only fires while a chat's monitors are polled, so idle or
   * removed monitors leave rows behind; this is the durable backstop (run on
   * boot and during periodic maintenance) that keeps the table bounded.
   */
  pruneExpired(now: number, maxAgeMs: number): void {
    this.db.prepare(`DELETE FROM dedup WHERE first_seen_at < ?`).run(now - maxAgeMs);
  }
}

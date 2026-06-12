/**
 * Access-control persistence: the user allowlist keyed by Telegram chat id.
 *
 * Deny-by-default — only chats with status `allowed` (or an admin) may use the
 * bot. This table is ALSO the source of truth mapping a chat id to the person's
 * name + email (collected at request time, tracking-only), so an operator can
 * trace which chat belongs to whom. Name/email never go to logs — logs carry the
 * chat id, this table maps it to a person.
 */

import type { DB } from './db';

/** Lifecycle of a chat's access. */
export type AccessStatus = 'unknown' | 'pending' | 'allowed' | 'denied';

/** Days a denied chat must wait before it may request access again. */
export const REAPPLY_COOLDOWN_DAYS = 7;
const DAY_MS = 86_400_000;

/** Outcome of a {@link AccessRepo.request} attempt. */
export type RequestOutcome =
  | { outcome: 'sent' }
  | { outcome: 'already_pending' }
  | { outcome: 'already_allowed' }
  | { outcome: 'too_soon'; daysLeft: number };

/**
 * A stored access record. Most chats reach a row via request/allow/deny; a row
 * can also exist in `unknown` status when only a tracking field (name/email) was
 * set before any access decision.
 */
export interface AccessRecord {
  chatId: number;
  status: AccessStatus;
  isAdmin: boolean;
  name?: string;
  email?: string;
  requestedAt?: number;
  decidedAt?: number;
  decidedBy?: number;
}

/** Raw `access` table row (snake_case, integer boolean). */
interface AccessRow {
  chat_id: number;
  status: string;
  is_admin: number;
  name: string | null;
  email: string | null;
  requested_at: number | null;
  decided_at: number | null;
  decided_by: number | null;
}

function rowToRecord(row: AccessRow): AccessRecord {
  return {
    chatId: row.chat_id,
    status: row.status as AccessStatus,
    isAdmin: row.is_admin === 1,
    name: row.name ?? undefined,
    email: row.email ?? undefined,
    requestedAt: row.requested_at ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    decidedBy: row.decided_by ?? undefined,
  };
}

export class AccessRepo {
  constructor(private readonly db: DB) {}

  /** The full record for a chat, or `undefined` when it has never been seen. */
  get(chatId: number): AccessRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM access WHERE chat_id = ?`)
      .get(chatId) as AccessRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Lifecycle status of a chat (`unknown` when it has no row). */
  statusOf(chatId: number): AccessStatus {
    return this.get(chatId)?.status ?? 'unknown';
  }

  /** True when the chat may use the bot (status `allowed`, which admins always are). */
  isAllowed(chatId: number): boolean {
    return this.get(chatId)?.status === 'allowed';
  }

  /** True when the chat is an admin. */
  isAdmin(chatId: number): boolean {
    return this.get(chatId)?.isAdmin === true;
  }

  /** True when at least one admin exists anywhere (drives the bootstrap rule). */
  hasAnyAdmin(): boolean {
    const row = this.db.prepare(`SELECT 1 FROM access WHERE is_admin = 1 LIMIT 1`).get();
    return row !== undefined;
  }

  /**
   * Days a denied chat must still wait before it may request again, or 0 when it
   * may request now (not denied, or the cooldown has elapsed). Read-only.
   */
  cooldownDaysLeft(chatId: number, now: number): number {
    const rec = this.get(chatId);
    if (rec?.status !== 'denied' || rec.decidedAt === undefined) return 0;
    const remaining = REAPPLY_COOLDOWN_DAYS * DAY_MS - (now - rec.decidedAt);
    return remaining > 0 ? Math.ceil(remaining / DAY_MS) : 0;
  }

  /** Every known chat, in chat-id order. */
  list(): AccessRecord[] {
    const rows = this.db.prepare(`SELECT * FROM access ORDER BY chat_id`).all() as AccessRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Record (or refresh) a pending access request with the requester's name and
   * email. Returns a discriminated {@link RequestOutcome}:
   *   - `already_allowed` — the chat already has access (no-op),
   *   - `already_pending` — a request is already awaiting a decision (details
   *     are still refreshed),
   *   - `too_soon`        — denied less than {@link REAPPLY_COOLDOWN_DAYS} ago;
   *     the request is refused and `daysLeft` says how long to wait,
   *   - `sent`            — a fresh pending request was recorded.
   */
  request(chatId: number, who: { name: string; email: string }, at: number): RequestOutcome {
    const existing = this.get(chatId);

    if (existing?.status === 'allowed') return { outcome: 'already_allowed' };

    // A denied chat must wait out the re-apply cooldown from its decision time.
    if (existing?.status === 'denied' && existing.decidedAt !== undefined) {
      const elapsed = at - existing.decidedAt;
      const windowMs = REAPPLY_COOLDOWN_DAYS * DAY_MS;
      if (elapsed < windowMs) {
        return { outcome: 'too_soon', daysLeft: Math.ceil((windowMs - elapsed) / DAY_MS) };
      }
    }

    const wasPending = existing?.status === 'pending';
    this.db
      .prepare(
        `INSERT INTO access (chat_id, status, is_admin, name, email, requested_at)
         VALUES (@chatId, 'pending', 0, @name, @email, @at)
         ON CONFLICT(chat_id) DO UPDATE SET
           status       = 'pending',
           name         = excluded.name,
           email        = excluded.email,
           requested_at = excluded.requested_at`,
      )
      .run({ chatId, name: who.name, email: who.email, at });

    return wasPending ? { outcome: 'already_pending' } : { outcome: 'sent' };
  }

  /** Grant access to a chat (creating the row if the admin grants directly). */
  allow(chatId: number, by: { by: number; at: number }): void {
    this.db
      .prepare(
        `INSERT INTO access (chat_id, status, is_admin, decided_at, decided_by)
         VALUES (@chatId, 'allowed', 0, @at, @by)
         ON CONFLICT(chat_id) DO UPDATE SET
           status     = 'allowed',
           decided_at = excluded.decided_at,
           decided_by = excluded.decided_by`,
      )
      .run({ chatId, at: by.at, by: by.by });
  }

  /** Revoke/deny a chat. No-op for an admin (admins are always allowed). */
  deny(chatId: number, by: { by: number; at: number }): void {
    if (this.isAdmin(chatId)) return;
    this.db
      .prepare(
        `INSERT INTO access (chat_id, status, is_admin, decided_at, decided_by)
         VALUES (@chatId, 'denied', 0, @at, @by)
         ON CONFLICT(chat_id) DO UPDATE SET
           status     = 'denied',
           decided_at = excluded.decided_at,
           decided_by = excluded.decided_by`,
      )
      .run({ chatId, at: by.at, by: by.by });
  }

  /** Promote a chat to admin (also grants access). Idempotent. */
  promote(chatId: number): void {
    this.seedAdmin(chatId);
  }

  /**
   * Demote an admin back to a plain allowed user. Refuses to remove the LAST
   * admin (so the bot can never be left with no administrator). Returns true on
   * success, false when it would orphan the bot.
   */
  demote(chatId: number): boolean {
    if (!this.isAdmin(chatId)) return true; // already not an admin — nothing to do
    const adminCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM access WHERE is_admin = 1`).get() as { n: number }).n;
    if (adminCount <= 1) return false; // never demote the last admin
    this.db.prepare(`UPDATE access SET is_admin = 0, status = 'allowed' WHERE chat_id = ?`).run(chatId);
    return true;
  }

  /** Seed a bootstrap admin from configuration: allowed + admin, idempotent. */
  seedAdmin(chatId: number): void {
    this.db
      .prepare(
        `INSERT INTO access (chat_id, status, is_admin)
         VALUES (@chatId, 'allowed', 1)
         ON CONFLICT(chat_id) DO UPDATE SET status = 'allowed', is_admin = 1`,
      )
      .run({ chatId });
  }

  /** Edit the stored name (tracking only); creates the row if absent. */
  setName(chatId: number, name: string): void {
    this.db
      .prepare(
        `INSERT INTO access (chat_id, status, is_admin, name)
         VALUES (@chatId, 'unknown', 0, @name)
         ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name`,
      )
      .run({ chatId, name });
  }

  /** Edit the stored email (tracking only); creates the row if absent. */
  setEmail(chatId: number, email: string): void {
    this.db
      .prepare(
        `INSERT INTO access (chat_id, status, is_admin, email)
         VALUES (@chatId, 'unknown', 0, @email)
         ON CONFLICT(chat_id) DO UPDATE SET email = excluded.email`,
      )
      .run({ chatId, email });
  }
}

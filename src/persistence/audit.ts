/**
 * Audit log: a durable, queryable record of access-control decisions
 * (allow / deny / promote / demote / first-admin bootstrap). Complements the
 * pino event log — those can roll off, this stays in the DB for `/audit`.
 */

import type { DB } from './db';

/** The access decisions worth auditing. */
export type AuditAction = 'allow' | 'deny' | 'promote' | 'demote' | 'bootstrap_admin';

/** A stored audit entry. */
export interface AuditEntry {
  id: number;
  action: AuditAction;
  /** The chat the decision was about. */
  targetChatId: number;
  /** The admin who made it (equals target for a self-service bootstrap). */
  actorChatId: number;
  at: number;
  note?: string;
}

interface AuditRow {
  id: number;
  action: string;
  target_chat_id: number;
  actor_chat_id: number;
  at: number;
  note: string | null;
}

function rowToEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    action: r.action as AuditAction,
    targetChatId: r.target_chat_id,
    actorChatId: r.actor_chat_id,
    at: r.at,
    note: r.note ?? undefined,
  };
}

export class AuditRepo {
  constructor(private readonly db: DB) {}

  /** Append one audit entry. */
  log(action: AuditAction, targetChatId: number, actorChatId: number, at: number, note?: string): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (action, target_chat_id, actor_chat_id, at, note)
         VALUES (@action, @target, @actor, @at, @note)`,
      )
      .run({ action, target: targetChatId, actor: actorChatId, at, note: note ?? null });
  }

  /** The most recent entries, newest first (default 20). */
  recent(limit = 20): AuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?`)
      .all(limit) as AuditRow[];
    return rows.map(rowToEntry);
  }
}

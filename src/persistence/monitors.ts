/**
 * Monitor persistence: the durable record of every watch the scheduler polls.
 *
 * Rows store `filters` as a JSON blob and `fast_tier` as a 0/1 integer; the
 * repo translates both ways so callers only ever touch the typed {@link Monitor}.
 */

import type { FilterConfig, Monitor, MonitorOrigin, MonitorType } from '../contracts';
import type { DB } from './db';

/** Fields a caller supplies when registering a brand-new monitor. */
export interface NewMonitor {
  type: MonitorType;
  chatId: number;
  vendor: string;
  url: string;
  filters: FilterConfig;
  intervalMs: number;
  /** ms epoch of the first scheduled poll. */
  nextDueAt: number;
  /** How the watch was created; defaults to 'user'. */
  origin?: MonitorOrigin;
}

/** Raw shape of a `monitors` table row (snake_case, integer booleans). */
interface MonitorRow {
  id: number;
  type: string;
  chat_id: number;
  vendor: string;
  url: string;
  filters_json: string;
  interval_ms: number;
  fast_tier: number;
  next_due_at: number;
  consecutive_failures: number | null;
  created_at: number;
  origin: string | null;
  paused: number | null;
  label: string | null;
}

/** Map a DB row into the typed domain {@link Monitor}. */
function rowToMonitor(row: MonitorRow): Monitor {
  const monitor: Monitor = {
    id: row.id,
    type: row.type as MonitorType,
    origin: (row.origin as MonitorOrigin) ?? 'user',
    chatId: row.chat_id,
    vendor: row.vendor,
    url: row.url,
    filters: JSON.parse(row.filters_json) as FilterConfig,
    intervalMs: row.interval_ms,
    fastTier: row.fast_tier === 1,
    nextDueAt: row.next_due_at,
    consecutiveFailures: row.consecutive_failures ?? 0,
    paused: row.paused === 1,
    createdAt: row.created_at,
  };
  if (row.label != null && row.label !== '') monitor.label = row.label;
  return monitor;
}

export class MonitorRepo {
  constructor(private readonly db: DB) {}

  /** Insert a new monitor (fast tier off, created stamped to now) and return it. */
  create(input: NewMonitor): Monitor {
    const createdAt = Date.now();
    const origin: MonitorOrigin = input.origin ?? 'user';
    const info = this.db
      .prepare(
        `INSERT INTO monitors
           (type, chat_id, vendor, url, filters_json, interval_ms, fast_tier, next_due_at, created_at, origin)
         VALUES
           (@type, @chatId, @vendor, @url, @filtersJson, @intervalMs, 0, @nextDueAt, @createdAt, @origin)`,
      )
      .run({
        type: input.type,
        chatId: input.chatId,
        vendor: input.vendor,
        url: input.url,
        filtersJson: JSON.stringify(input.filters),
        intervalMs: input.intervalMs,
        nextDueAt: input.nextDueAt,
        createdAt,
        origin,
      });

    return {
      id: Number(info.lastInsertRowid),
      type: input.type,
      origin,
      chatId: input.chatId,
      vendor: input.vendor,
      url: input.url,
      filters: input.filters,
      intervalMs: input.intervalMs,
      fastTier: false,
      nextDueAt: input.nextDueAt,
      consecutiveFailures: 0,
      paused: false,
      createdAt,
    };
  }

  /** Fetch a single monitor by id, or `undefined` when absent. */
  get(id: number): Monitor | undefined {
    const row = this.db
      .prepare(`SELECT * FROM monitors WHERE id = ?`)
      .get(id) as MonitorRow | undefined;
    return row ? rowToMonitor(row) : undefined;
  }

  /** All monitors owned by a chat, in insertion order. */
  listByChat(chatId: number): Monitor[] {
    const rows = this.db
      .prepare(`SELECT * FROM monitors WHERE chat_id = ? ORDER BY id`)
      .all(chatId) as MonitorRow[];
    return rows.map(rowToMonitor);
  }

  /**
   * Monitors whose next poll is due at or before `now`, soonest first. Paused
   * watches are skipped — they keep their config and history but are not polled.
   */
  listDue(now: number): Monitor[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM monitors
          WHERE next_due_at <= ? AND (paused IS NULL OR paused = 0)
          ORDER BY next_due_at`,
      )
      .all(now) as MonitorRow[];
    return rows.map(rowToMonitor);
  }

  /** Persist the mutable fields of an existing monitor. */
  update(m: Monitor): void {
    this.db
      .prepare(
        `UPDATE monitors
            SET vendor       = @vendor,
                url          = @url,
                filters_json = @filtersJson,
                interval_ms  = @intervalMs,
                fast_tier    = @fastTier,
                next_due_at  = @nextDueAt
          WHERE id = @id`,
      )
      .run({
        id: m.id,
        vendor: m.vendor,
        url: m.url,
        filtersJson: JSON.stringify(m.filters),
        intervalMs: m.intervalMs,
        fastTier: m.fastTier ? 1 : 0,
        nextDueAt: m.nextDueAt,
      });
  }

  /** Re-arm a monitor's schedule and flip its fast/slow tier in one write. */
  setSchedule(id: number, nextDueAt: number, fastTier: boolean): void {
    this.db
      .prepare(
        `UPDATE monitors SET next_due_at = ?, fast_tier = ? WHERE id = ?`,
      )
      .run(nextDueAt, fastTier ? 1 : 0, id);
  }

  /** Persist a monitor's consecutive-failure count (failure surfacing). */
  setFailures(id: number, count: number): void {
    this.db.prepare(`UPDATE monitors SET consecutive_failures = ? WHERE id = ?`).run(count, id);
  }

  /** Pause or resume a monitor (paused watches are skipped by {@link listDue}). */
  setPaused(id: number, paused: boolean): void {
    this.db.prepare(`UPDATE monitors SET paused = ? WHERE id = ?`).run(paused ? 1 : 0, id);
  }

  /** Set or clear a monitor's user-given label (empty string clears it). */
  setLabel(id: number, label: string): void {
    this.db.prepare(`UPDATE monitors SET label = ? WHERE id = ?`).run(label || null, id);
  }

  /** Remove a monitor by id. */
  delete(id: number): void {
    this.db.prepare(`DELETE FROM monitors WHERE id = ?`).run(id);
  }
}

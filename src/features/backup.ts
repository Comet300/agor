/**
 * SQLite backup & restore.
 *
 * Backup uses better-sqlite3's online `.backup()` so a consistent snapshot is
 * taken even while the bot is writing. Restore is applied SAFELY at boot, before
 * the database is opened: an uploaded backup is first *staged* next to the live
 * DB, then on the next start it atomically replaces the live file (and its WAL
 * sidecars are cleared so SQLite can't replay stale journal over the restore).
 * Never overwriting an open database is what keeps this safe.
 */
import Database from 'better-sqlite3';
import { existsSync, renameSync, unlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../persistence/db';

/** Suffix of the staged-restore file that boot looks for next to the live DB. */
export const STAGED_SUFFIX = '.restore';

/** Take a consistent snapshot of the live DB to `destPath` (online backup). */
export async function snapshotTo(db: DB, destPath: string): Promise<void> {
  await db.backup(destPath);
}

/**
 * Produce a timestamped backup snapshot in the OS temp dir (for upload), and —
 * when `localDir` is set — also drop a copy there. Returns the temp snapshot path;
 * the caller deletes it after delivery. `now` is injected for a stable filename.
 */
export async function runBackup(db: DB, opts: { now: number; localDir?: string }): Promise<string> {
  const name = `agor-backup-${new Date(opts.now).toISOString().replace(/[:.]/g, '-')}.db`;
  const dest = join(tmpdir(), name);
  await snapshotTo(db, dest);
  if (opts.localDir) copyFileSync(dest, join(opts.localDir, name));
  return dest;
}

/**
 * Whether `path` is a readable SQLite database carrying agor's schema (a sentinel
 * `monitors` table). Used to reject a corrupt or unrelated upload before staging.
 */
export function isValidBackup(path: string): boolean {
  if (!existsSync(path)) return false;
  let probe: DB | undefined;
  try {
    probe = new Database(path, { readonly: true, fileMustExist: true });
    const row = probe
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='monitors'`)
      .get();
    return row !== undefined;
  } catch {
    return false;
  } finally {
    probe?.close();
  }
}

/**
 * Stage a validated backup for the next boot to apply. Copies the upload to
 * `<dbPath>.restore`. Throws if the file isn't a valid agor backup.
 */
export function stageRestore(dbPath: string, uploadedPath: string): void {
  if (!isValidBackup(uploadedPath)) throw new Error('not a valid agor backup');
  copyFileSync(uploadedPath, dbPath + STAGED_SUFFIX);
}

/**
 * Apply a staged restore if one exists and is valid — call ONCE at boot, before
 * opening the database. Atomically replaces the live DB with the staged file and
 * clears the `-wal`/`-shm` sidecars (otherwise SQLite could replay the old WAL
 * over the restored data). Returns true when a restore was applied.
 */
export function applyStagedRestore(dbPath: string): boolean {
  const staged = dbPath + STAGED_SUFFIX;
  if (!existsSync(staged)) return false;
  if (!isValidBackup(staged)) {
    unlinkSync(staged); // drop a bad stage so it can't wedge every boot
    return false;
  }
  renameSync(staged, dbPath); // atomic on the same filesystem
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  return true;
}

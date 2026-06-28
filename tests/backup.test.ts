import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../src/persistence';
import { snapshotTo, isValidBackup, stageRestore, applyStagedRestore, STAGED_SUFFIX } from '../src/features/backup';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'agor-backup-'));
}

function seedMonitor(store: Store, chatId: number): void {
  store.monitors.create({
    type: 'search', chatId, vendor: 'olx',
    url: 'https://www.olx.ro/q/',
    filters: { sellerVisibility: 'both', exclusionKeywords: [] },
    intervalMs: 60_000, nextDueAt: 0,
  });
}

describe('backup snapshot + validation', () => {
  it('snapshots a live DB to a valid, openable file that carries the data', async () => {
    const dir = tmpDir();
    try {
      const live = openStore(join(dir, 'live.db'));
      seedMonitor(live, 5);
      const snap = join(dir, 'snap.db');
      await snapshotTo(live.db, snap);
      live.db.close();

      expect(isValidBackup(snap)).toBe(true);
      const restored = openStore(snap);
      expect(restored.monitors.listByChat(5).length).toBe(1);
      restored.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-sqlite or missing file', () => {
    const dir = tmpDir();
    try {
      const bad = join(dir, 'bad.db');
      writeFileSync(bad, 'this is not a database');
      expect(isValidBackup(bad)).toBe(false);
      expect(isValidBackup(join(dir, 'nope.db'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('staged restore (boot swap)', () => {
  it('stages a valid backup and applies it atomically at boot', () => {
    const dir = tmpDir();
    try {
      const dbPath = join(dir, 'live.db');
      const live = openStore(dbPath);
      seedMonitor(live, 1); // live: one monitor on chat 1
      live.db.close();

      const backupPath = join(dir, 'backup.db');
      const other = openStore(backupPath);
      seedMonitor(other, 2);
      seedMonitor(other, 2); // backup: two monitors on chat 2
      other.db.close();

      stageRestore(dbPath, backupPath);
      expect(existsSync(dbPath + STAGED_SUFFIX)).toBe(true);

      expect(applyStagedRestore(dbPath)).toBe(true);
      expect(existsSync(dbPath + STAGED_SUFFIX)).toBe(false); // consumed

      const reopened = openStore(dbPath);
      expect(reopened.monitors.listByChat(1).length).toBe(0); // old data gone
      expect(reopened.monitors.listByChat(2).length).toBe(2); // backup applied
      reopened.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when nothing is staged', () => {
    const dir = tmpDir();
    try {
      expect(applyStagedRestore(join(dir, 'live.db'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops a corrupt stage instead of applying it', () => {
    const dir = tmpDir();
    try {
      const dbPath = join(dir, 'live.db');
      openStore(dbPath).db.close();
      writeFileSync(dbPath + STAGED_SUFFIX, 'garbage, not sqlite');
      expect(applyStagedRestore(dbPath)).toBe(false);
      expect(existsSync(dbPath + STAGED_SUFFIX)).toBe(false); // bad stage removed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to stage an invalid backup', () => {
    const dir = tmpDir();
    try {
      const dbPath = join(dir, 'live.db');
      openStore(dbPath).db.close();
      const bad = join(dir, 'bad');
      writeFileSync(bad, 'nope');
      expect(() => stageRestore(dbPath, bad)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

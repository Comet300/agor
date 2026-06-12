/**
 * Access control persistence: the user allowlist keyed by Telegram chat id.
 * The `access` table is also the source of truth mapping chat id -> name/email
 * (tracking who a chat belongs to); name/email never go to logs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../src/persistence';

describe('AccessRepo', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });

  it('an unknown chat has status "unknown" and is not allowed', () => {
    expect(store.access.statusOf(111)).toBe('unknown');
    expect(store.access.isAllowed(111)).toBe(false);
    expect(store.access.get(111)).toBeUndefined();
  });

  it('records a pending request with name + email', () => {
    store.access.request(111, { name: 'Ana Pop', email: 'ana@example.com' }, 1000);
    const row = store.access.get(111);
    expect(row).toMatchObject({
      chatId: 111,
      status: 'pending',
      name: 'Ana Pop',
      email: 'ana@example.com',
      requestedAt: 1000,
    });
    expect(store.access.isAllowed(111)).toBe(false);
  });

  it('allow() grants access and stamps the decider', () => {
    store.access.request(111, { name: 'Ana', email: 'a@x.com' }, 1000);
    store.access.allow(111, { by: 999, at: 2000 });
    expect(store.access.statusOf(111)).toBe('allowed');
    expect(store.access.isAllowed(111)).toBe(true);
    expect(store.access.get(111)).toMatchObject({ status: 'allowed', decidedBy: 999, decidedAt: 2000 });
  });

  it('deny() revokes access (a previously-allowed user becomes not allowed)', () => {
    store.access.request(111, { name: 'Ana', email: 'a@x.com' }, 1000);
    store.access.allow(111, { by: 999, at: 2000 });
    store.access.deny(111, { by: 999, at: 3000 });
    expect(store.access.statusOf(111)).toBe('denied');
    expect(store.access.isAllowed(111)).toBe(false);
  });

  it('allow() works for a chat that never requested (admin grants directly)', () => {
    store.access.allow(222, { by: 999, at: 1000 });
    expect(store.access.isAllowed(222)).toBe(true);
    expect(store.access.get(222)).toMatchObject({ chatId: 222, status: 'allowed' });
  });

  it('hasAnyAdmin() reflects whether any admin exists (bootstrap rule)', () => {
    expect(store.access.hasAnyAdmin()).toBe(false);
    store.access.request(111, { name: 'Ana', email: 'a@x.com' }, 1000);
    expect(store.access.hasAnyAdmin()).toBe(false); // a pending request is not an admin
    store.access.seedAdmin(111);
    expect(store.access.hasAnyAdmin()).toBe(true);
  });

  it('seedAdmin() marks a chat allowed + admin, and admins cannot be denied', () => {
    store.access.seedAdmin(999);
    expect(store.access.isAdmin(999)).toBe(true);
    expect(store.access.isAllowed(999)).toBe(true);
    // A deny attempt on an admin is a no-op (admins are always allowed).
    store.access.deny(999, { by: 999, at: 5000 });
    expect(store.access.isAdmin(999)).toBe(true);
    expect(store.access.isAllowed(999)).toBe(true);
  });

  it('promote() makes a chat admin; demote() returns it to a plain allowed user', () => {
    store.access.seedAdmin(999); // a first admin so we never demote the last one
    store.access.allow(111, { by: 999, at: 1 });
    store.access.promote(111);
    expect(store.access.isAdmin(111)).toBe(true);
    expect(store.access.demote(111)).toBe(true);
    expect(store.access.isAdmin(111)).toBe(false);
    expect(store.access.isAllowed(111)).toBe(true); // still allowed, just not admin
  });

  it('demote() refuses to remove the LAST admin (bot must keep one)', () => {
    store.access.seedAdmin(999);
    expect(store.access.demote(999)).toBe(false);
    expect(store.access.isAdmin(999)).toBe(true); // unchanged
  });

  it('setName / setEmail edit the tracking fields without changing status', () => {
    store.access.request(111, { name: 'Ana', email: 'a@x.com' }, 1000);
    store.access.allow(111, { by: 999, at: 2000 });
    store.access.setName(111, 'Ana Maria Pop');
    store.access.setEmail(111, 'ana.maria@example.com');
    expect(store.access.get(111)).toMatchObject({
      status: 'allowed',
      name: 'Ana Maria Pop',
      email: 'ana.maria@example.com',
    });
  });

  it('setName / setEmail on an unknown chat create the row (so edits never throw)', () => {
    store.access.setName(333, 'Later Named');
    expect(store.access.get(333)).toMatchObject({ chatId: 333, name: 'Later Named' });
  });

  it('list() returns every known chat with its status/name/email', () => {
    store.access.request(111, { name: 'Ana', email: 'a@x.com' }, 1000);
    store.access.allow(111, { by: 999, at: 2000 });
    store.access.request(222, { name: 'Bob', email: 'b@x.com' }, 1500);
    store.access.seedAdmin(999);
    const all = store.access.list();
    const byId = new Map(all.map((r) => [r.chatId, r]));
    expect(byId.get(111)?.status).toBe('allowed');
    expect(byId.get(222)?.status).toBe('pending');
    expect(byId.get(999)?.status).toBe('allowed');
    expect(byId.size).toBe(3);
  });

  it('re-requesting while pending keeps it pending (idempotent), refreshes name/email', () => {
    expect(store.access.request(111, { name: 'Ana', email: 'a@x.com' }, 1000).outcome).toBe('sent');
    const again = store.access.request(111, { name: 'Ana Pop', email: 'ana@x.com' }, 1200);
    expect(again.outcome).toBe('already_pending');
    expect(store.access.get(111)).toMatchObject({ status: 'pending', name: 'Ana Pop', email: 'ana@x.com' });
  });

  it('a DENIED user cannot re-apply within 7 days, but can after', () => {
    const DAY = 86_400_000;
    store.access.request(111, { name: 'Ana', email: 'a@x.com' }, 0);
    store.access.deny(111, { by: 999, at: 1 * DAY }); // denied at day 1
    // Day 4: still inside the 7-day window from the decision -> too_soon.
    const tooSoon = store.access.request(111, { name: 'Ana', email: 'a@x.com' }, 4 * DAY);
    expect(tooSoon.outcome).toBe('too_soon');
    expect(tooSoon.outcome === 'too_soon' && tooSoon.daysLeft).toBeGreaterThan(0);
    expect(store.access.statusOf(111)).toBe('denied'); // unchanged
    // Day 9 (>7 after the day-1 decision): allowed to re-apply -> back to pending.
    const ok = store.access.request(111, { name: 'Ana', email: 'a@x.com' }, 9 * DAY);
    expect(ok.outcome).toBe('sent');
    expect(store.access.statusOf(111)).toBe('pending');
  });
});

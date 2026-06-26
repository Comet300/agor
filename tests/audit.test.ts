import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../src/persistence';

describe('AuditRepo', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });

  it('logs entries and returns them newest-first', () => {
    store.audit.log('allow', 111, 999, 1_000, 'Ana');
    store.audit.log('deny', 222, 999, 2_000);
    store.audit.log('promote', 111, 999, 3_000);
    const recent = store.audit.recent();
    expect(recent.map((e) => e.action)).toEqual(['promote', 'deny', 'allow']);
    expect(recent[2]).toMatchObject({ action: 'allow', targetChatId: 111, actorChatId: 999, at: 1_000, note: 'Ana' });
  });

  it('respects the limit', () => {
    for (let i = 0; i < 30; i++) store.audit.log('allow', i, 1, 1_000 + i);
    expect(store.audit.recent(5)).toHaveLength(5);
    // Newest first → the last-logged ids lead.
    expect(store.audit.recent(5)[0]!.targetChatId).toBe(29);
  });

  it('is empty on a fresh store', () => {
    expect(store.audit.recent()).toEqual([]);
  });
});

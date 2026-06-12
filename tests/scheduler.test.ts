import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../src/persistence';
import type { NewMonitor } from '../src/persistence';
import { Scheduler, groupByDestination, type SchedulerDeps } from '../src/scheduler';
import type { FilterConfig, Monitor, MonitorType } from '../src/contracts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseFilters: FilterConfig = {
  sellerVisibility: 'private',
  exclusionKeywords: [],
};

const DEFAULT_INTERVAL = 60_000;
const OOS_FAST_INTERVAL = 10_000;

function freshStore(): Store {
  return openStore(':memory:');
}

function newMonitorInput(over: Partial<NewMonitor> = {}): NewMonitor {
  return {
    type: 'search' as MonitorType,
    chatId: 42,
    vendor: 'olx',
    url: 'https://www.olx.ro/auto/q-golf/',
    filters: baseFilters,
    intervalMs: DEFAULT_INTERVAL,
    nextDueAt: 1_000,
    ...over,
  };
}

/** A `runMonitor` test double that records the ids it was asked to run. */
function recordingRunner() {
  const calls: number[] = [];
  const runMonitor = async (m: Monitor): Promise<void> => {
    calls.push(m.id);
  };
  return { calls, runMonitor };
}

/** Assemble Scheduler deps with sane test defaults, overridable per case. */
function makeScheduler(
  store: Store,
  over: Partial<SchedulerDeps> = {},
): { scheduler: Scheduler; deps: SchedulerDeps } {
  const deps: SchedulerDeps = {
    store,
    runMonitor: async () => {},
    defaultIntervalMs: DEFAULT_INTERVAL,
    oosFastIntervalMs: OOS_FAST_INTERVAL,
    ...over,
  };
  return { scheduler: new Scheduler(deps), deps };
}

// ── Helpers to fabricate a Monitor object (for pure groupByDestination tests) ──

function makeMonitor(over: Partial<Monitor> = {}): Monitor {
  return {
    id: 1,
    type: 'search',
    chatId: 42,
    vendor: 'olx',
    url: 'https://www.olx.ro/auto/q-golf/',
    filters: baseFilters,
    intervalMs: DEFAULT_INTERVAL,
    fastTier: false,
    nextDueAt: 0,
    consecutiveFailures: 0,
    createdAt: 0,
    ...over,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Scheduler.tick', () => {
  it('runs only due monitors and reschedules each; non-due stays untouched', async () => {
    const store = freshStore();
    // Due now: next_due_at <= now (we tick at now = 5_000).
    const dueA = store.monitors.create(newMonitorInput({ nextDueAt: 1_000 }));
    const dueB = store.monitors.create(newMonitorInput({ nextDueAt: 5_000 }));
    // Not yet due: next_due_at in the future.
    const notDue = store.monitors.create(newMonitorInput({ nextDueAt: 9_999 }));

    const { calls, runMonitor } = recordingRunner();
    const { scheduler } = makeScheduler(store, { runMonitor });

    const now = 5_000;
    await scheduler.tick(now);

    // Only the two due monitors ran.
    expect(calls.sort((a, b) => a - b)).toEqual([dueA.id, dueB.id]);

    // Due monitors advanced by the (normal) interval; non-due is unchanged.
    expect(store.monitors.get(dueA.id)!.nextDueAt).toBe(now + DEFAULT_INTERVAL);
    expect(store.monitors.get(dueB.id)!.nextDueAt).toBe(now + DEFAULT_INTERVAL);
    expect(store.monitors.get(notDue.id)!.nextDueAt).toBe(9_999);
  });

  it('fastTier monitor reschedules to oosFastInterval while a normal one uses intervalMs', async () => {
    const store = freshStore();
    const normal = store.monitors.create(newMonitorInput({ nextDueAt: 0 }));
    const fast = store.monitors.create(newMonitorInput({ nextDueAt: 0 }));
    // Flip the second monitor onto the fast tier.
    store.monitors.setSchedule(fast.id, 0, true);

    const { scheduler } = makeScheduler(store);

    const now = 1_000;
    await scheduler.tick(now);

    expect(store.monitors.get(normal.id)!.nextDueAt).toBe(now + DEFAULT_INTERVAL);
    expect(store.monitors.get(normal.id)!.fastTier).toBe(false);

    expect(store.monitors.get(fast.id)!.nextDueAt).toBe(now + OOS_FAST_INTERVAL);
    // Fast tier flag is preserved across the reschedule.
    expect(store.monitors.get(fast.id)!.fastTier).toBe(true);
  });

  it('falls back to defaultIntervalMs when a monitor has no intervalMs', async () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput({ nextDueAt: 0, intervalMs: 0 }));

    const { scheduler } = makeScheduler(store);
    const now = 2_000;
    await scheduler.tick(now);

    expect(store.monitors.get(m.id)!.nextDueAt).toBe(now + DEFAULT_INTERVAL);
  });

  it('routes a throwing runMonitor to onError and STILL reschedules; siblings unaffected', async () => {
    const store = freshStore();
    const bad = store.monitors.create(newMonitorInput({ nextDueAt: 0 }));
    const good = store.monitors.create(
      newMonitorInput({ nextDueAt: 0, url: 'https://www.olx.ro/auto/q-passat/' }),
    );

    const errors: Array<{ id: number; err: unknown }> = [];
    const ran: number[] = [];
    const boom = new Error('scrape failed');

    const runMonitor = async (m: Monitor): Promise<void> => {
      ran.push(m.id);
      if (m.id === bad.id) throw boom;
    };
    const onError = (m: Monitor, err: unknown): void => {
      errors.push({ id: m.id, err });
    };

    const { scheduler } = makeScheduler(store, { runMonitor, onError });

    const now = 3_000;
    await scheduler.tick(now);

    // Both monitors attempted; the good one wasn't blocked by the bad one.
    expect(ran.sort((a, b) => a - b)).toEqual([bad.id, good.id]);

    // The failure was reported exactly once with the original error.
    expect(errors).toEqual([{ id: bad.id, err: boom }]);

    // The bad monitor was still rescheduled (not left stuck in the due window).
    expect(store.monitors.get(bad.id)!.nextDueAt).toBe(now + DEFAULT_INTERVAL);
    // And so was the good one.
    expect(store.monitors.get(good.id)!.nextDueAt).toBe(now + DEFAULT_INTERVAL);
  });

  it('aborts a hung monitor cycle at runTimeoutMs, routes it to onError, and reschedules', async () => {
    const store = freshStore();
    const hung = store.monitors.create(newMonitorInput({ nextDueAt: 0 }));
    const good = store.monitors.create(
      newMonitorInput({ nextDueAt: 0, url: 'https://www.olx.ro/auto/q-passat/' }),
    );

    const ran: number[] = [];
    const errors: Array<{ id: number; msg: string }> = [];
    const runMonitor = async (m: Monitor): Promise<void> => {
      ran.push(m.id);
      if (m.id === hung.id) return new Promise<void>(() => {}); // never resolves
    };
    const onError = (m: Monitor, err: unknown): void => {
      errors.push({ id: m.id, msg: (err as Error).message });
    };

    const { scheduler } = makeScheduler(store, { runMonitor, onError, runTimeoutMs: 40 });

    const now = 3_000;
    await scheduler.tick(now);

    // Both were attempted; the hung one did not block the good one.
    expect(ran.sort((a, b) => a - b)).toEqual([hung.id, good.id]);
    // The hung cycle surfaced a timeout error exactly once.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ id: hung.id });
    expect(errors[0]!.msg).toMatch(/timeout/i);
    // The hung monitor was still rescheduled (not left stuck due).
    expect(store.monitors.get(hung.id)!.nextDueAt).toBe(now + DEFAULT_INTERVAL);
  });

  it('with no runTimeoutMs configured, a normal cycle is unaffected', async () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput({ nextDueAt: 0 }));
    const { calls, runMonitor } = recordingRunner();
    const { scheduler } = makeScheduler(store, { runMonitor }); // no runTimeoutMs
    await scheduler.tick(1_000);
    expect(calls).toEqual([m.id]);
  });

  it('is a no-op when nothing is due', async () => {
    const store = freshStore();
    store.monitors.create(newMonitorInput({ nextDueAt: 100_000 }));

    const { calls, runMonitor } = recordingRunner();
    const { scheduler } = makeScheduler(store, { runMonitor });

    await scheduler.tick(1_000);
    expect(calls).toEqual([]);
  });
});

describe('Scheduler.reschedule', () => {
  it('persists nextDueAt and fastTier directly', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput({ nextDueAt: 0 }));

    const { scheduler } = makeScheduler(store);
    scheduler.reschedule(store.monitors.get(m.id)!, 7_000);

    expect(store.monitors.get(m.id)!.nextDueAt).toBe(7_000 + DEFAULT_INTERVAL);
  });
});

describe('groupByDestination', () => {
  it('groups identical vendor+url into one bucket and keeps distinct targets apart', () => {
    const a1 = makeMonitor({ id: 1, vendor: 'olx', url: 'https://x/golf' });
    const a2 = makeMonitor({ id: 2, vendor: 'olx', url: 'https://x/golf' }); // same target
    const b = makeMonitor({ id: 3, vendor: 'olx', url: 'https://x/passat' }); // diff url
    const c = makeMonitor({ id: 4, vendor: 'autovit', url: 'https://x/golf' }); // diff vendor

    const groups = groupByDestination([a1, a2, b, c]);

    expect(groups.size).toBe(3);
    expect(groups.get('olx|https://x/golf')!.map((m) => m.id)).toEqual([1, 2]);
    expect(groups.get('olx|https://x/passat')!.map((m) => m.id)).toEqual([3]);
    expect(groups.get('autovit|https://x/golf')!.map((m) => m.id)).toEqual([4]);
  });

  it('returns an empty map for no monitors', () => {
    expect(groupByDestination([]).size).toBe(0);
  });
});

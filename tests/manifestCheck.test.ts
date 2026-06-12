/**
 * Manifest self-test, exercised end-to-end. `runCheck()` loads every committed
 * manifest, dry-runs its search/product mapping against the mapped fixture, and
 * asserts a well-formed item resolves. This test guards against manifest drift:
 * if a selector/path silently stops resolving, `ok` flips to false here.
 */
import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/bin/check';

describe('manifest self-test (runCheck)', () => {
  it('every mapped manifest extracts a well-formed item from its fixture', async () => {
    const { ok, results } = await runCheck();
    // Surface a readable failure: list the surfaces that did not pass.
    const failures = results.flatMap((m) =>
      m.surfaces
        .filter((s) => s.status === 'fail')
        .map((s) => `${m.domain}/${s.surface}: ${s.detail}`),
    );
    expect(failures).toEqual([]);
    expect(ok).toBe(true);
  });

  it('covers every committed manifest with at least one mapped surface', async () => {
    const { results } = await runCheck();
    expect(results.length).toBeGreaterThanOrEqual(11);
    for (const m of results) {
      const mapped = m.surfaces.filter((s) => s.status !== 'skipped');
      expect(mapped.length, `${m.domain} has no mapped fixture`).toBeGreaterThan(0);
    }
  });
});

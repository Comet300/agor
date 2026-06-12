/**
 * Manifest self-test (`agor --check` / `npm run check:manifests`).
 *
 * Catches manifest drift that the type system can't: a structurally-valid YAML
 * whose paths silently resolve to nothing. For every manifest it (1) structurally
 * validates it (reusing the registry's zod parse), then (2) dry-runs the search
 * and product mappings against a committed fixture and asserts at least one item
 * with the required identity fields resolves. Reports per-manifest pass/fail and
 * exits non-zero on any failure — suitable for CI / a pre-push hook.
 *
 * The fixture mapping lives in `tests/fixtures.json` (version-controlled, a dev
 * artifact) so the production runtime carries no fixture dependency.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PluginRegistry } from '../registry';
import { ProxyPool } from '../scraping/proxyPool';
import { ScrapingEngine } from '../scraping/engine';
import { normalizeItems } from '../pipeline/normalize';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures');

interface FixtureMap {
  [domain: string]: { search?: string | null; product?: string | null };
}

/** Result of checking one manifest surface. */
interface SurfaceResult {
  surface: 'search' | 'product';
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
}

interface ManifestResult {
  domain: string;
  surfaces: SurfaceResult[];
}

/** Build an engine whose only fetch returns the given fixture body. */
function fixtureEngine(body: string): ScrapingEngine {
  return new ScrapingEngine({
    pool: new ProxyPool([], 1000),
    cooldownMs: 1000,
    fetcher: async () => ({ status: 200, body }),
    sleep: async () => {},
  });
}

const REQUIRED: Array<'id' | 'title' | 'price' | 'url'> = ['id', 'title', 'price', 'url'];

/**
 * Run the manifest self-test. Returns `{ ok, results }`; `ok` is false when any
 * mapped surface failed to extract a well-formed item.
 */
export async function runCheck(): Promise<{ ok: boolean; results: ManifestResult[] }> {
  const registry = PluginRegistry.load(join(ROOT, 'plugins'));
  const fixtures = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures.json'), 'utf8')) as FixtureMap;
  const results: ManifestResult[] = [];
  let ok = true;

  for (const plugin of registry.all()) {
    const map = fixtures[plugin.domain] ?? {};
    const surfaces: SurfaceResult[] = [];

    for (const surface of ['search', 'product'] as const) {
      const file = map[surface];
      if (!file) {
        surfaces.push({ surface, status: 'skipped', detail: 'no fixture mapped' });
        continue;
      }
      let body: string;
      try {
        body = readFileSync(join(FIXTURE_DIR, file), 'utf8');
      } catch {
        ok = false;
        surfaces.push({ surface, status: 'fail', detail: `fixture not found: ${file}` });
        continue;
      }
      try {
        const engine = fixtureEngine(body);
        const outcome =
          surface === 'search'
            ? await engine.scrapeSearch(plugin, `https://${plugin.domain}/x`, 0)
            : await engine.scrapeProduct(plugin, `https://${plugin.domain}/d/x`, 0);
        const items = outcome.ok ? normalizeItems(outcome.rawNodes, plugin, surface) : [];
        if (items.length === 0) {
          ok = false;
          surfaces.push({ surface, status: 'fail', detail: `0 items (rawNodes=${outcome.rawNodes.length})` });
          continue;
        }
        const missing = REQUIRED.filter((f) => !items[0]![f]);
        if (missing.length > 0) {
          ok = false;
          surfaces.push({ surface, status: 'fail', detail: `item missing required: ${missing.join(',')}` });
          continue;
        }
        surfaces.push({ surface, status: 'pass', detail: `${items.length} items` });
      } catch (err) {
        ok = false;
        surfaces.push({ surface, status: 'fail', detail: `threw: ${(err as Error).message}` });
      }
    }
    results.push({ domain: plugin.domain, surfaces });
  }
  return { ok, results };
}

/** Pretty-print the report to stdout. */
export function printReport(results: ManifestResult[]): void {
  const icon = (s: string): string => (s === 'pass' ? '✅' : s === 'fail' ? '❌' : '⏭️');
  for (const m of results) {
    const parts = m.surfaces.map((s) => `${s.surface} ${icon(s.status)} (${s.detail})`);
    // eslint-disable-next-line no-console
    console.log(`${m.domain.padEnd(16)} ${parts.join('  |  ')}`);
  }
}

// Direct execution (`tsx src/bin/check.ts`): run, report, set exit code.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCheck()
    .then(({ ok, results }) => {
      printReport(results);
      // eslint-disable-next-line no-console
      console.log(ok ? '\n✅ all mapped manifests extract correctly' : '\n❌ manifest check FAILED');
      process.exit(ok ? 0 : 1);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('manifest check crashed:', (err as Error).message);
      process.exit(1);
    });
}

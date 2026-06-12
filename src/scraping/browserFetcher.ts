/**
 * Headless-browser transport for `fetch_strategy: browser` manifests.
 *
 * This is the escalation path the engine takes only when an HTTP fetch hits a
 * recognised anti-bot hard block (Akamai/DataDome/…). It drives a real Chromium
 * via Playwright with the stealth plugin so the TLS/JA3 fingerprint, navigator
 * surface, and cookies look like a genuine browser — the things a raw undici GET
 * cannot mimic.
 *
 * Playwright and its stealth plugin are OPTIONAL dependencies, imported lazily
 * the first time a browser fetch is actually needed. A deployment that never
 * opts a manifest into `browser` (e.g. the Raspberry Pi default) never installs
 * or loads Chromium. When the dependency is missing, a clear, actionable error
 * is thrown rather than a cryptic module-not-found.
 */
import type { Fetcher } from './engine';
import { log } from '../logging/logger';

/** The minimal slice of the Playwright API this module uses. */
interface BrowserHandle {
  newContext(opts: { userAgent?: string; locale?: string }): Promise<ContextHandle>;
  close(): Promise<void>;
}
interface ContextHandle {
  newPage(): Promise<PageHandle>;
  close(): Promise<void>;
}
interface PageHandle {
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  goto(
    url: string,
    opts: { waitUntil: 'domcontentloaded' | 'networkidle'; timeout: number },
  ): Promise<ResponseHandle | null>;
  content(): Promise<string>;
}
interface ResponseHandle {
  status(): number;
  headers(): Record<string, string>;
  url(): string;
}

/** Launches a headless browser; injectable so tests need no real Chromium. */
export type BrowserLauncher = () => Promise<BrowserHandle>;

/** Options controlling the headless browser transport. */
export interface BrowserFetcherOptions {
  /**
   * Per-navigation timeout in ms (default 45s — generous, networks can be slow).
   * Also the per-step deadline applied to content read and context teardown so a
   * single hung operation cannot block a polling cycle indefinitely.
   */
  timeoutMs?: number;
  /** Wait condition before reading content (default `domcontentloaded`). */
  waitUntil?: 'domcontentloaded' | 'networkidle';
  /** Hard cap on the rendered body kept (bytes); default {@link MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
  /** Browser launcher seam; defaults to the lazy Playwright import. */
  launcher?: BrowserLauncher;
}

/** Generous body cap — far above any real listing page (~30 MB). */
const MAX_BODY_BYTES = 30 * 1024 * 1024;

/** Cached browser launch promise so repeated fetches reuse one Chromium. */
let browserPromise: Promise<BrowserHandle> | undefined;

/** Reject a promise if it does not settle within `ms` (a hung step guard). */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`browser ${what} exceeded ${ms}ms deadline`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Lazily import Playwright (+ stealth) and launch a shared headless Chromium.
 * Throws an actionable error when the optional dependency is not installed.
 *
 * On ANY failure the cached promise is cleared so the next call retries — a
 * transient launch/import error must not permanently disable the browser path.
 */
async function launchBrowser(): Promise<BrowserHandle> {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    let chromium: { launch(opts: { headless: boolean; args: string[] }): Promise<BrowserHandle> };
    try {
      // Lazy, optional: only loaded when a manifest opts into the browser path.
      // The specifiers are held in variables so the typechecker does not try to
      // resolve the optional packages' types at build time.
      const playwrightExtra = 'playwright-extra';
      const stealthPlugin = 'puppeteer-extra-plugin-stealth';
      const extra = (await import(playwrightExtra)) as unknown as {
        chromium: typeof chromium & { use(plugin: unknown): void };
      };
      try {
        const stealth = (await import(stealthPlugin)) as unknown as {
          default: () => unknown;
        };
        extra.chromium.use(stealth.default());
      } catch {
        log('browser').warn({}, 'stealth plugin unavailable — continuing without it');
      }
      chromium = extra.chromium;
    } catch (err) {
      throw new Error(
        'fetch_strategy "browser" requires the optional dependencies ' +
          '`playwright-extra`, `playwright`, and `puppeteer-extra-plugin-stealth`. ' +
          'Install them (and `npx playwright install chromium`) to enable the browser ' +
          `fallback, or set the manifest back to fetch_strategy: http. Cause: ${(err as Error).message}`,
      );
    }
    return chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
  })().catch((err) => {
    // Clear the cache so a transient failure does not permanently reject every
    // future call; the next fetch will attempt the launch again.
    browserPromise = undefined;
    throw err;
  });
  return browserPromise;
}

/**
 * Build a {@link Fetcher} that renders pages in a real headless browser. The
 * returned fetcher matches the HTTP fetcher's contract (status + body + headers
 * + finalUrl) so the engine treats both transports identically.
 */
export function createBrowserFetcher(options: BrowserFetcherOptions = {}): Fetcher {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const waitUntil = options.waitUntil ?? 'domcontentloaded';
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const launcher = options.launcher ?? launchBrowser;

  return async (url, { headers }) => {
    const browser = await launcher();
    const context = await browser.newContext({
      userAgent: headers['User-Agent'],
      locale: 'ro-RO',
    });
    try {
      const page = await context.newPage();
      // Carry the same accept/client-hint headers the HTTP path sends.
      await page.setExtraHTTPHeaders(headers);
      const response = await page.goto(url, { waitUntil, timeout: timeoutMs });
      // Bound the content read too: page.goto's timeout does not cover it, and a
      // wedged renderer could otherwise hang the whole polling cycle.
      const raw = await withDeadline(page.content(), timeoutMs, 'content read');
      const body = raw.length > maxBodyBytes ? raw.slice(0, maxBodyBytes) : raw;
      return {
        status: response?.status() ?? 0,
        body,
        headers: response?.headers() ?? {},
        finalUrl: response?.url() ?? url,
      };
    } finally {
      // Teardown is also deadline-bounded so a stuck close cannot wedge the cycle.
      await withDeadline(context.close(), timeoutMs, 'context close').catch((err) => {
        log('browser').warn({ err: (err as Error).message }, 'context close failed');
      });
    }
  };
}

/** Close the shared browser (call on shutdown). Safe when never launched. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } finally {
    browserPromise = undefined;
  }
}

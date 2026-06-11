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

/** Options controlling the headless browser transport. */
export interface BrowserFetcherOptions {
  /** Per-navigation timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Wait condition before reading content (default `domcontentloaded`). */
  waitUntil?: 'domcontentloaded' | 'networkidle';
}

/** Cached browser launch promise so repeated fetches reuse one Chromium. */
let browserPromise: Promise<BrowserHandle> | undefined;

/**
 * Lazily import Playwright (+ stealth) and launch a shared headless Chromium.
 * Throws an actionable error when the optional dependency is not installed.
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
  })();
  return browserPromise;
}

/**
 * Build a {@link Fetcher} that renders pages in a real headless browser. The
 * returned fetcher matches the HTTP fetcher's contract (status + body + headers
 * + finalUrl) so the engine treats both transports identically.
 */
export function createBrowserFetcher(options: BrowserFetcherOptions = {}): Fetcher {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const waitUntil = options.waitUntil ?? 'domcontentloaded';

  return async (url, { headers }) => {
    const browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: headers['User-Agent'],
      locale: 'ro-RO',
    });
    try {
      const page = await context.newPage();
      // Carry the same accept/client-hint headers the HTTP path sends.
      await page.setExtraHTTPHeaders(headers);
      const response = await page.goto(url, { waitUntil, timeout: timeoutMs });
      const body = await page.content();
      return {
        status: response?.status() ?? 0,
        body,
        headers: response?.headers() ?? {},
        finalUrl: response?.url() ?? url,
      };
    } finally {
      await context.close();
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

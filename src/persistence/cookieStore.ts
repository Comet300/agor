/**
 * SQLite backing for the per-vendor cookie jar.
 *
 * Stores one row per domain holding the JSON-serialized cookie map, so a cleared
 * session (e.g. a Cloudflare `cf_clearance`) survives a restart. Implements the
 * {@link CookiePersistence} seam so the pure jar logic in `scraping/cookieJar.ts`
 * stays I/O-free.
 */

import type { DB } from './db';
import type { CookiePersistence, DomainJar } from '../scraping/cookieJar';

interface CookieRow {
  jar: string;
}

export class CookieStoreRepo implements CookiePersistence {
  constructor(private readonly db: DB) {}

  load(domain: string): DomainJar | undefined {
    const row = this.db
      .prepare(`SELECT jar FROM cookies WHERE domain = ?`)
      .get(domain) as CookieRow | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.jar) as DomainJar;
    } catch {
      return undefined; // a corrupt row should not break a scrape
    }
  }

  save(domain: string, jar: DomainJar): void {
    this.db
      .prepare(
        `INSERT INTO cookies (domain, jar, updated_at)
         VALUES (@domain, @jar, @now)
         ON CONFLICT(domain) DO UPDATE SET jar = excluded.jar, updated_at = excluded.updated_at`,
      )
      .run({ domain, jar: JSON.stringify(jar), now: Date.now() });
  }
}

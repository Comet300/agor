/**
 * Persistence for self-healing DOM selectors.
 *
 * Stores one structural fingerprint per (vendor, role); the scraping engine
 * refreshes it on every successful `dom-selector` scrape and reads it back to
 * relocate a broken selector. Implements the {@link SelfHealer} seam so the pure
 * relocation logic in `scraping/selfHeal.ts` stays I/O-free.
 */

import type { DB } from './db';
import type { ElementFingerprint, SelectorRole, SelfHealer } from '../scraping/selfHeal';

interface DomFingerprintRow {
  vendor: string;
  role: string;
  fingerprint: string;
  updated_at: number;
}

export class DomFingerprintsRepo implements SelfHealer {
  constructor(private readonly db: DB) {}

  load(vendor: string, role: SelectorRole): ElementFingerprint | undefined {
    const row = this.db
      .prepare(`SELECT fingerprint FROM dom_fingerprints WHERE vendor = ? AND role = ?`)
      .get(vendor, role) as Pick<DomFingerprintRow, 'fingerprint'> | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.fingerprint) as ElementFingerprint;
    } catch {
      // A corrupt row should not break a scrape — treat as no fingerprint.
      return undefined;
    }
  }

  save(vendor: string, role: SelectorRole, fp: ElementFingerprint): void {
    this.db
      .prepare(
        `INSERT INTO dom_fingerprints (vendor, role, fingerprint, updated_at)
         VALUES (@vendor, @role, @fingerprint, @now)
         ON CONFLICT(vendor, role) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           updated_at  = excluded.updated_at`,
      )
      .run({ vendor, role, fingerprint: JSON.stringify(fp), now: Date.now() });
  }
}

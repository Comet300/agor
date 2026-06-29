/**
 * Persistence layer entry point: opens one SQLite database and wires the repos
 * that share it into a single {@link Store} handed to the rest of the app.
 */

import { openDb, type DB } from "./db";
import { MonitorRepo } from "./monitors";
import { ItemRepo } from "./items";
import { PriceHistoryRepo } from "./priceHistory";
import { ChatPrefsRepo } from "./chatPrefs";
import { AccessRepo } from "./access";
import { DedupRepo } from "./dedupStore";
import { AuditRepo } from "./audit";
import { ValuationRepo } from "./valuation";
import { ItemFlagsRepo } from "./itemFlags";
import { WatchSubscribersRepo } from "./watchSubscribers";
import { DigestQueueRepo } from "./digestQueue";
import { ReportStateRepo } from "./reportState";
import { DomFingerprintsRepo } from "./domFingerprints";

export { MonitorRepo } from "./monitors";
export { ItemRepo } from "./items";
export { PriceHistoryRepo } from "./priceHistory";
export { ChatPrefsRepo } from "./chatPrefs";
export { AccessRepo } from "./access";
export { DedupRepo } from "./dedupStore";
export { ValuationRepo } from "./valuation";
export { ItemFlagsRepo, type ItemFlag } from "./itemFlags";
export { WatchSubscribersRepo } from "./watchSubscribers";
export { DigestQueueRepo, type DigestRow, type DigestPending } from "./digestQueue";
export { ReportStateRepo, type ReportStateRow } from "./reportState";
export { DomFingerprintsRepo } from "./domFingerprints";
export { AuditRepo } from "./audit";
export type { DedupStore, PersistedDedupEntry } from "./dedupStore";
export type { AuditAction, AuditEntry } from "./audit";
export {
  openDb,
  migrate,
  maintainDb,
  type DB,
  type MaintainOptions,
} from "./db";
export type { NewMonitor } from "./monitors";
export type { ItemState, ItemSnapshot } from "./items";
export type { AccessStatus, AccessRecord, RequestOutcome } from "./access";
export { REAPPLY_COOLDOWN_DAYS } from "./access";

/** The bundle of repos every component reads/writes through. */
export interface Store {
  db: DB;
  monitors: MonitorRepo;
  items: ItemRepo;
  priceHistory: PriceHistoryRepo;
  chatPrefs: ChatPrefsRepo;
  access: AccessRepo;
  /** Cross-cycle dedup persistence so seen listings survive a restart. */
  dedup: DedupRepo;
  /** Durable audit trail of access-control decisions. */
  audit: AuditRepo;
  /** Fair-value (v2) ridge accumulators per (category, currency). */
  valuation: ValuationRepo;
  /** Per-chat item flags: saved (shortlist) + dismissed (hidden). */
  itemFlags: ItemFlagsRepo;
  /** Group/shared watches: extra subscriber chats a watch's alerts fan out to. */
  watchSubscribers: WatchSubscribersRepo;
  /** Digest mode: parked new-listing alerts awaiting a daily/weekly summary flush. */
  digestQueue: DigestQueueRepo;
  /** Weekly-report opt-in + delivery cadence, per watch. */
  reportState: ReportStateRepo;
  /** Self-healing DOM selectors: last-good element fingerprint per (vendor, role). */
  domFingerprints: DomFingerprintsRepo;
  /**
   * Run `fn`'s writes inside a single SQLite transaction (atomic + faster):
   * either every write commits or, on a thrown error, all roll back. Used to
   * keep related multi-table writes (e.g. an item's state + its price point)
   * consistent if the process dies mid-cycle. Synchronous by design — the work
   * inside must not await (better-sqlite3 is synchronous).
   */
  transaction<T>(fn: () => T): T;
}

/** Open the database at `path` (or `':memory:'`) and assemble its repos. */
export function openStore(path: string): Store {
  const db = openDb(path);
  return {
    db,
    monitors: new MonitorRepo(db),
    items: new ItemRepo(db),
    priceHistory: new PriceHistoryRepo(db),
    chatPrefs: new ChatPrefsRepo(db),
    access: new AccessRepo(db),
    dedup: new DedupRepo(db),
    audit: new AuditRepo(db),
    valuation: new ValuationRepo(db),
    itemFlags: new ItemFlagsRepo(db),
    watchSubscribers: new WatchSubscribersRepo(db),
    digestQueue: new DigestQueueRepo(db),
    reportState: new ReportStateRepo(db),
    domFingerprints: new DomFingerprintsRepo(db),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  };
}

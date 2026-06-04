/**
 * Persistence layer entry point: opens one SQLite database and wires the repos
 * that share it into a single {@link Store} handed to the rest of the app.
 */

import { openDb, type DB } from './db';
import { MonitorRepo } from './monitors';
import { ItemRepo } from './items';
import { PriceHistoryRepo } from './priceHistory';
import { ChatPrefsRepo } from './chatPrefs';

export { MonitorRepo } from './monitors';
export { ItemRepo } from './items';
export { PriceHistoryRepo } from './priceHistory';
export { ChatPrefsRepo } from './chatPrefs';
export { openDb, migrate, type DB } from './db';
export type { NewMonitor } from './monitors';
export type { ItemState } from './items';

/** The bundle of repos every component reads/writes through. */
export interface Store {
  db: DB;
  monitors: MonitorRepo;
  items: ItemRepo;
  priceHistory: PriceHistoryRepo;
  chatPrefs: ChatPrefsRepo;
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
  };
}

import type pg from "pg";
import {
  deleteDocumentState,
  documentStateExists,
  listDocumentNames,
  loadDocumentState,
  saveDocumentState,
} from "./document-state";
import { storeWithRetry } from "./store-with-retry";
import type { Tombstones } from "./tombstones";

/** What the Hocuspocus server persists through. */
export type DocumentStorage = {
  /** `null` for a document never stored; the first-open seed (`src/commands/first-open-seed.ts`, ISS-12508) seeds it from its latest version. */
  fetch: (documentName: string) => Promise<Uint8Array | null>;
  /** Merges a full document state into the stored one. */
  store: (documentName: string, state: Uint8Array) => Promise<void>;
  exists: (documentName: string) => Promise<boolean>;
  /** Removes the stored row; `true` when one existed. Only the delete command calls it, once the document is unloaded. */
  delete: (documentName: string) => Promise<boolean>;
  /** Up to `limit` stored names after `after`, in name order. */
  listNames: (after: string | undefined, limit: number) => Promise<string[]>;
  /** Releases the storage's connections; called once, at shutdown. */
  close: () => Promise<void>;
  /** Resolves when the database answers. */
  ping: () => Promise<void>;
};

/**
 * `probePool` serves only `ping`, so a store pool with every connection
 * checked out cannot fail the health check, and a stalled ping cannot hold a
 * store's connection.
 */
export function pgDocumentStorage(
  pool: pg.Pool,
  probePool: pg.Pool = pool
): DocumentStorage {
  return {
    fetch: (documentName) => loadDocumentState(pool, documentName),
    store: (documentName, state) =>
      storeWithRetry(
        () => saveDocumentState(pool, documentName, state),
        documentName
      ),
    exists: (documentName) => documentStateExists(pool, documentName),
    delete: (documentName) => deleteDocumentState(pool, documentName),
    listNames: (after, limit) => listDocumentNames(pool, after, limit),
    close: () =>
      probePool === pool
        ? pool.end()
        : Promise.all([pool.end(), probePool.end()]).then(() => undefined),
    ping: () => probePool.query("SELECT 1").then(() => undefined),
  };
}

/**
 * A deleted document's state never comes back through the server: while its
 * name is tombstoned, a store resolves without writing and a fetch reads
 * nothing (PLN-2200 T-3.7).
 */
export function tombstoneAwareStorage(
  storage: DocumentStorage,
  tombstones: Pick<Tombstones, "has">
): DocumentStorage {
  return {
    ...storage,
    fetch: (documentName) =>
      tombstones.has(documentName)
        ? Promise.resolve(null)
        : storage.fetch(documentName),
    store: (documentName, state) =>
      tombstones.has(documentName)
        ? Promise.resolve()
        : storage.store(documentName, state),
  };
}

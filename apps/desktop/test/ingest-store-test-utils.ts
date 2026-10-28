/**
 * @file ingest-store-test-utils.ts
 * @description In-memory {@link IngestStorePort} / {@link IngestStoreProvider}
 * fakes for the ISS-9838 SQLite-backed ingest stores.
 *
 * The production port serializes its snapshot to a JSON column, so these fakes
 * JSON round-trip every save. Without that a test could pass while the store
 * under test handed out a live reference to its own internal map — which the
 * real port cannot do — or persisted an `undefined` the column would drop.
 */
import type {
  IngestStorePort,
  IngestStoreProvider,
  IngestStoreSnapshot,
} from "../src/main/collectors/engine/ingest-store-port.js";

/**
 * A port whose `hydrated` reflects the last `save`, i.e. the next boot's read —
 * what the production port gives a manager built from a re-resolved provider.
 */
export type MemoryIngestStore = IngestStorePort & {
  /** What a store constructed right now would hydrate from. */
  peek(): IngestStoreSnapshot | null;
  /** Overwrite the persisted snapshot, as a foreign or older build would have. */
  seed(snapshot: IngestStoreSnapshot | null): void;
  /** How many times the store wrote back SUCCESSFULLY. */
  saveCount(): number;
  /**
   * Make every subsequent `save` REFUSE the snapshot, in the shape the real
   * SQLite-backed port takes: the seam never rejects, so the refusal arrives as
   * a `false` resolved on a later microtask (whitlockk review, ISS-9838). The
   * synchronous-throw shape is {@link createFailingIngestStore}.
   */
  failWrites(failing: boolean): void;
};

/** Build one standalone in-memory ingest-store port. */
export function createMemoryIngestStore(
  initial: IngestStoreSnapshot | null = null
): MemoryIngestStore {
  let snapshot = initial;
  let saves = 0;
  let failing = false;
  return {
    get hydrated(): IngestStoreSnapshot | null {
      return snapshot;
    },
    save(next: IngestStoreSnapshot): Promise<boolean> {
      if (failing) {
        return Promise.resolve(false);
      }
      saves += 1;
      snapshot = JSON.parse(JSON.stringify(next)) as IngestStoreSnapshot;
      return Promise.resolve(true);
    },
    peek: () => snapshot,
    seed: (next) => {
      snapshot = next;
    },
    saveCount: () => saves,
    failWrites: (next) => {
      failing = next;
    },
  };
}

/** A port whose every `save` throws, standing in for an unwritable store. */
export function createFailingIngestStore(): IngestStorePort & {
  /** How many times a write was ATTEMPTED, including the ones that threw. */
  attempts(): number;
} {
  let attempts = 0;
  return {
    hydrated: null,
    save(): Promise<boolean> {
      attempts += 1;
      throw new Error("ingest store write refused");
    },
    attempts: () => attempts,
  };
}

export type MemoryIngestStoreProvider = {
  provider: IngestStoreProvider;
  /** The port behind one collector's catchup cache. */
  catchupCache(cacheName: string): MemoryIngestStore;
  /** The port behind one collector's parse quarantine. */
  parseQuarantine(cacheName: string): MemoryIngestStore;
  /** The port behind the Codex rollout-linkage cache. */
  codexLinkage(): MemoryIngestStore;
};

/**
 * A provider that hands the SAME port back for a given store on every call, so a
 * manager rebuilt in one test re-hydrates what the previous one wrote — the
 * across-restart behaviour the real table gives a re-resolved provider (the
 * production port itself retires its snapshot on save, ISS-12021).
 */
export function createMemoryIngestStoreProvider(): MemoryIngestStoreProvider {
  const stores = new Map<string, MemoryIngestStore>();
  const open = (key: string): MemoryIngestStore => {
    const existing = stores.get(key);
    if (existing) {
      return existing;
    }
    const store = createMemoryIngestStore();
    stores.set(key, store);
    return store;
  };
  const catchupCache = (cacheName: string) =>
    open(`catchup-cache:${cacheName}`);
  const parseQuarantine = (cacheName: string) =>
    open(`parse-quarantine:${cacheName}`);
  const codexLinkage = () => open("codex-linkage");
  return {
    provider: { catchupCache, parseQuarantine, codexLinkage },
    catchupCache,
    parseQuarantine,
    codexLinkage,
  };
}

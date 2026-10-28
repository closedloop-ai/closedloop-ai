/**
 * @file ingest-store-port.ts
 * @description ISS-9838: the narrow durable-state seam the persisted ingest
 * stores (`catchup-cache`, `parse-quarantine`, the Codex linkage cache) write
 * through, now that their backing store is a SQLite table rather than a JSON
 * file.
 *
 * ISS-9837 R2 (operator-ratified): the `collectors/` subtree must NOT import
 * `agentDatabase` or `@repo/database`. Each store takes an injected port through
 * its options object (the shape `CollectorManager` already uses for `importer`
 * and `emit`), and the runtime supplies the implementation
 * at the construct site (`dashboard/ingest-store-provider.ts`). That keeps this
 * subtree DB-free and keeps every store constructible from a literal in a test
 * with no database.
 *
 * ISS-9837 R1: {@link IngestStorePort.hydrated} is ALREADY RESOLVED — the async
 * read happens in the runtime, awaited alongside the other pre-construct awaits,
 * so every store constructor stays synchronous and `HarnessCollector` keeps the
 * synchronous `listSources()` its contract requires. The first read TAKES that
 * snapshot and an accepted write RETIRES it, so a later reader never gets the
 * pre-write state; a store rebuilt afterwards re-resolves the provider and reads
 * the database again (ISS-12021).
 *
 * ISS-9837 R3: the version is a property of the STORE, not of a row. A snapshot
 * whose {@link IngestStoreSnapshot.version} differs from the reading store's own
 * constant is discarded WHOLE. These are derived caches over sources of truth
 * that stay on disk, so a discard costs recomputation and never information.
 */

/** One persisted ingest store's entire contents, at one format version. */
export type IngestStoreSnapshot = {
  /** The writer's store-wide format version. A mismatch discards everything. */
  version: number;
  /** Entries keyed by absolute source path. Validated by the reading store. */
  entries: Record<string, unknown>;
};

/** The durable seam one ingest store owns. Never throws; never awaits. */
export type IngestStorePort = {
  /**
   * The snapshot resolved before the first constructor ran (ISS-9837 R1),
   * handed out to the FIRST read only and retired by an accepted {@link save}.
   * `null` means nothing is persisted, the read failed, the snapshot was
   * already read, or a save has since superseded it — the store starts empty,
   * which is the same non-fatal degrade the JSON file had.
   */
  readonly hydrated: IngestStoreSnapshot | null;
  /**
   * Best-effort whole-store write-back. The caller's `flush()` stays synchronous
   * and the store stays correct in memory if this never lands — but the WRITE is
   * asynchronous now that the backing store is SQLite, so returning is not
   * accepting. Resolves `true` only once the store accepted the snapshot and
   * {@link hydrated} no longer serves the read it superseded; `false` when the
   * write was refused, which is a
   * caller's cue to stay dirty and retry on its next flush. NEVER rejects.
   */
  save(snapshot: IngestStoreSnapshot): Promise<boolean>;
};

/**
 * Opens the durable port for each ingest store, one instance per store key. A
 * manager rebuilt after a write resolves a new provider to read that write back.
 */
export type IngestStoreProvider = {
  /** Per-source catchup cache for one collector's `cacheName`. */
  catchupCache(cacheName: string): IngestStorePort;
  /** Parse/import quarantine dead-letter store for one collector's `cacheName`. */
  parseQuarantine(cacheName: string): IngestStorePort;
  /** The single Codex rollout-linkage cache (FEA-2264). */
  codexLinkage(): IngestStorePort;
};

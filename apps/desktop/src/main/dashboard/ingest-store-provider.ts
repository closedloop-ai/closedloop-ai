/**
 * @file ingest-store-provider.ts
 * @description ISS-9838: the SQLite-backed implementation of the collectors'
 * {@link IngestStoreProvider} seam, and the single pre-construct await that
 * hydrates every ingest store.
 *
 * This module is the boundary ISS-9837 R2 (operator-ratified) draws: the
 * `collectors/` subtree never imports `agentDatabase`, so the DB handle stops
 * here and the collectors receive only the narrow port. It sits beside
 * `opencode-withheld-reconciliation.ts`, which resolves the other pre-construct
 * lookup for exactly the same reason — `listSources` cannot await, so the answer
 * is read here and closed over (ISS-9837 R1).
 *
 * A FAILED read yields ports with `hydrated: null`, i.e. every store starts
 * empty. That is the same non-fatal degrade the JSON files had for a missing or
 * corrupt file, and it is safe in this direction because all three stores are
 * derived caches: an empty start costs one recomputation pass and never
 * information.
 */
import type {
  IngestStorePort,
  IngestStoreProvider,
  IngestStoreSnapshot,
} from "../collectors/engine/ingest-store-port.js";

/**
 * The clone-safe `agentDatabase` slice this provider reads. Declared
 * structurally and resolved at CALL time (`database.collectorIngestStores.…`),
 * never captured as a detached method — `database/AGENTS.md` requires that of
 * every db-host proxy consumer, and it also lets a test pass a plain object.
 */
export type IngestStoreDatabase = {
  collectorIngestStores: {
    loadAll(): Promise<
      { storeKey: string; formatVersion: number; payload: string }[]
    >;
    save(
      storeKey: string,
      formatVersion: number,
      payload: string
    ): Promise<unknown>;
  };
};

export type IngestStoreProviderInput = {
  database: IngestStoreDatabase;
  log: (message: string) => void;
};

/** Store key for one collector's per-source catchup cache. */
function catchupCacheKey(cacheName: string): string {
  return `catchup-cache:${cacheName}`;
}

/** Store key for one collector's parse/import quarantine. */
function parseQuarantineKey(cacheName: string): string {
  return `parse-quarantine:${cacheName}`;
}

/** Store key for the single Codex rollout-linkage cache (FEA-2264). */
const CODEX_LINKAGE_KEY = "codex-linkage";

/**
 * Decode one persisted row. The payload is unknown JSON at a persistence
 * boundary — hand-edited, written by another build, or truncated by a store that
 * predates this table — so a non-object decodes as absent rather than being
 * handed to a store that would then iterate a string's indices.
 */
function decodeSnapshot(
  row: { formatVersion: number; payload: string },
  log: (message: string) => void,
  storeKey: string
): IngestStoreSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch (error) {
    log(
      `ingest store ${storeKey}: unreadable payload, starting empty: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log(`ingest store ${storeKey}: payload is not an object, starting empty`);
    return null;
  }
  return {
    version: row.formatVersion,
    entries: parsed as Record<string, unknown>,
  };
}

/**
 * Read every persisted ingest store and return the provider the collectors are
 * built with. The ONE await this seam costs, taken alongside the other
 * pre-construct awaits at the `new CollectorManager(...)` site so that every
 * store constructor — and therefore `HarnessCollector` — stays synchronous.
 */
export async function resolveIngestStoreProvider(
  input: IngestStoreProviderInput
): Promise<IngestStoreProvider> {
  const hydrated = new Map<string, IngestStoreSnapshot>();
  try {
    for (const row of await input.database.collectorIngestStores.loadAll()) {
      const snapshot = decodeSnapshot(row, input.log, row.storeKey);
      if (snapshot) {
        hydrated.set(row.storeKey, snapshot);
      }
    }
  } catch (error) {
    input.log(
      `ingest store hydrate failed, every store starts empty: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const ports = new Map<string, IngestStorePort>();
  const open = (storeKey: string): IngestStorePort => {
    const existing = ports.get(storeKey);
    if (existing) {
      return existing;
    }
    const port: IngestStorePort = {
      // davetho review (ISS-9838): a GETTER, not a value captured at open, so
      // the boot-time snapshot can be retired. Pinning it here would hand a
      // rebuild the pre-write state and silently undo every flush the previous
      // manager landed. ISS-12021 (tamsinb review): handed out ONCE. Every
      // reader takes it in a constructor and a rebuild re-resolves the
      // provider, so a store that never saves does not keep it either.
      get hydrated(): IngestStoreSnapshot | null {
        const snapshot = hydrated.get(storeKey) ?? null;
        hydrated.delete(storeKey);
        return snapshot;
      },
      save(snapshot: IngestStoreSnapshot): Promise<boolean> {
        const payload = JSON.stringify(snapshot.entries);
        // Never rejects: the caller's `flush()` is synchronous, so a failed
        // write must surface as a `false` it can stay dirty on rather than as a
        // rejection that takes down an import tick.
        return input.database.collectorIngestStores
          .save(storeKey, snapshot.version, payload)
          .then(() => {
            // ISS-12021: the read this save superseded is DROPPED, not replaced
            // with a decoded copy of the save. The live store already holds what
            // it saved, so a copy here was a second one for the life of the
            // process. A rebuild re-resolves this provider and reads the row
            // back from the DB; this port no longer hands out the pre-write
            // snapshot either way (davetho review, ISS-9838).
            hydrated.delete(storeKey);
            return true;
          })
          .catch((error: unknown) => {
            input.log(
              `ingest store ${storeKey}: write failed: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          });
      },
    };
    ports.set(storeKey, port);
    return port;
  };

  return {
    catchupCache: (cacheName) => open(catchupCacheKey(cacheName)),
    parseQuarantine: (cacheName) => open(parseQuarantineKey(cacheName)),
    codexLinkage: () => open(CODEX_LINKAGE_KEY),
  };
}

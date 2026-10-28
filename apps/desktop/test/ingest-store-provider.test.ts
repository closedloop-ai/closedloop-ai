/**
 * @file ingest-store-provider.test.ts
 * @description ISS-9838: coverage for the SQLite-backed ingest-store seam — the
 * `collector_ingest_stores` table itself (against a real libSQL database built
 * by the production migration runner), the runtime provider that hydrates every
 * store BEFORE the collectors are constructed (ISS-9837 R1), and the production
 * wiring that hands those ports to `CollectorManager` and `defaultCollectors`.
 */
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createCatchupCache } from "../src/main/collectors/engine/catchup-cache.js";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import { defaultCollectors } from "../src/main/collectors/engine/default-collectors.js";
import type {
  IngestStorePort,
  IngestStoreProvider,
} from "../src/main/collectors/engine/ingest-store-port.js";
import {
  type IngestStoreDatabase,
  resolveIngestStoreProvider,
} from "../src/main/dashboard/ingest-store-provider.js";
import {
  loadCollectorIngestStores,
  saveCollectorIngestStore,
} from "../src/main/database/collector-ingest-store.js";
import { fakeCollector } from "./normalized-session-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

type IngestStoreRow = {
  storeKey: string;
  formatVersion: number;
  payload: string;
};

/**
 * A database fake that records every save, and whose `loadAll` answers with
 * each store's latest row — the seeded one until a save replaces it.
 */
function recordingDatabase(rows: IngestStoreRow[] = []): IngestStoreDatabase & {
  saves: IngestStoreRow[];
} {
  const saves: IngestStoreRow[] = [];
  const current = new Map(rows.map((row) => [row.storeKey, row]));
  return {
    saves,
    collectorIngestStores: {
      loadAll: () => Promise.resolve([...current.values()]),
      save: (storeKey, formatVersion, payload) => {
        saves.push({ storeKey, formatVersion, payload });
        current.set(storeKey, { storeKey, formatVersion, payload });
        return Promise.resolve();
      },
    },
  };
}

const silentLog = (): void => {
  // The provider's degrade paths log; the assertions are on behaviour.
};

test("ISS-9838: the table round-trips a store snapshot and replaces it wholesale", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    assert.deepEqual(
      await loadCollectorIngestStores(prisma),
      [],
      "a fresh install has no persisted ingest stores"
    );

    await saveCollectorIngestStore(
      prisma,
      "catchup-cache:claude",
      2,
      '{"a":1}'
    );
    assert.deepEqual(await loadCollectorIngestStores(prisma), [
      {
        storeKey: "catchup-cache:claude",
        formatVersion: 2,
        payload: '{"a":1}',
      },
    ]);

    // A second save REPLACES rather than merges — these stores flush their whole
    // map, so a merge would resurrect entries the store deliberately pruned.
    await saveCollectorIngestStore(
      prisma,
      "catchup-cache:claude",
      3,
      '{"b":2}'
    );
    assert.deepEqual(await loadCollectorIngestStores(prisma), [
      {
        storeKey: "catchup-cache:claude",
        formatVersion: 3,
        payload: '{"b":2}',
      },
    ]);

    // Two stores are independent rows keyed by store, never by entry.
    await saveCollectorIngestStore(prisma, "codex-linkage", 1, "{}");
    const keys = (await loadCollectorIngestStores(prisma))
      .map((row) => row.storeKey)
      .sort();
    assert.deepEqual(keys, ["catchup-cache:claude", "codex-linkage"]);
  } finally {
    await close();
  }
});

test("ISS-9837 R1: the provider hydrates every store before any constructor runs", async () => {
  const database = recordingDatabase([
    {
      storeKey: "catchup-cache:claude",
      formatVersion: 2,
      payload: JSON.stringify({ "/a.jsonl": { mtimeMs: 1, size: 2 } }),
    },
    {
      storeKey: "parse-quarantine:codex",
      formatVersion: 1,
      payload: JSON.stringify({ "/b.jsonl": { attempts: 3 } }),
    },
    { storeKey: "codex-linkage", formatVersion: 1, payload: "{}" },
  ]);
  const provider = await resolveIngestStoreProvider({
    database,
    log: silentLog,
  });

  assert.deepEqual(provider.catchupCache("claude").hydrated, {
    version: 2,
    entries: { "/a.jsonl": { mtimeMs: 1, size: 2 } },
  });
  assert.deepEqual(provider.parseQuarantine("codex").hydrated, {
    version: 1,
    entries: { "/b.jsonl": { attempts: 3 } },
  });
  assert.deepEqual(provider.codexLinkage().hydrated, {
    version: 1,
    entries: {},
  });
  // A store with no persisted row hydrates as absent, never as an empty
  // snapshot at the reader's own version — that would claim "nothing to import".
  assert.equal(provider.catchupCache("cursor").hydrated, null);
});

test("ISS-9838: one port per store key", async () => {
  const database = recordingDatabase();
  const provider = await resolveIngestStoreProvider({
    database,
    log: silentLog,
  });
  assert.equal(
    provider.catchupCache("claude"),
    provider.catchupCache("claude"),
    "the same store key resolves to the same port"
  );
  assert.notEqual(
    provider.catchupCache("claude"),
    provider.parseQuarantine("claude"),
    "the catchup cache and the quarantine are separate stores"
  );
});

test("ISS-9838: save serializes the entries and names the store key and version", async () => {
  const database = recordingDatabase();
  const provider = await resolveIngestStoreProvider({
    database,
    log: silentLog,
  });
  const accepted = await provider.parseQuarantine("opencode").save({
    version: 7,
    entries: { "/poison.jsonl": { attempts: 2 } },
  });
  assert.equal(accepted, true, "the store accepted the snapshot");
  assert.deepEqual(database.saves, [
    {
      storeKey: "parse-quarantine:opencode",
      formatVersion: 7,
      payload: JSON.stringify({ "/poison.jsonl": { attempts: 2 } }),
    },
  ]);
});

test("ISS-9838: a rejected save never rejects into the caller's synchronous flush", async () => {
  const logged: string[] = [];
  const provider = await resolveIngestStoreProvider({
    database: {
      collectorIngestStores: {
        loadAll: () => Promise.resolve([]),
        save: () => Promise.reject(new Error("db host down")),
      },
    },
    log: (message) => logged.push(message),
  });
  const port = provider.codexLinkage();
  let settled: boolean | undefined;
  assert.doesNotThrow(() => {
    settled = undefined;
    port
      .save({ version: 1, entries: {} })
      .then((accepted) => {
        settled = accepted;
      })
      .catch(() => {
        settled = undefined;
      });
  }, "a rejected write must not reject into the synchronous flush");
  // The rejection is settled on a microtask, so drain before asserting.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    false,
    "a refused write resolves false so the caller can stay dirty and retry"
  );
  assert.equal(
    port.hydrated,
    null,
    "a refused write must not advance the accepted snapshot"
  );
  assert.ok(
    logged.some((line) => line.includes("db host down")),
    `the failure reached the monitored log: ${JSON.stringify(logged)}`
  );
});

test("ISS-12021: an accepted save retires the boot snapshot without decoding a copy of itself", async () => {
  const provider = await resolveIngestStoreProvider({
    database: recordingDatabase([
      {
        storeKey: "catchup-cache:claude",
        formatVersion: 2,
        payload: JSON.stringify({ "/boot.jsonl": { mtimeMs: 1, size: 2 } }),
      },
    ]),
    log: silentLog,
  });
  const port = provider.catchupCache("claude");
  assert.deepEqual(port.hydrated, {
    version: 2,
    entries: { "/boot.jsonl": { mtimeMs: 1, size: 2 } },
  });

  const parse = vi.spyOn(JSON, "parse");
  let accepted: boolean;
  try {
    accepted = await port.save({
      version: 2,
      entries: { "/written.jsonl": { mtimeMs: 3, size: 4 } },
    });
    assert.equal(
      parse.mock.calls.length,
      0,
      "the save decoded its own payload back into a retained copy"
    );
  } finally {
    parse.mockRestore();
  }
  assert.equal(accepted, true);
  // davetho review (ISS-9838): never the pre-write snapshot after a write.
  assert.equal(provider.catchupCache("claude").hydrated, null);
});

test("ISS-12021: a store that never saves does not keep its boot snapshot once its constructor took it (tamsinb review)", async () => {
  const database = recordingDatabase([
    {
      storeKey: "catchup-cache:codex",
      formatVersion: 2,
      payload: JSON.stringify({ "/old.jsonl": { mtimeMs: 1, size: 2 } }),
    },
  ]);
  const provider = await resolveIngestStoreProvider({
    database,
    log: silentLog,
  });
  const port = provider.catchupCache("codex");
  const cache = createCatchupCache({ store: port });
  assert.equal(cache.size(), 1, "the constructor hydrated the boot snapshot");
  assert.equal(port.hydrated, null, "the port still held the boot snapshot");
  assert.deepEqual(database.saves, []);

  const rebuilt = await resolveIngestStoreProvider({
    database,
    log: silentLog,
  });
  assert.equal(
    createCatchupCache({ store: rebuilt.catchupCache("codex") }).size(),
    1,
    "a rebuild reads the row from the database again"
  );
});

test("ISS-9838: a store rebuilt after a save reads what it landed, from the database (davetho review)", async () => {
  const database = recordingDatabase([
    {
      storeKey: "catchup-cache:claude",
      formatVersion: 1,
      payload: JSON.stringify({ "/boot.jsonl": { mtimeMs: 1, size: 2 } }),
    },
  ]);
  const provider = await resolveIngestStoreProvider({
    database,
    log: silentLog,
  });
  assert.equal(
    await provider.catchupCache("claude").save({
      version: 2,
      entries: { "/written.jsonl": { mtimeMs: 3, size: 4 }, gone: undefined },
    }),
    true
  );
  // A rebuild re-resolves the provider, so it reads the row back rather than
  // a copy this process kept — and sees exactly what the column kept, without
  // the `undefined` member `JSON.stringify` dropped.
  const rebuilt = await resolveIngestStoreProvider({
    database,
    log: silentLog,
  });
  assert.deepEqual(rebuilt.catchupCache("claude").hydrated, {
    version: 2,
    entries: { "/written.jsonl": { mtimeMs: 3, size: 4 } },
  });
});

test("ISS-9838: a failed hydrate degrades to empty stores rather than throwing", async () => {
  const logged: string[] = [];
  const provider = await resolveIngestStoreProvider({
    database: {
      collectorIngestStores: {
        loadAll: () => Promise.reject(new Error("store thread gone")),
        save: () => Promise.resolve(),
      },
    },
    log: (message) => logged.push(message),
  });
  assert.equal(provider.catchupCache("claude").hydrated, null);
  assert.ok(
    logged.some((line) => line.includes("store thread gone")),
    `the failure reached the monitored log: ${JSON.stringify(logged)}`
  );
});

for (const [label, payload] of [
  ["is not JSON", "{ truncated"],
  ["is a JSON string", '"not-an-object"'],
  ["is a JSON array", "[1,2,3]"],
  ["is JSON null", "null"],
] as const) {
  test(`ISS-9838: a payload that ${label} hydrates as absent, not as entries`, async () => {
    const logged: string[] = [];
    const provider = await resolveIngestStoreProvider({
      database: recordingDatabase([
        { storeKey: "catchup-cache:claude", formatVersion: 2, payload },
      ]),
      log: (message) => logged.push(message),
    });
    assert.equal(provider.catchupCache("claude").hydrated, null);
    assert.equal(logged.length, 1, "the bad payload was reported once");
  });
}

/** A provider that records which stores production actually opened. */
function recordingProvider(): IngestStoreProvider & { opened: string[] } {
  const opened: string[] = [];
  const port = (): IngestStorePort => ({
    hydrated: null,
    save: () => Promise.resolve(true),
  });
  return {
    opened,
    catchupCache: (cacheName) => {
      opened.push(`catchup-cache:${cacheName}`);
      return port();
    },
    parseQuarantine: (cacheName) => {
      opened.push(`parse-quarantine:${cacheName}`);
      return port();
    },
    codexLinkage: () => {
      opened.push("codex-linkage");
      return port();
    },
  };
}

test("ISS-9838: CollectorManager opens a catchup and quarantine port per collector", async () => {
  const provider = recordingProvider();
  const manager = new CollectorManager({
    importer: {
      importSession: () => ({ skipped: false, reactivated: false }),
    },
    stateDir: "/tmp/iss-9838-unused",
    ingestStores: provider,
    emit: () => {},
    getCollectionMode: () => "disabled",
    catchupPollMs: null,
    collectors: [
      fakeCollector("claude", { sources: [] }),
      // A BATCH collector has no catchup cache but still owns a quarantine.
      fakeCollector("opencode", { batch: true, sources: [] }),
    ],
  });
  await manager.stop();

  assert.deepEqual(provider.opened.sort(), [
    "catchup-cache:claude",
    "parse-quarantine:claude",
    "parse-quarantine:opencode",
  ]);
});

test("ISS-9838: defaultCollectors hands the Codex collector its linkage port", () => {
  const provider = recordingProvider();
  defaultCollectors(
    { stateDir: "/tmp/iss-9838-unused", ingestStores: provider },
    () => {}
  );
  assert.deepEqual(provider.opened, ["codex-linkage"]);
});

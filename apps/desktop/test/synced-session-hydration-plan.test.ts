/**
 * @file synced-session-hydration-plan.test.ts
 * @description ISS-6105 — the hydration chunk planner bounds a chunk by the heap
 * its rows will occupy, and can never lose, reorder, or duplicate a session id
 * while doing it.
 *
 * The packing rules are the interesting half; the id-preservation rules are the
 * SAFETY half. A planner that silently dropped an id would look like a large
 * heap win and read, downstream, as a session that failed to hydrate — which
 * ISS-6031 established the sync lane must not confuse with a deletion. Every
 * packing case below therefore also asserts the id set survives intact.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  EVENT_DATA_HEAP_BYTES_PER_SOURCE_BYTE,
  EVENT_ROW_HEAP_BYTES,
  estimateSessionHydrationHeapBytes,
  HYDRATION_ASSEMBLY_HEAP_MULTIPLIER,
  loadSyncedSessionHydrationCosts,
  METADATA_HEAP_BYTES_PER_SOURCE_BYTE,
  planSyncedSessionHydration,
  planSyncedSessionHydrationChunks,
  SYNCED_SESSION_HYDRATE_CHUNK_SIZE,
  SYNCED_SESSION_HYDRATE_MAX_CHUNK_IDS,
  SYNCED_SESSION_HYDRATION_HEAP_BUDGET_BYTES,
  type SyncedSessionHydrationCost,
  type SyncedSessionHydrationShape,
  sizingDegradeMessage,
  TOKEN_EVENT_COST_SUMMARY_HEAP_BYTES_PER_ROW,
  TOKEN_EVENT_ROW_HEAP_BYTES,
  UNKNOWN_SESSION_HYDRATION_HEAP_BYTES,
} from "../src/main/database/synced-session-hydration-plan.js";

const LIST_SHAPE: SyncedSessionHydrationShape = {
  omitEventData: true,
  omitTokenEventCostColumns: true,
};
const SYNC_SHAPE: SyncedSessionHydrationShape = {
  omitEventData: true,
  omitTokenEventCostColumns: false,
};
/** The detail / branch-trace shape — the one that actually loads `events.data`. */
const FULL_SHAPE: SyncedSessionHydrationShape = {
  omitEventData: false,
  omitTokenEventCostColumns: false,
};

function cost(
  sessionId: string,
  overrides: Partial<Omit<SyncedSessionHydrationCost, "sessionId">> = {}
): SyncedSessionHydrationCost {
  return {
    sessionId,
    metadataBytes: 0,
    eventRowCount: 0,
    eventDataBytes: 0,
    tokenEventRowCount: 0,
    ...overrides,
  };
}

function costMap(
  entries: SyncedSessionHydrationCost[]
): Map<string, SyncedSessionHydrationCost> {
  return new Map(entries.map((entry) => [entry.sessionId, entry]));
}

/**
 * Every shape the raw-SQL sizing boundary can hand back that cannot be a count.
 * `null` is in the set because the row type admits it even though
 * `COALESCE(LENGTH(CAST(... AS BLOB)), 0)` and `COUNT(*)` cannot produce one.
 */
const INVALID_SIZING_COUNTS: readonly (number | null)[] = [
  -1000,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  null,
];

const EVENT_DATA_SUM_SQL = /SUM\(LENGTH\(CAST\(e2\.data AS BLOB\)\)\)/;
/**
 * Both size terms must measure BYTES. `LENGTH()` on a TEXT value counts
 * CHARACTERS, which UNDER-reports any non-ASCII payload — and an under-priced
 * session is exactly what packs an oversized load into a shared chunk.
 */
const METADATA_BYTES_SQL = /LENGTH\(CAST\(s\.metadata AS BLOB\)\)/;
const SIZING_FAILURE_LOG = /sizing read failed/;
const SIZING_FAILURE_CAUSE_LOG = /reader unavailable/;

function flatten(chunks: string[][]): string[] {
  return chunks.flat();
}

test("ISS-6105: a session's estimate scales with metadata, events and token events", () => {
  const base = estimateSessionHydrationHeapBytes(cost("s"), LIST_SHAPE);
  assert.equal(base, 0, "a session with no rows and no metadata costs nothing");

  const metadataOnly = estimateSessionHydrationHeapBytes(
    cost("s", { metadataBytes: 1000 }),
    LIST_SHAPE
  );
  assert.equal(
    metadataOnly,
    Math.ceil(
      1000 *
        METADATA_HEAP_BYTES_PER_SOURCE_BYTE *
        HYDRATION_ASSEMBLY_HEAP_MULTIPLIER
    )
  );

  const eventsOnly = estimateSessionHydrationHeapBytes(
    cost("s", { eventRowCount: 10 }),
    LIST_SHAPE
  );
  assert.equal(
    eventsOnly,
    Math.ceil(10 * EVENT_ROW_HEAP_BYTES * HYDRATION_ASSEMBLY_HEAP_MULTIPLIER)
  );
});

test("ISS-6105: keeping the token-event cost blob raises the estimate for the same rows", () => {
  const rows = cost("s", { tokenEventRowCount: 100 });
  const listEstimate = estimateSessionHydrationHeapBytes(rows, LIST_SHAPE);
  const syncEstimate = estimateSessionHydrationHeapBytes(rows, SYNC_SHAPE);

  assert.equal(
    listEstimate,
    Math.ceil(
      100 * TOKEN_EVENT_ROW_HEAP_BYTES * HYDRATION_ASSEMBLY_HEAP_MULTIPLIER
    )
  );
  assert.equal(
    syncEstimate,
    Math.ceil(
      100 *
        (TOKEN_EVENT_ROW_HEAP_BYTES +
          TOKEN_EVENT_COST_SUMMARY_HEAP_BYTES_PER_ROW) *
        HYDRATION_ASSEMBLY_HEAP_MULTIPLIER
    )
  );
  assert.ok(
    syncEstimate > listEstimate,
    "ISS-6050 nulls `cost_summary` for list reads, so the sync shape must cost more"
  );
});

test("ISS-6105: the full-data shape prices event payloads by SIZE, not by row count", () => {
  // Equal row counts, wildly different payloads. A per-row average would score
  // these identically — which is the id-count proxy the module exists to
  // replace, wearing a heap number's clothes.
  const rows = 200;
  const lightBlob = 64;
  const heavyBlob = 64 * 1024;
  const light = cost("light", {
    eventRowCount: rows,
    eventDataBytes: rows * lightBlob,
  });
  const heavy = cost("heavy", {
    eventRowCount: rows,
    eventDataBytes: rows * heavyBlob,
  });

  const lightEstimate = estimateSessionHydrationHeapBytes(light, FULL_SHAPE);
  const heavyEstimate = estimateSessionHydrationHeapBytes(heavy, FULL_SHAPE);
  const expected = (blob: number) =>
    Math.ceil(
      (rows * EVENT_ROW_HEAP_BYTES +
        rows * blob * EVENT_DATA_HEAP_BYTES_PER_SOURCE_BYTE) *
        HYDRATION_ASSEMBLY_HEAP_MULTIPLIER
    );

  assert.equal(lightEstimate, expected(lightBlob));
  assert.equal(heavyEstimate, expected(heavyBlob));
  assert.ok(
    heavyEstimate > 20 * lightEstimate,
    "the same row count with 1024x the payload must cost far more, not the same"
  );
  assert.ok(
    lightEstimate < SYNCED_SESSION_HYDRATION_HEAP_BUDGET_BYTES,
    "the light session still fits a chunk"
  );
  assert.ok(
    heavyEstimate > SYNCED_SESSION_HYDRATION_HEAP_BUDGET_BYTES,
    "13 MB of stored event payload exceeds the 48 MiB chunk budget once parsed — it must be recognised as over-budget"
  );
  assert.deepEqual(
    planSyncedSessionHydrationChunks(
      ["light", "heavy"],
      costMap([light, heavy]),
      FULL_SHAPE
    ),
    [["light"], ["heavy"]],
    "and identical row counts with different payloads must chunk differently"
  );
});

test("ISS-6105: a shape that nulls events.data does not pay for the blob it never reads", () => {
  const rows = cost("s", { eventRowCount: 100, eventDataBytes: 100 * 64_000 });

  assert.equal(
    estimateSessionHydrationHeapBytes(rows, LIST_SHAPE),
    Math.ceil(100 * EVENT_ROW_HEAP_BYTES * HYDRATION_ASSEMBLY_HEAP_MULTIPLIER),
    "FEA-2038 nulls the blob in SQL for this shape, so it contributes nothing"
  );
  assert.ok(
    estimateSessionHydrationHeapBytes(rows, FULL_SHAPE) >
      estimateSessionHydrationHeapBytes(rows, LIST_SHAPE),
    "and the shape that does read it must cost more for the identical rows"
  );
});

test("ISS-6105: an unmeasured event-payload size is unknown only for the shape that reads it", () => {
  // `eventDataBytes: null` is what the sizing read stores when the shape did not
  // measure the blob. That is a true zero for an `omitEventData` hydration and
  // an UNKNOWN for one that loads the payload — it must never silently price as
  // zero for the latter.
  const unmeasured = cost("s", { eventRowCount: 100, eventDataBytes: null });

  assert.equal(
    estimateSessionHydrationHeapBytes(unmeasured, LIST_SHAPE),
    Math.ceil(100 * EVENT_ROW_HEAP_BYTES * HYDRATION_ASSEMBLY_HEAP_MULTIPLIER)
  );
  assert.equal(
    estimateSessionHydrationHeapBytes(unmeasured, FULL_SHAPE),
    UNKNOWN_SESSION_HYDRATION_HEAP_BYTES
  );
});

test("ISS-6105: a nonsense sizing count sizes the session at the WHOLE budget, never at zero", () => {
  // The direction is the whole point. A count that cannot be a count means the
  // session's true size is UNKNOWN, and an unknown session that estimates at
  // zero is FREE to pack — so an arbitrarily heavy session whose count arrived
  // corrupt would be packed alongside a full budget of known ones, restoring the
  // oversized chunk this module exists to prevent. Every unusable shape the
  // raw-SQL boundary can hand us therefore degrades UPWARD.
  for (const invalid of INVALID_SIZING_COUNTS) {
    const perField: Partial<Omit<SyncedSessionHydrationCost, "sessionId">>[] = [
      { metadataBytes: invalid },
      { eventRowCount: invalid },
      { tokenEventRowCount: invalid },
    ];
    for (const overrides of perField) {
      assert.equal(
        estimateSessionHydrationHeapBytes(cost("s", overrides), LIST_SHAPE),
        UNKNOWN_SESSION_HYDRATION_HEAP_BYTES,
        `${JSON.stringify(overrides)} must size at the whole budget, not at zero`
      );
    }
    assert.equal(
      estimateSessionHydrationHeapBytes(
        cost("s", { eventDataBytes: invalid }),
        FULL_SHAPE
      ),
      UNKNOWN_SESSION_HYDRATION_HEAP_BYTES,
      `eventDataBytes=${String(invalid)} must size at the whole budget for the shape that reads the payload`
    );
  }
});

test("ISS-6105: a session with a nonsense count is isolated rather than packed with its neighbours", () => {
  for (const invalid of INVALID_SIZING_COUNTS) {
    const ids = ["small-before", "corrupt", "small-after"];
    const chunks = planSyncedSessionHydrationChunks(
      ids,
      costMap([
        cost("small-before", { eventRowCount: 10 }),
        cost("corrupt", { eventRowCount: invalid }),
        cost("small-after", { eventRowCount: 10 }),
      ]),
      LIST_SHAPE
    );

    assert.deepEqual(
      chunks,
      [["small-before"], ["corrupt"], ["small-after"]],
      `a session sized from ${String(invalid)} must not share a chunk`
    );
    assert.deepEqual(flatten(chunks), ids, "and no id is lost isolating it");
  }
});

test("ISS-6105: the sizing read reports an unusable column as unknown, never as zero", async () => {
  // The raw-SQL boundary is a genuine trust boundary: `COALESCE(LENGTH(...), 0)`
  // and `COUNT(*)` cannot legitimately produce these, so each one means the row
  // is corrupt — not that the session is empty.
  const reader = {
    read: (
      fn: (client: { $queryRawUnsafe: () => Promise<unknown[]> }) => unknown
    ) =>
      fn({
        $queryRawUnsafe: () =>
          Promise.resolve([
            {
              session_id: "corrupt",
              metadata_bytes: -1,
              event_rows: Number.NaN,
              event_data_bytes: -5,
              token_event_rows: Number.POSITIVE_INFINITY,
            },
            {
              session_id: "null-columns",
              metadata_bytes: null,
              event_rows: null,
              event_data_bytes: null,
              token_event_rows: null,
            },
            {
              session_id: "healthy",
              metadata_bytes: 0,
              event_rows: 10n,
              event_data_bytes: 4096n,
              token_event_rows: 0,
            },
          ]),
      }),
  } as unknown as DesktopPrisma;

  const costs = await loadSyncedSessionHydrationCosts(
    reader,
    ["corrupt", "null-columns", "healthy"],
    FULL_SHAPE
  );

  assert.deepEqual(costs.get("corrupt"), {
    sessionId: "corrupt",
    metadataBytes: null,
    eventRowCount: null,
    eventDataBytes: null,
    tokenEventRowCount: null,
  });
  assert.deepEqual(costs.get("null-columns"), {
    sessionId: "null-columns",
    metadataBytes: null,
    eventRowCount: null,
    eventDataBytes: null,
    tokenEventRowCount: null,
  });
  assert.deepEqual(
    costs.get("healthy"),
    {
      sessionId: "healthy",
      metadataBytes: 0,
      eventRowCount: 10,
      eventDataBytes: 4096,
      tokenEventRowCount: 0,
    },
    "a genuine zero is a real count and stays a real count"
  );

  const ids = ["corrupt", "null-columns", "healthy"];
  const chunks = planSyncedSessionHydrationChunks(ids, costs, FULL_SHAPE);
  assert.deepEqual(
    chunks,
    [["corrupt"], ["null-columns"], ["healthy"]],
    "each unusable row takes a chunk of its own instead of packing as free"
  );
  assert.deepEqual(flatten(chunks), ids);
});

test("ISS-6105: the payload-size term is selected only for the shape that reads the payload", async () => {
  // The blob sum is the one term that cannot come from the covering index, so
  // the hot `omitEventData` lanes must not start paying a payload scan for a
  // column their hydration nulls in SQL.
  const statements: string[] = [];
  const reader = {
    read: (
      fn: (client: {
        $queryRawUnsafe: (sql: string) => Promise<unknown[]>;
      }) => unknown
    ) =>
      fn({
        $queryRawUnsafe: (sql: string) => {
          statements.push(sql);
          return Promise.resolve([
            {
              session_id: "s",
              metadata_bytes: 0,
              event_rows: 1,
              token_event_rows: 0,
            },
          ]);
        },
      }),
  } as unknown as DesktopPrisma;

  const listCosts = await loadSyncedSessionHydrationCosts(
    reader,
    ["s"],
    LIST_SHAPE
  );
  assert.equal(statements.length, 1);
  assert.ok(
    !EVENT_DATA_SUM_SQL.test(statements[0]),
    "the omitEventData shape does not pay a payload scan for a column it nulls"
  );
  assert.ok(
    METADATA_BYTES_SQL.test(statements[0]),
    "and metadata is still sized in BYTES, not in characters"
  );
  assert.equal(
    listCosts.get("s")?.eventDataBytes,
    null,
    "an unmeasured payload size is stored as unknown, not as a fabricated zero"
  );

  await loadSyncedSessionHydrationCosts(reader, ["s"], FULL_SHAPE);
  assert.equal(statements.length, 2);
  assert.ok(
    EVENT_DATA_SUM_SQL.test(statements[1]),
    "the shape that loads events.data sizes it from the summed blob length"
  );
});

test("ISS-6105: cheap sessions pack together, and the pack stops at the budget", () => {
  // Each session is a quarter of the budget, so exactly four fit per chunk.
  const quarterBudgetEvents = Math.floor(
    SYNCED_SESSION_HYDRATION_HEAP_BUDGET_BYTES /
      4 /
      (EVENT_ROW_HEAP_BYTES * HYDRATION_ASSEMBLY_HEAP_MULTIPLIER)
  );
  const ids = ["a", "b", "c", "d", "e", "f"];
  const chunks = planSyncedSessionHydrationChunks(
    ids,
    costMap(ids.map((id) => cost(id, { eventRowCount: quarterBudgetEvents }))),
    LIST_SHAPE
  );

  assert.deepEqual(chunks, [
    ["a", "b", "c", "d"],
    ["e", "f"],
  ]);
  assert.deepEqual(flatten(chunks), ids, "every id survives, in order");
});

test("ISS-6105: a session larger than the whole budget takes a chunk of its own and is never dropped", () => {
  // The shape measured on the real snapshot: one 26k-event / 22k-token-event
  // session sitting between ordinary neighbours.
  const ids = ["small-before", "monster", "small-after"];
  const chunks = planSyncedSessionHydrationChunks(
    ids,
    costMap([
      cost("small-before", { eventRowCount: 10 }),
      cost("monster", {
        metadataBytes: 9_862_784,
        eventRowCount: 26_071,
        tokenEventRowCount: 22_001,
      }),
      cost("small-after", { eventRowCount: 10 }),
    ]),
    SYNC_SHAPE
  );

  assert.deepEqual(chunks, [["small-before"], ["monster"], ["small-after"]]);
  assert.deepEqual(
    flatten(chunks),
    ids,
    "an over-budget session is isolated, NEVER deferred or discarded"
  );
});

test("ISS-6105: a session the sizing read could not see is isolated rather than packed blind", () => {
  const ids = ["known", "unsized"];
  const chunks = planSyncedSessionHydrationChunks(
    ids,
    // `unsized` deliberately absent from the cost map.
    costMap([cost("known", { eventRowCount: 10 })]),
    LIST_SHAPE
  );

  assert.deepEqual(chunks, [["known"], ["unsized"]]);
  assert.equal(
    UNKNOWN_SESSION_HYDRATION_HEAP_BYTES,
    SYNCED_SESSION_HYDRATION_HEAP_BUDGET_BYTES,
    "an unknown session is sized at the whole budget — the conservative direction"
  );
});

test("ISS-6105: the count backstop still bounds a chunk of zero-cost sessions", () => {
  const ids = Array.from({ length: 450 }, (_, i) => `s${i}`);
  const chunks = planSyncedSessionHydrationChunks(
    ids,
    costMap(ids.map((id) => cost(id))),
    LIST_SHAPE,
    SYNCED_SESSION_HYDRATION_HEAP_BUDGET_BYTES,
    200
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [200, 200, 50],
    "free sessions would otherwise pack unboundedly past the SQLite parameter ceiling"
  );
  assert.deepEqual(flatten(chunks), ids);
});

test("ISS-6105: an empty id list plans no chunks at all", () => {
  assert.deepEqual(
    planSyncedSessionHydrationChunks([], new Map(), LIST_SHAPE),
    []
  );
});

test("ISS-6105: a lone id plans exactly one chunk regardless of its size", () => {
  assert.deepEqual(
    planSyncedSessionHydrationChunks(
      ["only"],
      costMap([
        cost("only", { metadataBytes: 50_000_000, tokenEventRowCount: 90_000 }),
      ]),
      SYNC_SHAPE
    ),
    [["only"]]
  );
});

test("ISS-6105: a sizing-read failure degrades to fixed chunking and still returns every id", async () => {
  // The load-bearing safety branch: a hydration that cannot SIZE itself must
  // still hydrate everything it was asked for. ISS-6031 established that an
  // empty/short `loadSyncedSessions` result is what the sync lane's absence
  // handling has to interpret, so a sizing failure that silently shortened the
  // plan would present as sessions that "failed to hydrate" — the one shape
  // this lane must never manufacture.
  const ids = Array.from({ length: 450 }, (_, i) => `s${i}`);
  const logged: string[] = [];
  const failingPrisma = {
    read: () => Promise.reject(new Error("reader unavailable")),
  } as unknown as DesktopPrisma;

  const chunks = await planSyncedSessionHydration(
    failingPrisma,
    ids,
    { omitEventData: true },
    (message) => logged.push(message)
  );

  assert.deepEqual(
    chunks.flat(),
    ids,
    "every id survives the degrade, in order — a sizing failure costs memory, never a session"
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [
      SYNCED_SESSION_HYDRATE_CHUNK_SIZE,
      SYNCED_SESSION_HYDRATE_CHUNK_SIZE,
      ids.length - 2 * SYNCED_SESSION_HYDRATE_CHUNK_SIZE,
    ],
    "the degrade is the pre-ISS-6105 fixed chunking, not an unbounded single chunk"
  );
  assert.equal(
    logged.length,
    1,
    "the degrade is surfaced, not swallowed silently"
  );
  assert.match(logged[0], SIZING_FAILURE_LOG);
  assert.match(logged[0], SIZING_FAILURE_CAUSE_LOG);
  // thadeusb (#4910): the same text also goes to the DURABLE main-process log,
  // because `db-host-worker.ts` never supplies the injectable sink above — so in
  // production `logged` is a no-op and this would otherwise be the one
  // degradation in this module with no trace at all. Both sinks are handed the
  // output of one builder, which is what this pins; the `writePersistentLog`
  // call itself is not directly asserted because the desktop node suite has no
  // mock convention for it (see the same note in
  // `shared-branches-zero-spend.test.ts`).
  assert.equal(
    logged[0],
    sizingDegradeMessage(ids.length, new Error("reader unavailable")),
    "the injected sink and the durable log must carry identical wording"
  );
});

test("ISS-6105: a multi-batch sizing sweep yields the loop and round-robins the readers", async () => {
  // FEA-2264. Awaiting a libSQL statement only turns the MICROTASK queue, so a
  // sweep with no macrotask boundary blocks the renderer's queued reads for its
  // whole duration. The widest caller is the 5,000-id list fallback on the
  // 2-second page-data poll — 25 batches back to back — so this is sized at the
  // multi-batch case, not the single-batch one the original measurement used.
  const events: string[] = [];
  let batch = 0;
  const prisma = {
    read: (
      fn: (client: { $queryRawUnsafe: () => Promise<unknown[]> }) => unknown
    ) => {
      const index = batch++;
      events.push(`read:${index}`);
      if (index === 0) {
        // Queued from INSIDE the first batch, so it can only run once the loop
        // actually reaches the check phase.
        setImmediate(() => events.push("macrotask"));
      }
      return fn({ $queryRawUnsafe: () => Promise.resolve([]) });
    },
  } as unknown as DesktopPrisma;

  const ids = Array.from(
    { length: SYNCED_SESSION_HYDRATE_MAX_CHUNK_IDS + 1 },
    (_, i) => `s${i}`
  );
  await loadSyncedSessionHydrationCosts(prisma, ids, LIST_SHAPE);

  assert.deepEqual(
    events,
    ["read:0", "macrotask", "read:1"],
    "the loop must reach the check phase BETWEEN batches — without the yield the second statement runs first, on a microtask"
  );
  assert.equal(
    batch,
    2,
    "each batch takes its own prisma.read so the two pooled readers round-robin instead of one being pinned for the sweep"
  );
});

test("ISS-6105: a single-batch sizing sweep does not pay an idle loop turn", async () => {
  const events: string[] = [];
  const prisma = {
    read: (
      fn: (client: { $queryRawUnsafe: () => Promise<unknown[]> }) => unknown
    ) => {
      events.push("read");
      setImmediate(() => events.push("macrotask"));
      return fn({ $queryRawUnsafe: () => Promise.resolve([]) });
    },
  } as unknown as DesktopPrisma;

  await loadSyncedSessionHydrationCosts(prisma, ["only"], LIST_SHAPE);

  assert.deepEqual(
    events,
    ["read"],
    "the final batch must not yield — the sweep returns without an extra turn"
  );
});

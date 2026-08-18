/**
 * @file agent-session-sync-component-cursor-keyset.test.ts
 * @description Regression coverage for the component-inventory sync lane's
 * KEYSET cursor (fix/component-sync-cursor-keyset).
 *
 * BUG: the lane previously read `WHERE last_seen_at >= watermark` and advanced
 * the watermark to `max(last_seen_at)` of the accepted batch. When MORE than
 * `AGENT_COMPONENT_BATCH_SIZE` rows share ONE `last_seen_at`, the first batch's
 * `max(last_seen_at)` equals the current watermark, so the watermark never
 * moves — the same first batch re-uploaded on every tick forever and the rest
 * (including all components with a LATER `last_seen_at`) never synced.
 *
 * FIX: page with a proper keyset on `(last_seen_at, id)` — read STRICTLY AFTER
 * the `(sinceTs, sinceId)` position and advance to the LAST row of the batch —
 * so the lane pages monotonically through a same-timestamp cluster one batch at
 * a time and completes.
 *
 * These tests drive the private lane through the public tick surface (`start()`
 * fires the first tick, `refresh()` drives each subsequent one), mirroring
 * `agent-session-sync-component-diag.test.ts`. The injected
 * `listComponentCursorRows(sinceTs, sinceId)` fake reproduces the real SQLite
 * keyset semantics against an in-memory, `(last_seen_at, id)`-sorted table.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import type {
  AgentComponentCursorRow,
  AgentSessionSyncSource,
  PersistedSyncState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  AGENT_COMPONENT_BATCH_SIZE,
  AGENT_COMPONENT_SYNC_PAYLOAD_REVISION,
  AGENT_COMPONENT_SYNC_SOURCE_KIND,
  buildAgentComponentSyncSourceKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  acceptedResult,
  flush,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";

const COMPUTE_TARGET = "target-keyset";

/**
 * An in-memory `agent_components` table that reproduces the production keyset
 * read: rows sorted by (last_seen_at, id) ASC, returned STRICTLY AFTER the
 * `(sinceTs, sinceId)` position. `last_seen_at` is normalized to '' so nulls
 * sort first, exactly like `COALESCE(last_seen_at,'')` in the SQL.
 */
function makeKeysetTable(rows: AgentComponentCursorRow[]) {
  const norm = (ts: string | null): string => ts ?? "";
  const sorted = [...rows].sort((a, b) => {
    const at = norm(a.last_seen_at);
    const bt = norm(b.last_seen_at);
    if (at !== bt) {
      return at < bt ? -1 : 1;
    }
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? -1 : 1;
  });
  return {
    read(sinceTs: string, sinceId: string): AgentComponentCursorRow[] {
      return sorted.filter((r) => {
        const t = norm(r.last_seen_at);
        return t > sinceTs || (t === sinceTs && r.id > sinceId);
      });
    },
  };
}

/**
 * Build a service whose component lane reads from `table` and records every id
 * it uploads. Cursor state is in-memory in the service, so multiple ticks on
 * one instance page forward exactly as production does.
 */
function makeService(
  table: ReturnType<typeof makeKeysetTable>,
  rowsById: Map<string, AgentComponentCursorRow>
): { service: AgentSessionSyncService; uploads: string[][] } {
  const uploads: string[][] = [];
  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: (payload) => {
      uploads.push(payload.components.map((c) => c.externalId));
      return Promise.resolve(acceptedResult());
    },
  };
  return { service: new AgentSessionSyncService(options), uploads };
}

test("component cursor keyset: pages through a same-timestamp cluster larger than the batch, exactly-once, without stalling", async () => {
  gatewayLog.clear();

  // 250 components ALL sharing ONE last_seen_at (> AGENT_COMPONENT_BATCH_SIZE),
  // plus 60 at a strictly-later timestamp. The old `>=`+`max()` cursor would
  // re-upload the first 200 of the shared cluster forever and never reach the
  // rest.
  const SHARED = "2026-07-12T14:08:43.186Z";
  const LATER = "2026-07-12T15:00:00.000Z";
  const clusterCount = 250;
  const laterCount = 60;
  const rows: AgentComponentCursorRow[] = [];
  for (let i = 0; i < clusterCount; i++) {
    rows.push({ id: `c-${String(i).padStart(4, "0")}`, last_seen_at: SHARED });
  }
  for (let i = 0; i < laterCount; i++) {
    rows.push({ id: `l-${String(i).padStart(4, "0")}`, last_seen_at: LATER });
  }
  assert.ok(
    clusterCount > AGENT_COMPONENT_BATCH_SIZE,
    "the shared cluster must exceed the batch size to exercise the bug"
  );

  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const table = makeKeysetTable(rows);
  const { service, uploads } = makeService(table, rowsById);

  // Enough ticks to drain: ceil(310 / 200) = 2 full batches, plus headroom to
  // prove the lane STOPS (no infinite re-send) once caught up.
  service.start();
  await flush();
  for (let i = 0; i < 8; i++) {
    service.refresh();
    await flush();
  }
  service.stop();

  const flatUploads = uploads.flat();
  const uniqueUploaded = new Set(flatUploads);

  // Every component was sent...
  assert.equal(
    uniqueUploaded.size,
    rows.length,
    `every component should sync; got ${uniqueUploaded.size}/${rows.length}`
  );
  for (const r of rows) {
    assert.ok(uniqueUploaded.has(r.id), `component ${r.id} was never synced`);
  }

  // ...exactly once (no id re-uploaded — the cursor never re-sends a batch).
  assert.equal(
    flatUploads.length,
    rows.length,
    `no component should be uploaded more than once; total sends ${flatUploads.length} vs ${rows.length} rows`
  );

  // The cursor reached completion: once drained, later ticks upload nothing.
  const batchesWithRows = uploads.filter((b) => b.length > 0);
  assert.equal(
    batchesWithRows.length,
    Math.ceil(rows.length / AGENT_COMPONENT_BATCH_SIZE),
    "lane pages in exactly ceil(total/batch) non-empty batches, then stops"
  );
  // The FIRST batch is a full cluster page (200), NOT re-sent — proving the
  // watermark advanced past the shared timestamp.
  assert.equal(
    batchesWithRows[0].length,
    AGENT_COMPONENT_BATCH_SIZE,
    "first page fills the batch from the shared-timestamp cluster"
  );
});

test("component cursor keyset: a component whose last_seen_at advances past the cursor is re-synced (re-sync-on-change)", async () => {
  gatewayLog.clear();

  const T1 = "2026-07-12T10:00:00.000Z";
  const T2 = "2026-07-12T20:00:00.000Z";
  const rows: AgentComponentCursorRow[] = [
    { id: "a", last_seen_at: T1 },
    { id: "b", last_seen_at: T1 },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  // Mutable table so we can bump a row's last_seen_at between ticks.
  let table = makeKeysetTable(rows);
  const uploads: string[][] = [];
  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: (payload) => {
      uploads.push(payload.components.map((c) => c.externalId));
      return Promise.resolve(acceptedResult());
    },
  };
  const service = new AgentSessionSyncService(options);

  // Tick 1: both sync, cursor at (T1, "b").
  service.start();
  await flush();
  // Tick 2: nothing new.
  service.refresh();
  await flush();
  assert.deepEqual(uploads.flat(), ["a", "b"], "initial two synced once");

  // "b" is re-seen with a LATER timestamp — it moves past the cursor and must
  // be re-selected on the next tick.
  const bumped: AgentComponentCursorRow = { id: "b", last_seen_at: T2 };
  rowsById.set("b", bumped);
  table = makeKeysetTable([{ id: "a", last_seen_at: T1 }, bumped]);

  service.refresh();
  await flush();
  service.stop();

  assert.deepEqual(
    uploads.flat(),
    ["a", "b", "b"],
    "the re-seen component (b) is re-synced after its last_seen_at advances"
  );
});

/**
 * ISS-5029 (wongk, #4391): a durable cursor store, so this suite can drive the
 * lane the way a REAL install runs it — with a watermark persisted by an earlier
 * version of the app.
 */
function makeStoreBackedService(
  table: ReturnType<typeof makeKeysetTable>,
  rowsById: Map<string, AgentComponentCursorRow>,
  store: Map<string, PersistedSyncState>
): { service: AgentSessionSyncService; uploads: string[][] } {
  const uploads: string[][] = [];
  // Only the two cursor methods are exercised; the rest of the source is unused,
  // so it is built narrowly and widened once (test-local), mirroring
  // `agent-session-sync-component-dead-letter.test.ts`.
  const source: Pick<
    AgentSessionSyncSource,
    "loadSyncState" | "advanceSyncState"
  > = {
    loadSyncState: (key: string) => store.get(key) ?? null,
    advanceSyncState: (key: string, state: PersistedSyncState) => {
      store.set(key, state);
    },
  };
  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => source as AgentSessionSyncSource,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: (payload) => {
      uploads.push(payload.components.map((c) => c.externalId));
      return Promise.resolve(acceptedResult());
    },
  };
  return { service: new AgentSessionSyncService(options), uploads };
}

test("ISS-5029: the payload revision bump replays an already-drained component cursor, so an existing install starts sending the truncation marker", async () => {
  gatewayLog.clear();

  // The marker (`variantsTruncated` / `variantsTruncatedReason`) is derived from
  // `agent_component_versions` — a SIBLING table the keyset cursor does not walk.
  // Teaching the packer to send it therefore does not touch the
  // `agent_components` rows the cursor has already passed, so without a revision
  // bump every install that had drained the previous key would keep the marker
  // below its watermark forever: the feature would ship dark on precisely the
  // long-lived installs whose histories have had time to grow past the cap.
  const SEEN = "2026-07-20T10:00:00.000Z";
  const rows: AgentComponentCursorRow[] = [
    { id: "c-1", last_seen_at: SEEN },
    { id: "c-2", last_seen_at: SEEN },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));

  // Pin the revision itself: a silent revert to `v2` is exactly the regression
  // this test exists to catch, and it is invisible from behaviour alone once the
  // key below is derived from the constant.
  assert.equal(
    AGENT_COMPONENT_SYNC_PAYLOAD_REVISION,
    "v3",
    "ISS-5029 bumped the component payload revision; see the constant's comment"
  );
  const currentKey = buildAgentComponentSyncSourceKey(COMPUTE_TARGET);
  const drainedLegacyKey = `${AGENT_COMPONENT_SYNC_SOURCE_KIND}:v2:${COMPUTE_TARGET}`;
  assert.notEqual(
    currentKey,
    drainedLegacyKey,
    "the cursor key must change, or hydration finds the drained watermark"
  );

  // An install that fully drained the PREVIOUS revision: watermark parked on the
  // last row, nothing pending.
  const drained: PersistedSyncState = {
    observedTopUpdatedAt: SEEN,
    observedIdsAtTopUpdatedAt: ["c-2"],
    deadLetteredIds: [],
  };

  const legacyStore = new Map<string, PersistedSyncState>([
    [drainedLegacyKey, { ...drained }],
  ]);
  const replay = makeStoreBackedService(
    makeKeysetTable(rows),
    rowsById,
    legacyStore
  );
  replay.service.start();
  await flush();
  replay.service.stop();

  assert.deepEqual(
    replay.uploads.flat(),
    ["c-1", "c-2"],
    "the whole inventory re-emits, carrying the marker for rows already below the old watermark"
  );

  // The discriminator: the SAME drained cursor stored under the CURRENT key must
  // suppress the replay. Without it this test would pass on an empty store — and
  // therefore pass even if the revision were never bumped.
  const currentStore = new Map<string, PersistedSyncState>([
    [currentKey, { ...drained }],
  ]);
  const noReplay = makeStoreBackedService(
    makeKeysetTable(rows),
    rowsById,
    currentStore
  );
  noReplay.service.start();
  await flush();
  noReplay.service.stop();

  assert.deepEqual(
    noReplay.uploads.flat(),
    [],
    "a cursor drained under the CURRENT key still suppresses re-sending — the replay above comes from the key change, not an empty store"
  );
});

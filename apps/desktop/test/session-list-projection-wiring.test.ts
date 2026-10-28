import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import type * as ProjectionModule from "../src/main/database/session-list-trace-projection.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import type * as BoundedReadsModule from "../src/main/database/sync-source-bounded-reads.js";
import type * as SessionRowsModule from "../src/main/database/sync-source-session-rows.js";
import { selectSessionRows } from "../src/main/database/sync-source-session-rows.js";
import type * as TokenEventColumnsModule from "../src/main/database/token-event-columns.js";
import {
  insertSqliteEvent,
  insertSqliteSession,
} from "./sqlite-session-fixtures.js";

const NULL_METADATA_PROJECTION = /NULL AS metadata/;
const STORED_METADATA_PROJECTION = /\n\s*metadata AS metadata,/;
const rawReadTraps = vi.hoisted(() => ({
  selectEventRows: vi.fn(() => {
    throw new Error("raw event selector entered");
  }),
  selectTokenEventRows: vi.fn(() => {
    throw new Error("raw token-event selector entered");
  }),
}));
const projectionSeam = vi.hoisted(() => ({
  afterEnsure: vi.fn<() => Promise<void>>(),
}));
const sessionRowSeam = vi.hoisted(() => ({
  options: [] as Parameters<typeof SessionRowsModule.selectSessionRows>[2][],
}));

vi.mock(
  "../src/main/database/sync-source-bounded-reads.js",
  async (importOriginal) => {
    const original = await importOriginal<typeof BoundedReadsModule>();
    return { ...original, selectEventRows: rawReadTraps.selectEventRows };
  }
);

vi.mock(
  "../src/main/database/token-event-columns.js",
  async (importOriginal) => {
    const original = await importOriginal<typeof TokenEventColumnsModule>();
    return {
      ...original,
      selectTokenEventRows: rawReadTraps.selectTokenEventRows,
    };
  }
);

vi.mock(
  "../src/main/database/session-list-trace-projection.js",
  async (importOriginal) => {
    const original = await importOriginal<typeof ProjectionModule>();
    return {
      ...original,
      ensureSessionListTraceProjections: async (
        ...args: Parameters<typeof original.ensureSessionListTraceProjections>
      ) => {
        await original.ensureSessionListTraceProjections(...args);
        await projectionSeam.afterEnsure();
      },
    };
  }
);

vi.mock(
  "../src/main/database/sync-source-session-rows.js",
  async (importOriginal) => {
    const original = await importOriginal<typeof SessionRowsModule>();
    return {
      ...original,
      selectSessionRows: (
        ...args: Parameters<typeof original.selectSessionRows>
      ) => {
        sessionRowSeam.options.push(args[2]);
        return original.selectSessionRows(...args);
      },
    };
  }
);

test("list base rows omit metadata without changing the default load", async () => {
  const statements: string[] = [];
  const reader = {
    $queryRawUnsafe: (sql: string) => {
      statements.push(sql);
      return Promise.resolve([]);
    },
  } as unknown as Parameters<typeof selectSessionRows>[0];

  await selectSessionRows(reader, ["list-row"], { omitMetadata: true });
  await selectSessionRows(reader, ["detail-or-sync-row"]);

  assert.match(statements[0], NULL_METADATA_PROJECTION);
  assert.doesNotMatch(statements[1], NULL_METADATA_PROJECTION);
  assert.match(statements[1], STORED_METADATA_PROJECTION);
});

test("production list wiring bypasses raw stream selectors and sync assembly", async () => {
  projectionSeam.afterEnsure.mockReset().mockResolvedValue(undefined);
  sessionRowSeam.options.length = 0;
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-12461-wiring-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "store"),
    detectBillingMode: () => "api",
  });
  try {
    await insertSqliteSession(db, "projection-wiring");
    db.syncSource.loadSyncedSessions = () => {
      throw new Error("sync assembler entered");
    };
    const response = await db.syncSource.projectSessionList?.({
      request: {
        ids: ["projection-wiring"],
        quality: "all",
        limit: 10,
        offset: 0,
      },
      computeTargetId: null,
      users: [],
    });
    assert.equal(response?.items[0]?.externalSessionId, "projection-wiring");
    assert.ok(sessionRowSeam.options.length > 0);
    assert.ok(
      sessionRowSeam.options.every((options) => options?.omitMetadata === true)
    );
    assert.equal(rawReadTraps.selectEventRows.mock.calls.length, 0);
    assert.equal(rawReadTraps.selectTokenEventRows.mock.calls.length, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production list repairs a projection invalidated before its read snapshot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-12461-read-race-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "store"),
    detectBillingMode: () => "api",
  });
  try {
    const sessionId = "projection-read-race";
    await insertSqliteSession(db, sessionId);
    projectionSeam.afterEnsure
      .mockReset()
      .mockResolvedValue(undefined)
      .mockImplementationOnce(() =>
        db.run(
          "DELETE FROM session_list_trace_projection WHERE session_id = $1",
          sessionId
        )
      );

    const response = await db.syncSource.projectSessionList?.({
      request: { ids: [sessionId], quality: "all", limit: 10, offset: 0 },
      computeTargetId: null,
      users: [],
    });

    assert.equal(response?.items[0]?.externalSessionId, sessionId);
    assert.ok(projectionSeam.afterEnsure.mock.calls.length >= 2);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production list renders from its snapshot when invalidation outpaces repair", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-12461-read-retry-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "store"),
    detectBillingMode: () => "api",
  });
  try {
    const sessionId = "projection-read-retry";
    await insertSqliteSession(db, sessionId);
    projectionSeam.afterEnsure
      .mockReset()
      .mockImplementation(() =>
        db.run(
          "DELETE FROM session_list_trace_projection WHERE session_id = $1",
          sessionId
        )
      );

    const response = await db.syncSource.projectSessionList?.({
      request: { ids: [sessionId], quality: "all", limit: 10, offset: 0 },
      computeTargetId: null,
      users: [],
    });

    assert.equal(response?.items[0]?.externalSessionId, sessionId);
    assert.ok(projectionSeam.afterEnsure.mock.calls.length >= 2);
    assert.equal(await projectionCount(db, sessionId), 0);
  } finally {
    projectionSeam.afterEnsure.mockReset().mockResolvedValue(undefined);
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("active list reads stay ephemeral and reflect appended trace rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-12461-active-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "store"),
    detectBillingMode: () => "api",
  });
  try {
    const sessionId = "projection-active";
    await insertSqliteSession(db, sessionId, {
      status: "active",
      startedAt: "2026-09-21T11:00:00.000Z",
      updatedAt: "2026-09-21T11:00:00.000Z",
    });
    projectionSeam.afterEnsure.mockReset().mockImplementation(() => {
      throw new Error("active projection entered writer promotion");
    });

    const first = await db.syncSource.projectSessionList?.({
      request: { ids: [sessionId], quality: "all", limit: 10, offset: 0 },
      computeTargetId: null,
      users: [],
    });
    assert.equal(
      first?.items[0]?.lastActivityAt.toISOString(),
      "2026-09-21T11:00:00.000Z"
    );
    assert.equal(await projectionCount(db, sessionId), 0);

    await insertSqliteEvent(db, sessionId, "2026-09-21T11:05:00.000Z");
    await db.run(
      `INSERT INTO token_events
         (session_id, transport_id, model, created_at, input_tokens,
          input_cost_usd_estimated)
       VALUES ($1, 'active-token', 'gpt-active', $2, 1, 0.25)`,
      sessionId,
      "2026-09-21T11:05:00.000Z"
    );
    const second = await db.syncSource.projectSessionList?.({
      request: { ids: [sessionId], quality: "all", limit: 10, offset: 0 },
      computeTargetId: null,
      users: [],
    });

    assert.equal(
      second?.items[0]?.lastActivityAt.toISOString(),
      "2026-09-21T11:05:00.000Z"
    );
    assert.equal(
      second?.items[0]?.activityBuckets?.[0]?.byModel["gpt-active"]?.cIn,
      0.25
    );
    assert.equal(await projectionCount(db, sessionId), 0);
    assert.equal(projectionSeam.afterEnsure.mock.calls.length, 0);
  } finally {
    projectionSeam.afterEnsure.mockReset().mockResolvedValue(undefined);
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production page data attributes same-timestamp agent evidence before the next prompt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-12461-tie-order-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "store"),
    detectBillingMode: () => "api",
  });
  try {
    const sessionId = "projection-autonomy-tie";
    const firstPromptAt = "2026-09-21T11:00:00.000Z";
    const tieAt = "2026-09-21T11:01:40.000Z";
    await insertSqliteSession(db, sessionId, {
      status: "active",
      startedAt: firstPromptAt,
      updatedAt: tieAt,
      metadata: JSON.stringify({
        messages: [
          { role: "human", timestamp: firstPromptAt },
          { role: "human", timestamp: tieAt },
        ],
      }),
    });
    await insertSqliteEvent(db, sessionId, tieAt);
    await db.run(
      "UPDATE events SET event_type = 'AssistantMessage' WHERE session_id = $1",
      sessionId
    );

    const response = await db.syncSource.projectSessionList?.({
      request: {
        ids: [sessionId],
        autonomyTiers: ["high"],
        quality: "all",
        limit: 10,
        offset: 0,
      },
      computeTargetId: null,
      users: [],
    });

    assert.equal(response?.total, 1);
    assert.equal(response?.items[0]?.autonomy, 100);
    assert.equal(response?.items[0]?.steeringEpisodes, 1);
    assert.equal(
      response?.items[0]?.activityBuckets?.reduce(
        (total, bucket) => total + bucket.total,
        0
      ),
      3
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function projectionCount(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sessionId: string
): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ count: number | bigint }>
  >(
    "SELECT COUNT(*) AS count FROM session_list_trace_projection WHERE session_id = $1",
    sessionId
  );
  return Number(rows[0]?.count ?? 0);
}

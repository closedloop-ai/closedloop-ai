/**
 * @file session-detail-event-cap.test.ts
 * @description ISS-5407: the desktop session-detail `events` read is bounded at
 * the SAME ceiling its cloud twin uses (ISS-5075 capped the cloud at
 * `SESSION_DETAIL_EVENT_MAX_ROWS`), reading one row past it so a read that hit
 * the bound is reported as `eventsTruncated` instead of served as if it were the
 * whole stream. Before this the local read had no `LIMIT` at all — on the
 * heap-capped db-host worker, carrying the multi-KB per-event `data` blob — and
 * because completeness is encoded by ABSENCE, it also silently asserted a
 * complete stream it never bounded.
 *
 * Two boundaries are driven: the real SQLite `loadSyncedSessions` read (that the
 * cap is applied PER SESSION, not as a batch total) and the
 * `getSharedAgentSessionDetail` projection (that the probe row is trimmed and
 * flagged).
 *
 * ISS-5407 (stage review) added the third thing a bound has to get right: WHICH
 * fields it is allowed to narrow. The event-derived trace shape may describe the
 * prefix — that is what `eventsTruncated` announces — but the fields a reader
 * compares against another screen may not. `toolUseCount`/`toolCallsTotal`/
 * `errorCount` render as bare whole-run stats beside a Sessions-list row that
 * folds the FULL stream, and `lastActivityAt` is the bound the ISS-5075 axis
 * extension widens a truncated timeline TO, so a prefix-derived one silently
 * no-ops the guard that exists to stop a partial run rendering as a complete one.
 * Both are put back on an unbounded basis and pinned here.
 *
 * Lives in its own file because both
 * `apps/desktop/test/shared-agent-sessions-api.test.ts` and the sync-source
 * suites it would otherwise join are grandfathered over-ceiling files.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SyncedAgentSessionEvent,
  TokenEventCostPoint,
} from "@repo/api/src/types/agent-session";
import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits";
import { test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type {
  AgentSessionSyncSource,
  SessionEventCounts,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { getSharedAgentSessionDetail } from "../src/main/session/shared-agent-session-detail-read.js";
import { projectedEventRowCount } from "./helpers/turn-item-rows.js";

const SESSION_ID = "cap-session";
const SESSION_STARTED_AT = "2026-07-10T00:00:00.000Z";
/** `eventValues(_, 5)`'s newest row — the whole-run last activity in SQLite. */
const LAST_EVENT_AT = "2026-07-10T00:00:04.000Z";
/**
 * Later than any row `syncedSession` generates (those are millisecond-spaced
 * inside the first second), so "outlives the last SERVED event" is a real
 * assertion rather than an artifact of the fixture's spacing.
 */
const WHOLE_RUN_LAST_ACTIVITY_AT = "2026-07-10T03:00:00.000Z";

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

function eventValues(sessionId: string, count: number): string {
  const rows: string[] = [];
  for (let index = 0; index < count; index++) {
    const at = new Date(Date.UTC(2026, 6, 10, 0, 0, index)).toISOString();
    rows.push(`('${sessionId}-e${index}', '${sessionId}', 'user', '${at}')`);
  }
  return rows.join(", ");
}

/**
 * A session whose event stream is `count` rows long. `data` stays absent — the
 * cap under test is on ROW COUNT, and the blob's own omit path (FEA-2038) is
 * covered elsewhere.
 */
function syncedSession(
  count: number,
  overrides?: Partial<SyncedAgentSession>
): SyncedAgentSession {
  const events: SyncedAgentSessionEvent[] = [];
  for (let index = 0; index < count; index++) {
    events.push({
      externalEventId: `e${index}`,
      agentExternalId: null,
      // Every served row is a tool use AND an error, so a fold over the prefix
      // lands on the cap itself — a number the whole-run aggregate below can be
      // made to disagree with, rather than one it might coincidentally match.
      eventType: "tool_error",
      toolName: "Bash",
      createdAt: new Date(Date.UTC(2026, 6, 10, 0, 0, 0, index)).toISOString(),
    });
  }
  return {
    externalSessionId: SESSION_ID,
    name: "Capped session",
    status: "completed",
    harness: "claude",
    cwd: "/tmp/cap",
    model: "gpt-test",
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T01:00:00.000Z",
    endedAt: "2026-07-10T02:00:00.000Z",
    awaitingInputSince: null,
    metadata: null,
    attribution: null,
    agents: [],
    events,
    tokenUsageByModel: [],
    ...overrides,
  };
}

type SeenLoad = {
  options?: { eventRowCap?: number };
  countIdRequests?: string[][];
};

/** The narrowest source the detail path needs, recording the load options. */
function fakeSource(
  session: SyncedAgentSession,
  seen: SeenLoad,
  eventCounts?: SessionEventCounts,
  tokenEvents?: TokenEventCostPoint[]
): AgentSessionSyncSource {
  return {
    ...(tokenEvents
      ? { loadSessionTokenEvents: () => Promise.resolve(tokenEvents) }
      : {}),
    listAllSessionCursorRows: () => [],
    listSessionCursorPage: () => ({ rows: [], total: 0 }),
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: (
      _ids: readonly string[],
      _cache: unknown,
      options?: { eventRowCap?: number }
    ) => {
      seen.options = options;
      return [session];
    },
    loadSessionEventCounts: (ids: string[]) => {
      seen.countIdRequests = [...(seen.countIdRequests ?? []), ids];
      return new Map(
        eventCounts ? [[session.externalSessionId, eventCounts]] : []
      );
    },
  } as unknown as AgentSessionSyncSource;
}

test("ISS-5407: the SQLite event read bounds each session at eventRowCap + 1, not the batch total", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5407-event-cap-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-07-10T00:00:00.000Z",
  });
  try {
    await db.run(
      "INSERT INTO sessions (id, status) VALUES ('cap-a','completed'), ('cap-b','completed')"
    );
    await db.run(
      `INSERT INTO events (id, session_id, event_type, created_at)
       VALUES ${eventValues("cap-a", 5)}, ${eventValues("cap-b", 5)}`
    );

    const sessions = await db.syncSource.loadSyncedSessions(
      ["cap-a", "cap-b"],
      emptyAttributionCache(),
      { eventRowCap: 2 }
    );
    const byId = new Map(
      sessions.map((session) => [session.externalSessionId, session])
    );

    // A single `LIMIT` on the multi-id `IN (...)` read would have handed all 3
    // rows to `cap-a` and starved `cap-b` of its events entirely.
    assert.equal(byId.get("cap-a")?.events.length, 3, "cap-a reads cap + 1");
    assert.equal(byId.get("cap-b")?.events.length, 3, "cap-b reads cap + 1");
    // Oldest-first, so the bounded set is a stable chronological PREFIX.
    assert.equal(byId.get("cap-a")?.events[0]?.externalEventId, "cap-a-e0");
    assert.equal(byId.get("cap-a")?.events[2]?.externalEventId, "cap-a-e2");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5407: the SQLite event read stays unbounded when no cap is passed (the sync lane)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5407-event-uncapped-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-07-10T00:00:00.000Z",
  });
  try {
    await db.run(
      "INSERT INTO sessions (id, status) VALUES ('cap-a','completed')"
    );
    await db.run(
      `INSERT INTO events (id, session_id, event_type, created_at)
       VALUES ${eventValues("cap-a", 5)}`
    );

    const [session] = await db.syncSource.loadSyncedSessions(
      ["cap-a"],
      emptyAttributionCache()
    );

    // The cloud-sync payload build must keep every row — a prefix there would
    // upsync a silently partial session.
    assert.equal(session?.events.length, 5);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5407: a non-integer cap degrades to the unbounded read, never to a short LIMIT", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5407-event-badcap-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-07-10T00:00:00.000Z",
  });
  try {
    await db.run(
      "INSERT INTO sessions (id, status) VALUES ('cap-a','completed')"
    );
    await db.run(
      `INSERT INTO events (id, session_id, event_type, created_at)
       VALUES ${eventValues("cap-a", 5)}`
    );

    // Truncation is encoded by ABSENCE, so a clamped fallback would serve a
    // short prefix that the projection then reports as a COMPLETE stream.
    const [session] = await db.syncSource.loadSyncedSessions(
      ["cap-a"],
      emptyAttributionCache(),
      { eventRowCap: Number.NaN }
    );

    assert.equal(session?.events.length, 5);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5407: the detail read asks for one row past the shared cloud ceiling", async () => {
  const seen: SeenLoad = {};
  await getSharedAgentSessionDetail(
    fakeSource(syncedSession(1), seen),
    SESSION_ID
  );
  assert.equal(seen.options?.eventRowCap, SESSION_DETAIL_EVENT_MAX_ROWS);
});

test("ISS-5407: a stream past the ceiling serves the prefix and flags eventsTruncated", async () => {
  const seen: SeenLoad = {};
  const detail = await getSharedAgentSessionDetail(
    fakeSource(syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS + 1), seen),
    SESSION_ID
  );

  assert.ok(detail);
  assert.equal(detail.events.length, SESSION_DETAIL_EVENT_MAX_ROWS);
  assert.equal(detail.eventsTruncated, true);
  // `turnItems` derive from the same prefix, so the trace the panel paints
  // never claims rows the bounded read did not serve.
  assert.equal(
    projectedEventRowCount(detail.turnItems),
    SESSION_DETAIL_EVENT_MAX_ROWS
  );
});

test("ISS-5407: a stream exactly at the ceiling is complete — eventsTruncated stays absent", async () => {
  const seen: SeenLoad = {};
  const detail = await getSharedAgentSessionDetail(
    fakeSource(syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS), seen),
    SESSION_ID
  );

  assert.ok(detail);
  assert.equal(detail.events.length, SESSION_DETAIL_EVENT_MAX_ROWS);
  // ABSENCE is the contract's only encoding of "complete" — never a serialized
  // `false`, which would become a third state every reader has to interpret.
  assert.equal(
    Object.hasOwn(detail, "eventsTruncated"),
    false,
    "eventsTruncated is omitted, not false"
  );
});

/** A session whose folded summary scalars are both present to be qualified. */
const MEASURED_SCALARS = { autonomy: 41, steeringEpisodes: 4 } as const;

test("ISS-5636: a truncated read flags a hook-only session's event-folded scalars", async () => {
  const seen: SeenLoad = {};
  const detail = await getSharedAgentSessionDetail(
    fakeSource(
      // `metadata: null` — no parsed transcript and no headless entrypoint, so
      // the human turns behind `steeringEpisodes` were matched out of the raw
      // event rows, which IS the bounded read.
      syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS + 1, MEASURED_SCALARS),
      seen
    ),
    SESSION_ID
  );

  assert.ok(detail);
  // These render as bare whole-run stats on the Properties panel, and
  // `eventsTruncated` alone cannot carry them: the cloud detail sets it too
  // while reading each scalar off a persisted column, so a shared row
  // qualifying on it would hedge a whole-run cloud number.
  assert.equal(detail.autonomyTruncated, true);
  assert.equal(detail.steeringEpisodesTruncated, true);
});

/**
 * ISS-5636 (whitlockk): the reviewer's counterfactual — a session whose steering
 * count comes from inputs the raw-event cap never bounded, while the raw-event
 * read DID hit its cap. One flag stamped off that read calls this number a
 * prefix count when it is a whole-run fact, which is the same defect pointing
 * the other way. Completeness comes from each DERIVATION, so the two flags
 * disagree here, on purpose.
 */
test("ISS-5636: a headless session's fixed steer count is not flagged by a truncated read", async () => {
  const seen: SeenLoad = {};
  const detail = await getSharedAgentSessionDetail(
    fakeSource(
      syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS + 1, {
        ...MEASURED_SCALARS,
        // A headless run's steering is returned as a fixed `0` from the
        // entrypoint, so no row cap can move it.
        steeringEpisodes: 0,
        // `sdk-` prefix — `isHeadlessEntrypoint`, the same SSOT the deriver
        // branches on.
        metadata: { entrypoint: "sdk-cli" },
      }),
      seen
    ),
    SESSION_ID
  );

  assert.ok(detail);
  assert.equal(detail.eventsTruncated, true);
  assert.equal(
    Object.hasOwn(detail, "steeringEpisodesTruncated"),
    false,
    "a construction-fixed steer count is not a prefix count"
  );
  // Autonomy still draws on the bounded rows for its agent-activity span, so it
  // remains flagged — the point is that the two are decided separately.
  assert.equal(detail.autonomyTruncated, true);
});

test("ISS-5636: a transcript-backed steer count is not flagged by a truncated read", async () => {
  const seen: SeenLoad = {};
  const detail = await getSharedAgentSessionDetail(
    fakeSource(
      syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS + 1, {
        ...MEASURED_SCALARS,
        // `sessionHasParsedTranscript`: human turns come from
        // `metadata.messages`, which the detail read never bounds.
        metadata: {
          messages: [{ role: "human", timestamp: "2026-07-10T00:00:00.000Z" }],
        },
      }),
      seen
    ),
    SESSION_ID
  );

  assert.ok(detail);
  assert.equal(detail.eventsTruncated, true);
  assert.equal(
    Object.hasOwn(detail, "steeringEpisodesTruncated"),
    false,
    "a count folded from the whole message stream is not a prefix count"
  );
});

test("ISS-5636: a scalar the producer never resolved is not qualified", async () => {
  const seen: SeenLoad = {};
  const detail = await getSharedAgentSessionDetail(
    fakeSource(
      syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS + 1, {
        autonomy: null,
        steeringEpisodes: null,
      }),
      seen
    ),
    SESSION_ID
  );

  assert.ok(detail);
  // There is no rendered number for a prefix note to describe, so hedging would
  // attach a qualifier to an empty cell.
  assert.equal(Object.hasOwn(detail, "autonomyTruncated"), false);
  assert.equal(Object.hasOwn(detail, "steeringEpisodesTruncated"), false);
});

test("ISS-5636: a complete read omits both scalar flags rather than serializing false", async () => {
  const seen: SeenLoad = {};
  const detail = await getSharedAgentSessionDetail(
    fakeSource(
      syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS, MEASURED_SCALARS),
      seen
    ),
    SESSION_ID
  );

  assert.ok(detail);
  assert.equal(
    Object.hasOwn(detail, "autonomyTruncated"),
    false,
    "autonomyTruncated is omitted, not false"
  );
  assert.equal(
    Object.hasOwn(detail, "steeringEpisodesTruncated"),
    false,
    "steeringEpisodesTruncated is omitted, not false"
  );
});

test("ISS-5407: a bounded read reads lastActivityAt from the stored column, not the prefix max", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5407-last-activity-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-07-10T00:00:00.000Z",
  });
  try {
    // The denormalized column is maintained at ingest as MAX(events.created_at)
    // over the WHOLE stream, so it is the whole-run answer even when the read
    // that follows only fetches a prefix.
    await db.run(
      `INSERT INTO sessions (id, status, started_at, last_activity_at)
       VALUES ('cap-a','running','${SESSION_STARTED_AT}','${LAST_EVENT_AT}')`
    );
    await db.run(
      `INSERT INTO events (id, session_id, event_type, created_at)
       VALUES ${eventValues("cap-a", 5)}`
    );

    const [capped] = await db.syncSource.loadSyncedSessions(
      ["cap-a"],
      emptyAttributionCache(),
      { eventRowCap: 2 }
    );
    const [uncapped] = await db.syncSource.loadSyncedSessions(
      ["cap-a"],
      emptyAttributionCache()
    );

    // The bounded read served rows e0..e2, so a running-max over THOSE would
    // answer with e2's timestamp — "when we stopped reading", not "when the run
    // stopped". Both lanes must answer with the real last event.
    assert.equal(capped?.events.length, 3, "the read really was bounded");
    assert.equal(capped?.lastActivityAt, LAST_EVENT_AT);
    assert.equal(uncapped?.lastActivityAt, LAST_EVENT_AT);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5407: a bounded read that did NOT hit its limit keeps the event derivation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5407-under-limit-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-07-10T00:00:00.000Z",
  });
  try {
    // A DIVERGENT column separates the retention anchor from event activity:
    // on desktop `sessions.last_activity_at` is the retention/default-window
    // anchor, and ISS-4833's semantics are that the detail's rendered
    // `lastActivityAt` is EVENT-derived. A session that came in under the limit
    // loaded its whole stream, so it must not switch bases.
    await db.run(
      `INSERT INTO sessions (id, status, started_at, last_activity_at)
       VALUES ('cap-a','running','${SESSION_STARTED_AT}','2026-07-11T00:00:00.000Z')`
    );
    await db.run(
      `INSERT INTO events (id, session_id, event_type, created_at)
       VALUES ${eventValues("cap-a", 5)}`
    );

    const [session] = await db.syncSource.loadSyncedSessions(
      ["cap-a"],
      emptyAttributionCache(),
      { eventRowCap: 50 }
    );

    assert.equal(session?.events.length, 5, "the read came in under its limit");
    assert.equal(session?.lastActivityAt, LAST_EVENT_AT);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5407: a truncated still-running detail keeps a lastActivityAt past its last served event", async () => {
  const seen: SeenLoad = {};
  // No `endedAt`, so `resolveSessionTimelineWindow`'s truncation extension has
  // only `lastActivityAt` to widen the axis to. If the cap were allowed to
  // narrow that field it would collapse onto the last plotted row and the
  // extension would silently no-op — a partial run rendering as a complete one,
  // the exact failure the ISS-5075 geometry guard refuses.
  const session = syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS + 1, {
    endedAt: null,
    lastActivityAt: WHOLE_RUN_LAST_ACTIVITY_AT,
  });
  const detail = await getSharedAgentSessionDetail(
    fakeSource(session, seen),
    SESSION_ID
  );

  assert.ok(detail);
  assert.equal(detail.eventsTruncated, true);
  const lastServedAt = detail.events.at(-1)?.createdAt;
  assert.ok(lastServedAt, "the prefix has a last row to compare against");
  assert.ok(
    detail.lastActivityAt.getTime() > new Date(lastServedAt).getTime(),
    "lastActivityAt outlives the last plotted event, so the axis has room to widen"
  );
});

test("ISS-5407: the SQL event-count aggregate matches the in-memory tool/error predicates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5407-event-counts-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-07-10T00:00:00.000Z",
  });
  try {
    await db.run(
      "INSERT INTO sessions (id, status) VALUES ('cap-a','completed'), ('cap-b','completed')"
    );
    // `countToolUseEvents` is `Boolean(event.toolName)`, so NULL and '' are both
    // non-tool rows; `countErrorEvents` is a case-insensitive substring match on
    // ERROR_EVENT_TERMS ("error", "fail"), so "Failure"/"tool_error" match and
    // "user" does not.
    await db.run(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at) VALUES
        ('a1','cap-a','tool_error','Bash','2026-07-10T00:00:01.000Z'),
        ('a2','cap-a','user','Read','2026-07-10T00:00:02.000Z'),
        ('a3','cap-a','Failure',NULL,'2026-07-10T00:00:03.000Z'),
        ('a4','cap-a','user','','2026-07-10T00:00:04.000Z'),
        ('a5','cap-a','assistant',NULL,'2026-07-10T00:00:05.000Z'),
        ('b1','cap-b','tool_use','Edit','2026-07-10T00:00:06.000Z')`
    );

    const counts = await db.syncSource.loadSessionEventCounts?.([
      "cap-a",
      "cap-b",
    ]);

    // Folding the same rows in memory would give tool=2 (Bash, Read) and
    // error=2 (tool_error, Failure) for cap-a.
    assert.deepEqual(counts?.get("cap-a"), { toolUseCount: 2, errorCount: 2 });
    assert.deepEqual(counts?.get("cap-b"), { toolUseCount: 1, errorCount: 0 });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5407: a truncated detail reports whole-run event counts, not the prefix fold", async () => {
  const seen: SeenLoad = {};
  const detail = await getSharedAgentSessionDetail(
    fakeSource(syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS + 1), seen, {
      toolUseCount: 12_345,
      errorCount: 67,
    }),
    SESSION_ID
  );

  assert.ok(detail);
  assert.equal(detail.eventsTruncated, true);
  // Every served row is a tool-use error, so the prefix fold would have answered
  // SESSION_DETAIL_EVENT_MAX_ROWS for all three — the same numbers this session's
  // Sessions-list row would NOT show, since that row folds the full stream.
  assert.equal(detail.toolUseCount, 12_345);
  assert.equal(detail.toolCallsTotal, 12_345);
  assert.equal(detail.errorCount, 67);
  assert.deepEqual(seen.countIdRequests, [[SESSION_ID]]);
});

test("ISS-5407: a complete detail never pays for the aggregate — counts stay on the loaded fold", async () => {
  const seen: SeenLoad = {};
  const detail = await getSharedAgentSessionDetail(
    fakeSource(syncedSession(3), seen, { toolUseCount: 999, errorCount: 999 }),
    SESSION_ID
  );

  assert.ok(detail);
  // Below the ceiling the loaded rows ARE the whole stream, so the extra query
  // would buy nothing on every normal detail open.
  assert.equal(seen.countIdRequests, undefined);
  assert.equal(detail.toolUseCount, 3);
  assert.equal(detail.toolCallsTotal, 3);
  assert.equal(detail.errorCount, 3);
});

test("ISS-5407: a source with no aggregate leaves the counts on their loaded-row basis", async () => {
  const seen: SeenLoad = {};
  const source = fakeSource(
    syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS + 1),
    seen
  ) as AgentSessionSyncSource & { loadSessionEventCounts?: unknown };
  // `loadSessionEventCounts` is optional on the contract; a source without it
  // must degrade to the pre-ISS-5407 fold rather than to a fabricated zero.
  source.loadSessionEventCounts = undefined;

  const detail = await getSharedAgentSessionDetail(source, SESSION_ID);

  assert.ok(detail);
  assert.equal(detail.eventsTruncated, true);
  assert.equal(detail.toolUseCount, SESSION_DETAIL_EVENT_MAX_ROWS);
  assert.equal(detail.errorCount, SESSION_DETAIL_EVENT_MAX_ROWS);
});

/**
 * ISS-9857: the cost points the producer attributed to the prefix's turn rows,
 * as `loadSessionTokenEvents` serves them.
 */
const TOKEN_EVENT_COST_POINTS: TokenEventCostPoint[] = [
  { tMs: Date.UTC(2026, 6, 10, 0, 0, 0, 100), costUsd: 0.01 },
  {
    tMs: Date.UTC(2026, 6, 10, 0, 0, 0, 200),
    costUsd: 0.02,
    agentExternalId: "agent-1",
  },
];

test("ISS-9857: a truncated detail carries the producer's token cost points for a client re-projection", async () => {
  const seen: SeenLoad = {};
  const detail = await getSharedAgentSessionDetail(
    fakeSource(
      syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS + 1),
      seen,
      undefined,
      TOKEN_EVENT_COST_POINTS
    ),
    SESSION_ID
  );

  assert.ok(detail);
  assert.equal(detail.eventsTruncated, true);
  // A client that pages past the prefix re-projects prefix + pages through the
  // same projector `turnItems` came from; without these points that render
  // would strip the cost badges the prefix rows already carried.
  assert.deepEqual(detail.tokenEventCostPoints, TOKEN_EVENT_COST_POINTS);
});

test("ISS-9857: a complete detail omits tokenEventCostPoints — no client re-projects it", async () => {
  const seen: SeenLoad = {};
  const detail = await getSharedAgentSessionDetail(
    fakeSource(
      syncedSession(SESSION_DETAIL_EVENT_MAX_ROWS),
      seen,
      undefined,
      TOKEN_EVENT_COST_POINTS
    ),
    SESSION_ID
  );

  assert.ok(detail);
  assert.equal(Object.hasOwn(detail, "eventsTruncated"), false);
  assert.equal(
    Object.hasOwn(detail, "tokenEventCostPoints"),
    false,
    "the key is absent, not an empty or serialized-undefined value"
  );
});

/**
 * @file session-dead-letter-sync-state.test.ts
 * @description ISS-11427: a dead-lettered session's row reports `dead_letter`
 * or `abandoned` instead of reading `synced`.
 *
 * Operator ruling (Marisol Ashgrove, 2026-10-05): dead letter means the lane will
 * retry it; abandoned means no path can ever reach it, which today is only a
 * lane with historical backfill disabled. Every case drives two sessions in
 * one fixture, one per state, through the real lifecycle doors and the real
 * Sessions reads, so a label that disagrees with what the lane actually does
 * fails here.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import ts from "typescript6";
import { test } from "vitest";
import { classifyDeadLetteredSession } from "../src/main/agent-sync/agent-session-dead-letter-sync-state.js";
import {
  markDeadLettered,
  promoteDeadLetterIfIdle,
  recoverExpiredDeadLetters,
} from "../src/main/agent-sync/agent-session-sync-dead-letter-lifecycle.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import { readAgentDashboardSessionList } from "../src/main/dashboard/agent-dashboard-session-list-projection.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { applyLocalSessionTranscriptProjection } from "../src/main/session/local-session-list-projection.js";
import { buildLocalCloudSyncDisclosure } from "../src/main/session/local-transcript-cloud-sync.js";
import { getSharedAgentSessionDetail } from "../src/main/session/shared-agent-session-detail-read.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  DETERMINISTIC_REASON,
  drainBackfillLane,
  type Harness,
  makeHarness,
  pinLifecycleClock,
  TRANSIENT_REASON,
} from "./agent-session-sync-dead-letter-fixtures.js";
import {
  makeIdleSession,
  makeService,
} from "./agent-session-sync-service-fixtures.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

pinLifecycleClock();

const RETRIED = "session-retried";
const GIVEN_UP = "session-given-up";
const SYNCED = "session-synced";
const TARGET = "target-dead-letter";

/** One transient (finite retry-after) and one deterministic (infinite) dead letter. */
function deadLetterBoth(harness: Harness): void {
  markDeadLettered(RETRIED, true, TRANSIENT_REASON, 3, null, harness.deps);
  markDeadLettered(
    GIVEN_UP,
    false,
    DETERMINISTIC_REASON,
    0,
    null,
    harness.deps
  );
}

function statesOf(harness: Harness) {
  return [RETRIED, GIVEN_UP].map((id) =>
    classifyDeadLetteredSession(id, harness.deps)
  );
}

/**
 * Run every door a dead letter can leave by, far past any retry window: the
 * expiry door, then — once the lane has drained what that re-queued, which is
 * the idle revisit's own precondition — the idle revisit.
 */
function runEveryRetryDoor(harness: Harness): void {
  recoverExpiredDeadLetters(Number.MAX_SAFE_INTEGER, harness.deps);
  drainBackfillLane(harness.deps);
  promoteDeadLetterIfIdle(harness.deps);
}

test("with historical backfill disabled, the infinite dead letter is abandoned and no door ever retries it", async () => {
  const harness = makeHarness();
  harness.scalars.backfillEnabled = false;
  deadLetterBoth(harness);

  assert.deepEqual(statesOf(harness), [
    AgentSessionCloudSyncState.DeadLetter,
    AgentSessionCloudSyncState.Abandoned,
  ]);

  runEveryRetryDoor(harness);
  await Promise.resolve();

  assert.deepEqual(harness.outboxReEnqueues, [RETRIED]);
  assert.equal(
    classifyDeadLetteredSession(GIVEN_UP, harness.deps),
    AgentSessionCloudSyncState.Abandoned
  );
  assert.equal(classifyDeadLetteredSession(RETRIED, harness.deps), undefined);
});

test("with historical backfill enabled, both are dead letters because the idle revisit retries the infinite one", () => {
  const harness = makeHarness();
  deadLetterBoth(harness);

  assert.deepEqual(statesOf(harness), [
    AgentSessionCloudSyncState.DeadLetter,
    AgentSessionCloudSyncState.DeadLetter,
  ]);

  runEveryRetryDoor(harness);

  assert.deepEqual(
    [...harness.outboxReEnqueues].sort(),
    [GIVEN_UP, RETRIED].sort()
  );
});

test("the service reads the state off its own set-aside map and backfill setting", () => {
  const service = makeService({} as AgentSessionSyncSource, () =>
    Promise.reject(new Error("no send in this test"))
  );
  const lane = service as unknown as {
    deadLetteredIds: Map<string, number>;
    historicalBackfillEnabled: boolean;
  };
  lane.deadLetteredIds.set(RETRIED, Date.now() + 60_000);
  lane.deadLetteredIds.set(GIVEN_UP, Number.POSITIVE_INFINITY);
  lane.historicalBackfillEnabled = false;

  assert.equal(
    service.readDeadLetterState(RETRIED),
    AgentSessionCloudSyncState.DeadLetter
  );
  assert.equal(
    service.readDeadLetterState(GIVEN_UP),
    AgentSessionCloudSyncState.Abandoned
  );
  assert.equal(service.readDeadLetterState(SYNCED), undefined);
});

const LANE_STATES = new Map([
  [RETRIED, AgentSessionCloudSyncState.DeadLetter],
  [GIVEN_UP, AgentSessionCloudSyncState.Abandoned],
] as const);

const readLaneState = (id: string) =>
  LANE_STATES.get(id as typeof RETRIED | typeof GIVEN_UP);

function fakeSource(): AgentSessionSyncSource {
  const ids = [RETRIED, GIVEN_UP, SYNCED];
  const rows = ids.map((id) => ({
    id,
    updated_at: "2026-01-01T00:00:00.000Z",
  }));
  return {
    listAllSessionCursorRows: () => rows,
    listSessionCursorPage: (request: { offset: number; limit: number }) => ({
      rows: rows.slice(request.offset, request.offset + request.limit),
      total: rows.length,
    }),
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: (loadIds: readonly string[]) =>
      loadIds.map((id) => makeIdleSession(id, "2026-01-01T00:00:00.000Z")),
    loadPendingOutboxIds: () => [],
  } as unknown as AgentSessionSyncSource;
}

function stateById(items: Array<{ id: string; cloudSyncState?: string }>) {
  return Object.fromEntries(
    items.map((item) => [item.id, item.cloudSyncState])
  );
}

test("the Sessions list reports each dead-lettered row's state, and an ordinary row still reads synced", async () => {
  const response = await getSharedAgentSessions(
    fakeSource(),
    { quality: "all" },
    { computeTargetId: TARGET, readSessionDeadLetterState: readLaneState }
  );

  assert.deepEqual(stateById(response.items), {
    [RETRIED]: AgentSessionCloudSyncState.DeadLetter,
    [GIVEN_UP]: AgentSessionCloudSyncState.Abandoned,
    [SYNCED]: AgentSessionCloudSyncState.Synced,
  });
});

test("the main-process half of the DB-host list projection folds the lane's verdict in", async () => {
  const fromDbHost = await getSharedAgentSessions(
    fakeSource(),
    { quality: "all" },
    { computeTargetId: TARGET }
  );
  assert.equal(
    stateById(fromDbHost.items)[RETRIED],
    AgentSessionCloudSyncState.Synced,
    "the DB host cannot see the lane, which is why main folds it in"
  );

  const projected = await applyLocalSessionTranscriptProjection(
    { ...fromDbHost, pendingOutboxAvailable: true },
    TARGET,
    () => Promise.resolve([]),
    readLaneState
  );

  assert.deepEqual(stateById(projected.items), {
    [RETRIED]: AgentSessionCloudSyncState.DeadLetter,
    [GIVEN_UP]: AgentSessionCloudSyncState.Abandoned,
    [SYNCED]: AgentSessionCloudSyncState.Synced,
  });
});

test("the session detail reports the same state its list row does", async () => {
  const states = await Promise.all(
    [RETRIED, GIVEN_UP].map(async (id) => {
      const detail = await getSharedAgentSessionDetail(fakeSource(), id, {
        computeTargetId: TARGET,
        readSessionDeadLetterState: readLaneState,
      });
      return detail?.cloudSyncState;
    })
  );

  assert.deepEqual(states, [
    AgentSessionCloudSyncState.DeadLetter,
    AgentSessionCloudSyncState.Abandoned,
  ]);
});

test("the dashboard list read threads the lane's reader from the runtime options to the projected rows", async () => {
  const fromDbHost = await getSharedAgentSessions(
    fakeSource(),
    { quality: "all" },
    { computeTargetId: TARGET }
  );
  const agentDatabase = {
    syncSource: {
      ...fakeSource(),
      projectSessionList: () =>
        Promise.resolve({ ...fromDbHost, pendingOutboxAvailable: true }),
    },
    transcriptSync: null,
  } as unknown as DbHostAgentDatabase;

  const response = await readAgentDashboardSessionList(
    agentDatabase,
    {
      getSyncComputeTargetId: () => TARGET,
      readSessionDeadLetterState: readLaneState,
    } as unknown as AgentDashboardDesignSystemRuntimeOptions,
    { quality: "all" }
  );

  assert.deepEqual(stateById(response.items), {
    [RETRIED]: AgentSessionCloudSyncState.DeadLetter,
    [GIVEN_UP]: AgentSessionCloudSyncState.Abandoned,
    [SYNCED]: AgentSessionCloudSyncState.Synced,
  });
});

test("the runtime bootstrap points the reader at the session lane", () => {
  const source = parseTypeScriptFile(
    join(
      import.meta.dirname,
      "../src/main/dashboard/agent-dashboard-runtime-bootstrap.ts"
    )
  );
  let wired = false;
  forEachNode(source, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "readSessionDeadLetterState"
    ) {
      forEachNode(node.initializer, (inner) => {
        if (
          ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(inner.expression) &&
          inner.expression.name.text === "readDeadLetterState"
        ) {
          wired = true;
        }
      });
    }
  });
  assert.ok(
    wired,
    "buildRuntimeOptions must map readSessionDeadLetterState to agentSessionSync.readDeadLetterState() — unwired, every dead-lettered row reads synced again"
  );
});

test("a dead-lettered row keeps its independent transcript verdict", () => {
  assert.deepEqual(
    buildLocalCloudSyncDisclosure(
      {
        known: true,
        pending: false,
        deadLetter: AgentSessionCloudSyncState.Abandoned,
      },
      {
        available: true,
        verdict: {
          disposition: TranscriptDisposition.FailedPermanent,
          reason: null,
        },
      }
    ),
    {
      cloudSyncState: AgentSessionCloudSyncState.Abandoned,
      transcriptDisposition: TranscriptDisposition.FailedPermanent,
    }
  );
});

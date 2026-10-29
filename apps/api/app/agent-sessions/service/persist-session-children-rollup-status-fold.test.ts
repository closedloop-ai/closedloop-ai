/**
 * ISS-9434 §2.4: `agent_session_usage_rollups.status` was the one cloud status
 * column with an open path for a retired spelling — a bare nullable string on the
 * wire, written verbatim, copied from the desktop `sessions.status` column.
 *
 * It now takes the same fold the session lifecycle column takes, and the fold
 * must FAIL OPEN rather than reject: the wire `sessions` array is unbounded
 * (ISS-8051) and the route safeParses the whole batch the byte budget admitted,
 * so a bound that threw here would 400 every session in the request over one
 * version-skewed row's rollup copy.
 */
import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSyncedSession } from "@/__tests__/support/agent-sessions/service.test-harness";
import { persistSessionChildren } from "./persist-session-children";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const ARTIFACT_ID = "a-1";
const ORGANIZATION_ID = "org-1";

/** The retired spellings a version-skewed desktop store can still hold. */
const RETIRED_STATUS_WAITING = "waiting";
const RETIRED_STATUS_COMPLETED = "completed";
const RETIRED_STATUS_ABANDONED = "abandoned";
/** A status no build in this repo models — a NEWER desktop, not an older one. */
const UNMODELLED_STATUS = "brand-new-status";

const SOUND_ANALYTICS = {
  agentTurns: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  errorEvents: 0,
  estimatedCostUsd: 1.5,
  eventCount: 3,
  harness: "claude",
  humanTurns: 1,
  inputTokens: 10,
  isHuman: true,
  outputTokens: 5,
  startedAt: "2026-08-01T00:00:00.000Z",
  startedDay: "2026-08-01",
  status: SESSION_STATUS.INACTIVE,
  toolInvocations: 4,
};

function txWithSpies() {
  const rollupUpsert = vi.fn().mockResolvedValue({ artifactId: ARTIFACT_ID });
  const tx = {
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([
        { toolUseCount: 0n, errorCount: 0n, maxEventCreatedAt: null },
      ]),
    agentSessionActivitySegment: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
    },
    agentSessionEvent: { deleteMany: vi.fn() },
    agentSessionTokenEvent: { createMany: vi.fn() },
    agentSessionTokenUsage: { createMany: vi.fn(), deleteMany: vi.fn() },
    agentSessionUsageRollup: { upsert: rollupUpsert },
    artifact: { findFirst: vi.fn() },
    sessionDetail: { update: vi.fn().mockResolvedValue({}) },
  };
  return { rollupUpsert, tx };
}

/**
 * Persist one session carrying `analyticsOverrides`, and hand back the upsert.
 *
 * `guardedStatus` is the lifecycle value the same slice writes to
 * `artifacts.status`. It defaults to `ACTIVE` — non-terminal, so terminal-wins
 * does not fire and the fold cases below read exactly as they did before the
 * guard was threaded through.
 */
async function persistRollupStatus(
  analyticsOverrides: Record<string, unknown>,
  guardedStatus: SessionStatus = SESSION_STATUS.ACTIVE
): Promise<{ create: { status: unknown }; update: { status: unknown } }> {
  const { rollupUpsert, tx } = txWithSpies();
  const session = buildSyncedSession({ events: [] }) as Record<string, unknown>;
  session.sessionAnalytics = { ...SOUND_ANALYTICS, ...analyticsOverrides };
  await persistSessionChildren(
    tx as unknown as Parameters<typeof persistSessionChildren>[0],
    ARTIFACT_ID,
    ORGANIZATION_ID,
    session as never,
    [],
    { guardedStatus, shouldReplace: false, shouldUpdateTokenEventCosts: true }
  );
  const [call] = rollupUpsert.mock.calls;
  if (!call) {
    // Not an assertion — a guard, so a slice that stopped writing the rollup at
    // all reports that instead of every case below reading `undefined.status`.
    throw new Error("the usage-rollup upsert never ran");
  }
  return call[0];
}

describe("agent_session_usage_rollups.status fold (ISS-9434)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    RETIRED_STATUS_WAITING,
    RETIRED_STATUS_COMPLETED,
    RETIRED_STATUS_ABANDONED,
    UNMODELLED_STATUS,
  ])(
    "folds the unrecognized spelling %s to the lifecycle set instead of storing it",
    async (rawStatus) => {
      const upsert = await persistRollupStatus({ status: rawStatus });

      // BOTH arms: the row is written wholesale, so a fold applied to only one
      // of them would leave a first sync clean and every resync poisoned.
      expect(upsert.create.status).toBe(SESSION_STATUS.ACTIVE);
      expect(upsert.update.status).toBe(SESSION_STATUS.ACTIVE);
    }
  );

  it("keeps the stored terminal status when a straggler batch claims the run is active", async () => {
    // The divergence the fold alone did not close. The lifecycle write resolves
    // through `resolveGuardedStatus`, so a session already settled as `inactive`
    // stays settled when a late batch arrives still claiming `active`. Without
    // the same guard here the rollup said `active` for a session the session
    // list correctly showed as finished — two records of one fact, disagreeing.
    const upsert = await persistRollupStatus(
      { status: SESSION_STATUS.ACTIVE },
      SESSION_STATUS.INACTIVE
    );

    expect(upsert.create.status).toBe(SESSION_STATUS.INACTIVE);
    expect(upsert.update.status).toBe(SESSION_STATUS.INACTIVE);
  });

  it("lets a terminal incoming status through against a terminal guard", async () => {
    // Terminal-wins is not "the guard always wins": an `error` arriving for a
    // session already stored `inactive` is a real transition between two
    // terminal states, and must not be pinned to the stored one.
    const upsert = await persistRollupStatus(
      { status: SESSION_STATUS.ERROR },
      SESSION_STATUS.INACTIVE
    );

    expect(upsert.create.status).toBe(SESSION_STATUS.ERROR);
  });

  it("does not invent a status for a session with none, whatever the guard says", async () => {
    const upsert = await persistRollupStatus(
      { status: null },
      SESSION_STATUS.INACTIVE
    );

    expect(upsert.create.status).toBeNull();
  });

  it("still writes the rollup row — an unrecognized status never rejects the payload", async () => {
    const upsert = await persistRollupStatus({ status: UNMODELLED_STATUS });

    // The whole point of folding rather than validating: the row lands, with
    // every other counter intact, instead of the batch 400ing.
    expect(upsert.create).toMatchObject({
      artifactId: ARTIFACT_ID,
      eventCount: SOUND_ANALYTICS.eventCount,
      status: SESSION_STATUS.ACTIVE,
    });
  });

  it.each(Object.values(SESSION_STATUS))(
    "stores the lifecycle value %s unchanged",
    async (lifecycle) => {
      const upsert = await persistRollupStatus({ status: lifecycle });

      expect(upsert.create.status).toBe(lifecycle);
    }
  );

  it("writes NULL when the payload carries no rollup status, never a fabricated active", async () => {
    const upsert = await persistRollupStatus({ status: null });

    expect(upsert.create.status).toBeNull();
    expect(upsert.update.status).toBeNull();
  });
});

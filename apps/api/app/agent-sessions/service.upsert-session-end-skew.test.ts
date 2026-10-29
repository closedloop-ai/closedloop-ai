/**
 * ISS-8681: the ingest must not persist a `sessionEndedAt` that leads server
 * receive time by more than a day.
 *
 * Every direct reader of `sessionEndedAt` (Duration span, the `endedAt` wire
 * field, completion filters) is deliberately clock-free, so such a value reads
 * as decisive proof the run ended long ago. Nothing downstream can reject the
 * value itself — `MAX_TRUSTED_FUTURE_SKEW_MS` lives in `apps/api`, not the
 * shared package — so the refusal is on the write path and is asserted here
 * through the REAL service, on the exact `sessionDetail.upsert` payload it
 * emits.
 *
 * Every session below carries a TERMINAL status, so the ISS-8552 gate (which
 * drops an end a non-terminal status denies) can never be what nulls the column.
 * The only thing that can is the guard under test.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  persistedSessionDetail,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";
import { SessionSyncMetric } from "./service/session-sync-metrics";

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

import { agentSessionsService } from "./service";

const PERSISTED_ARTIFACT_ID = "persisted-session-1";

const CONTEXT = {
  organizationId: "org-1",
  userId: "user-1",
  computeTargetId: "target-1",
};

/**
 * The batch reads `new Date()` for its receive instant, so the clock is pinned
 * rather than the offsets computed from it.
 */
const RECEIVED_AT = new Date("2026-05-20T18:00:00.000Z");

/**
 * The skew boundary written out rather than imported: this suite's job includes
 * guarding the value `MAX_TRUSTED_FUTURE_SKEW_MS` holds, and an expectation
 * derived from that constant would follow it anywhere it moved.
 */
const ONE_DAY_AHEAD = new Date("2026-05-21T18:00:00.000Z");
const ONE_MS_PAST_ONE_DAY_AHEAD = new Date("2026-05-21T18:00:00.001Z");
const TWO_DAYS_AHEAD = new Date("2026-05-22T18:00:00.000Z");
const ONE_HOUR_AHEAD = new Date("2026-05-20T19:00:00.000Z");

/** A legitimate end already on the row, comfortably in the past. */
const STORED_END = new Date("2026-05-20T17:30:00.000Z");

function buildExistingRow(sessionEndedAt: Date | null) {
  return {
    artifactId: PERSISTED_ARTIFACT_ID,
    agents: [],
    dataRevision: null,
    sessionStartedAt: SESSION_STARTED_AT,
    sessionUpdatedAt: SESSION_UPDATED_AT,
    sessionEndedAt,
    artifact: { status: SESSION_STATUS.INACTIVE },
  };
}

/**
 * Drive one apply and report the `sessionEndedAt` each upsert arm would write.
 *
 * The `upsert` mock ECHOES the arm the database would take — the create arm's
 * value when there was no prior row, the update arm's otherwise — because
 * `didDropContradictorySessionEnd` reads the COMMITTED end back off the upsert.
 * A mock returning a fixed value would decide the telemetry assertion by itself.
 */
async function upsertAndReadEnds(
  existingRow: ReturnType<typeof buildExistingRow> | null,
  endedAt: Date | null
): Promise<{ create: Date | null; update: Date | null }> {
  const upsert = vi.fn().mockImplementation((args) =>
    persistedSessionDetail(PERSISTED_ARTIFACT_ID, {
      sessionEndedAt: existingRow
        ? (args.update.sessionEndedAt ?? null)
        : (args.create.sessionEndedAt ?? null),
    })
  );

  installDb({
    slugCounter: buildSlugCounterMock(),
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue(existingRow),
      upsert,
      update: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: buildDefaultAgentSessionEventMocks(),
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  });

  await agentSessionsService.upsertSessions(CONTEXT, {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba011",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      buildSyncedSession({
        status: SESSION_STATUS.INACTIVE,
        endedAt: endedAt?.toISOString(),
      }),
    ],
  });

  // A THROW rather than an `expect`: reaching here without exactly one upsert
  // means the harness never drove the path under test, which is a setup failure
  // rather than a failed expectation.
  if (upsert.mock.calls.length !== 1) {
    throw new Error(
      `expected exactly one sessionDetail.upsert, saw ${upsert.mock.calls.length}`
    );
  }
  const upsertArg = upsert.mock.calls[0][0];
  return {
    create: upsertArg.create.sessionEndedAt ?? null,
    update: upsertArg.update.sessionEndedAt ?? null,
  };
}

function contradictorySessionEndEmissions() {
  return mocks.emitTelemetryMetric.mock.calls
    .map(([emission]) => emission)
    .filter(
      (emission) =>
        emission?.metric === SessionSyncMetric.ContradictorySessionEndDropped
    );
}

describe("upsertSessions — implausibly-future sessionEndedAt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(RECEIVED_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses an end two days ahead of receive time on the create arm", async () => {
    const ends = await upsertAndReadEnds(null, TWO_DAYS_AHEAD);

    expect(ends.create).toBeNull();
  });

  it("still persists an end one hour ahead, which is ordinary clock drift", async () => {
    const ends = await upsertAndReadEnds(null, ONE_HOUR_AHEAD);

    expect(ends.create).toEqual(ONE_HOUR_AHEAD);
  });

  // The boundary is inclusive, and both sides of it are pinned so a widened or
  // narrowed window fails here rather than silently changing what is stored.
  it("persists an end exactly one day ahead and refuses one a millisecond past it", async () => {
    const atBoundary = await upsertAndReadEnds(null, ONE_DAY_AHEAD);
    const pastBoundary = await upsertAndReadEnds(
      null,
      ONE_MS_PAST_ONE_DAY_AHEAD
    );

    expect(atBoundary.create).toEqual(ONE_DAY_AHEAD);
    expect(pastBoundary.create).toBeNull();
  });

  // The guard runs on the INCOMING value, ahead of max-wins. Gating the max-wins
  // RESULT instead would read the same on the create arm but delete the stored
  // end here, because a future instant always wins that comparison.
  it("keeps a legitimate stored end when the payload carries an implausible one", async () => {
    const ends = await upsertAndReadEnds(
      buildExistingRow(STORED_END),
      TWO_DAYS_AHEAD
    );

    expect(ends.update).toEqual(STORED_END);
  });

  it("writes no end on the update arm when the row had none and the payload is implausible", async () => {
    const ends = await upsertAndReadEnds(
      buildExistingRow(null),
      TWO_DAYS_AHEAD
    );

    expect(ends.update).toBeNull();
  });
});

/*
 * AGENTS.md, "Handling Bad or Nonsensical Data": a refused value is never
 * silently coerced. The refusal joins the ingest's existing per-slice
 * session-end counter rather than a new event name.
 */
describe("upsertSessions — implausibly-future sessionEndedAt telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(RECEIVED_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the refusal on the existing contradictory-session-end metric", async () => {
    const ends = await upsertAndReadEnds(null, TWO_DAYS_AHEAD);

    // Proves the emission below is about a value the apply actually dropped,
    // not about a payload that carried no end at all.
    expect(ends.create).toBeNull();
    expect(contradictorySessionEndEmissions()).toEqual([
      expect.objectContaining({
        metric: SessionSyncMetric.ContradictorySessionEndDropped,
        organizationId: CONTEXT.organizationId,
        computeTargetId: CONTEXT.computeTargetId,
        count: 1,
      }),
    ]);
  });

  // The case the commit read-back cannot see: max-wins preserves the stored end,
  // so the column commits NON-null and a read-back-only diagnostic would report
  // no refusal at all — silently under-counting the repeat clock-skewed producer
  // this counter exists to name.
  it("counts the refusal even when a stored end survived it", async () => {
    const ends = await upsertAndReadEnds(
      buildExistingRow(STORED_END),
      TWO_DAYS_AHEAD
    );

    // The committed end is non-null here, which is exactly why the emission
    // below cannot be coming from the committed read-back.
    expect(ends.update).toEqual(STORED_END);
    expect(contradictorySessionEndEmissions()).toEqual([
      expect.objectContaining({
        metric: SessionSyncMetric.ContradictorySessionEndDropped,
        count: 1,
      }),
    ]);
  });

  // The counter measures a draining population, so an end the ingest stored must
  // not raise it — otherwise it reports sync traffic and no rate is readable.
  it("stays silent when the end was plausible and was stored", async () => {
    const ends = await upsertAndReadEnds(null, ONE_HOUR_AHEAD);

    expect(ends.create).toEqual(ONE_HOUR_AHEAD);
    expect(contradictorySessionEndEmissions()).toEqual([]);
  });
});

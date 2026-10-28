/**
 * ISS-6463: the ingest seeds `session_detail.last_activity_at` on the CREATE arm
 * and deliberately leaves it alone on the UPDATE arm.
 *
 * Both halves are load-bearing and neither was covered before this file.
 *
 * The create arm exists because the column is NOT NULL: omit the key and every
 * new-session INSERT is a constraint violation. But the DB constraint is a poor
 * test — it only proves *a* value was written, not the right one. Writing
 * `new Date()` instead of the session start would satisfy Postgres while
 * inflating the row's freshness, pulling it out of the Stale facet and shifting
 * the default Sessions sort. So the value is asserted, not just its presence.
 *
 * The update arm's OMISSION is the monotonicity guarantee.
 * `persistSessionChildren`'s `GREATEST("last_activity_at", $startedAt, $maxEvent)`
 * is the sole advancer; if the anchor were also written from the incoming
 * payload here, a re-sync carrying an older start would walk a live session's
 * anchor BACKWARD. `agent-session-reopen.test.ts` covers that regression against
 * a real database; this asserts the structural reason it cannot arise.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  persistedSessionDetail,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";

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

/** An EARLIER start than the persisted row's, so a regression would be visible. */
const OLDER_STARTED_AT = new Date("2026-05-19T09:00:00.000Z");

describe("upsertSessions — ISS-6463 activity anchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("seeds the create arm's lastActivityAt at the session start", async () => {
    const upsertArg = await captureUpsertArg(null, SESSION_STARTED_AT);

    // The same instant `persistSessionChildren`'s GREATEST floor uses for its
    // `$startedAt` operand — so the seed can never exceed what the floor would
    // independently produce for an event-less session.
    expect(upsertArg.create.lastActivityAt).toEqual(SESSION_STARTED_AT);
  });

  it("never writes lastActivityAt on the update arm", async () => {
    const upsertArg = await captureUpsertArg(
      buildExistingRow(),
      OLDER_STARTED_AT
    );

    // Absent, not merely equal to something benign: presence here is what would
    // hand a re-sync the ability to lower a live anchor.
    expect(upsertArg.update).not.toHaveProperty("lastActivityAt");
  });

  it("keeps the update arm clean even when the incoming start is older than the persisted row", async () => {
    const upsertArg = await captureUpsertArg(
      buildExistingRow(),
      OLDER_STARTED_AT
    );

    // The regression this guards: were the anchor written from the payload, this
    // payload would move it backward from SESSION_STARTED_AT to OLDER_STARTED_AT.
    expect(Object.keys(upsertArg.update)).not.toContain("lastActivityAt");
    expect(upsertArg.create.lastActivityAt).toEqual(OLDER_STARTED_AT);
  });
});

/** The persisted row `sessionDetail.findUnique` returns for the update arm. */
function buildExistingRow() {
  return {
    artifactId: PERSISTED_ARTIFACT_ID,
    agents: [],
    dataRevision: null,
    sessionStartedAt: SESSION_STARTED_AT,
    sessionUpdatedAt: SESSION_UPDATED_AT,
    sessionEndedAt: null,
    awaitingInputSince: null,
    artifact: { status: null },
  };
}

function buildPayload(...sessions: SyncedAgentSession[]) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba011",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

/**
 * Drive one real apply and hand back the arguments the single
 * `sessionDetail.upsert` received. Throws rather than asserts on a miscount: a
 * harness that never reached the upsert is a setup failure, not a failed
 * expectation, and an `expect` buried in a helper would report it as the latter.
 */
async function captureUpsertArg(
  existingRow: ReturnType<typeof buildExistingRow> | null,
  startedAt: Date
): Promise<{
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}> {
  const upsert = vi
    .fn()
    .mockResolvedValue(persistedSessionDetail(PERSISTED_ARTIFACT_ID));

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

  await agentSessionsService.upsertSessions(
    CONTEXT,
    buildPayload(buildSyncedSession({ startedAt: startedAt.toISOString() }))
  );

  if (upsert.mock.calls.length !== 1) {
    throw new Error(
      `expected exactly one sessionDetail.upsert, saw ${upsert.mock.calls.length}`
    );
  }
  return upsert.mock.calls[0][0];
}

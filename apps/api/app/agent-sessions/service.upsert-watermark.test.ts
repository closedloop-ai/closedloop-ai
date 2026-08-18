/**
 * ISS-4678: the ingestion watermark (`ComputeTarget.lastAgentSessionSyncAt`)
 * must advance ONLY when a batch actually lands session rows. The pure
 * `stampIngestSyncWatermark` decision is covered by ingest-sync-stamp.test.ts;
 * these tests drive the REAL `upsertSessions` path so the `persistedSessionCount`
 * WIRING between the loop and the stamp cannot silently break while the helper
 * suite stays green (wongk review, PR #4187).
 *
 * Asserts the observable `computeTarget.updateMany` write: fired for a batch that
 * persists a row, and NOT fired for an accepted empty batch (zero rows landed).
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
  generateSlug: vi.fn().mockResolvedValue("SES-0001"),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    SESSION: "SESSION",
  },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  Prisma: { DbNull: mocks.dbNull },
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: mocks.generateSlug,
}));

import { agentSessionsService } from "./service";

const SESSION_STARTED_AT = new Date("2026-07-24T09:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-07-24T09:30:00.000Z");
const PERSISTED_ARTIFACT_ID = "artifact-watermark-test-1";
const COMPUTE_TARGET_ID = "target-watermark-1";
const ORG_ID = "org-watermark-1";
const USER_ID = "user-watermark-1";

function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "ext-sess-watermark-1",
    name: "Watermark Test Session",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/project",
    model: "claude-sonnet-4",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function buildPayload(sessions: SyncedAgentSession[]) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-watermark-1",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

function buildContext() {
  return {
    organizationId: ORG_ID,
    userId: USER_ID,
    computeTargetId: COMPUTE_TARGET_ID,
  };
}

/**
 * Minimal transaction-level DB mock driving upsertSessions to the
 * sessionDetail.upsert call (create arm; no existing row, no refs, no events).
 * Exposes computeTarget.updateMany — the write stampIngestSyncWatermark performs.
 */
function installDb(
  options: { committedRevisionByExternalId?: Record<string, number> } = {}
) {
  const computeTargetUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const committedRevisions = options.committedRevisionByExternalId ?? {};

  const db = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([{ toolUseCount: 0n, errorCount: 0n }]),
    organization: {
      findUnique: vi.fn().mockResolvedValue({ settings: null }),
    },
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: COMPUTE_TARGET_ID }),
      updateMany: computeTargetUpdateMany,
    },
    sessionDetail: {
      // Goal stage 2: a session listed in `committedRevisionByExternalId`
      // already exists on the server at that `dataRevision`, which is how a
      // deterministic FEA-3595 stale-revision (foreign) chunk is staged.
      findUnique: vi.fn(
        (args: {
          where: {
            computeTargetId_externalSessionId: { externalSessionId: string };
          };
        }) => {
          const externalSessionId =
            args.where.computeTargetId_externalSessionId.externalSessionId;
          const dataRevision = committedRevisions[externalSessionId];
          if (dataRevision === undefined) {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            artifactId: PERSISTED_ARTIFACT_ID,
            agents: [],
            dataRevision,
            pendingChunkRevision: null,
            pendingChunkTotal: null,
            pendingChunkReceived: null,
            sessionStartedAt: SESSION_STARTED_AT,
            sessionUpdatedAt: SESSION_UPDATED_AT,
            sessionEndedAt: null,
            artifact: { status: null },
          });
        }
      ),
      upsert: vi.fn().mockResolvedValue({ artifactId: PERSISTED_ARTIFACT_ID }),
      update: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _max: { eventCreatedAt: null } }),
    },
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    artifactLink: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    sessionTranscript: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };

  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );

  return { computeTargetUpdateMany };
}

describe("upsertSessions — ISS-4678/ISS-4827 watermark wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("advances the watermark when a batch persists at least one session row", async () => {
    const { computeTargetUpdateMany } = installDb();

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession()])
    );

    expect(computeTargetUpdateMany).toHaveBeenCalledTimes(2);
    const attemptUpdateArg = computeTargetUpdateMany.mock.calls[0][0];
    const landedUpdateArg = computeTargetUpdateMany.mock.calls[1][0];
    expect(attemptUpdateArg.where.id).toBe(COMPUTE_TARGET_ID);
    expect(landedUpdateArg.where.id).toBe(COMPUTE_TARGET_ID);
    expect(attemptUpdateArg.data.lastAgentSessionSyncAttemptAt).toBeInstanceOf(
      Date
    );
    expect(landedUpdateArg.data.lastAgentSessionSyncAt).toBeInstanceOf(Date);
  });

  // Goal stage 2 (atomic row-level ack): the desktop clears its durable outbox
  // rows keyed on the `acceptedSessionIds` the server echoes, and that echo is
  // built from THIS return value. `upsertSessionSlice` returns false for a
  // foreign chunk WITHOUT throwing, so an `accepted: true` batch can legally
  // contain a session the server never stored — if that id were reported as
  // persisted, the desktop would delete the only durable record of it. A test
  // against a mocked `upsertBatch` cannot catch a regression here, because the
  // value under test is computed by the REAL loop below.
  it("goal stage 2: persistedSessionIds reports ONLY the sessions the loop actually wrote", async () => {
    installDb({ committedRevisionByExternalId: { "ext-sess-stale": 41 } });

    const result = await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({ externalSessionId: "ext-sess-written" }),
        // FEA-3595 stale revision: the server already holds revision 41 and the
        // desktop re-posts 39, so resolveChunkGating flags it foreign and the
        // slice is skipped — the batch still succeeds.
        buildSyncedSession({
          externalSessionId: "ext-sess-stale",
          dataRevision: 39,
        }),
      ])
    );

    expect(result.persistedSessionIds).toEqual(["ext-sess-written"]);
  });

  it("goal stage 2: a batch whose every slice is skipped reports no persisted ids and withholds the landed watermark", async () => {
    const { computeTargetUpdateMany } = installDb({
      committedRevisionByExternalId: { "ext-sess-stale": 41 },
    });

    const result = await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({
          externalSessionId: "ext-sess-stale",
          dataRevision: 39,
        }),
      ])
    );

    expect(result.persistedSessionIds).toEqual([]);
    // The same derived count still drives the ISS-4678 landed-data watermark:
    // zero rows landed, so only the attempt watermark is stamped.
    expect(computeTargetUpdateMany).toHaveBeenCalledTimes(1);
    expect(computeTargetUpdateMany.mock.calls[0][0].data).not.toHaveProperty(
      "lastAgentSessionSyncAt"
    );
  });

  it("does NOT advance the LANDED-DATA watermark for an accepted empty batch (zero rows land)", async () => {
    const { computeTargetUpdateMany } = installDb();

    await agentSessionsService.upsertSessions(buildContext(), buildPayload([]));

    // ISS-4827: the accepted empty batch DOES stamp the attempt watermark — it
    // is proof the desktop reached the cloud — while the landed-data watermark
    // the stall detector reads stays untouched.
    expect(computeTargetUpdateMany).toHaveBeenCalledTimes(1);
    const updateArg = computeTargetUpdateMany.mock.calls[0][0];
    expect(updateArg.data).not.toHaveProperty("lastAgentSessionSyncAt");
    expect(updateArg.data.lastAgentSessionSyncAttemptAt).toBeInstanceOf(Date);
  });

  // Review, PR #4256: the in-transaction stamp is the LAST statement in the
  // ingest transaction, so an `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS` timeout or
  // any mid-transaction throw rolled it back with the data — leaving the attempt
  // watermark ageing in lockstep with the landed-data one, so a fleet whose
  // every batch fails read as QUIET ("nothing is even trying") instead of
  // STALLED. The failure-path stamp records it from outside the rolled-back
  // transaction.
  it("stamps the ATTEMPT watermark when an ACCEPTED batch fails inside its transaction", async () => {
    const { computeTargetUpdateMany } = installDb();
    const txFailure = new Error("Transaction already closed");
    mocks.withDb.tx.mockRejectedValue(txFailure);

    await expect(
      agentSessionsService.upsertSessions(
        buildContext(),
        buildPayload([buildSyncedSession()])
      )
      // The original ingest failure must still reach the caller — the stamp is
      // best-effort and never replaces it.
    ).rejects.toBe(txFailure);

    expect(computeTargetUpdateMany).toHaveBeenCalledTimes(1);
    const updateArg = computeTargetUpdateMany.mock.calls[0][0];
    expect(updateArg.where.id).toBe(COMPUTE_TARGET_ID);
    // ONLY the attempt watermark: the transaction rolled back, so no session
    // rows landed and the landed-data watermark must not move.
    expect(updateArg.data).not.toHaveProperty("lastAgentSessionSyncAt");
    expect(updateArg.data.lastAgentSessionSyncAttemptAt).toBeInstanceOf(Date);
  });

  it("stamps the LANDED-DATA watermark for partial legacy batch progress", async () => {
    const { computeTargetUpdateMany } = installDb();
    const txFailure = new Error("Transaction already closed");
    // The slice's own outcome shape (ISS-5648): `persisted` is what the landed-
    // data watermark counts, and the two fold flags are the per-source tallies
    // the batch-level telemetry aggregates.
    mocks.withDb.tx
      // The slice's result shape (FEA-1718 + ISS-5648): `persisted` feeds
      // `persistedSessionCount`, a null `loopBacklink` means this session named
      // no loop so no back-link write follows the commit, and the two fold flags
      // feed the batch-level retired-status tally.
      .mockResolvedValueOnce({
        loopBacklink: null,
        persisted: true,
      })
      .mockRejectedValueOnce(txFailure);

    await expect(
      agentSessionsService.upsertSessions(
        buildContext(),
        buildPayload([
          buildSyncedSession({ externalSessionId: "ext-sess-watermark-1" }),
          buildSyncedSession({ externalSessionId: "ext-sess-watermark-2" }),
        ])
      )
    ).rejects.toBe(txFailure);

    expect(computeTargetUpdateMany).toHaveBeenCalledTimes(2);
    const attemptUpdateArg = computeTargetUpdateMany.mock.calls[0][0];
    const landedUpdateArg = computeTargetUpdateMany.mock.calls[1][0];
    expect(attemptUpdateArg.data.lastAgentSessionSyncAttemptAt).toBeInstanceOf(
      Date
    );
    expect(landedUpdateArg.data.lastAgentSessionSyncAt).toBeInstanceOf(Date);
  });

  it("still surfaces the original ingest failure when the watermark stamp itself fails", async () => {
    const { computeTargetUpdateMany } = installDb();
    const txFailure = new Error("Transaction already closed");
    mocks.withDb.tx.mockRejectedValue(txFailure);
    computeTargetUpdateMany.mockRejectedValue(
      new Error("watermark write failed")
    );

    await expect(
      agentSessionsService.upsertSessions(
        buildContext(),
        buildPayload([buildSyncedSession()])
      )
    ).rejects.toBe(txFailure);
  });
});

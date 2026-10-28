/**
 * ISS-8781: the REAL foreign-chunk bridge, end to end.
 *
 * `upsert-sessions-batch-omission-report.test.ts` mocks `upsertSessionSlice` and
 * injects `SessionGateHoldReason.ForeignChunk` itself, so it proves what the
 * report does with the reason and NOT that the slice still produces it. If
 * `resolveGateRefusal` stopped naming the reason, the report would fall back to
 * `unattributed` and that whole suite would stay green — a false green on the
 * exact bridge this change added.
 *
 * So this case drives the real `upsertSessionSlice` (only the database is faked)
 * with a genuine foreign chunk: a chunked payload whose revision does not match
 * the assembly staged on the row. The fixture shape follows
 * `chunk-revision-gating.test.ts`; the DB-less slice harness follows
 * `service.degraded-metadata-persist.test.ts`.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistedSessionDetail } from "@/__tests__/support/agent-sessions/service.test-harness";

const mocks = vi.hoisted(() => ({
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  recordObservedRepositories: vi.fn(),
  stampIngestSyncWatermark: vi.fn(),
  stampIngestWatermarkAfterFailedBatch: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: { DOCUMENT: "DOCUMENT", BRANCH: "BRANCH", SESSION: "SESSION" },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  Prisma: { DbNull: mocks.dbNull },
  SessionOrigin: { DESKTOP_SYNC: "DESKTOP_SYNC", LOOP: "LOOP" },
  withDb: mocks.withDb,
}));
vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: mocks.logWarn, debug: mocks.logDebug },
}));
vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));
vi.mock("@/lib/github/observed-repository-store", () => ({
  recordObservedRepositories: mocks.recordObservedRepositories,
}));
vi.mock("./ingest-sync-stamp", () => ({
  stampIngestSyncWatermark: mocks.stampIngestSyncWatermark,
  stampIngestWatermarkAfterFailedBatch:
    mocks.stampIngestWatermarkAfterFailedBatch,
}));
// Spread the originals: the slice imports `resolveProjectId` from the first and
// `persistArtifactLinks` from the second, so replacing either module wholesale
// would leave a real production import undefined.
vi.mock("./project-resolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./project-resolution")>()),
  resolveProjectResolution: vi.fn().mockResolvedValue({
    artifactProjectById: new Map(),
  }),
}));
vi.mock("./artifact-links/slug-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./artifact-links/slug-links")>()),
  resolveArtifactSlugMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/app/settings/frustration-setting-service", () => ({
  frustrationSettingService: { isFrustrationEnabled: async () => false },
}));

import { SessionOmissionCause } from "./session-omission-report";
import { SessionSyncMetric } from "./session-sync-metrics";
import { upsertSessionsBatch } from "./upsert-sessions-batch";

const ORGANIZATION_ID = "org-foreign-chunk-1";
const COMPUTE_TARGET_ID = "target-foreign-chunk-1";
const EXTERNAL_SESSION_ID = "ext-foreign-chunk-1";
const CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: "user-foreign-chunk-1",
  computeTargetId: COMPUTE_TARGET_ID,
};
const OMISSION_MESSAGE = "Desktop agent sessions withheld from the ack echo";

/**
 * The staged sequence on the row: revision 4, three chunks, one received. The
 * incoming chunk below carries revision 5, so it belongs to a DIFFERENT
 * assembly and `resolveChunkGating` refuses it as foreign.
 */
const STAGED_PENDING_REVISION = 4;
const INCOMING_REVISION = 5;

function buildSession(): SyncedAgentSession {
  return {
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "Foreign Chunk Session",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/project",
    model: "claude-sonnet-4",
    startedAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T09:30:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    metadata: {},
    dataRevision: INCOMING_REVISION,
    chunk: { index: 1, total: 3 },
  };
}

function buildPayload(session: SyncedAgentSession) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-foreign-chunk-1",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [session],
    wantsAcceptedSessionIds: true,
  };
}

/** The stored row the slice reads, carrying the staged pending assembly. */
function installDb(): { detailUpsert: ReturnType<typeof vi.fn> } {
  const detailUpsert = vi
    .fn()
    .mockResolvedValue(persistedSessionDetail("artifact-1"));
  const db = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: COMPUTE_TARGET_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue({
        artifactId: "artifact-1",
        agents: [],
        dataRevision: 3,
        pendingChunkRevision: STAGED_PENDING_REVISION,
        pendingChunkTotal: 3,
        pendingChunkReceived: 1,
        sessionStartedAt: new Date("2026-08-24T09:00:00.000Z"),
        sessionUpdatedAt: new Date("2026-08-24T09:30:00.000Z"),
        sessionEndedAt: null,
        artifact: { status: null },
      }),
      upsert: detailUpsert,
      update: vi.fn().mockResolvedValue({}),
    },
  };
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(db)
  );
  return { detailUpsert };
}

function omissionBuckets(): {
  cause: SessionOmissionCause;
  count: number;
  sessionIds: string[];
}[] {
  return [...mocks.logWarn.mock.calls, ...mocks.logDebug.mock.calls]
    .filter((call) => call[0] === OMISSION_MESSAGE)
    .flatMap((call) => call[1].causes);
}

describe("upsertSessionsBatch — real foreign-chunk omission (ISS-8781)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stampIngestSyncWatermark.mockResolvedValue(undefined);
  });

  it("names a genuine foreign chunk under foreign_chunk, not unattributed", async () => {
    const { detailUpsert } = installDb();

    const result = await upsertSessionsBatch(
      CONTEXT,
      buildPayload(buildSession()) as never
    );

    // The gate refused before any write, so the id is genuinely withheld rather
    // than persisted-and-omitted.
    expect(detailUpsert).not.toHaveBeenCalled();
    expect(result.persistedSessionIds).toEqual([]);

    // THE BRIDGE. Drop the reason from `resolveGateRefusal` and this reads
    // `unattributed` instead — which is the fail-safe bucket, and would be
    // reported as a NEW unexplained omission path rather than as the known one.
    expect(omissionBuckets()).toEqual([
      {
        cause: SessionOmissionCause.ForeignChunk,
        count: 1,
        sessionIds: [EXTERNAL_SESSION_ID],
        sampleTruncated: false,
      },
    ]);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.SessionWithheldFromAck,
        cause: SessionOmissionCause.ForeignChunk,
        count: 1,
      })
    );
    // ISS-8603: a refused chunk never reached the tiling lane, so it must not
    // report a tiling refusal. `buildNoWriteSliceResult` hardcodes the reason
    // `null` for exactly this; without this assertion, flipping that constant
    // would make every foreign chunk and every revision hold — both routine,
    // high-volume conditions — report a tiling drop that never happened.
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.ActivityTilingSliceRefused,
      })
    );
  });
});

/**
 * ISS-8603 (PRD-699 §6.13): the cloud ingest's activity-tiling version-mismatch
 * skip reaches a MONITOR, not only a `log.warn`.
 *
 * The refused slice is otherwise invisible downstream. The session commits, its
 * id is echoed in the ack, and the stored tiling is simply short by that
 * slice's spans — nothing on the row, in the response, or in the ingest's
 * metric family distinguished it from a session that was tiled that way. The
 * root `AGENTS.md` bad-data rule does not accept a bare log for that, so this
 * drives the real `upsertSessions` path and pins the emission at the batch.
 *
 * Driven through the service rather than `appendActivityTilingSlice` on
 * purpose: the value crosses five modules between the skip and the emission
 * (persistence -> children -> slice children -> slice result -> batch tally),
 * and every seam is an assignment a unit test on either end would leave green.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedActivitySegmentRow,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistedSessionDetail } from "@/__tests__/support/agent-sessions/service.test-harness";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";

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

vi.mock("./service/session-ingest-metadata-activity", () => ({
  writeSessionArtifactMetadata: vi.fn().mockResolvedValue(null),
  captureCommittedSessionMetadata: vi.fn(),
}));

import { agentSessionsService } from "./service";

/**
 * The metric name spelled out, NOT imported from `SessionSyncMetric`.
 *
 * A monitor keys off this exact string, so the duplication IS the test: read
 * through the const the suite guards, a rename would carry the assertion along
 * with it and stay green while every dashboard querying the old name went
 * quiet.
 */
const METRIC_NAME = "agent_sessions.sync.activity_tiling_slice_refused";
/** Likewise spelled out: the facet a monitor would group and alert on. */
const REASON_VERSION_MISMATCH = "version_mismatch";

const ORG_ID = "org-tiling-mismatch-1";
const USER_ID = "user-tiling-mismatch-1";
const COMPUTE_TARGET_ID = "target-tiling-mismatch-1";
const PERSISTED_ARTIFACT_ID = "artifact-tiling-mismatch-1";
const SESSION_STARTED_AT = new Date("2026-08-01T09:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-08-01T09:30:00.000Z");
/** The revision the staged chunk sequence is assembling. */
const CHUNK_REVISION = 42;
/** The classifier version every payload slice below declares. */
const INCOMING_CLASSIFIER_VERSION = 5;

function buildSegmentRow(): SyncedActivitySegmentRow {
  return {
    phase: "implementing",
    startMs: 1000,
    endMs: 2000,
    confidence: 1,
    evidenceLayers: [],
    version: INCOMING_CLASSIFIER_VERSION,
  };
}

/**
 * A LATER chunk of the staged sequence, carrying one tiling span.
 *
 * `chunk.index > 0` is what routes the apply to the append lane; the matching
 * `dataRevision`/`chunk.total` keep it out of the foreign-chunk refusal, which
 * would return a no-write result before the tiling lane ever ran.
 */
function buildLaterChunkSession(externalSessionId: string): SyncedAgentSession {
  return {
    externalSessionId,
    name: externalSessionId,
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/project",
    model: "claude-sonnet-4",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    dataRevision: CHUNK_REVISION,
    chunk: { index: 1, total: 3 },
    activitySegmentRows: [buildSegmentRow()],
  } as unknown as SyncedAgentSession;
}

function buildPayload(sessions: SyncedAgentSession[]) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-tiling-mismatch-1",
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
 * The stored row every session in the batch resolves to: mid-sequence at
 * `(42, total 3, received 1)`, so chunk 1 of 3 is in-sequence and the apply
 * proceeds to the children write.
 */
function buildExistingRow() {
  return {
    artifactId: PERSISTED_ARTIFACT_ID,
    agents: [],
    dataRevision: null,
    pendingChunkRevision: CHUNK_REVISION,
    pendingChunkTotal: 3,
    pendingChunkReceived: 1,
    sessionStartedAt: SESSION_STARTED_AT,
    sessionUpdatedAt: SESSION_UPDATED_AT,
    sessionEndedAt: null,
    awaitingInputSince: null,
    activitySegmentRowsStripped: null,
    artifact: { status: SESSION_STATUS.ACTIVE },
  };
}

/**
 * Install the transaction-level mocks and queue one STORED classifier version
 * per session, in batch order. A version equal to
 * {@link INCOMING_CLASSIFIER_VERSION} makes that session's slice append; any
 * other value makes it the mismatch this metric counts.
 */
function installDb(storedClassifierVersions: number[]) {
  const segmentFindFirst = vi.fn();
  for (const classifierVersion of storedClassifierVersions) {
    segmentFindFirst.mockResolvedValueOnce({ classifierVersion });
  }
  const segmentCreateMany = vi.fn().mockResolvedValue({ count: 1 });

  const db = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([
        { toolUseCount: 0n, errorCount: 0n, maxEventCreatedAt: null },
      ]),
    organization: {
      findUnique: vi.fn().mockResolvedValue({ settings: null }),
    },
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: COMPUTE_TARGET_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue(buildExistingRow()),
      upsert: vi
        .fn()
        .mockResolvedValue(persistedSessionDetail(PERSISTED_ARTIFACT_ID)),
      update: vi.fn().mockResolvedValue({}),
    },
    artifact: { update: vi.fn().mockResolvedValue({}) },
    agentSessionEvent: {
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      aggregate: vi.fn().mockResolvedValue({ _max: { eventCreatedAt: null } }),
    },
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    agentSessionTokenEvent: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    agentSessionActivitySegment: {
      findFirst: segmentFindFirst,
      createMany: segmentCreateMany,
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    artifactLink: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
  };

  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );

  return { segmentCreateMany, segmentFindFirst };
}

/** Every emission carrying this metric name, whatever else the batch emitted. */
function refusalEmissions(): Record<string, unknown>[] {
  return mocks.emitTelemetryMetric.mock.calls
    .map((call: unknown[]) => call[0] as Record<string, unknown>)
    .filter((emission) => emission?.metric === METRIC_NAME);
}

describe("upsertSessions — ISS-8603 tiling slice refusal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits ONE batch count naming only the slices the append lane refused", async () => {
    // Two later chunks in one batch. The first slice's stored tiling is at
    // version 9 against an incoming 5 — refused; the second matches and
    // appends. Both are needed: a fixture where every session skips would pass
    // just as well against a counter that fires on every append attempt.
    const { segmentCreateMany } = installDb([9, INCOMING_CLASSIFIER_VERSION]);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildLaterChunkSession("ext-sess-mismatch"),
        buildLaterChunkSession("ext-sess-match"),
      ])
    );

    // The lane genuinely ran both arms: the matching slice wrote its rows, so
    // the count below is a refusal tally rather than "the tiling lane is dead".
    expect(segmentCreateMany).toHaveBeenCalledTimes(1);
    expect(refusalEmissions()).toEqual([
      expect.objectContaining({
        metric: METRIC_NAME,
        organizationId: ORG_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        reason: REASON_VERSION_MISMATCH,
        count: 1,
      }),
    ]);
  });

  it("SUMS the refusals in a batch rather than reporting their presence", async () => {
    // THREE later chunks, TWO of them refused on a version mismatch. Without
    // this case the accumulator can be replaced by a constant `1` and every
    // other assertion here still passes — the metric would then under-report a
    // 200-session batch to a monitor reading `sum(count)`.
    const { segmentCreateMany } = installDb([
      9,
      11,
      INCOMING_CLASSIFIER_VERSION,
    ]);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildLaterChunkSession("ext-sess-mismatch-a"),
        buildLaterChunkSession("ext-sess-mismatch-b"),
        buildLaterChunkSession("ext-sess-match"),
      ])
    );

    expect(segmentCreateMany).toHaveBeenCalledTimes(1);
    expect(refusalEmissions()).toEqual([
      expect.objectContaining({
        metric: METRIC_NAME,
        reason: REASON_VERSION_MISMATCH,
        count: 2,
      }),
    ]);
  });

  it("stays silent when every slice matched the stored tiling version", async () => {
    // The metric measures a draining population. A zero would turn it into a
    // sync-traffic counter, and a `value > 0` monitor into a permanent page.
    const { segmentCreateMany } = installDb([INCOMING_CLASSIFIER_VERSION]);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildLaterChunkSession("ext-sess-match")])
    );

    expect(segmentCreateMany).toHaveBeenCalledTimes(1);
    expect(refusalEmissions()).toEqual([]);
  });

  it("persists a slice whose sequence stored no tiling (ISS-10259)", async () => {
    // The whole defect, on the real `upsertSessions` path. Nothing stored is
    // what a PAGINATED tiling looks like between its opening chunk — which
    // carries the explicit `activitySegmentRows: []` that
    // `createChunkBuilders.baseFor` stamps, and so clears and inserts nothing —
    // and its first slice. This lane used to read that as "chunk 0 has not
    // landed" and drop the spans, which dropped every paginated tiling whole.
    //
    // The two arms this suite used to split are now one: the refusal that named
    // `no_stored_tiling` WAS the bug, so it is gone rather than re-homed.
    const { segmentCreateMany } = installDb([]);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildLaterChunkSession("ext-sess-unstaged")])
    );

    expect(segmentCreateMany).toHaveBeenCalledTimes(1);
    expect(segmentCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );
    expect(refusalEmissions()).toEqual([]);
  });
});

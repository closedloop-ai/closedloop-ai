/**
 * FEA-1718, thread 4 (whitlockk): a back-link failure must NOT abort the ingest of
 * the sessions queued behind it in a version-skewed multi-session payload.
 *
 * This is the throwing case specifically. The sibling integration suite covers a
 * claim that merely matches no rows, which is benign and cannot prove anything
 * about propagation; a genuine transient failure cannot be forced against a real
 * Postgres on demand, so it is injected here and driven through the REAL
 * `upsertSessionsBatch` — the production caller — rather than through the helper
 * in isolation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) => fn({})),
    { tx: vi.fn() }
  ),
  emitTelemetryMetric: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  recordObservedRepositories: vi.fn(),
  upsertSessionSlice: vi.fn(),
  stampIngestSyncWatermark: vi.fn(),
  stampIngestWatermarkAfterFailedBatch: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));
vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: mocks.logWarn },
}));
vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));
vi.mock("@/lib/github/observed-repository-store", () => ({
  recordObservedRepositories: mocks.recordObservedRepositories,
}));
vi.mock("./upsert-session-slice", () => ({
  upsertSessionSlice: mocks.upsertSessionSlice,
}));
vi.mock("./ingest-sync-stamp", () => ({
  stampIngestSyncWatermark: mocks.stampIngestSyncWatermark,
  stampIngestWatermarkAfterFailedBatch:
    mocks.stampIngestWatermarkAfterFailedBatch,
}));
vi.mock("./project-resolution", () => ({
  resolveProjectResolution: vi.fn().mockResolvedValue({
    artifactProjectById: new Map(),
  }),
}));
vi.mock("./artifact-links/slug-links", () => ({
  resolveArtifactSlugMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/app/settings/frustration-setting-service", () => ({
  frustrationSettingService: { isFrustrationEnabled: async () => false },
}));

import type { DesktopAgentSessionsPayload } from "@repo/api/src/types/agent-session";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { EVENT } from "@/__tests__/support/agent-sessions/monitored-session-activity.test-fixtures";
import {
  buildBatch,
  buildPayload,
  buildRowLevelAckPayload,
  buildSession,
} from "@/__tests__/support/agent-sessions/upsert-sessions-batch.test-fixtures";
import {
  ACTIVITY_TILING_STRIPPED_EVENT,
  activityTilingStrippedThrottle,
} from "./activity-tiling-strip";
import { SessionSyncMetric } from "./session-sync-metrics";
import {
  MAX_OBSERVED_REPOSITORIES_PER_SYNC_REQUEST,
  upsertSessionsBatch,
} from "./upsert-sessions-batch";

const ORGANIZATION_ID = "org-batch-1";
const CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: "user-batch-1",
  computeTargetId: "target-batch-1",
};

/** Fail exactly one session's slice; every other session persists. */
function failSliceFor(externalSessionId: string, error: Error) {
  mocks.upsertSessionSlice.mockImplementation(
    (_tx: unknown, input: { session: { externalSessionId: string } }) => {
      if (input.session.externalSessionId === externalSessionId) {
        throw error;
      }
      return {
        persisted: true,
        observedRepositoryFullNames: [],
        indexKeyProjections: 0,
      };
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The strip report rides a process-local emission throttle keyed on
  // (org, compute target), and every case here uses the same CONTEXT — without
  // this reset the second stripped batch in the file would be suppressed and
  // the suite would be testing the throttle instead of the report.
  activityTilingStrippedThrottle.clear();
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ computeTarget: { findFirst: async () => ({ id: "target-batch-1" }) } })
  );
  mocks.withDb.tx.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  mocks.upsertSessionSlice.mockImplementation(
    (_tx: unknown, _input: { session: { externalSessionId: string } }) => ({
      persisted: true,
      observedRepositoryFullNames: [],
      indexKeyProjections: 0,
    })
  );
  mocks.recordObservedRepositories.mockResolvedValue(undefined);
});

/**
 * A session the server cannot ingest must not reject the sessions batched with
 * it. Scope, because the incident does not fully fit inside it: this protects
 * the multi-session fresh drain, not the one-chunk-per-request chunk lane.
 */
describe("upsertSessionsBatch — failing-slice isolation", () => {
  it("ingests the sessions around a failing slice and omits only its id", async () => {
    failSliceFor("ext-1", new Error("tx timeout"));

    await expect(
      upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(3))
    ).resolves.toEqual({ persistedSessionIds: ["ext-0", "ext-2"] });

    // Decisive: `ext-2` was queued BEHIND the failure and still reached the
    // slice. Before the fix the throw escaped the loop, so it never ran and
    // `ext-0` was re-sent despite already being durable.
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(3);
    expect(mocks.stampIngestSyncWatermark).toHaveBeenCalledTimes(1);
  });

  it("names the failing session in the log and counts the skip", async () => {
    const error = new Error("tx timeout");
    failSliceFor("ext-1", error);

    await upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(3));

    // The handler's batch-level log names only the compute target and no longer
    // fires for a partial batch, so this is the only record of which and why.
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      "Desktop agent session slices failed",
      expect.objectContaining({
        failedSessionCount: 1,
        failures: [{ error, externalSessionId: "ext-1" }],
      })
    );
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: SessionSyncMetric.SliceFailed,
      organizationId: ORGANIZATION_ID,
      count: 1,
    });
  });

  it("emits one log and one count for a batch, not one per failing session", async () => {
    mocks.upsertSessionSlice.mockImplementation(
      (_tx: unknown, input: { session: { externalSessionId: string } }) => {
        if (input.session.externalSessionId === "ext-2") {
          return {
            persisted: true,
            observedRepositoryFullNames: [],
            indexKeyProjections: 0,
          };
        }
        throw new Error(`poison ${input.session.externalSessionId}`);
      }
    );

    // Caller-supplied, up to 200 per request, so per-row emission is an
    // amplification vector. Decisive: the CALL COUNTS, two failures to one log.
    await upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(3));

    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      "Desktop agent session slices failed",
      expect.objectContaining({ failedSessionCount: 2 })
    );
    const sliceFailedEmissions = mocks.emitTelemetryMetric.mock.calls
      .map((call) => call[0])
      .filter((arg) => arg?.metric === SessionSyncMetric.SliceFailed);
    expect(sliceFailedEmissions).toEqual([
      {
        metric: SessionSyncMetric.SliceFailed,
        organizationId: ORGANIZATION_ID,
        count: 2,
      },
    ]);
  });

  it("isolates a failing slice from ones that declined to write", async () => {
    const error = new Error("tx timeout");
    mocks.upsertSessionSlice.mockImplementation(
      (_tx: unknown, input: { session: { externalSessionId: string } }) => {
        if (input.session.externalSessionId === "ext-1") {
          throw error;
        }
        // A foreign chunk: deliberately no write, and deliberately NOT echoed.
        return {
          persisted: false,
          observedRepositoryFullNames: [],
          indexKeyProjections: 0,
        };
      }
    );

    // An empty echo is not a total failure: one slice threw, two declined to
    // write. Rejecting on "nothing persisted" would walk all three back through
    // the retry budget.
    await expect(
      upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(3))
    ).resolves.toEqual({ persistedSessionIds: [] });
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(3);
  });

  it("still rejects the batch when every slice threw", async () => {
    const error = new Error("pool exhausted");
    mocks.upsertSessionSlice.mockImplementation(() => {
      throw error;
    });

    // Every slice failing is an outage, not a poison row: the desktop must back
    // off on `ingestion_failed` rather than burn its whole ack-omitted budget.
    await expect(
      upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(3))
    ).rejects.toThrow(error);
    expect(mocks.stampIngestWatermarkAfterFailedBatch).toHaveBeenCalledTimes(1);
    expect(mocks.stampIngestSyncWatermark).not.toHaveBeenCalled();
    // An outage must not inflate the signal that names poison rows.
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({ metric: SessionSyncMetric.SliceFailed })
    );
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("rejects the whole batch when the client cannot read a partial ack", async () => {
    failSliceFor("ext-1", new Error("tx timeout"));

    // No `wantsAcceptedSessionIds`: `accepted: true` would mean "all of it
    // landed", so a version-skewed desktop would clear rows never stored.
    await expect(upsertSessionsBatch(CONTEXT, buildPayload(3))).rejects.toThrow(
      "tx timeout"
    );
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(2);
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({ metric: SessionSyncMetric.SliceFailed })
    );
  });
});

/**
 * PLN-1775 M1 (ISS-7403): the discovery write for an org with no GitHub App
 * installation. It runs AFTER the slices commit, so what it must prove is that
 * it describes only durable sessions and can never cost one.
 */
describe("upsertSessionsBatch — observed repository discovery", () => {
  /** Every slice reports the same repository, plus one unique to itself. */
  function observeRepositories(perSession: (index: number) => string[]) {
    mocks.upsertSessionSlice.mockImplementation(
      (_tx: unknown, input: { session: { externalSessionId: string } }) => ({
        persisted: true,
        observedRepositoryFullNames: perSession(
          Number(input.session.externalSessionId.split("-")[1])
        ),
        indexKeyProjections: 0,
      })
    );
  }

  it("writes the batch's unrecorded repositories once, with each one's session weight", async () => {
    observeRepositories((index) => ["acme/shared", `acme/only-${index}`]);

    await upsertSessionsBatch(CONTEXT, buildPayload(2));

    // ONE write for the batch, not one per session: a 200-session payload is an
    // authenticated caller's to shape.
    expect(mocks.recordObservedRepositories).toHaveBeenCalledTimes(1);
    const call = mocks.recordObservedRepositories.mock.calls[0]?.[0];
    expect(call.organizationId).toBe(ORGANIZATION_ID);
    expect(
      [...call.observations].sort(
        (
          left: { repositoryFullName: string },
          right: { repositoryFullName: string }
        ) => left.repositoryFullName.localeCompare(right.repositoryFullName)
      )
    ).toEqual([
      { repositoryFullName: "acme/only-0", observedSessionCount: 1 },
      { repositoryFullName: "acme/only-1", observedSessionCount: 1 },
      { repositoryFullName: "acme/shared", observedSessionCount: 2 },
    ]);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: SessionSyncMetric.ObservedRepositoryRecorded,
      organizationId: ORGANIZATION_ID,
      computeTargetId: CONTEXT.computeTargetId,
      count: 3,
      droppedCount: 0,
    });
  });

  it("records nothing for a slice that failed", async () => {
    mocks.upsertSessionSlice.mockImplementation(
      (_tx: unknown, input: { session: { externalSessionId: string } }) => {
        if (input.session.externalSessionId === "ext-1") {
          throw new Error("tx timeout");
        }
        return {
          persisted: true,
          observedRepositoryFullNames: ["acme/committed"],
          indexKeyProjections: 0,
        };
      }
    );

    await upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(2));

    // A candidate is evidence that a durable session worked in a repo. A slice
    // that rolled back left no such session behind.
    const call = mocks.recordObservedRepositories.mock.calls[0]?.[0];
    expect(call.observations).toEqual([
      { repositoryFullName: "acme/committed", observedSessionCount: 1 },
    ]);
  });

  it("ingests the batch and counts the loss when the discovery write throws", async () => {
    observeRepositories(() => ["acme/widget"]);
    mocks.recordObservedRepositories.mockRejectedValue(
      new Error("db unavailable")
    );

    // The sessions are already committed; letting a derived discovery row abort
    // the response would make the desktop re-send durable rows.
    await expect(
      upsertSessionsBatch(CONTEXT, buildPayload(2))
    ).resolves.toEqual({ persistedSessionIds: ["ext-0", "ext-1"] });

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: SessionSyncMetric.ObservedRepositoryWriteFailed,
      organizationId: ORGANIZATION_ID,
      computeTargetId: CONTEXT.computeTargetId,
      count: 1,
    });
    // Never a recorded count for rows that were not written — that reads as
    // coverage the org does not have.
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.ObservedRepositoryRecorded,
      })
    );
  });

  it("counts a repository dropped by two sessions once, not twice", async () => {
    // `droppedCount` claims DISTINCT repositories missed. Every session in a
    // batch names the same repositories, so an occurrence counter reports one
    // missed repository as N and makes a bounded cap look like a bigger gap
    // than it is.
    const overflowNames = Array.from(
      { length: MAX_OBSERVED_REPOSITORIES_PER_SYNC_REQUEST + 2 },
      (_, index) => `acme/repo-${index}`
    );
    observeRepositories(() => overflowNames);

    await upsertSessionsBatch(CONTEXT, buildPayload(3));

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.ObservedRepositoryRecorded,
        count: MAX_OBSERVED_REPOSITORIES_PER_SYNC_REQUEST,
        // Two distinct repositories missed — not six.
        droppedCount: 2,
      })
    );
  });

  it("caps the distinct repositories one batch may record and reports what it dropped", async () => {
    const overflow = MAX_OBSERVED_REPOSITORIES_PER_SYNC_REQUEST + 3;
    observeRepositories(() =>
      Array.from({ length: overflow }, (_, index) => `acme/repo-${index}`)
    );

    await upsertSessionsBatch(CONTEXT, buildPayload(1));

    const call = mocks.recordObservedRepositories.mock.calls[0]?.[0];
    expect(call.observations).toHaveLength(
      MAX_OBSERVED_REPOSITORIES_PER_SYNC_REQUEST
    );
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.ObservedRepositoryRecorded,
        count: MAX_OBSERVED_REPOSITORIES_PER_SYNC_REQUEST,
        droppedCount: 3,
      })
    );
  });

  it("writes nothing when every repository the batch named is already recorded", async () => {
    observeRepositories(() => []);

    await upsertSessionsBatch(CONTEXT, buildPayload(2));

    expect(mocks.recordObservedRepositories).not.toHaveBeenCalled();
  });
});

/**
 * The smallest carrier the wire contract can actually deliver: on the parsed
 * payload `monitoredSessionActivity` is `syncedMonitoredSessionActivitySchema
 * .optional()`, so it is an OBJECT when present and ABSENT otherwise. A boolean
 * here would pin the guard against a shape no producer can send, and would stay
 * green under a guard that read the flag as `=== true`.
 */
function monitoredActivityCarrier() {
  return {
    completeness: BranchActivityEvidenceCompleteness.Complete,
    events: [EVENT],
  };
}

describe("upsertSessionsBatch — tiling-strip monitored event (ISS-7265)", () => {
  it("raises the monitored event for a stripped session the batch persisted", async () => {
    await upsertSessionsBatch(CONTEXT, buildStrippedTilingPayload());

    // One emission per BATCH, never per session (apps/api/AGENTS.md), and it
    // must come from the real `upsertSessionsBatch` — the unit test for
    // `reportStrippedTilings` proves the function, not that anything calls it.
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(ACTIVITY_TILING_STRIPPED_EVENT, {
      computeTargetId: CONTEXT.computeTargetId,
      organizationId: ORGANIZATION_ID,
      strippedSessionCount: 1,
      // #5741: the emission now rides a fixed-window throttle whose rollup
      // reports N on one event, so a live event states its own weight. Kept as
      // a whole-object match so a NEW facet still has to be declared here.
      occurrences: 1,
    });
  });

  it("stays silent when the stripped session's slice never persisted", async () => {
    // THE SIBLING, and the one that pins the `persistedSessionIds` gate: a slice
    // that threw will re-send its tiling in full, so reporting it would name a
    // loss that has not happened. Counting `payload.sessions` instead passes the
    // case above and fails here.
    failSliceFor("ext-stripped", new Error("slice blew up"));

    await upsertSessionsBatch(CONTEXT, buildStrippedTilingPayload());

    // Scoped to the strip event by NAME, not a blanket "nothing warned"
    // (ISS-8781): the same fixture now legitimately raises the omission report,
    // because a thrown slice is an id withheld from the ack echo. The contract
    // this case exists for is unchanged and still fully pinned — the strip
    // report stays silent for a slice that never persisted.
    expect(mocks.logWarn).not.toHaveBeenCalledWith(
      ACTIVITY_TILING_STRIPPED_EVENT,
      expect.anything()
    );
  });

  it("still reports a stripped session that committed but was withheld from the ack echo", async () => {
    // An unresolved monitored-activity target holds a session out of
    // `persistedSessionIds` on EVERY attempt, while its columns — including the
    // strip — are already durable. Keying the report on the echo would go
    // permanently silent on exactly those rows.
    mocks.upsertSessionSlice.mockImplementation(
      (_tx: unknown, input: { session: { externalSessionId: string } }) => ({
        persisted: true,
        retryRequired: input.session.externalSessionId === "ext-stripped",
        observedRepositoryFullNames: [],
        indexKeyProjections: 0,
      })
    );

    const result = await upsertSessionsBatch(
      CONTEXT,
      buildStrippedTilingPayload()
    );

    // Positive control: the stripped row really was withheld from the echo, so
    // the assertion below is about the committed-vs-acked split and not about a
    // session that simply acked normally.
    expect(result.persistedSessionIds).toEqual(["ext-clean"]);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      ACTIVITY_TILING_STRIPPED_EVENT,
      expect.objectContaining({ strippedSessionCount: 1 })
    );
  });

  it("stays silent for a batch in which nothing was stripped", async () => {
    await upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(2));

    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("stays silent for a NON-FINAL chunk of a stripped session", async () => {
    // whitlockk, #5741. The desktop's bounded fallback stamps the strip on EVERY
    // part of a split, and each part commits, so a population of "every
    // committed slice" reports one lost tiling once per chunk — inflating the
    // single number an ISS-7265 ruling depends on. A non-final chunk has also
    // dequeued nothing yet, which is why the desktop delivery side defers to
    // the final chunk too.
    await upsertSessionsBatch(
      CONTEXT,
      buildChunkedStrippedPayload({ index: 0, total: 3 })
    );

    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("reports the stripped session on the FINAL chunk of its split", async () => {
    // THE PAIRED POSITIVE. Without it, never reporting a chunked session at all
    // would satisfy the case above — and a stripped session that had to chunk is
    // precisely the compound shape this ticket is about.
    await upsertSessionsBatch(
      CONTEXT,
      buildChunkedStrippedPayload({ index: 2, total: 3 })
    );

    expect(mocks.logWarn).toHaveBeenCalledWith(
      ACTIVITY_TILING_STRIPPED_EVENT,
      expect.objectContaining({ strippedSessionCount: 1 })
    );
  });
});

/**
 * A row-level-ack batch carrying one session that shipped WITHOUT its activity
 * tiling and one ordinary session, so the emission's count has to discriminate
 * rather than just report the batch size.
 */
function buildStrippedTilingPayload(): DesktopAgentSessionsPayload {
  return buildBatch(
    [
      buildSession({
        externalSessionId: "ext-stripped",
        activitySegmentRowsStripped: true,
      }),
      buildSession({ externalSessionId: "ext-clean" }),
    ],
    { wantsAcceptedSessionIds: true }
  );
}

/**
 * ISS-8051: monitored-activity targets are a SPLITTING problem, never a budget.
 *
 * There used to be a batch-wide guard here that counted distinct monitored
 * targets across the whole payload and threw before any slice ran. It is gone,
 * and these tests exist so it cannot come back quietly.
 *
 * Two things make its removal safe rather than merely permissive. The write it
 * claimed to protect is ALREADY split — `persistMonitoredSessionActivity` runs
 * per slice, on one session's `artifactRefs`, inside that slice's own bounded
 * transaction — so a request-wide count was a proxy for nothing the database
 * ever saw. And the recovery the guard assumed no longer exists: it answered 400
 * so FEA-4375 would isolate one id and re-send it alone, which converged only
 * while a per-session wire cap kept a lone session under the aggregate. That cap
 * is gone, so an isolated session that breached the budget would draw the same
 * rejection forever, with no smaller batch left to try.
 *
 * Driven through the REAL `upsertSessionsBatch`, because the property under test
 * is that NOTHING is refused before the per-session loop.
 */
describe("upsertSessionsBatch — oversized monitored-activity payloads", () => {
  /**
   * Independently written literals. Neither is derived from a cap — the old
   * budget was 500 and the wire cap it was compared against was 500, so a
   * fixture spelled in terms of either would have moved with the constant it was
   * supposed to police. That is exactly how the guard test this suite replaces
   * stayed green through the change that armed the bug: it asserted a
   * relationship between two constants the change never touched.
   */
  const LONE_SESSION_TARGET_COUNT = 1201;
  const BATCH_SESSION_COUNT = 40;
  const TARGETS_PER_BATCHED_SESSION = 37;

  function monitoredBranchRefs(
    count: number,
    sessionIndex: number
  ): SyncedArtifactRef[] {
    return Array.from({ length: count }, (_, index) => ({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "acme/app",
      branchName: `feature/s${sessionIndex}-branch-${index}`,
      method: ArtifactRefMethod.McpToolCall,
      relation: ArtifactRefRelation.Reviewed,
      monitoredSessionActivity: monitoredActivityCarrier(),
    }));
  }

  it("admits a LONE session naming far more monitored targets than any batch ever bounded", async () => {
    // The permanent-loss case, and the reason the old guard could not stay. One
    // session is the floor of bisection: whatever this payload's fate is, it is
    // final. It must be persistence.
    const refs = monitoredBranchRefs(LONE_SESSION_TARGET_COUNT, 0);

    await expect(
      upsertSessionsBatch(
        CONTEXT,
        buildBatch([
          buildSession({ externalSessionId: "ext-0", artifactRefs: refs }),
        ])
      )
    ).resolves.toEqual({ persistedSessionIds: ["ext-0"] });

    // Not merely "no throw": the slice ran, and it was handed every ref the
    // session named. A preflight that quietly dropped the tail would satisfy an
    // error-free assertion while losing exactly what this ticket is about.
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(1);
    const deliveredRefs =
      mocks.upsertSessionSlice.mock.calls[0][1].session.artifactRefs;
    expect(deliveredRefs).toHaveLength(LONE_SESSION_TARGET_COUNT);
    expect(
      new Set(
        deliveredRefs.map((ref: { branchName: string }) => ref.branchName)
      ).size
    ).toBe(LONE_SESSION_TARGET_COUNT);
  });

  it("persists EVERY session of a batch whose combined targets exceed any former budget", async () => {
    // The busy-org case the guard refused wholesale: no single session is
    // remarkable, and the aggregate is only large because the batch is. Count
    // the sessions that came out, not the absence of an exception.
    const sessions = Array.from(
      { length: BATCH_SESSION_COUNT },
      (_, sessionIndex) =>
        buildSession({
          externalSessionId: `ext-${sessionIndex}`,
          artifactRefs: monitoredBranchRefs(
            TARGETS_PER_BATCHED_SESSION,
            sessionIndex
          ),
        })
    );

    await expect(
      upsertSessionsBatch(CONTEXT, buildBatch(sessions))
    ).resolves.toEqual({
      persistedSessionIds: sessions.map((session) => session.externalSessionId),
    });

    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(BATCH_SESSION_COUNT);
    // The fixture's own precondition, so this test cannot pass by being small:
    // the payload really does name more distinct targets than the retired cap.
    expect(BATCH_SESSION_COUNT * TARGETS_PER_BATCHED_SESSION).toBeGreaterThan(
      1000
    );
  });

  it("does not reject a payload whose targets repeat across sessions", async () => {
    // The other half of the retired guard's semantics: it deduped by identity,
    // so a payload of many refs naming few targets was admitted while a payload
    // of fewer refs naming more was refused. Neither reading survives — both
    // shapes persist now, and this pins the one that used to be the pass.
    const shared = monitoredBranchRefs(TARGETS_PER_BATCHED_SESSION, 0);

    await expect(
      upsertSessionsBatch(
        CONTEXT,
        buildBatch([
          buildSession({ externalSessionId: "ext-0", artifactRefs: shared }),
          buildSession({ externalSessionId: "ext-1", artifactRefs: shared }),
          buildSession({ externalSessionId: "ext-2", artifactRefs: shared }),
        ])
      )
    ).resolves.toEqual({
      persistedSessionIds: ["ext-0", "ext-1", "ext-2"],
    });

    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(3);
  });
});

/**
 * ONE chunk of a stripped session's fallback split. `chunkOversizedSession`
 * spreads the base session into every part, so the strip flag rides all of them
 * — which is why the report's population is final-delivery-gated.
 */
function buildChunkedStrippedPayload(chunk: {
  index: number;
  total: number;
}): DesktopAgentSessionsPayload {
  return buildBatch(
    [
      buildSession({
        externalSessionId: "ext-stripped",
        activitySegmentRowsStripped: true,
        chunk,
      }),
    ],
    { wantsAcceptedSessionIds: true }
  );
}

/**
 * ISS-9181: which monitored-activity holds reach the acknowledgement, and what
 * the batch reports about the ones that do not.
 *
 * `persistMonitoredSessionActivity`'s own suite owns WHICH targets are held.
 * This file owns the seam after it: a slice that reports `retryRequired: false`
 * must reach `persistedSessionIds` — the list the desktop reads as
 * `acceptedSessionIds` — and each acknowledged skip must arrive on the batch
 * metric under its own field, because a skip nothing counts is the invisible
 * population ISS-6476 -> ISS-6980 shipped once already.
 *
 * ISS-9182 extends that to the holds: WHICH of the four it was, each on its
 * own field and under an unchanged `targetRetryRequiredCount`.
 *
 * A sibling file rather than another block in `upsert-sessions-batch.test.ts`,
 * which is at the 1,000-line ceiling, for the same reason
 * `upsert-sessions-batch-unstorable-counters.test.ts` is.
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

import {
  emptyMonitoredActivityOutcomeCounts,
  MonitoredActivityOutcome,
} from "./monitored-session-activity-persistence";
import { SessionSyncMetric } from "./session-sync-metrics";
import { upsertSessionsBatch } from "./upsert-sessions-batch";

const ORGANIZATION_ID = "org-batch-monitored-activity-ack";
const CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: "user-batch-monitored-activity-ack",
  computeTargetId: "target-batch-monitored-activity-ack",
};
const OUT_OF_SCOPE_SESSION = "ext-out-of-scope";
const RETRY_OWNED_SESSION = "ext-retry-owned";
/** Every acknowledged skip, each wired to its own field on the batch metric. */
const ACKNOWLEDGED_OUTCOME_BY_SESSION = new Map([
  [OUT_OF_SCOPE_SESSION, MonitoredActivityOutcome.TargetRepositoryOutOfScope],
  [RETRY_OWNED_SESSION, MonitoredActivityOutcome.TargetIntentionallyAbsent],
  [
    "ext-repository-unfetchable-a",
    MonitoredActivityOutcome.TargetRepositoryUnfetchable,
  ],
  [
    "ext-repository-unfetchable-b",
    MonitoredActivityOutcome.TargetRepositoryUnfetchable,
  ],
]);
/**
 * Every held disposition, each wired to a DIFFERENT number of sessions. One
 * disposition cannot tell a per-disposition counter from one counter every hold
 * increments, and equal numbers cannot tell two fields apart from two fields
 * wired to the same member. A disposition left out of the batch is worse than
 * an unasserted field: its `MONITORED_ACTIVITY_OUTCOME_COUNTS_ONE_CANDIDATE`
 * entry never reaches `count`, so flipping it to the summed kind would double
 * that hold with every case here still green.
 */
const HELD_SESSIONS_BY_OUTCOME = [
  {
    outcome: MonitoredActivityOutcome.TargetAuthorityConflict,
    externalSessionIds: ["ext-authority-conflict"],
  },
  {
    outcome: MonitoredActivityOutcome.TargetNotMaterialized,
    externalSessionIds: ["ext-not-materialized-a", "ext-not-materialized-b"],
  },
  {
    outcome: MonitoredActivityOutcome.TargetRepositoryIdentityUnknown,
    externalSessionIds: [
      "ext-repository-identity-unknown-a",
      "ext-repository-identity-unknown-b",
      "ext-repository-identity-unknown-c",
    ],
  },
  {
    outcome: MonitoredActivityOutcome.TargetProviderIdentityAmbiguous,
    externalSessionIds: [
      "ext-provider-identity-ambiguous-a",
      "ext-provider-identity-ambiguous-b",
      "ext-provider-identity-ambiguous-c",
      "ext-provider-identity-ambiguous-d",
    ],
  },
] as const;
const HELD_OUTCOME_BY_SESSION = new Map<string, MonitoredActivityOutcome>(
  HELD_SESSIONS_BY_OUTCOME.flatMap(({ outcome, externalSessionIds }) =>
    externalSessionIds.map(
      (externalSessionId) => [externalSessionId, outcome] as const
    )
  )
);
const HELD_SESSION_COUNT = HELD_OUTCOME_BY_SESSION.size;

function sliceOutcome(input: {
  retryRequired: boolean;
  outcome: MonitoredActivityOutcome;
}) {
  return {
    persisted: true,
    retryRequired: input.retryRequired,
    observedRepositoryFullNames: [],
    indexKeyProjections: 0,
    unstorableCounterFields: [],
    monitoredActivityOutcomeCounts: {
      ...emptyMonitoredActivityOutcomeCounts(),
      [input.outcome]: 1,
    },
  };
}

/**
 * A held slice as the producer builds one: its disposition's own member AND
 * the `TargetRetryRequired` total, which is the double tally the batch's
 * `count` has to see through.
 */
function heldSliceOutcome(outcome: MonitoredActivityOutcome) {
  const held = sliceOutcome({ retryRequired: true, outcome });
  return {
    ...held,
    monitoredActivityOutcomeCounts: {
      ...held.monitoredActivityOutcomeCounts,
      [MonitoredActivityOutcome.TargetRetryRequired]: 1,
    },
  };
}

/**
 * ISS-11427: a hold the ceiling RESOLVED. Acknowledged (`retryRequired: false`),
 * counted under `TargetHoldExpired` and under its classified disposition, and
 * deliberately NOT under `TargetRetryRequired` — the resolution is what takes it
 * out of the held population.
 */
function holdExpiredSliceOutcome(classified: MonitoredActivityOutcome) {
  const settled = sliceOutcome({ retryRequired: false, outcome: classified });
  return {
    ...settled,
    monitoredActivityOutcomeCounts: {
      ...settled.monitoredActivityOutcomeCounts,
      [MonitoredActivityOutcome.TargetHoldExpired]: 1,
    },
  };
}

function outcomeEmission() {
  return mocks.emitTelemetryMetric.mock.calls
    .map(([arg]) => arg)
    .find(
      (arg) =>
        arg?.metric === SessionSyncMetric.MonitoredActivityOutcomeRecorded
    );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      computeTarget: {
        findFirst: async () => ({ id: CONTEXT.computeTargetId }),
      },
    })
  );
  mocks.withDb.tx.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  mocks.recordObservedRepositories.mockResolvedValue(undefined);
});

describe("upsertSessionsBatch — monitored-activity acknowledgement (ISS-9181)", () => {
  it("acknowledges the out-of-scope session and withholds only the retry-owned one", async () => {
    mocks.upsertSessionSlice.mockImplementation(
      (
        _tx: unknown,
        { session }: { session: { externalSessionId: string } }
      ) =>
        session.externalSessionId === OUT_OF_SCOPE_SESSION
          ? sliceOutcome({
              retryRequired: false,
              outcome: MonitoredActivityOutcome.TargetRepositoryOutOfScope,
            })
          : sliceOutcome({
              retryRequired: true,
              outcome: MonitoredActivityOutcome.TargetRetryRequired,
            })
    );

    const result = await upsertSessionsBatch(CONTEXT, {
      sessions: [
        { externalSessionId: OUT_OF_SCOPE_SESSION },
        { externalSessionId: RETRY_OWNED_SESSION },
      ],
      wantsAcceptedSessionIds: true,
    } as never);

    // Both rows COMMITTED; only the retry-owned one is withheld from the ack.
    // Before ISS-9181 both were withheld, and the desktop charged both against
    // its `ack_omitted` budget until they dead-lettered.
    expect(result.persistedSessionIds).toEqual([OUT_OF_SCOPE_SESSION]);
  });

  /**
   * ISS-9182 review r4053480710 adds the third acknowledged cause. The two
   * unfetchable sessions are deliberately a DIFFERENT count from the other
   * two members: equal counts cannot tell three fields apart from three
   * fields wired to the same member, which is the rule the held set below
   * already states.
   */
  it("reports each acknowledged skip on the batch metric under its own field", async () => {
    mocks.upsertSessionSlice.mockImplementation(
      (
        _tx: unknown,
        { session }: { session: { externalSessionId: string } }
      ) => {
        const outcome = ACKNOWLEDGED_OUTCOME_BY_SESSION.get(
          session.externalSessionId
        );
        if (!outcome) {
          throw new Error(
            `No acknowledged skip wired for ${session.externalSessionId}`
          );
        }
        return sliceOutcome({ retryRequired: false, outcome });
      }
    );

    await upsertSessionsBatch(CONTEXT, {
      sessions: [...ACKNOWLEDGED_OUTCOME_BY_SESSION.keys()].map(
        (externalSessionId) => ({ externalSessionId })
      ),
      wantsAcceptedSessionIds: true,
    } as never);

    expect(outcomeEmission()).toMatchObject({
      count: 4,
      targetRepositoryOutOfScopeCount: 1,
      targetIntentionallyAbsentCount: 1,
      // The distinction this field exists for: a PR behind a read the
      // organization cannot perform, never the provider saying it is absent.
      targetRepositoryUnfetchableCount: 2,
      // Narrowed by this change: it counts the retry-owned remainder now, not
      // every unresolved target.
      targetRetryRequiredCount: 0,
      transportTargetSkippedCount: 0,
    });
  });

  it("reports each held disposition under its own field, under one total", async () => {
    mocks.upsertSessionSlice.mockImplementation(
      (
        _tx: unknown,
        { session }: { session: { externalSessionId: string } }
      ) => {
        const outcome = HELD_OUTCOME_BY_SESSION.get(session.externalSessionId);
        if (!outcome) {
          throw new Error(
            `No held disposition wired for ${session.externalSessionId}`
          );
        }
        return heldSliceOutcome(outcome);
      }
    );

    await upsertSessionsBatch(CONTEXT, {
      sessions: HELD_SESSIONS_BY_OUTCOME.flatMap(({ externalSessionIds }) =>
        externalSessionIds.map((externalSessionId) => ({ externalSessionId }))
      ),
      wantsAcceptedSessionIds: true,
    } as never);

    expect(outcomeEmission()).toMatchObject({
      // TEN candidates, not twenty. The breakdown fields re-describe the same
      // ten `targetRetryRequiredCount` already counted, so a `count` that
      // summed every member would double them.
      count: HELD_SESSION_COUNT,
      // Unchanged by the split: a monitor reading the held total still reads
      // every hold.
      targetRetryRequiredCount: HELD_SESSION_COUNT,
      targetAuthorityConflictCount: 1,
      targetNotMaterializedCount: 2,
      targetRepositoryIdentityUnknownCount: 3,
      targetProviderIdentityAmbiguousCount: 4,
      // A hold lands on its own held member and on the total, never on a
      // member the acknowledged-skip population owns.
      targetIntentionallyAbsentCount: 0,
      targetRepositoryUnfetchableCount: 0,
      targetRepositoryOutOfScopeCount: 0,
      transportTargetSkippedCount: 0,
      // ISS-11427: a hold that is still held has not expired. Pinned at zero so
      // the sibling case below is the only thing that can raise it.
      targetHoldExpiredCount: 0,
    });
  });

  it("ISS-11427: reports and WARNs about a hold the ceiling resolved, and acknowledges it", async () => {
    mocks.upsertSessionSlice.mockResolvedValue(
      holdExpiredSliceOutcome(MonitoredActivityOutcome.TargetNotMaterialized)
    );

    const result = await upsertSessionsBatch(CONTEXT, {
      sessions: [{ externalSessionId: "ext-hold-expired" }],
      wantsAcceptedSessionIds: true,
    } as never);

    // The acknowledgement is the point: a resolved hold reaches the echo, so the
    // desktop clears the row instead of burning its `ack_omitted` budget.
    expect(result.persistedSessionIds).toEqual(["ext-hold-expired"]);
    expect(outcomeEmission()).toMatchObject({
      count: 1,
      targetHoldExpiredCount: 1,
      // Still on its classified member, so "classified not-materialized,
      // abandoned at the ceiling" stays readable — and NOT on the held total,
      // which the resolution removed it from.
      targetNotMaterializedCount: 1,
      targetRetryRequiredCount: 0,
    });
    // The operator-visible half. Asserted from the BATCH, not from the reporter:
    // deleting the call site in `emitMonitoredActivityOutcomeCounts` must redden.
    const warned = mocks.logWarn.mock.calls.find(
      ([message]) =>
        message === "Monitored session activity hold reached its ceiling"
    );
    expect(warned?.[1]).toMatchObject({
      computeTargetId: CONTEXT.computeTargetId,
      organizationId: CONTEXT.organizationId,
      holdExpiredCount: 1,
    });
  });
});

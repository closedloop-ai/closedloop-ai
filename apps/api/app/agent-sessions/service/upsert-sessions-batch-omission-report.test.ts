/**
 * ISS-8781: every `externalSessionId` a row-level-ack batch withheld from
 * `acceptedSessionIds` is named, with its cause, in one bounded per-batch report.
 *
 * The obvious test is worthless. Asserting that `acceptedSessionIds` excludes a
 * withheld session passes today and always has — that exclusion is not the
 * defect. The defect is that nothing anywhere said WHICH id or WHY, so an
 * omission could be attributed only by pulling a desktop's local SQLite store.
 *
 * The load-bearing case is therefore the COMPLETENESS INVARIANT: for a
 * row-level-ack batch, every id in `payload.sessions` absent from the echo is
 * named under exactly one cause. It is the only assertion a SIXTH omission path
 * cannot silently escape — a case pinning the five known causes by name would
 * stay green while a new one went unreported, which is exactly how causes 4 and
 * 5 inherited the original silence.
 *
 * Every case drives the REAL `upsertSessionsBatch` and asserts after the call.
 * The clock is scripted from independent literals, so nothing here asserts on
 * real elapsed time.
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
  logDebug: vi.fn(),
  recordObservedRepositories: vi.fn(),
  upsertSessionSlice: vi.fn(),
  stampIngestSyncWatermark: vi.fn(),
  stampIngestWatermarkAfterFailedBatch: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));
vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: mocks.logWarn, debug: mocks.logDebug },
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
  legacyPayload,
  rowLevelAckPayload,
} from "@/__tests__/support/agent-sessions/upsert-sessions-batch.test-fixtures";
import { activityTilingStrippedThrottle } from "./activity-tiling-strip";
import {
  MAX_SAMPLED_IDENTIFIER_BYTES,
  SAMPLED_IDENTIFIER_TRUNCATION_MARKER,
} from "./sampled-identifier";
import {
  MAX_OMITTED_SESSION_IDS_PER_CAUSE,
  SessionOmissionCause,
} from "./session-omission-report";
import { SessionSyncMetric } from "./session-sync-metrics";
import { upsertSessionsBatch } from "./upsert-sessions-batch";
import {
  SessionGateHoldReason,
  type SessionHoldReason,
  WireDataRevisionSkipReason,
} from "./wire-data-revision";

const ORGANIZATION_ID = "org-omission-1";
const COMPUTE_TARGET_ID = "target-omission-1";
const CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: "user-omission-1",
  computeTargetId: COMPUTE_TARGET_ID,
};

/** The one message BOTH levels write; the LEVEL is what splits the population. */
const OMISSION_MESSAGE = "Desktop agent sessions withheld from the ack echo";
/** A reading past any plausible budget, so the check after it always trips. */
const FAR_PAST_BUDGET_MS = 999_999;

/** What the mocked slice does for one session id. */
type SliceBehavior =
  | { kind: "persisted"; observedRepositories?: readonly string[] }
  /** Committed, but an activity target is unresolved: withheld from the echo. */
  | { kind: "retryRequired" }
  | { kind: "held"; reason: SessionHoldReason }
  /**
   * A no-write arm that named NO reason — the shape a sixth omission path would
   * arrive in before anyone taught it to attribute itself.
   */
  | { kind: "unattributed" }
  | { kind: "threw" };

type OmissionBucket = {
  cause: SessionOmissionCause;
  count: number;
  sessionIds: string[];
  sampleTruncated: boolean;
};

/**
 * ONE emission per cause, scalar. The ids are deliberately absent — they ride
 * the log line, because `emitTelemetryMetric` is `JSON.stringify` into a single
 * log line and a nested array cannot be summed per cause by a log-metric
 * generator.
 */
type OmissionEmission = {
  metric: string;
  cause: SessionOmissionCause;
  count: number;
};

/** The report's log payload, whichever level carried it. */
type OmissionLogFields = {
  causes: OmissionBucket[];
  computeTargetId: string;
  organizationId: string;
  withheldCount: number;
};

const SLICE_RESULT_BASE = {
  observedRepositoryFullNames: [],
  indexKeyProjections: 0,
};

function sliceResultFor(behavior: Exclude<SliceBehavior, { kind: "threw" }>) {
  if (behavior.kind === "persisted") {
    return {
      ...SLICE_RESULT_BASE,
      persisted: true,
      retryRequired: false,
      observedRepositoryFullNames: [...(behavior.observedRepositories ?? [])],
    };
  }
  if (behavior.kind === "retryRequired") {
    return { ...SLICE_RESULT_BASE, persisted: true, retryRequired: true };
  }
  if (behavior.kind === "held") {
    return {
      ...SLICE_RESULT_BASE,
      persisted: false,
      retryRequired: false,
      heldRevisionReason: behavior.reason,
    };
  }
  return { ...SLICE_RESULT_BASE, persisted: false, retryRequired: false };
}

/** Drive each session id's slice; anything unnamed simply persists. */
function driveSlices(behaviors: ReadonlyMap<string, SliceBehavior>): void {
  mocks.upsertSessionSlice.mockImplementation(
    (_tx: unknown, input: { session: { externalSessionId: string } }) => {
      const behavior = behaviors.get(input.session.externalSessionId) ?? {
        kind: "persisted" as const,
      };
      if (behavior.kind === "threw") {
        throw new Error(`poison ${input.session.externalSessionId}`);
      }
      return sliceResultFor(behavior);
    }
  );
}

/**
 * A clock that hands back exactly these readings, in order. Exhausting it
 * throws: a case that reads the clock more often than it declared is asserting
 * against a loop it did not describe.
 */
function scriptedClock(readings: readonly number[]): () => number {
  let index = 0;
  return () => {
    const reading = readings[index];
    if (reading === undefined) {
      throw new Error(`scriptedClock exhausted after ${index} readings`);
    }
    index += 1;
    return reading;
  };
}

/** A clock that never defers, for the cases that are not about the budget. */
function steadyClock(sessionCount: number): () => number {
  return scriptedClock(Array.from({ length: sessionCount + 1 }, () => 0));
}

function omissionEmissions(): OmissionEmission[] {
  return mocks.emitTelemetryMetric.mock.calls
    .map((call) => call[0] as OmissionEmission)
    .filter(
      (metric) => metric.metric === SessionSyncMetric.SessionWithheldFromAck
    );
}

function omissionLogFields(sink: typeof mocks.logWarn): OmissionLogFields[] {
  return sink.mock.calls
    .filter((call) => call[0] === OMISSION_MESSAGE)
    .map((call) => call[1] as OmissionLogFields);
}

function warnFields(): OmissionLogFields[] {
  return omissionLogFields(mocks.logWarn);
}

function debugFields(): OmissionLogFields[] {
  return omissionLogFields(mocks.logDebug);
}

/** Every bucket the report named, whichever level carried it. */
function reportedBuckets(): OmissionBucket[] {
  return [...warnFields(), ...debugFields()].flatMap((fields) => fields.causes);
}

function bucketFor(cause: SessionOmissionCause): OmissionBucket | undefined {
  return reportedBuckets().find((bucket) => bucket.cause === cause);
}

function causesAt(fields: OmissionLogFields): SessionOmissionCause[] {
  return fields.causes.map((bucket) => bucket.cause).sort();
}

function sentinelHeldReasons(): unknown[] {
  return mocks.emitTelemetryMetric.mock.calls
    .map((call) => call[0] as { metric: string; reason?: unknown })
    .filter(
      (metric) => metric.metric === SessionSyncMetric.SentinelRevisionHeld
    )
    .map((metric) => metric.reason);
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS, never implementations, and three cases below
  // install a throwing or rejecting one. Re-establishing them here is what keeps
  // those cases from priming every case after them in file order.
  mocks.logWarn.mockImplementation(() => undefined);
  mocks.logDebug.mockImplementation(() => undefined);
  mocks.emitTelemetryMetric.mockImplementation(() => undefined);
  mocks.stampIngestSyncWatermark.mockResolvedValue(undefined);
  activityTilingStrippedThrottle.clear();
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      computeTarget: { findFirst: async () => ({ id: COMPUTE_TARGET_ID }) },
    })
  );
  mocks.withDb.tx.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  driveSlices(new Map());
  mocks.recordObservedRepositories.mockResolvedValue(undefined);
});

/**
 * One batch carrying one session per omission cause, plus a healthy one so the
 * echo is non-empty and the batch is genuinely partial rather than an outage.
 * The deferred tail must be LAST, because the runtime budget stops the loop
 * rather than skipping a session in the middle of it.
 */
const ALL_CAUSES_IDS = [
  "ext-persisted",
  "ext-foreign",
  "ext-held",
  "ext-threw",
  "ext-retry",
  "ext-deferred",
] as const;

function driveAllCauses(): void {
  driveSlices(
    new Map<string, SliceBehavior>([
      [
        "ext-foreign",
        { kind: "held", reason: SessionGateHoldReason.ForeignChunk },
      ],
      [
        "ext-held",
        { kind: "held", reason: WireDataRevisionSkipReason.RevisionPending },
      ],
      ["ext-threw", { kind: "threw" }],
      ["ext-retry", { kind: "retryRequired" }],
    ])
  );
}

/** Start, then four in-budget readings, then one past it — deferring the tail. */
const ALL_CAUSES_CLOCK = [0, 1, 2, 3, 4, FAR_PAST_BUDGET_MS];

describe("upsertSessionsBatch — omission report (ISS-8781)", () => {
  it("names every id the echo withheld, under exactly one cause", async () => {
    driveAllCauses();

    const result = await upsertSessionsBatch(
      CONTEXT,
      rowLevelAckPayload(ALL_CAUSES_IDS),
      { readNowMs: scriptedClock(ALL_CAUSES_CLOCK) }
    );

    // The oracle, stated the way the desktop experiences it: sent minus acked.
    // Derived from the RESULT rather than restated, so a change to the echo
    // moves this expectation with it instead of leaving it stale.
    const withheld = ALL_CAUSES_IDS.filter(
      (id) => !result.persistedSessionIds.includes(id)
    );
    expect(withheld).toHaveLength(5);

    const buckets = reportedBuckets();
    const named = buckets.flatMap((bucket) => bucket.sessionIds);
    // Every withheld id is named...
    expect([...named].sort()).toEqual([...withheld].sort());
    // ...exactly once, so no id is double-attributed and the counts reconcile.
    expect(new Set(named).size).toBe(named.length);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(
      withheld.length
    );
    // The metric half reconciles against the same population, across the two
    // levels the log split it into.
    const emissions = omissionEmissions();
    expect(emissions).toHaveLength(buckets.length);
    expect(emissions.reduce((sum, emission) => sum + emission.count, 0)).toBe(
      withheld.length
    );
  });

  it("gives each withheld id its own cause rather than a shared bucket", async () => {
    driveAllCauses();

    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(ALL_CAUSES_IDS), {
      readNowMs: scriptedClock(ALL_CAUSES_CLOCK),
    });

    const causeById = new Map(
      reportedBuckets().flatMap((bucket) =>
        bucket.sessionIds.map((id) => [id, bucket.cause] as const)
      )
    );
    expect(Object.fromEntries(causeById)).toEqual({
      "ext-foreign": SessionOmissionCause.ForeignChunk,
      "ext-held": SessionOmissionCause.RevisionPending,
      "ext-threw": SessionOmissionCause.SliceThrew,
      "ext-retry": SessionOmissionCause.MonitoredActivityRetryRequired,
      "ext-deferred": SessionOmissionCause.BudgetDeferred,
    });
  });

  /**
   * THE LEVEL SPLIT. Routine holds are not operator-actionable: chunked
   * same-revision snapshots make later slices arrive foreign BY DESIGN
   * (`app/agent-sessions/AGENTS.md`) and `revision_pending` is ordinary desktop
   * behaviour, so one undifferentiated warn made steady-state chunked sync page
   * on every request. A batch carrying both kinds emits BOTH lines, each naming
   * only its own buckets — blended counts would put the routine holds straight
   * back into the warn.
   */
  it("splits the log by cause, warn and debug each carrying only its own", async () => {
    driveAllCauses();

    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(ALL_CAUSES_IDS), {
      readNowMs: scriptedClock(ALL_CAUSES_CLOCK),
    });

    const warn = warnFields();
    expect(warn).toHaveLength(1);
    expect(causesAt(warn[0])).toEqual([
      SessionOmissionCause.MonitoredActivityRetryRequired,
      SessionOmissionCause.SliceThrew,
    ]);
    expect(warn[0].withheldCount).toBe(2);
    expect(warn[0].computeTargetId).toBe(COMPUTE_TARGET_ID);
    expect(warn[0].organizationId).toBe(ORGANIZATION_ID);

    const debug = debugFields();
    expect(debug).toHaveLength(1);
    expect(causesAt(debug[0])).toEqual([
      SessionOmissionCause.BudgetDeferred,
      SessionOmissionCause.ForeignChunk,
      SessionOmissionCause.RevisionPending,
    ]);
    expect(debug[0].withheldCount).toBe(3);
  });

  /**
   * ONE EMISSION PER CAUSE, scalar. `emitTelemetryMetric` is `JSON.stringify`
   * into a single log line, so a nested `causes` array cannot be summed per
   * cause by the PRD-159 log-metric generator this report is waiting on — and
   * the withheld ids are wire-supplied, which is not a metric dimension.
   */
  it("emits a scalar count per cause and keeps the ids off the metric", async () => {
    driveAllCauses();

    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(ALL_CAUSES_IDS), {
      readNowMs: scriptedClock(ALL_CAUSES_CLOCK),
    });

    const emissions = omissionEmissions();
    expect(
      emissions
        .map(({ cause, count }) => ({ cause, count }))
        .sort((left, right) => left.cause.localeCompare(right.cause))
    ).toEqual([
      { cause: SessionOmissionCause.BudgetDeferred, count: 1 },
      { cause: SessionOmissionCause.ForeignChunk, count: 1 },
      { cause: SessionOmissionCause.MonitoredActivityRetryRequired, count: 1 },
      { cause: SessionOmissionCause.RevisionPending, count: 1 },
      { cause: SessionOmissionCause.SliceThrew, count: 1 },
    ]);
    for (const emission of emissions) {
      expect(emission).not.toHaveProperty("causes");
      expect(emission).not.toHaveProperty("sessionIds");
    }
  });

  /**
   * `SentinelRevisionHeld` is a monitoring contract whose docstring defines its
   * population as sentinel and too-new revisions. `foreign_chunk` is a hold and
   * NOT a sentinel, so folding it in would silently change what an existing
   * Datadog query means.
   */
  it("keeps foreign chunks out of the sentinel_revision_held population", async () => {
    driveSlices(
      new Map<string, SliceBehavior>([
        ["ext-0", { kind: "held", reason: SessionGateHoldReason.ForeignChunk }],
        ["ext-1", { kind: "held", reason: SessionGateHoldReason.ForeignChunk }],
      ])
    );

    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(["ext-0", "ext-1"]), {
      readNowMs: steadyClock(2),
    });

    // Not merely "foreign_chunk is absent from the reason field": a batch of
    // NOTHING BUT foreign chunks must not emit the sentinel metric at all.
    expect(sentinelHeldReasons()).toEqual([]);
    // ...while the omission report does name them, so the ids are not lost.
    expect(bucketFor(SessionOmissionCause.ForeignChunk)).toEqual({
      cause: SessionOmissionCause.ForeignChunk,
      count: 2,
      sessionIds: ["ext-0", "ext-1"],
      sampleTruncated: false,
    });
    // A batch of nothing but routine holds never warns — the steady state of a
    // chunked sync, and what the level split exists for.
    expect(warnFields()).toEqual([]);
    expect(debugFields()).toHaveLength(1);
  });

  /**
   * Both gates, each against a fixture where the UNGATED code would emit — a
   * gate test that cannot distinguish the two implementations proves nothing.
   */
  it("reports nothing for a legacy batch, which is acked in full", async () => {
    driveSlices(
      new Map<string, SliceBehavior>([
        ["ext-1", { kind: "held", reason: SessionGateHoldReason.ForeignChunk }],
      ])
    );

    // `ext-1` IS absent from `persistedSessionIds`, so the ungated report would
    // name it. But without `wantsAcceptedSessionIds` the handler answers
    // `{accepted: true}` with no echo and the desktop clears every sent row, so
    // "withheld" describes nothing that happened to this client.
    const result = await upsertSessionsBatch(
      CONTEXT,
      legacyPayload(["ext-0", "ext-1"])
    );

    expect(result.persistedSessionIds).toEqual(["ext-0"]);
    expect(omissionEmissions()).toEqual([]);
    expect(warnFields()).toEqual([]);
    expect(debugFields()).toEqual([]);
  });

  it("reports nothing when every attempted slice threw", async () => {
    driveSlices(
      new Map<string, SliceBehavior>([
        ["ext-0", { kind: "threw" }],
        ["ext-1", { kind: "threw" }],
      ])
    );

    // Every id is absent from the echo, so the ungated report would name both.
    // But the batch rethrows and the handler answers `ingestion_failed`: there
    // is no ack, so there is nothing to have been omitted from.
    await expect(
      upsertSessionsBatch(CONTEXT, rowLevelAckPayload(["ext-0", "ext-1"]), {
        readNowMs: steadyClock(2),
      })
    ).rejects.toThrow("poison ext-0");

    expect(omissionEmissions()).toEqual([]);
    expect(warnFields()).toEqual([]);
    expect(debugFields()).toEqual([]);
  });

  /**
   * THE SECOND GATE'S REAL BOUNDARY (ISS-8781 review). `batchSucceeded` is set
   * while the loop is still unwinding, so a report placed ahead of the watermark
   * stamps described an ack echo the request never sent: a failed stamp makes
   * the handler answer `ingestion_failed` with no `acceptedSessionIds` at all,
   * and the report had already claimed those ids were withheld from it.
   */
  it("reports nothing when the ingest watermark stamp fails", async () => {
    driveSlices(
      new Map<string, SliceBehavior>([["ext-retry", { kind: "retryRequired" }]])
    );
    mocks.stampIngestSyncWatermark.mockRejectedValue(
      new Error("watermark stamp failed")
    );

    await expect(
      upsertSessionsBatch(CONTEXT, rowLevelAckPayload(["ext-0", "ext-retry"]), {
        readNowMs: steadyClock(2),
      })
    ).rejects.toThrow("watermark stamp failed");

    expect(omissionEmissions()).toEqual([]);
    expect(warnFields()).toEqual([]);
    expect(debugFields()).toEqual([]);
  });

  /**
   * BEST-EFFORT, AND GUARDED PER CALL. The report runs from the batch `finally`
   * ahead of the discovery flush and the two degradation reports, so a throwing
   * observability sink must not take them with it — nor may one broken sink
   * suppress the emissions beside it, which is why each call is wrapped on its
   * own rather than the report as a whole.
   */
  it("finishes the batch when its own observability sinks throw", async () => {
    driveSlices(
      new Map<string, SliceBehavior>([
        ["ext-0", { kind: "persisted", observedRepositories: ["acme/api"] }],
        ["ext-retry", { kind: "retryRequired" }],
        [
          "ext-foreign",
          { kind: "held", reason: SessionGateHoldReason.ForeignChunk },
        ],
      ])
    );
    // Scoped to this report's own calls: the emissions ahead of it in the
    // `finally` are NOT guarded, so a blanket throw would fail the batch before
    // the code under test ever ran.
    mocks.logWarn.mockImplementation((message: string) => {
      if (message === OMISSION_MESSAGE) {
        throw new Error("warn sink down");
      }
    });
    mocks.emitTelemetryMetric.mockImplementation(
      (metric: { metric: string; cause?: string }) => {
        if (
          metric.metric === SessionSyncMetric.SessionWithheldFromAck &&
          metric.cause === SessionOmissionCause.MonitoredActivityRetryRequired
        ) {
          throw new Error("metric sink down");
        }
      }
    );

    const result = await upsertSessionsBatch(
      CONTEXT,
      rowLevelAckPayload(["ext-0", "ext-retry", "ext-foreign"]),
      { readNowMs: steadyClock(3) }
    );

    expect(result.persistedSessionIds).toEqual(["ext-0"]);
    // The finalizers BEHIND the report still ran.
    expect(mocks.stampIngestSyncWatermark).toHaveBeenCalledTimes(1);
    expect(mocks.recordObservedRepositories).toHaveBeenCalledTimes(1);
    // The failing warn did not suppress the debug line beside it...
    expect(causesAt(debugFields()[0])).toEqual([
      SessionOmissionCause.ForeignChunk,
    ]);
    // ...nor did the throwing emission suppress the cause behind it. The
    // retry-required bucket is FIRST (payload order), so under a report guarded
    // as a whole — or not guarded at all — the foreign-chunk emission below it
    // is never reached.
    expect(
      omissionEmissions().map(({ cause, count }) => ({ cause, count }))
    ).toEqual([
      { cause: SessionOmissionCause.MonitoredActivityRetryRequired, count: 1 },
      { cause: SessionOmissionCause.ForeignChunk, count: 1 },
    ]);
    // Both failures are surfaced through a DIFFERENT sink from the one that
    // threw, rather than swallowed.
    const guardMessage = "Failed to report withheld desktop agent sessions";
    expect(mocks.logError).toHaveBeenCalledWith(
      guardMessage,
      expect.objectContaining({ step: "warn" })
    );
    expect(mocks.logError).toHaveBeenCalledWith(
      guardMessage,
      expect.objectContaining({
        step: SessionOmissionCause.MonitoredActivityRetryRequired,
      })
    );
  });

  /**
   * THE MUTATION THE PER-CAUSE DESIGN EXISTS TO KILL.
   *
   * A batch-wide cap satisfies the amplification bound identically and passes
   * every other case in this file. It fails only here: 25 routine foreign-chunk
   * skips ahead of the one `retryRequired` id exhaust a shared sample budget, so
   * the single id anyone is actually chasing is evicted and the report says only
   * that it exists.
   */
  it("keeps the retryRequired id named behind a flood of foreign chunks", async () => {
    const foreignChunkIds = Array.from(
      { length: MAX_OMITTED_SESSION_IDS_PER_CAUSE + 5 },
      (_, index) => `ext-fc-${index}`
    );
    const ids = [...foreignChunkIds, "ext-retry"];
    driveSlices(
      new Map<string, SliceBehavior>([
        ...foreignChunkIds.map(
          (id) =>
            [
              id,
              { kind: "held", reason: SessionGateHoldReason.ForeignChunk },
            ] as const
        ),
        ["ext-retry", { kind: "retryRequired" }],
      ])
    );

    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(ids), {
      readNowMs: steadyClock(ids.length),
    });

    // The decisive assertion. Under a batch-wide cap this bucket comes back
    // with an empty `sessionIds` and `sampleTruncated: true`, because the
    // foreign chunks ahead of it in the payload spent the whole budget.
    expect(
      bucketFor(SessionOmissionCause.MonitoredActivityRetryRequired)
    ).toEqual({
      cause: SessionOmissionCause.MonitoredActivityRetryRequired,
      count: 1,
      sessionIds: ["ext-retry"],
      sampleTruncated: false,
    });
  });

  it("counts every omission exactly while sampling only the ids", async () => {
    const overCap = MAX_OMITTED_SESSION_IDS_PER_CAUSE + 5;
    const ids = Array.from({ length: overCap }, (_, index) => `ext-${index}`);
    driveSlices(
      new Map<string, SliceBehavior>(
        ids.map(
          (id) =>
            [
              id,
              {
                kind: "held",
                reason: WireDataRevisionSkipReason.RevisionTooNew,
              },
            ] as const
        )
      )
    );

    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(ids), {
      readNowMs: steadyClock(overCap),
    });

    const bucket = bucketFor(SessionOmissionCause.RevisionTooNew);
    // The count is the whole population; a capped count would understate the
    // defect and read as coverage.
    expect(bucket?.count).toBe(overCap);
    // The metric carries that same exact count, scalar.
    expect(omissionEmissions()).toEqual([
      expect.objectContaining({
        cause: SessionOmissionCause.RevisionTooNew,
        count: overCap,
      }),
    ]);
    expect(bucket?.sessionIds).toHaveLength(MAX_OMITTED_SESSION_IDS_PER_CAUSE);
    // Never handed a partial list that looks whole.
    expect(bucket?.sampleTruncated).toBe(true);
  });

  /**
   * ISS-8881's hazard: `externalSessionId` is wire-supplied as
   * `z.string().trim().min(1)` with no maximum, so the cardinality cap alone
   * bounds no bytes and a corrupt producer re-sends the same payload forever.
   */
  it("truncates and marks an oversized session id", async () => {
    const huge = "s".repeat(MAX_SAMPLED_IDENTIFIER_BYTES * 4);
    driveSlices(
      new Map<string, SliceBehavior>([
        [huge, { kind: "held", reason: SessionGateHoldReason.ForeignChunk }],
      ])
    );

    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload([huge]), {
      readNowMs: steadyClock(1),
    });

    const bucket = bucketFor(SessionOmissionCause.ForeignChunk);
    // Single-byte characters, so the byte ceiling is the character count too.
    // The marker's own bytes are RESERVED from the cap rather than added on top
    // of it, so the emitted id stays inside `MAX_SAMPLED_IDENTIFIER_BYTES`.
    const markerBytes = Buffer.byteLength(
      SAMPLED_IDENTIFIER_TRUNCATION_MARKER,
      "utf8"
    );
    expect(bucket?.sessionIds).toEqual([
      `${"s".repeat(
        MAX_SAMPLED_IDENTIFIER_BYTES - markerBytes
      )}${SAMPLED_IDENTIFIER_TRUNCATION_MARKER}`,
    ]);
  });

  /**
   * The fail-safe, and the whole reason the population is DERIVED rather than
   * accumulated at each known omission site. A no-write arm that names no
   * reason is what a sixth omission path looks like on the day it lands.
   */
  it("reports a withheld id no cause claims rather than dropping it", async () => {
    driveSlices(
      new Map<string, SliceBehavior>([["ext-1", { kind: "unattributed" }]])
    );

    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(["ext-0", "ext-1"]), {
      readNowMs: steadyClock(2),
    });

    expect(bucketFor(SessionOmissionCause.Unattributed)).toEqual({
      cause: SessionOmissionCause.Unattributed,
      count: 1,
      sessionIds: ["ext-1"],
      sampleTruncated: false,
    });
  });

  it("stays silent for a batch that withheld nothing", async () => {
    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(["ext-0", "ext-1"]), {
      readNowMs: steadyClock(2),
    });

    // A zero would turn the metric into a sync-traffic counter.
    expect(omissionEmissions()).toEqual([]);
    expect(warnFields()).toEqual([]);
    expect(debugFields()).toEqual([]);
  });
});

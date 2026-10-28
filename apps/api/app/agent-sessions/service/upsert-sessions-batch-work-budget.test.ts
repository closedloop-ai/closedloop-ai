/**
 * ISS-8186 path 1: `upsertSessionsBatch` opens and awaits one transaction per
 * session, and nothing on either transport bounds the session count — ~10,000
 * minimal sessions fit inside every byte ceiling the route and the socket lane
 * apply. Left unbounded the request outruns the 60 s function ceiling and the
 * desktop's 30 s client timeout, and a client that abandoned the request reads
 * no ack, so the committed prefix is re-sent in full on every retry and nothing
 * ever converges.
 *
 * Every case here drives the REAL `upsertSessionsBatch` and asserts after the
 * call. The clock is scripted rather than measured: the readings are
 * independent literals, so nothing here asserts on real elapsed time and
 * nothing re-derives `SessionIngestWorkBudget.RuntimeMs` from the code it
 * polices.
 *
 * The convergence case is the load-bearing one. A bound that defers a tail and
 * never resumes is a drop, not a bound, so it is not enough to show the loop
 * stops — the tail has to land on a later request, and the union of the two
 * passes has to be the whole batch.
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
  legacyPayload,
  rowLevelAckPayload,
} from "@/__tests__/support/agent-sessions/upsert-sessions-batch.test-fixtures";
import { activityTilingStrippedThrottle } from "./activity-tiling-strip";
import {
  AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS,
  AGENT_SESSION_UPSERT_TX_TIMEOUT_MS,
  SessionIngestWorkBudget,
} from "./ingest-work-budget";
import { SessionSyncMetric } from "./session-sync-metrics";
import { upsertSessionsBatch } from "./upsert-sessions-batch";

const ORGANIZATION_ID = "org-budget-1";
const COMPUTE_TARGET_ID = "target-budget-1";
const CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: "user-budget-1",
  computeTargetId: COMPUTE_TARGET_ID,
};

/** A reading past any plausible budget, so the check after it always trips. */
const FAR_PAST_BUDGET_MS = 999_999;

/**
 * davetho (#6080): elapsed enough that the OLD gate — "has the budget already
 * been exceeded?" — still answers no, while what remains cannot cover a slice.
 * A literal, like every other reading in this file, so the case states the
 * elapsed time it depends on instead of re-deriving it from the constant it
 * polices. Its relationship to the budget is asserted in the case itself.
 */
const JUST_UNDER_BUDGET_MS = 19_900;

/** Elapsed enough to shorten the next slice's deadline without deferring it. */
const MID_BUDGET_MS = 6000;

/** The `withDb.tx` options each slice was actually opened under, in order. */
function sliceTransactionOptions(): Array<{
  maxWait: number;
  timeout: number;
}> {
  return mocks.withDb.tx.mock.calls.map(
    (call) => call[1] as { maxWait: number; timeout: number }
  );
}

function sessionIds(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, index) => `ext-${index + offset}`);
}

/**
 * A clock that hands back exactly these readings, in order.
 *
 * Scripted rather than stepped so each case states the elapsed values it
 * depends on, and so the readings stay independent of the budget constant.
 * Exhausting the script throws: a case that reads the clock more often than it
 * declared is asserting against a loop it did not describe.
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

function persistedIdsFrom(): string[] {
  return mocks.upsertSessionSlice.mock.calls.map(
    (call) =>
      (call[1] as { session: { externalSessionId: string } }).session
        .externalSessionId
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  activityTilingStrippedThrottle.clear();
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      computeTarget: { findFirst: async () => ({ id: COMPUTE_TARGET_ID }) },
    })
  );
  mocks.withDb.tx.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  mocks.upsertSessionSlice.mockImplementation(() => ({
    persisted: true,
    observedRepositoryFullNames: [],
  }));
  mocks.recordObservedRepositories.mockResolvedValue(undefined);
});

describe("upsertSessionsBatch — ingest runtime budget", () => {
  it("stops opening slices once the budget is spent and echoes only what it reached", async () => {
    const result = await upsertSessionsBatch(
      CONTEXT,
      rowLevelAckPayload(sessionIds(10)),
      // Start, then the three in-budget checks, then one past it.
      { readNowMs: scriptedClock([0, 1, 2, FAR_PAST_BUDGET_MS]) }
    );

    // The decisive assertions: the loop stopped, and the ack echo describes
    // exactly the sessions the server actually attempted and persisted. Against
    // the unbounded loop all ten run and both of these fail.
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(3);
    expect(result.persistedSessionIds).toEqual(["ext-0", "ext-1", "ext-2"]);
  });

  it("reports the deferred tail rather than truncating it silently", async () => {
    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(sessionIds(10)), {
      readNowMs: scriptedClock([0, 1, 2, FAR_PAST_BUDGET_MS]),
    });

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.IngestRuntimeBudgetDeferred,
        organizationId: ORGANIZATION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        count: 7,
        attemptedSessionCount: 3,
      })
    );
  });

  it("emits no deferral for a batch that ran to completion", async () => {
    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(sessionIds(4)), {
      readNowMs: scriptedClock([0, 1, 2, 3]),
    });

    // A zero here would read as coverage; the metric describes a tail, and this
    // batch has none.
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.IngestRuntimeBudgetDeferred,
      })
    );
  });

  it("converges: the deferred tail is persisted by the next request", async () => {
    const all = sessionIds(10);
    const first = await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(all), {
      readNowMs: scriptedClock([0, 1, 2, FAR_PAST_BUDGET_MS]),
    });

    // What the desktop's outbox still holds: every id the echo did not confirm.
    const stillQueued = all.filter(
      (id) => !first.persistedSessionIds.includes(id)
    );
    mocks.upsertSessionSlice.mockClear();

    const second = await upsertSessionsBatch(
      CONTEXT,
      rowLevelAckPayload(stillQueued),
      { readNowMs: scriptedClock(stillQueued.map(() => 0)) }
    );

    // A deferral that never resumes is a drop. Two passes, no id sent twice, no
    // id lost: the union is the whole batch.
    expect(persistedIdsFrom()).toEqual(stillQueued);
    expect([
      ...first.persistedSessionIds,
      ...second.persistedSessionIds,
    ]).toEqual(all);
  });

  it("always attempts at least one session, so a request cannot livelock", async () => {
    const result = await upsertSessionsBatch(
      CONTEXT,
      rowLevelAckPayload(sessionIds(10)),
      // The budget is already spent at the very first check.
      { readNowMs: scriptedClock([0, FAR_PAST_BUDGET_MS]) }
    );

    // Strict progress is what makes the remaining set shrink monotonically. A
    // budget that could return zero sessions would defer the same batch forever.
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(1);
    expect(result.persistedSessionIds).toEqual(["ext-0"]);
  });

  it("never defers for a client that cannot express a partial batch", async () => {
    const result = await upsertSessionsBatch(
      CONTEXT,
      legacyPayload(sessionIds(10)),
      // The same exhausted clock the row-level case truncates on. Without the
      // echo, `accepted: true` means "all of it landed", so stopping early
      // would let the desktop clear rows the server never attempted.
      { readNowMs: scriptedClock([0, FAR_PAST_BUDGET_MS]) }
    );

    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(10);
    expect(result.persistedSessionIds).toEqual(sessionIds(10));
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.IngestRuntimeBudgetDeferred,
      })
    );
  });

  it("refuses a slice the remaining deadline cannot cover, not merely one past the budget", async () => {
    const result = await upsertSessionsBatch(
      CONTEXT,
      rowLevelAckPayload(sessionIds(10)),
      // Start, then a reading the OLD gate admitted: the budget is not yet
      // spent, but what is left of it cannot pay for another transaction. The
      // reading is repeated for every remaining session on purpose — a script
      // that ran out would fail this case by exhaustion, and what is under test
      // is how many slices the gate ADMITS, not how often it reads the clock.
      {
        readNowMs: scriptedClock([
          0,
          ...sessionIds(9).map(() => JUST_UNDER_BUDGET_MS),
        ]),
      }
    );

    // The fixture is only discriminating if it really is inside the old gate,
    // so assert that rather than assume it: a reading past the budget would
    // have deferred under either rule and would prove nothing about reserving.
    expect(JUST_UNDER_BUDGET_MS).toBeLessThan(
      SessionIngestWorkBudget.RuntimeMs
    );
    // Admitting a second slice here is what puts the response past the
    // desktop's 30 s abandon, so the committed prefix is re-sent forever.
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(1);
    expect(result.persistedSessionIds).toEqual(["ext-0"]);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.IngestRuntimeBudgetDeferred,
        count: 9,
        attemptedSessionCount: 1,
      })
    );
  });

  it("gives an admitted slice only the deadline the request can still cover", async () => {
    await upsertSessionsBatch(CONTEXT, rowLevelAckPayload(sessionIds(2)), {
      readNowMs: scriptedClock([0, MID_BUDGET_MS]),
    });

    const [first, second] = sliceTransactionOptions();
    // The mandatory first slice is deliberately unclamped — see the budget
    // module for why shortening it trades one non-convergence for a worse one.
    expect(first.timeout).toBe(AGENT_SESSION_UPSERT_TX_TIMEOUT_MS);
    // The invariant davetho asked for, stated end to end: when the second
    // transaction is opened, everything it may still consume — the connection
    // it has yet to acquire plus its own deadline — fits inside the request's
    // allowance. Against the fixed 30 s guardrail this sums to 41 s.
    expect(MID_BUDGET_MS + second.maxWait + second.timeout).toBeLessThanOrEqual(
      SessionIngestWorkBudget.RuntimeMs
    );
    expect(second.timeout).toBeGreaterThan(0);
    expect(second.maxWait).toBe(AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS);
  });

  it("leaves a legacy client's slices on the unclamped guardrail", async () => {
    // The budget does not apply without the row-level echo, so neither does the
    // clamp: a legacy batch keeps today's behaviour exactly, including the
    // deadline each of its transactions runs under.
    await upsertSessionsBatch(CONTEXT, legacyPayload(sessionIds(3)), {
      readNowMs: scriptedClock([0, FAR_PAST_BUDGET_MS]),
    });

    expect(sliceTransactionOptions()).toEqual([
      {
        maxWait: AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS,
        timeout: AGENT_SESSION_UPSERT_TX_TIMEOUT_MS,
      },
      {
        maxWait: AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS,
        timeout: AGENT_SESSION_UPSERT_TX_TIMEOUT_MS,
      },
      {
        maxWait: AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS,
        timeout: AGENT_SESSION_UPSERT_TX_TIMEOUT_MS,
      },
    ]);
  });

  it("rejects a truncated batch whose every ATTEMPTED slice threw", async () => {
    mocks.upsertSessionSlice.mockImplementation(() => {
      throw new Error("slice exploded");
    });

    // Measured against what the request attempted, not against what the payload
    // carried: answering `accepted: true` with an empty echo would make the
    // desktop burn its bounded `ack_omitted` allowance on rows the server is
    // failing outright instead of backing off on `ingestion_failed`.
    await expect(
      upsertSessionsBatch(CONTEXT, rowLevelAckPayload(sessionIds(10)), {
        readNowMs: scriptedClock([0, 1, 2, FAR_PAST_BUDGET_MS]),
      })
    ).rejects.toThrow("slice exploded");
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(3);
  });
});

/**
 * @file sync-freshest-session-lag.test.ts
 * @description ISS-7496 — `sync.freshest_session_lag_ms`: how stale the freshest
 * session the cloud CONFIRMED was at the moment it confirmed it.
 *
 * Every expected lag below is a HAND-WRITTEN literal, never `PINNED_NOW -
 * Date.parse(...)`. Re-deriving the expectation with the implementation's own
 * expression would make the assertion survive the mutations it exists to catch,
 * and the fixture timestamps are chosen so three of those mutations produce a
 * DIFFERENT number rather than merely a different code path: the batch carries
 * an older session (so min-instead-of-max reads 1_800_000), and the fixture's
 * `startedAt` is 12:00:00Z (so startedAt-instead-of-updatedAt reads 1_200_000).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FreshestSessionLagAnomaly,
  resolveFreshestSessionLagMs,
  resolveFreshestUpdatedAtMs,
} from "../src/main/agent-sync/agent-session-freshness-lag.js";
import {
  type AcceptedAckDeps,
  type AcceptedAckInput,
  processAcceptedAck,
} from "../src/main/agent-sync/agent-session-sync-accepted-ack.js";
import {
  DesktopSyncBatchOutcome,
  type SessionSyncBatchEvent,
} from "../src/main/telemetry/app-otel-runtime.js";
import {
  flushAgentSessionSync,
  makeServiceCapturingSyncTelemetry,
  runWithMockedNow,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

/** 2026-06-08T12:20:00.000Z — the moment every ack below is processed. */
const PINNED_NOW_MS = Date.parse("2026-06-08T12:20:00.000Z");
/** 15m30s before {@link PINNED_NOW_MS}. */
const FRESHEST_UPDATED_AT = "2026-06-08T12:04:30.000Z";
/** 30m before {@link PINNED_NOW_MS} — present so max-vs-min is discriminated. */
const STALEST_UPDATED_AT = "2026-06-08T11:50:00.000Z";
/** 15m30s, written out rather than computed from the two constants above. */
const EXPECTED_LAG_MS = 930_000;

describe("resolveFreshestUpdatedAtMs", () => {
  it("returns the NEWEST readable updatedAt on the wire, not the first or the oldest", () => {
    expect(
      resolveFreshestUpdatedAtMs([
        makeSyncedSession("stale", STALEST_UPDATED_AT),
        makeSyncedSession("fresh", FRESHEST_UPDATED_AT),
        makeSyncedSession("middling", "2026-06-08T12:00:30.000Z"),
      ])
    ).toBe(Date.parse(FRESHEST_UPDATED_AT));
  });

  it("skips an unreadable updatedAt rather than letting it poison the batch", () => {
    expect(
      resolveFreshestUpdatedAtMs([
        makeSyncedSession("corrupt", "not-a-timestamp"),
        makeSyncedSession("fresh", FRESHEST_UPDATED_AT),
      ])
    ).toBe(Date.parse(FRESHEST_UPDATED_AT));
  });

  it("returns null when NO session carried a readable updatedAt", () => {
    expect(
      resolveFreshestUpdatedAtMs([
        makeSyncedSession("corrupt", "not-a-timestamp"),
        makeSyncedSession("also-corrupt", ""),
      ])
    ).toBeNull();
  });
});

describe("resolveFreshestSessionLagMs", () => {
  it("measures the lag to the confirmation clock", () => {
    expect(
      resolveFreshestSessionLagMs({
        freshestUpdatedAtMs: Date.parse(FRESHEST_UPDATED_AT),
        confirmedAtMs: PINNED_NOW_MS,
      })
    ).toEqual({ lagMs: EXPECTED_LAG_MS });
  });

  it("reports an unreadable batch instead of substituting a timestamp", () => {
    expect(
      resolveFreshestSessionLagMs({
        freshestUpdatedAtMs: null,
        confirmedAtMs: PINNED_NOW_MS,
      })
    ).toEqual({
      lagMs: null,
      anomaly: FreshestSessionLagAnomaly.UnreadableUpdatedAt,
    });
  });

  it("reports a backward clock step instead of clamping it to a lag of 0", () => {
    expect(
      resolveFreshestSessionLagMs({
        freshestUpdatedAtMs: PINNED_NOW_MS + 60_000,
        confirmedAtMs: PINNED_NOW_MS,
      })
    ).toEqual({
      lagMs: null,
      anomaly: FreshestSessionLagAnomaly.FutureUpdatedAt,
    });
  });

  it("stays silent when the producer measured nothing at all", () => {
    expect(
      resolveFreshestSessionLagMs({
        freshestUpdatedAtMs: undefined,
        confirmedAtMs: PINNED_NOW_MS,
      })
    ).toEqual({ lagMs: null });
  });
});

describe("processAcceptedAck freshness attribute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW_MS);
    return () => {
      vi.useRealTimers();
    };
  });

  it("carries the lag on a batch the server confirmed whole, and raises nothing", async () => {
    const { events, anomalies } = await driveAcceptedAck();

    expect(events).toEqual([
      {
        outcome: DesktopSyncBatchOutcome.Success,
        payloadBytes: 4096,
        latencyMs: 120,
        freshestSessionLagMs: EXPECTED_LAG_MS,
        // ISS-7401: both sent rows reached here through a COMMITTED
        // `clearOutboxDurably`, so both left the outbox.
        durablyClearedRows: 2,
      },
    ]);
    // Pins the `if (anomaly)` guard. Without this, dropping that guard would
    // report `undefined` on every healthy batch — an `error`-severity event with
    // no message, on an install with nothing wrong with it — and every other case
    // in this file would stay green, because they all assert POSITIVELY on an
    // anomaly they expect or return before the reporter is ever reached.
    expect(anomalies).toEqual([]);
  });

  it("omits the lag when the echo confirmed only some of the sent rows", async () => {
    const { events } = await driveAcceptedAck({
      acceptedSessionIds: ["fresh"],
    });

    // Two events: the `ack_omitted` fold for the dropped row, then the Success
    // for the confirmed one. The fold never carries the attribute, so asserting
    // on it would pass under any mutation — the Success is the one under test.
    expect(events).toHaveLength(2);
    expect(successEvent(events)).not.toHaveProperty("freshestSessionLagMs");
  });

  it("omits the lag on a NON-final chunk, whose session is not yet whole upstream", async () => {
    const { events } = await driveAcceptedAck({
      ids: ["fresh"],
      acceptedSessionIds: ["fresh"],
      hasMoreChunks: true,
      remainingChunks: 2,
    });

    expect(events).toEqual([
      {
        outcome: DesktopSyncBatchOutcome.Success,
        payloadBytes: 4096,
        latencyMs: 120,
        // ISS-7401: a non-final chunk spends bytes and dequeues NOTHING — the
        // session only leaves the outbox on its final chunk. Reporting the
        // chunk's acked id here would credit the burn-down with a durable
        // clear that did not happen and suppress a real stall.
        durablyClearedRows: 0,
      },
    ]);
  });

  it("omits the lag and raises the monitored anomaly when no row had a readable timestamp", async () => {
    const { events, anomalies } = await driveAcceptedAck({
      freshestUpdatedAtMs: null,
    });

    expect(anomalies).toEqual([FreshestSessionLagAnomaly.UnreadableUpdatedAt]);
    expect(successEvent(events)).not.toHaveProperty("freshestSessionLagMs");
  });

  it("omits the lag and raises the monitored anomaly when the freshest row is in the future", async () => {
    const { events, anomalies } = await driveAcceptedAck({
      freshestUpdatedAtMs: PINNED_NOW_MS + 60_000,
    });

    expect(anomalies).toEqual([FreshestSessionLagAnomaly.FutureUpdatedAt]);
    expect(successEvent(events)).not.toHaveProperty("freshestSessionLagMs");
  });
});

describe("agent-session sync lane freshness wiring", () => {
  it("emits the real lag of the batch it actually sent (ISS-7496)", async () => {
    const capture: { sync: SessionSyncBatchEvent[] } = { sync: [] };
    const source = new FakeSyncSource([
      makeSyncedSession("fresh", FRESHEST_UPDATED_AT),
      makeSyncedSession("stale", STALEST_UPDATED_AT),
    ]);

    await runWithMockedNow(async () => {
      const service = makeServiceCapturingSyncTelemetry(
        source,
        () => Promise.resolve({ accepted: true as const }),
        capture
      );
      service.start();
      await flushAgentSessionSync();
      await flushAgentSessionSync();
      service.stop();
    }, PINNED_NOW_MS);

    const success = capture.sync.filter(
      (event) => event.outcome === DesktopSyncBatchOutcome.Success
    );
    // Positive control: the lane really ran and really acked, so an absent
    // attribute below would mean the wiring is gone rather than that nothing
    // was sent.
    expect(success).toHaveLength(1);
    expect(success[0]?.freshestSessionLagMs).toBe(EXPECTED_LAG_MS);
  });
});

/**
 * Drive the real accepted-ack path with a whole-batch echo by default, so each
 * case above overrides exactly the one input it is about.
 */
async function driveAcceptedAck(
  overrides: Partial<AcceptedAckInput> = {}
): Promise<{ events: SessionSyncBatchEvent[]; anomalies: string[] }> {
  const events: SessionSyncBatchEvent[] = [];
  const anomalies: string[] = [];
  const input: AcceptedAckInput = {
    syncMode: "incremental",
    ids: ["fresh", "stale"],
    sessionCount: 2,
    payloadBytes: 4096,
    latencyMs: 120,
    hasMoreChunks: false,
    remainingChunks: null,
    acceptedSessionIds: ["fresh", "stale"],
    freshestUpdatedAtMs: Date.parse(FRESHEST_UPDATED_AT),
    ...overrides,
  };
  await processAcceptedAck(input, {
    ...acceptedAckDeps(),
    emitTelemetry: (event) => events.push(event),
    reportFreshnessAnomaly: (anomaly) => anomalies.push(anomaly),
  });
  return { events, anomalies };
}

/** The inert half of the ack deps: everything this suite does not assert on. */
function acceptedAckDeps(): AcceptedAckDeps {
  return {
    rowState: {
      timeoutCountById: new Map(),
      rateLimitedCountById: new Map(),
      unknownAckReasonCountById: new Map(),
      ingestionFailedCountById: new Map(),
      laneStalledSinceMsById: new Map(),
      validationFailedCountById: new Map(),
      ackOmittedCountById: new Map(),
      validationBisectIds: new Set(),
      transportErrorCountById: new Map(),
      clearTransportTimeoutBudgetFor: () => undefined,
      nextRetryAfterMs: new Map(),
      deadLetterCountById: new Map(),
      chunkValidationCycleById: new Map(),
      ackOmittedCycleById: new Map(),
      deadLetteredIds: new Map(),
    },
    // ISS-7957: models a store in which every acked id still HAD a row, which
    // is what `deleteMany` would report for these fixtures. The absent-row
    // case — where the count and the ack length diverge — is the subject of
    // `agent-session-outbox-cleared-rows.test.ts`.
    clearOutboxDurably: (ids) =>
      Promise.resolve({ cleared: true, deletedRowCount: ids.length }),
    sourceStateGeneration: () => 0,
    isStarted: () => true,
    // ISS-8116: these bags exercise ack folding, not identity; the pass-level
    // switch has its own suite (agent-session-sync-pass-identity-guards).
    isCurrentSourceIdentity: () => true,
    dequeue: () => undefined,
    clearLaneGiveUp: () => undefined,
    persistCursorIfCaughtUp: () => undefined,
    applyBoundedFold: () => undefined,
    deadLetteredCount: () => 0,
    resetDeadLetterRevisitAfterDrainedAck: () => undefined,
    queueSizes: () => ({ incremental: 0, backfill: 0 }),
    discardPendingChunkTail: () => undefined,
    schedulePendingPartDrain: () => undefined,
    scheduleImmediateDrainIfReadyWorkRemains: () => undefined,
    emitTelemetry: () => undefined,
    logInfo: () => undefined,
    logError: () => undefined,
  };
}

/**
 * The Success event, which is the only one this suite's negative assertions may
 * target: an `ack_omitted` fold event never carries the attribute, so asserting
 * its absence there would stay green under every mutation.
 */
function successEvent(events: SessionSyncBatchEvent[]): SessionSyncBatchEvent {
  const success = events.filter(
    (event) => event.outcome === DesktopSyncBatchOutcome.Success
  );
  if (success.length !== 1) {
    throw new Error(
      `expected exactly one Success batch event, got ${success.length} of ${events.length}`
    );
  }
  return success[0];
}

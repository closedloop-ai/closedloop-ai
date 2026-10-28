/**
 * @file sync-tiling-strip-delivery-visibility.test.ts
 * @description ISS-7265 — a session DELIVERED without its activity tiling must
 * say so, and one that never had a tiling must not.
 *
 * PR #5456 made the strip visible on a FAILED attempt only. Success is the path
 * that commits the durable outbox clear and dequeues the session, so success is
 * where a stripped tiling becomes a permanent loss — and it emitted nothing at
 * all. This suite pins the delivery arm.
 *
 * EVERY POSITIVE CASE HERE HAS A NEGATIVE SIBLING, on purpose. "A stripped
 * delivery is marked" is satisfied by an implementation that marks every
 * delivery, so each assertion that the attributes ARE present is paired with one
 * that they are ABSENT for a batch that legitimately carried no tiling, and the
 * two fail independently. The absence assertions use whole-object `toEqual`
 * rather than `not.toHaveProperty`, so an attribute that appears with a value of
 * `0` or `whole` fails them too — a `0` strip count and a `whole` shaping are
 * the exact reassuring lies this ticket exists to remove.
 */
import { SyncPayloadShaping } from "@closedloop-ai/telemetry-contract/sync";
import { DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES } from "@repo/api/src/types/agent-session-sync-limits";
import { describe, expect, it } from "vitest";
import {
  type AcceptedAckDeps,
  type AcceptedAckInput,
  processAcceptedAck,
} from "../src/main/agent-sync/agent-session-sync-accepted-ack.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  prepareAgentSessionPayload,
  tilingStrippedSessionIds,
} from "../src/main/agent-sync/agent-session-sync-payload.js";
import {
  DesktopSyncBatchOutcome,
  type SessionSyncBatchEvent,
} from "../src/main/telemetry/app-otel-runtime.js";
import {
  leakedSyncTelemetryKeys,
  makeServiceWithIdentity,
  makeSessionWithLargeTiling,
  settleSelfContinuedDrain,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

/**
 * Enough events that a tiling-stripped session still cannot fit one request, so
 * the bounded fallback has to chunk what survives.
 */
const EVENTS_FORCING_A_SPLIT = 3000;

/** The lane fixture needs an identified compute target to reach caught-up. */
const COMPUTE_TARGET_ID = "compute-target-iss7265";

/** The cost fields every Success event in this suite carries, unchanged. */
const DELIVERY_COST = { payloadBytes: 4096, latencyMs: 120 };

/**
 * ISS-7401: the ack's own cleared-row count. Present in these shapes only
 * because the events are asserted WHOLE — the pin is exhaustive on purpose, so
 * a field arriving on the session event has to be accounted for here rather
 * than slipping in unnoticed. Every case below acks exactly one id on a FINAL
 * chunk; the non-final case reports `0` and says so at its own site.
 */
const CLEARED_ONE_ROW = { durablyClearedRows: 1 };

describe("tilingStrippedSessionIds", () => {
  it("names the stripped sessions in the id space the ack echo speaks", () => {
    expect(
      tilingStrippedSessionIds([
        makeSyncedSession("clean", "2026-06-08T12:00:00.000Z"),
        {
          ...makeSyncedSession("stripped", "2026-06-08T12:00:00.000Z"),
          activitySegmentRowsStripped: true,
        },
      ])
    ).toEqual(["stripped"]);
  });
});

describe("processAcceptedAck tiling-strip attributes", () => {
  it("reports the strip on a delivery the server confirmed", async () => {
    const events = await driveAcceptedAck({
      tilingStrippedSessionIds: ["stripped"],
    });

    expect(events).toEqual([
      {
        outcome: DesktopSyncBatchOutcome.Success,
        ...DELIVERY_COST,
        ...CLEARED_ONE_ROW,
        payloadShaping: SyncPayloadShaping.TilingStripped,
        tilingStrippedSessionCount: 1,
      },
    ]);
  });

  it("stays silent for a delivery that legitimately carried no tiling", async () => {
    // THE SIBLING of the case above. Without it, marking every delivery as
    // stripped would pass this suite; with it, that mutation fails here and the
    // case above still passes, so the two are independent.
    const events = await driveAcceptedAck({ tilingStrippedSessionIds: [] });

    expect(events).toEqual([
      {
        outcome: DesktopSyncBatchOutcome.Success,
        ...DELIVERY_COST,
        ...CLEARED_ONE_ROW,
      },
    ]);
  });

  it("stays silent for a caller that measured nothing at all", async () => {
    // Old-desktop skew inside the process: a caller that predates the measure
    // passes no ids. Absent must mean "not measured", never "none stripped" and
    // never "complete".
    const events = await driveAcceptedAck({
      tilingStrippedSessionIds: undefined,
    });

    expect(events).toEqual([
      {
        outcome: DesktopSyncBatchOutcome.Success,
        ...DELIVERY_COST,
        ...CLEARED_ONE_ROW,
      },
    ]);
  });

  it("counts the stripped rows the server CONFIRMED, not the ones that were sent", async () => {
    // The discriminating case. Both sent sessions shipped stripped; the echo
    // confirmed one. Reporting the SENT count would read 2 and claim a loss for
    // a row that is still queued and will re-send its tiling in full.
    const events = await driveAcceptedAck({
      ids: ["stripped", "also-stripped"],
      acceptedSessionIds: ["stripped"],
      tilingStrippedSessionIds: ["stripped", "also-stripped"],
    });

    expect(successEvent(events).tilingStrippedSessionCount).toBe(1);
  });

  it("omits the strip when the echo confirmed none of the stripped rows", async () => {
    const events = await driveAcceptedAck({
      ids: ["clean", "stripped"],
      acceptedSessionIds: ["clean"],
      tilingStrippedSessionIds: ["stripped"],
    });

    // The omitted row produces an `ack_omitted` fold event alongside the
    // Success. That fold never carries these attributes, so the Success is the
    // only event a negative assertion may target.
    expect(events).toHaveLength(2);
    expect(successEvent(events)).toEqual({
      outcome: DesktopSyncBatchOutcome.Success,
      ...DELIVERY_COST,
      ...CLEARED_ONE_ROW,
    });
  });

  it("defers the strip to the FINAL chunk rather than repeating it per chunk", async () => {
    const nonFinal = await driveAcceptedAck({
      ids: ["stripped"],
      acceptedSessionIds: ["stripped"],
      tilingStrippedSessionIds: ["stripped"],
      hasMoreChunks: true,
      remainingChunks: 2,
    });
    // A non-final chunk has dequeued nothing, so no loss has happened yet — and
    // counting each chunk would report one stripped session three times.
    expect(nonFinal).toEqual([
      {
        outcome: DesktopSyncBatchOutcome.Success,
        ...DELIVERY_COST,
        // ISS-7401: a non-final chunk dequeued nothing, so it reports a MEASURED
        // zero rather than the one id it acked — the same reason the strip is
        // deferred to the final chunk.
        durablyClearedRows: 0,
      },
    ]);

    const final = await driveAcceptedAck({
      ids: ["stripped"],
      acceptedSessionIds: ["stripped"],
      tilingStrippedSessionIds: ["stripped"],
      hasMoreChunks: false,
    });
    // The paired positive: the same session on its LAST chunk does report. Both
    // halves must be here, or "always silent" would satisfy the first alone.
    expect(successEvent(final).tilingStrippedSessionCount).toBe(1);
  });

  it("carries no session id or content out to telemetry", async () => {
    const events = await driveAcceptedAck({
      tilingStrippedSessionIds: ["stripped"],
    });

    expect(leakedSyncTelemetryKeys(events)).toEqual([]);
  });
});

describe("a stripped session that must ALSO chunk", () => {
  it("stamps the strip on EVERY part, which is why the report is final-chunk-gated", () => {
    // The compound shape: the tiling cannot ride the base against a server that
    // will not merge parts, AND the surviving events still overflow one request,
    // so the bounded fallback strips and then chunks. `baseFor` spreads the
    // session into every part, so the flag rides all of them.
    const prepared = prepareAgentSessionPayload(
      makeStrippedSessionThatMustAlsoChunk("stripped-and-chunked"),
      DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES,
      undefined,
      undefined,
      /* activityChunkingSupported */ false
    );
    if (prepared.kind !== "chunked") {
      throw new Error(`expected a chunked fallback, got ${prepared.kind}`);
    }
    const parts = [prepared.firstChunk, ...prepared.remainingChunks];

    // Positive control: this really did split, so the count below is about
    // repetition across parts and not about a single-part delivery.
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.activitySegmentRowsStripped).toBe(true);
      expect(part.activitySegmentRows).toBeUndefined();
    }
    // ONE lost tiling, N parts claiming it. This is the arithmetic the
    // accepted-ack path's final-chunk gate exists to stop: without it the
    // monitored count would read `parts.length` for a single degraded session,
    // inflating the one number an ISS-7265 ruling depends on.
    expect(tilingStrippedSessionIds(parts)).toHaveLength(parts.length);
  });
});

describe("agent-session sync lane tiling-strip delivery wiring", () => {
  it("reports the strip of the batch it actually delivered", async () => {
    const { success } = await runSyncLane([
      makeSessionWithLargeTiling("big-tiling"),
    ]);

    // Positive control: the lane really ran and really acked, so an absent
    // attribute below means the wiring is gone rather than that nothing shipped.
    expect(success.length).toBeGreaterThan(0);
    const delivered = success.at(-1);
    expect(delivered?.tilingStrippedSessionCount).toBe(1);
    expect(delivered?.payloadShaping).toBe(SyncPayloadShaping.TilingStripped);
  });

  it("reports nothing for a lane whose sessions never had a tiling", async () => {
    // THE WIRING-LEVEL SIBLING. The service passes ids read off the payload it
    // sent; a producer that stamped the strip unconditionally would fail here
    // and pass the case above.
    const { success } = await runSyncLane([
      makeSyncedSession("no-tiling", "2026-06-08T12:00:00.000Z"),
    ]);

    expect(success.length).toBeGreaterThan(0);
    for (const event of success) {
      expect(event).not.toHaveProperty("tilingStrippedSessionCount");
      expect(event).not.toHaveProperty("payloadShaping");
    }
  });
});

/**
 * A session that forces BOTH halves of the bounded fallback: a tiling too large
 * to ride the base against a server that cannot merge multi-part tilings, and
 * enough surviving events that the tiling-stripped remainder still has to chunk.
 */
function makeStrippedSessionThatMustAlsoChunk(id: string): SyncedAgentSession {
  return {
    ...makeSessionWithLargeTiling(id),
    events: Array.from({ length: EVENTS_FORCING_A_SPLIT }, (_, index) => ({
      externalEventId: `${id}-event-${index}`,
      eventType: "ToolUse",
      toolName: "Read",
      createdAt: "2026-06-08T12:00:00.000Z",
    })),
  };
}

/** Drive the real sync lane end to end against an always-accepting server. */
async function runSyncLane(
  sessions: ConstructorParameters<typeof FakeSyncSource>[0]
): Promise<{ success: SessionSyncBatchEvent[] }> {
  const capture: { sync: SessionSyncBatchEvent[] } = { sync: [] };
  const source = new FakeSyncSource(sessions);
  // The IDENTITY-bearing fixture, because `settleSelfContinuedDrain` waits on
  // the service's own caught-up signal and a lane with no compute target never
  // identifies, so it can never report caught-up. Same transport and same
  // telemetry sink as before; only the target id is added.
  const service = makeServiceWithIdentity(
    source,
    () => Promise.resolve({ accepted: true as const }),
    COMPUTE_TARGET_ID,
    capture
  );
  service.start();
  try {
    // FEA-4375 / ISS-4705 (whitlockk, #5741): the self-continuing drain reschedules
    // itself in the TIMERS phase, which `flushAgentSessionSync` does not pump —
    // so the fixed check-phase tick loop this replaced was a disguised
    // wall-clock race that could stop before the lane emitted its final Success
    // under load. `settleSelfContinuedDrain` pumps both phases and THROWS
    // instead of falling through onto a stale snapshot.
    await settleSelfContinuedDrain(service);
  } finally {
    // In a `finally` so a drain that never settles still stops its service
    // rather than leaking a running lane into the next test's timers.
    service.stop();
  }
  return {
    success: capture.sync.filter(
      (event) => event.outcome === DesktopSyncBatchOutcome.Success
    ),
  };
}

/**
 * Drive the real accepted-ack path with a whole-batch echo by default, so each
 * case above overrides exactly the one input it is about.
 */
async function driveAcceptedAck(
  overrides: Partial<AcceptedAckInput> = {}
): Promise<SessionSyncBatchEvent[]> {
  const events: SessionSyncBatchEvent[] = [];
  const ids = overrides.ids ?? ["stripped"];
  const input: AcceptedAckInput = {
    syncMode: "incremental",
    sessionCount: ids.length,
    hasMoreChunks: false,
    remainingChunks: null,
    acceptedSessionIds: ids,
    ...DELIVERY_COST,
    ...overrides,
    ids,
  };
  await processAcceptedAck(input, {
    ...acceptedAckDeps(),
    emitTelemetry: (event) => events.push(event),
  });
  return events;
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
 * The Success event, which is the only one a negative assertion may target: an
 * `ack_omitted` fold event never carries these attributes, so asserting their
 * absence there would stay green under every mutation.
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

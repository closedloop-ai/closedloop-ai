// ISS-4758: shared fixtures/builders for `agent-session-sync-service.test.ts`.
// Split out of that file so it stops growing — it is on the biome shrink-only
// grandfather list, and the root AGENTS.md requires a substantive edit to leave
// such a file smaller. Mirrors the existing `fake-sync-source.ts` /
// `agent-session-sync-component-test-utils.ts` split; behavior is unchanged.
import { MAX_SYNCED_ACTIVITY_SEGMENTS } from "@repo/api/src/types/agent-session";
import {
  MAX_CONSECUTIVE_TRANSPORT_ERRORS,
  MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS,
  MAX_CONSECUTIVE_VALIDATION_FAILED,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type {
  AgentSessionSyncTransportPayload,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { DesktopAgentSessionsAck } from "../src/main/cloud/cloud-protocol.js";
import type { DesktopSyncBatchEventInput } from "../src/main/telemetry/app-otel-runtime.js";
import { LANE_STALL_MAX_RETRY_MS } from "../src/shared/lane-stall-clock.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

/**
 * Run `body` with `Date.now` pinned to a mutable virtual clock, restoring the
 * real `Date.now` afterward even if `body` throws. The sync service reads
 * `Date.now` for per-session backoff scheduling but drives flushing with real
 * timers/promises, so we mock only the clock (not the timer queue) and advance
 * it explicitly via the `advance(ms)` passed to `body`. The owned try/finally
 * cleanup keeps the global mutation from leaking across tests on failure.
 */
export async function runWithMockedNow(
  body: (clock: { advance: (ms: number) => void }) => Promise<void>,
  /**
   * ISS-7496: pin the virtual clock's ORIGIN, not just its motion. A suite that
   * asserts a duration computed against `Date.now()` needs a hand-written
   * expected value, and it cannot have one while the origin is whatever the wall
   * clock said. Defaults to the real clock so every existing caller is
   * unaffected.
   */
  startMs?: number
): Promise<void> {
  const realNow = Date.now;
  let virtualNow = startMs ?? realNow();
  Date.now = () => virtualNow;
  try {
    await body({
      advance: (ms) => {
        virtualNow += ms;
      },
    });
  } finally {
    Date.now = realNow;
  }
}

export class ResettingSyncSource extends FakeSyncSource {
  onLoad: () => void = () => undefined;

  override loadSyncedSessions(ids: string[]) {
    this.onLoad();
    return super.loadSyncedSessions(ids);
  }
}

/**
 * FEA-2718: still exposes the retired raw-event-`data` "unhydratable" gate (which
 * `AgentSessionSyncSource` no longer declares) so a test can prove the sync path
 * never consults it. Flags every candidate as unhydratable — if the gate were
 * still wired up, every session would be dead-lettered.
 */
export class UnhydratableFlaggingSyncSource extends FakeSyncSource {
  findLocallyUnhydratableCallCount = 0;

  findLocallyUnhydratableSessions(ids: string[], _maxBytes: number) {
    this.findLocallyUnhydratableCallCount += 1;
    return ids.map((id) => ({ id, payloadBytes: Number.MAX_SAFE_INTEGER }));
  }
}

export function makeService(
  source: AgentSessionSyncSource,
  // Goal stage 2: typed against the real ack union so a test can return the
  // `acceptedSessionIds` echo without re-declaring the contract here.
  sendBatch: (
    batch: AgentSessionSyncTransportPayload
  ) => Promise<DesktopAgentSessionsAck>
) {
  return new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    sendBatch,
  });
}

export function makeServiceCapturingSyncTelemetry(
  source: AgentSessionSyncSource,
  sendBatch: AgentSessionSyncServiceOptions["sendBatch"],
  capture: {
    sync: DesktopSyncBatchEventInput[];
    batchOutcome?: AgentSessionSyncServiceOptions["onBatchOutcome"];
  }
) {
  return new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    sendBatch,
    onSyncBatchTelemetry: (event) => {
      capture.sync.push(event);
    },
    onBatchOutcome: capture.batchOutcome,
  });
}

export function makeServiceWithIdentity(
  source: AgentSessionSyncSource,
  sendBatch: (
    batch: AgentSessionSyncTransportPayload
  ) => Promise<DesktopAgentSessionsAck>,
  computeTargetId: string,
  /**
   * Goal stage 2: optional sync-batch telemetry sink. The identity-bearing
   * fixture previously dropped telemetry on the floor, so the ack-path reasons
   * (`ack_clear_failed`, `ack_omitted`) could not be asserted by any suite that
   * needed a durable, identity-keyed outbox.
   */
  capture?: { sync: DesktopSyncBatchEventInput[] },
  /**
   * ISS-6031 follow-up: the signed-in account. Omitted by default so every
   * existing suite keeps the pre-adoption behavior (a null identity skips the
   * retired-target sweep outright).
   */
  identity?: { organizationId: string; userId: string }
) {
  return new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => computeTargetId,
    ...(identity ? { getSyncIdentity: () => identity } : {}),
    sendBatch,
    ...(capture
      ? {
          onSyncBatchTelemetry: (event: DesktopSyncBatchEventInput) => {
            capture.sync.push(event);
          },
        }
      : {}),
  });
}

/**
 * FEA-3287: an idle ("phantom") session — no turns, no tokens, no tool-use — the
 * desktop live-hook mints on `SessionStart` before any real activity. The sync
 * service must DEFER (withhold) it from cloud upload without dead-lettering it.
 */
export function makeIdleSession(
  id: string,
  updatedAt: string
): SyncedAgentSession {
  return {
    externalSessionId: id,
    status: "active",
    harness: "codex",
    cwd: `/workspace/${id}`,
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt,
    agents: [],
    // A SessionStart-only session carries a SessionStart event with NO tool name.
    events: [
      {
        externalEventId: `${id}-session-start`,
        eventType: "SessionStart",
        createdAt: "2026-06-08T12:00:00.000Z",
      },
    ],
    tokenUsageByModel: [],
  };
}

export function makeOversizedSession(id: string): SyncedAgentSession {
  // FEA-2718: turn text (`data`) is stripped before sync, so a session is only
  // oversized by its RETAINED columnar fields — here, a very large event array
  // whose slim per-event metadata still overflows the byte cap and must chunk.
  const events = Array.from({ length: 4000 }, (_, index) => ({
    externalEventId: `${id}-event-${index}`,
    eventType: "ToolUse",
    toolName: "Read",
    createdAt: "2026-06-08T12:00:00.000Z",
  }));
  return makeSyncedSession(id, "2026-06-08T12:00:00.000Z", events);
}

/**
 * ISS-4578: a session whose activity-segment tiling is large enough to force the
 * activity chunker to paginate it across parts (more than the per-chunk row cap
 * MAX_SYNCED_ACTIVITY_SEGMENTS), so a mid-tick activity-chunking downgrade has a
 * split tiling to defer. Each segment is a disjoint [startMs, endMs) span.
 */
export function makeSessionWithLargeTiling(id: string): SyncedAgentSession {
  const segmentCount = MAX_SYNCED_ACTIVITY_SEGMENTS + 1000;
  return {
    ...makeSyncedSession(id, "2026-06-08T12:00:00.000Z", [
      {
        externalEventId: `${id}-event`,
        eventType: "ToolUse",
        toolName: "Read",
        createdAt: "2026-06-08T12:00:00.000Z",
      },
    ]),
    dataRevision: 1,
    activitySegmentRows: Array.from({ length: segmentCount }, (_, index) => ({
      phase: "implement",
      startMs: index * 10,
      endMs: index * 10 + 10,
      confidence: 1,
      evidenceLayers: ["structural"],
      version: 4,
      workItemRef: null,
      subagentId: null,
    })),
  };
}

export function makeUnchunkableOversizedSession(
  id: string,
  updatedAt: string
): SyncedAgentSession {
  // FEA-2718: chunking paginates the event array but replicates every agent into
  // each chunk, so a session whose agents alone exceed the cap can never produce
  // a valid chunk and is dead-lettered locally.
  return {
    ...makeSyncedSession(id, updatedAt, [
      {
        externalEventId: `${id}-event`,
        eventType: "ToolUse",
        toolName: "Read",
        createdAt: "2026-06-08T12:00:00.000Z",
      },
    ]),
    agents: Array.from({ length: 5000 }, (_, index) => ({
      externalAgentId: `${id}-agent-${index}`,
      name: `agent-${index}`,
      type: "subagent",
      status: "completed",
    })),
  };
}

export function makeMetadataHeavyChunkCandidate(
  id: string
): SyncedAgentSession {
  return {
    ...makeSyncedSession(
      id,
      "2026-06-08T12:00:00.000Z",
      Array.from({ length: 506 }, (_, index) => ({
        externalEventId: `${id}-event-${index}`,
        eventType: "ToolUse",
        toolName: "Read",
        createdAt: "2026-06-08T12:00:00.000Z",
        data: { index, safePayload: "x".repeat(500) },
      }))
    ),
    metadata: {
      messages: Array.from({ length: 506 }, (_, index) => ({
        role: index % 2 === 0 ? "human" : "assistant",
        timestamp: "2026-06-08T12:00:00.000Z",
        text: "x".repeat(1000),
        model: "gpt-5",
      })),
      tokenSeries: Array.from({ length: 506 }, (_, index) => ({
        timestamp: "2026-06-08T12:00:00.000Z",
        model: "gpt-5",
        input: index,
        output: index,
        extra: "x".repeat(500),
      })),
    },
  };
}

export async function flushAgentSessionSync(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * FEA-4375 / ISS-4705: advance ONE turn of the self-continuing drain, pumping
 * BOTH event-loop phases the drain depends on — the `setImmediate` (check)
 * phase the service's awaits flush through, AND the `setTimeout(0)` (timers)
 * phase the self-continue reschedule actually lives in
 * (`SyncPollTimers.scheduleDrain`).
 *
 * Pumping only `setImmediate` is NOT equivalent and is the flake that reddened
 * the `desktop` gate: `setTimeout(…, 0)` is clamped to >= 1ms, so a check-phase-
 * only spin burns an unbounded, machine- and load-dependent number of turns per
 * drain tick (measured: ~15 turns/batch on an idle dev machine, ~100 on the CI
 * runner). A turn budget denominated in those turns is really a disguised
 * wall-clock race, so a healthy drain can exhaust it and report a false wedge.
 * Yielding the timers phase every turn makes one turn cost at most one drain
 * tick on any machine, which is what makes a turn bound mean what it says.
 */
export async function pumpSyncDrainTurn(): Promise<void> {
  await flushAgentSessionSync();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * FEA-4375: pump event-loop turns until the self-continuing drain settles the
 * queue to caught-up, via {@link pumpSyncDrainTurn} so the chained ticks make
 * progress deterministically. THROWS if it never settles within a generous
 * bound — a silent fall-through onto a stale snapshot is the FEA-2399 flake the
 * desktop test:node guard forbids.
 */
export async function settleSelfContinuedDrain(
  service: AgentSessionSyncService,
  maxTurns = 200
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (service.getSyncProgress().caughtUp) {
      return;
    }
    await pumpSyncDrainTurn();
  }
  throw new Error(
    `self-continued drain never reached caught-up after ${maxTurns} turns ` +
      `(last progress: ${JSON.stringify(service.getSyncProgress())})`
  );
}

const SYNC_TELEMETRY_ALLOWED_KEYS = new Set([
  "outcome",
  "payloadBytes",
  "latencyMs",
  // FEA-3426: the closed failure/dead-letter reason enum (never ids/content).
  "reason",
  // ISS-8589: the closed five-member lane enum, the same class as `reason`. It
  // reached this guard only once the session lane's failure seam started naming
  // its own lane instead of leaving the composition to re-stamp it downstream —
  // a lane id is never interpolated from a variable, so it can carry no id and
  // no content. A SESSION ID still trips this guard.
  "lane",
  // ISS-7248 widened what a FAILED attempt reports, and only by things of the
  // same class this guard exists to permit: `batchId` is the client-generated
  // UUID the request body already carries (the server-join key), `sessionCount`
  // and `attempt` are counts, and `payloadShaping` is a closed enum. A SESSION
  // ID still trips this guard, which is the leak it was written to catch.
  "batchId",
  "sessionCount",
  "attempt",
  "payloadShaping",
  // ISS-7265 added one more of that same class: how many sessions in the failed
  // batch shipped without their activity tiling. A count floored at 0 by
  // `safeCount` and omitted entirely when absent — it names no session and
  // carries no transcript text, so permitting it does not widen what this guard
  // rejects. A SESSION ID still trips it.
  "tilingStrippedSessionCount",
  // ISS-7496: a DURATION, the same class again — whole milliseconds between the
  // freshest confirmed session's `updatedAt` and the ack that confirmed it. It
  // is derived from a timestamp and never carries one: the absolute time, the
  // session it came from, and its id are all unrecoverable from the difference.
  // A SESSION ID still trips this guard.
  "freshestSessionLagMs",
  // ISS-7401: a COUNT of the outbox ids one ack asked to drop — the same class
  // again, and the safest member of it: `buildSyncBatchAttributes` projects an
  // explicit key list, so unlike every entry above this one never becomes a
  // `sync.*` span attribute at all. It rides `SessionSyncBatchEvent` only to
  // reach the ISS-5387 burn-down tee. It names no session, carries no
  // transcript text, and is derived from `ackedIds.length` rather than from the
  // ids. A SESSION ID still trips this guard.
  "durablyClearedRows",
]);

/**
 * Returns any emitted `sync.*` attribute keys outside the transport-health
 * allowlist. Callers assert on the returned array inside their own `test()` so
 * the assertion is not misplaced in a helper (Biome `noMisplacedAssertion`).
 */
export function leakedSyncTelemetryKeys(
  events: DesktopSyncBatchEventInput[]
): string[] {
  return events
    .flatMap((event) => Object.keys(event))
    .filter((key) => !SYNC_TELEMETRY_ALLOWED_KEYS.has(key));
}

/** ms a bounded event wait allows before it reports the event never arrived. */
const EVENT_WAIT_TIMEOUT_MS = 5000;

/**
 * Await a fixture event with an EXPLICIT bound, so a missing event fails with
 * what was being waited for instead of riding the runner's whole-test timeout.
 */
export async function awaitEvent(
  promise: Promise<void>,
  what: string
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}`)),
          EVENT_WAIT_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Settle a STALE continuation — one whose pass is no longer the published
 * `sessionSyncPromise`, so `whenSessionSyncSettled()` cannot see it.
 *
 * Two steps, and neither is a turn count. First a real fixture event proving the
 * parked read actually resumed. Then ONE macrotask boundary, which is a barrier
 * rather than a guess: from that resume to the durable write under test, every
 * step is a microtask (the fake source is synchronous throughout), and a
 * `setImmediate` callback runs only after the microtask queue has fully drained.
 * A second boundary would add nothing, which is the test that tells a barrier
 * apart from a guess.
 */
export async function awaitStaleContinuation(
  resumed: Promise<void>,
  what: string
): Promise<void> {
  await awaitEvent(resumed, what);
  await flushAgentSessionSync();
}

/**
 * How many rounds put a retry FAR past every per-reason dead-letter budget, so a
 * rejection class that burned ANY counter would strand the row mid-loop: a
 * dead-lettered id defers for `DEAD_LETTER_RETRY_AFTER_MS` (24h), far beyond the
 * 30s advances these suites make, and the attempt count would stop short.
 *
 * Shared, not copied: `agent-session-sync-service.test.ts` pins the fold from
 * the ack side and `session-sync-composed-offline-post.test.ts` from the
 * composed-lane side, and two hand-maintained sums of the same budgets drift —
 * whoever edits one has no reason to look at the other, and the stale copy stays
 * green while no longer meaning "past every budget".
 *
 * ISS-7730 dropped the `ingestion_failed` term and ISS-8605 dropped the
 * `ack_timeout` and `rate_limited` terms: none of those classes HAS a
 * consecutive-failure budget any more, so summing one in would be inventing a
 * number. What remains is every surviving per-row budget on this lane.
 */
export const ROUNDS_PAST_EVERY_FAILURE_BUDGET =
  MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS +
  MAX_CONSECUTIVE_TRANSPORT_ERRORS +
  MAX_CONSECUTIVE_VALIDATION_FAILED;

/**
 * ISS-8610: how far a test must advance the virtual clock to clear ONE rung of
 * the session lane's environmental ladder, whichever rung it is on.
 *
 * The 401/403/no-target defers used to be a flat 30s, so a test advanced by that
 * constant. They now stage off the run's own age, and the rung a given round
 * lands on is a function of how long the run has been open — so a test that
 * wants "one more attempt" advances past the ladder's per-delay CAP rather than
 * re-deriving the schedule, which would make it a second implementation of the
 * thing under test.
 *
 * Well inside the 24h give-up for any realistic round count: 13 rounds (the
 * value above) is ~13 hours.
 */
export const PAST_ANY_LANE_ENVIRONMENTAL_RUNG_MS = LANE_STALL_MAX_RETRY_MS + 1;

// ISS-4758: shared fixtures/builders for `agent-session-sync-service.test.ts`.
// Split out of that file so it stops growing — it is on the biome shrink-only
// grandfather list, and the root AGENTS.md requires a substantive edit to leave
// such a file smaller. Mirrors the existing `fake-sync-source.ts` /
// `agent-session-sync-component-test-utils.ts` split; behavior is unchanged.
import { MAX_SYNCED_ACTIVITY_SEGMENTS } from "@repo/api/src/types/agent-session";
import type {
  AgentSessionSyncTransportPayload,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { DesktopAgentSessionsAck } from "../src/main/cloud/cloud-protocol.js";
import type { DesktopSyncBatchEventInput } from "../src/main/telemetry/app-otel-runtime.js";
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
  body: (clock: { advance: (ms: number) => void }) => Promise<void>
): Promise<void> {
  const realNow = Date.now;
  let virtualNow = realNow();
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
  capture?: { sync: DesktopSyncBatchEventInput[] }
) {
  return new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => computeTargetId,
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

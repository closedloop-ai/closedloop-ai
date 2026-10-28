/**
 * @file agent-session-sync-service-fixture.ts
 * @description The scaffolding every service-level agent-session-sync suite
 * needs to drive a REAL `AgentSessionSyncService` and read back what reached the
 * cloud.
 *
 * Extracted when ISS-8594's fail-closed suite copied it verbatim out of
 * `db-host-reply-boundary-resume-wiring.test.ts`: two files disagreeing about
 * what "the pass settled" means is how one of them starts asserting against an
 * idle lane. Root AGENTS.md asks for the shared fixture at the second
 * occurrence, and this is it.
 *
 * Deliberately NOT here: each suite's scripted source subclass. They skew
 * different db-host ops (`loadPendingOutboxIds` vs
 * `loadPendingSessionOutboxEngineState`), so folding them into one generic fixture would
 * hide the op each suite is actually about behind a type parameter.
 */
import type {
  AgentSessionSyncBatch,
  AgentSessionSyncTransportPayload,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import { Observability } from "../src/main/telemetry/observability.js";
import type { TelemetryEventPayload } from "../src/main/telemetry/telemetry-protocol.js";
import type { FakeSyncSource } from "./fake-sync-source.js";

/** One microtask turn plus one macrotask turn. */
export async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * codex (#6041): the REAL pass-completion signal, not a guessed number of
 * event-loop turns that a slower worker — or one more `await` added to the pass
 * — can outrun. `start()` and `refresh()` both reach `syncSessionsOnce`, which
 * publishes `sessionSyncPromise` SYNCHRONOUSLY before they return, so the await
 * below settles the pass they just kicked rather than returning on an idle lane.
 * The trailing turn plus re-await covers a pass that self-continued while the
 * first await was outstanding.
 */
export async function settle(service: AgentSessionSyncService): Promise<void> {
  await service.whenSessionSyncSettled();
  await flush();
  await service.whenSessionSyncSettled();
}

/** A service that accepts every batch and records what it was handed. */
export function makeAcceptingService(
  source: FakeSyncSource,
  sent: AgentSessionSyncBatch[],
  computeTargetId: string
): AgentSessionSyncService {
  const sendBatch = (
    batch: AgentSessionSyncTransportPayload
  ): Promise<
    | { accepted: true }
    | { accepted: false; reason: DesktopAgentSessionsAckReason }
  > => {
    sent.push(batch);
    return Promise.resolve({ accepted: true });
  };
  return new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => computeTargetId,
    sendBatch,
  });
}

/** Every session id that reached the transport, in send order. */
export function sentIds(sent: AgentSessionSyncBatch[]): string[] {
  return sent.flatMap((batch) =>
    batch.sessions.map((session) => session.externalSessionId)
  );
}

/**
 * Capture the telemetry lane. The caller restores the static in `afterEach` —
 * unconditionally, not at the end of the case, so a failing assertion between
 * the two cannot leak the stub into every later test in the worker.
 */
export function armTelemetry(): {
  events: TelemetryEventPayload[];
  restore: () => void;
} {
  const events: TelemetryEventPayload[] = [];
  const original = Observability.getTelemetryEmitter;
  Observability.getTelemetryEmitter = () => ({
    emit: (event: TelemetryEventPayload) => {
      events.push(event);
    },
  });
  return {
    events,
    restore: () => {
      Observability.getTelemetryEmitter = original;
    },
  };
}

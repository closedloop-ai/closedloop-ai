/**
 * @file agent-session-sync-lane-stall-fixtures.ts
 * @description Shared fixtures for the session lane's ENVIRONMENTAL fold suites.
 *
 * Split out of `agent-session-sync-lane-stall-fold.test.ts` by ISS-8610, which
 * added the staged-schedule cases and pushed that file past the 1,000-line
 * ceiling. Same split, and the same reason, as
 * `agent-session-sync-service-fixtures.ts`.
 *
 * That ONE suite is the consumer today. The gate-level suite
 * (`agent-session-lane-environmental-gate.test.ts`) deliberately does not import
 * these: it drives the real service through the service fixtures rather than the
 * fold in isolation, so it needs a running lane and not a recording dep.
 */

import type { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { SessionLaneRun } from "../src/main/agent-sync/agent-session-lane-run.js";
import type { SessionFoldRunnerView } from "../src/main/agent-sync/agent-session-sync-fold-runners.js";
import {
  applyLaneStallFold,
  type LaneStallFoldDeps,
  SessionEnvironmentalDeferClass,
} from "../src/main/agent-sync/agent-session-sync-lane-stall-fold.js";

/**
 * The pinned ORIGIN every case measures against. A wall-clock bound is exactly
 * where a real-clock assertion would be worthless, and the ceiling arithmetic
 * needs a hand-written expected instant to compare against.
 */
export const NOW_MS = Date.parse("2026-08-20T00:00:00.000Z");

export const ORIGIN_ISO = new Date(NOW_MS).toISOString();

export type DeadLetterCall = {
  id: string;
  recoverable: boolean;
  reason: string;
  attemptCount: number;
};

export type StallWrite = {
  id: string;
  attemptCount: number;
  nextAttemptAtMs: number;
  reason: string;
  laneStalledSince: string;
};

/**
 * ISS-8605: how the durable stall write behaves for a case. `refuseFirst`
 * models the db-host rejecting (or never committing) the FIRST attempt for an
 * id, which is the shape whitlockk's review names — the write the whole 24h bound
 * rides on being lost with nobody waiting on it.
 */
export type StallWriteBehaviour = {
  refuseFirst?: boolean;
  refuseAll?: boolean;
};

export type RecordingLaneStallDeps = {
  deps: LaneStallFoldDeps;
  cleared: string[];
  deadLettered: DeadLetterCall[];
  dequeued: string[];
  stallWrites: StallWrite[];
  committedStallWrites: StallWrite[];
  /**
   * PLN-2028: every LANE give-up this fold noted, with the CAUSE it recorded
   * beside it — a stamp with no reason is what a resumed give-up cannot explain.
   */
  giveUpStamps: Array<{ gaveUpAtMs: number; reason: SyncReason }>;
  warnings: string[];
  infos: string[];
};

export function makeRecordingDeps(
  behaviour: StallWriteBehaviour = {}
): RecordingLaneStallDeps {
  const cleared: string[] = [];
  const deadLettered: DeadLetterCall[] = [];
  const dequeued: string[] = [];
  const stallWrites: StallWrite[] = [];
  const committedStallWrites: StallWrite[] = [];
  const giveUpStamps: Array<{ gaveUpAtMs: number; reason: SyncReason }> = [];
  const refusedOnce = new Set<string>();
  const warnings: string[] = [];
  const infos: string[] = [];
  const deps: LaneStallFoldDeps = {
    nextRetryAfterMs: new Map<string, number>(),
    clearFailureStateForId: (id) => cleared.push(id),
    markDeadLettered: (id, recoverable, reason, attemptCount) =>
      deadLettered.push({ id, recoverable, reason, attemptCount }),
    dequeue: (_syncMode, ids) => dequeued.push(...ids),
    // Commits on a later TASK, not a microtask: a fold that merely became
    // `async` without awaiting this write would still drain the microtask queue
    // before its own promise settled, and the "did it wait for the commit?"
    // assertion would pass against a fold that waited for nothing.
    recordOutboxStall: async (write) => {
      stallWrites.push(write);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (behaviour.refuseAll) {
        return false;
      }
      if (behaviour.refuseFirst && !refusedOnce.has(write.id)) {
        refusedOnce.add(write.id);
        return false;
      }
      committedStallWrites.push(write);
      return true;
    },
    noteLaneGiveUp: (gaveUpAtMs, reason) =>
      giveUpStamps.push({ gaveUpAtMs, reason }),
    queueSizes: () => ({ incremental: 0, backfill: 0, deadLettered: 0 }),
    logWarn: (message) => warnings.push(message),
    logInfo: (message) => infos.push(message),
    formatBytes: (bytes) => `${bytes} B`,
  };
  return {
    deps,
    cleared,
    deadLettered,
    dequeued,
    stallWrites,
    committedStallWrites,
    giveUpStamps,
    warnings,
    infos,
  };
}

/** An inert view; each test overrides only the members it asserts on. */
export function foldRunnerViewStub(): SessionFoldRunnerView {
  return {
    sourceKey: () => "stub-source",
    laneRun: inertSessionLaneRun(),
    nextRetryAfterMs: new Map<string, number>(),
    rateLimitedCountById: new Map<string, number>(),
    timeoutCountById: new Map<string, number>(),
    unknownAckReasonCountById: new Map<string, number>(),
    ingestionFailedCountById: new Map<string, number>(),
    laneStalledSinceMsById: new Map<string, number>(),
    validationFailedCountById: new Map<string, number>(),
    chunkValidationCycleById: new Map<string, number>(),
    validationBisectIds: new Set<string>(),
    clearFailureStateForId: () => undefined,
    markDeadLettered: () => undefined,
    dequeue: () => undefined,
    recordOutboxRetry: () => undefined,
    recordOutboxStall: () => Promise.resolve(true),
    clearOutboxLaneStall: () => undefined,
    queueSizes: () => ({ incremental: 0, backfill: 0, deadLettered: 0 }),
    logWarn: () => undefined,
    logInfo: () => undefined,
  };
}

/**
 * A {@link SessionLaneRun} wired to nothing, for the view stub above.
 *
 * A real one rather than a hand-rolled double: its identity and change-detection
 * are what the fold runners drive, and a stub that accepted every call would let
 * a wiring change go unnoticed. With no source there is no durable write to make,
 * so it records and writes nothing.
 */
function inertSessionLaneRun(): SessionLaneRun {
  return new SessionLaneRun({
    readSourceKey: () => "stub-source",
    getSource: () => null,
    onWriteFailed: () => undefined,
    onRunDefect: () => undefined,
  });
}

export function foldOnce(
  deps: LaneStallFoldDeps,
  attemptsById: Map<string, number>,
  stalledSinceMsById: Map<string, number>,
  ids: string[] = ["s1"],
  deferClass: SessionEnvironmentalDeferClass = SessionEnvironmentalDeferClass.IngestionFailed,
  retryAfterMs?: number
): Promise<void> {
  return applyLaneStallFold(
    {
      ids,
      syncMode: AgentSessionSyncMode.Backfill,
      payloadBytes: 100,
      deferClass,
      attemptsById,
      stalledSinceMsById,
      retryAfterMs,
    },
    deps
  );
}

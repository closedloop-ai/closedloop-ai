/**
 * @file sync-burndown-reporter-harness.ts
 * @description ISS-5387 — the fake store, logger, and stall sink every
 * `SyncBurndownReporter` suite drives the reporter through.
 *
 * Shared rather than duplicated: the reporter's stall suites live in
 * `sync-burndown-reporter-stalls.test.ts` and the rest in
 * `sync-burndown-reporter.test.ts`, and a second copy of this fixture would let
 * the two drift onto different notions of a healthy sample.
 */
import type { SessionCursorBoundary } from "../src/main/agent-sync/agent-session-sync-cursor-prefix.js";
import type {
  SyncBurndownQuery,
  SyncBurndownStoreSample,
} from "../src/main/database/sync-burndown-store.js";
import {
  type SyncBurndownLogLevel,
  SyncBurndownReporter,
} from "../src/main/sync/sync-burndown-reporter.js";
import type { SyncLaneStallReport } from "../src/main/sync/sync-burndown-stall-detectors.js";
import {
  type SyncBurndownSnapshot,
  type SyncLaneId,
  SyncLaneRemainderBasis,
} from "../src/shared/sync-burndown-contract.js";

export const TEMPLATE_KEY = "agent_component_invocations";
export const SESSION_KEY = "agent_sessions:ct-1";
export const COMPONENT_KEY = "agent_components:v3:ct-1";

export type LoggedLine = { level: SyncBurndownLogLevel; message: string };

export function emptySample(): SyncBurndownStoreSample {
  return {
    sessionOutbox: {
      // ISS-10082: `emptySample()` is a lane that LOOKED and found nothing, which
      // is what almost every suite here means. A suite exercising the unread case
      // sets `Unqueried` explicitly.
      remainderBasis: SyncLaneRemainderBasis.Counted,
      pending: 0,
      readyPending: 0,
      deadLettered: 0,
      withheld: 0,
      oldestPendingSinceIso: null,
      unmeasuredRows: 0,
      parkedPending: 0,
    },
    invocationOutbox: {
      remainderBasis: SyncLaneRemainderBasis.Counted,
      pending: 0,
      readyPending: 0,
      deadLettered: 0,
      withheld: 0,
      oldestPendingSinceIso: null,
      unmeasuredRows: 0,
      pendingSessions: 0,
      pendingParts: 0,
      pendingPayloadBytes: 0,
      pendingTemplateSessions: 0,
      pendingTemplateSessionsTruncated: false,
    },
    transcript: {
      inFlightFiles: 0,
      strandedIdleFiles: 0,
      deadFiles: 0,
      bytesRemaining: 0,
      oldestInFlightUpdatedAtIso: null,
      unmeasuredRows: 0,
    },
    componentInventory: {
      rowsRemaining: 0,
      deadLetteredCount: 0,
      remainderBasis: SyncLaneRemainderBasis.Counted,
    },
    cursorsBySourceKey: {},
  };
}

export type Harness = {
  reporter: SyncBurndownReporter;
  lines: LoggedLine[];
  stalls: SyncLaneStallReport[];
  queries: SyncBurndownQuery[];
  readCount: () => number;
  setSample: (sample: SyncBurndownStoreSample) => void;
  setRunning: (running: boolean) => void;
  setComputeTargetId: (computeTargetId: string | null) => void;
  /**
   * ISS-9744: drop the lane source keys, as an unpaired or offline install has
   * them. The store short-circuits its scoped reads on a null key, so this is
   * how a suite reaches the counts that were never actually measured.
   */
  setSourceKeys: (keys: {
    session?: string | null;
    invocation?: string | null;
    component?: string | null;
  }) => void;
  setConsented: (consented: boolean) => void;
  setConsentedLanes: (predicate: (lane: SyncLaneId) => boolean) => void;
};

export function buildHarness(
  options: {
    running?: boolean;
    sample?: SyncBurndownStoreSample;
    consented?: boolean;
    /** ISS-8768: per-lane consent, for the lanes whose axes differ. */
    consentedLanes?: (lane: SyncLaneId) => boolean;
    /**
     * ISS-8768: override the sample cadence the gate-shut WARN log's hourly
     * throttle computes against, so a throttle-window test does not need
     * dozens of `sampleOnce()` passes at the real 60s default.
     */
    intervalMs?: number;
    /**
     * ISS-9246: the telemetry promotion sink. Passed through rather than given
     * its own fixture so the gauge suite drives the SAME reporter the log suites
     * do - a second harness is how the two would come to disagree about what a
     * sample contains.
     */
    onSample?: (snapshot: SyncBurndownSnapshot) => void;
    /** ISS-10429: the session service's in-memory cursor boundary. */
    readSessionCursorBoundary?: () => SessionCursorBoundary | null;
  } = {}
): Harness {
  const lines: LoggedLine[] = [];
  const stalls: SyncLaneStallReport[] = [];
  const queries: SyncBurndownQuery[] = [];
  let sample = options.sample ?? emptySample();
  let running = options.running ?? true;
  let consentedLanes: (lane: SyncLaneId) => boolean =
    options.consentedLanes ?? (() => options.consented ?? true);
  let computeTargetId: string | null = "ct-1";
  let sessionSourceKey: string | null = SESSION_KEY;
  let invocationSourceKey: string | null = `${TEMPLATE_KEY}:ct-1`;
  let componentSourceKey: string | null = COMPONENT_KEY;
  let reads = 0;
  const reporter = new SyncBurndownReporter({
    getSource: () => ({
      readSyncBurndown: (query) => {
        reads += 1;
        queries.push(query);
        return Promise.resolve(sample);
      },
    }),
    getSessionSourceKey: () => sessionSourceKey,
    getInvocationSourceKey: () => invocationSourceKey,
    invocationTemplateSourceKey: TEMPLATE_KEY,
    getComponentSourceKey: () => componentSourceKey,
    getTranscriptComputeTargetId: () => computeTargetId,
    getIdentity: () => null,
    readSessionCursorBoundary: options.readSessionCursorBoundary,
    isSessionLaneRunning: () => running,
    isInvocationLaneRunning: () => running,
    isTranscriptLaneRunning: () => running,
    isComponentLaneRunning: () => running,
    isLaneDeliveryConsented: (lane) => consentedLanes(lane),
    log: (level, message) => {
      lines.push({ level, message });
    },
    onLaneStall: (report) => {
      stalls.push(report);
    },
    onSample: options.onSample,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    intervalMs: options.intervalMs,
  });
  return {
    reporter,
    lines,
    stalls,
    queries,
    readCount: () => reads,
    setSample: (next) => {
      sample = next;
    },
    setRunning: (next) => {
      running = next;
    },
    setComputeTargetId: (next) => {
      computeTargetId = next;
    },
    setSourceKeys: (keys) => {
      if ("session" in keys) {
        sessionSourceKey = keys.session ?? null;
      }
      if ("invocation" in keys) {
        invocationSourceKey = keys.invocation ?? null;
      }
      if ("component" in keys) {
        componentSourceKey = keys.component ?? null;
      }
    },
    setConsented: (next) => {
      consentedLanes = () => next;
    },
    setConsentedLanes: (next) => {
      consentedLanes = next;
    },
  };
}

export function messages(lines: LoggedLine[]): string {
  return lines.map((line) => line.message).join("\n");
}

/**
 * ISS-7401: the session outbox at a steady state where enqueue matches drain.
 * Depth is FLAT across both samples and the watermark is parked, which is what
 * `persistCursorIfCaughtUp` does by design while any row is queued.
 */
export function refillingSessionOutboxSample(
  pending: number,
  oldestPendingSinceIso = "2026-08-06T11:00:00.000Z"
): SyncBurndownStoreSample {
  const sample = emptySample();
  sample.sessionOutbox.pending = pending;
  sample.sessionOutbox.readyPending = pending;
  sample.sessionOutbox.oldestPendingSinceIso = oldestPendingSinceIso;
  sample.cursorsBySourceKey = {
    [SESSION_KEY]: {
      sourceKey: SESSION_KEY,
      observedTopUpdatedAt: "2026-08-06T09:00:00.000Z",
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: [],
      updatedAt: "2026-08-06T09:00:01.000Z",
      dataRevision: 89,
    },
  };
  return sample;
}

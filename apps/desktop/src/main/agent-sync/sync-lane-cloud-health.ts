/**
 * @file sync-lane-cloud-health.ts
 * @description ISS-6338 (PRD-650) — per-lane cloud batch health for the
 * desktop→cloud sync lanes.
 *
 * ## The gap this closes
 *
 * Before this module exactly ONE lane reported to the cloud whether its batches
 * were landing: the session-metadata lane, through the single
 * `appOtelRuntime.emitSyncBatchEvent` call site in
 * `desktop-sync-lane-composition.ts`. Lanes 2–5 (invocation parts, component
 * inventory, transcript archive, trace comments) emitted nothing at all, so a
 * customer whose transcript archive silently stopped uploading was invisible:
 * their local rows piled up, their lane logged its own failures to a file nobody
 * reads, and every cloud-side signal stayed quiet.
 *
 * ## Why these events and not the stall alert
 *
 * The stall alert (`sync.durable_cursor.stalled`, ISS-5387) rides
 * `Observability.getTelemetryEmitter()` — the AUTHENTICATED `POST
 * /desktop/telemetry` lane, gated on `isHttpReady()` in
 * `cloud/observability-lane-router.ts`. `emitSyncBatchEvent` does not: it hands
 * a span to the OTel SDK, whose `BatchSpanProcessor` exports through
 * `createRelayOtlpExporters` onto the KEYLESS Socket.IO `/telemetry` relay leg.
 * That pipe carries no Bearer token, so it survives exactly the auth loss and
 * cloud unreachability a sync-health signal exists to report. Putting lane 2–5
 * coverage here rather than on the stall path is the whole point.
 *
 * ## What may cross the wire
 *
 * Counts, sizes, durations, and CLOSED enum values only — a lane id is never
 * interpolated from a variable and a reason is never free text, so this cannot
 * carry a session id, a file path, a comment body, or a credential. Every
 * per-lane mapper below folds its lane's own vocabulary onto the shared
 * {@link SyncReason} through an exhaustive `Record`, so a reason added to a
 * vocabulary THIS build declares fails `tsc` rather than reaching the wire
 * unmapped. That guard is compile-time only, and several of these reasons
 * arrive over the wire from a cloud that may be newer — so every fold that
 * reads an external value also has a runtime fallback to a generic reason,
 * because a `failure` span with no cause at all is worse than an imprecise one.
 * `SyncTelemetrySchema.parse` in the runtime is the last line: it rejects the
 * whole record rather than shipping an out-of-contract value.
 *
 * Reason vocabularies are folded, never MERGED: `part_conflict` keeps its own
 * spelling rather than collapsing into `validation_failed`, because collapsing
 * them destroys the distinction an incident is actually debugged on
 * (`main/sync/AGENTS.md`, "No merged status vocabularies").
 */

import { SyncLane, SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { AgentComponentInvocationSyncRejectReason } from "@repo/api/src/types/agent-component-invocation";
import { DesktopAgentComponentInvocationSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { clampNonNegativeCount } from "@repo/api/src/utils/math";
import type { AgentComponentInvocationSyncClientResult } from "../dashboard/desktop-agent-component-invocations-client.js";
import {
  type DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../telemetry/app-otel-runtime.js";
import { ComponentSyncSendOutcome } from "./agent-component-sync-dead-letter.js";

/**
 * A batch event that has NAMED its lane. `lane` is optional on the runtime input
 * so a version-skewed reader tolerates records from a build that predates this
 * ticket; it is required here so a NEW producer cannot forget it.
 */
export type SyncLaneBatchEvent = DesktopSyncBatchEventInput & {
  lane: SyncLane;
};

/** The emit seam every lane is wired to; absent where no telemetry runtime exists. */
export type SyncLaneBatchEmit = (event: SyncLaneBatchEvent) => void;

/**
 * The invocation-parts lane's server rejection reasons, folded onto the shared
 * enum. Exhaustive by type: a new `AgentComponentInvocationSyncRejectReason`
 * fails typecheck here rather than reaching the wire unmapped.
 */
const INVOCATION_REJECT_SYNC_REASON: Record<
  AgentComponentInvocationSyncRejectReason,
  SyncReason
> = {
  [AgentComponentInvocationSyncRejectReason.ProtocolUnsupported]:
    SyncReason.ProtocolUnsupported,
  [AgentComponentInvocationSyncRejectReason.SessionMissing]:
    SyncReason.SessionMissing,
  [AgentComponentInvocationSyncRejectReason.ValidationFailed]:
    SyncReason.ValidationFailed,
  [AgentComponentInvocationSyncRejectReason.PartConflict]:
    SyncReason.PartConflict,
  [AgentComponentInvocationSyncRejectReason.GenerationConflict]:
    SyncReason.GenerationConflict,
  [AgentComponentInvocationSyncRejectReason.IngestionFailed]:
    SyncReason.IngestionFailed,
  [AgentComponentInvocationSyncRejectReason.RateLimited]:
    SyncReason.RateLimited,
};

/**
 * HTTP statuses folded onto the shared reason enum.
 *
 * A `Map`, not an object literal: the key is a server-supplied status, and a
 * plain `{}` lookup on an unvalidated key is the prototype-pollution shape the
 * repo bans for dispatch tables.
 */
const HTTP_STATUS_SYNC_REASON = new Map<number, SyncReason>([
  [400, SyncReason.ValidationFailed],
  [401, SyncReason.Unauthenticated],
  [403, SyncReason.TargetNotOwned],
  [404, SyncReason.SessionMissing],
  [408, SyncReason.AckTimeout],
  [409, SyncReason.UploadConflict],
  [413, SyncReason.LocallyOversized],
  [422, SyncReason.ValidationFailed],
  [429, SyncReason.RateLimited],
]);

/**
 * Fold an HTTP status onto the shared reason enum.
 *
 * An unrecognised status degrades by CLASS rather than being dropped: 5xx is the
 * server failing to ingest, any other unmapped code is treated as a lane-wide
 * transport problem. Never guess a row-attributable reason from a code this
 * build has not seen — that is what would dead-letter healthy rows if the value
 * were ever read back as blame.
 */
export function syncReasonForHttpStatus(
  status: number | undefined
): SyncReason {
  if (status === undefined) {
    return SyncReason.TransportError;
  }
  const mapped = HTTP_STATUS_SYNC_REASON.get(status);
  if (mapped) {
    return mapped;
  }
  return status >= 500 ? SyncReason.IngestionFailed : SyncReason.TransportError;
}

/**
 * Lane 2 (invocation parts): fold one `syncPart` result into a batch event.
 *
 * `unavailable` is the lane's "could not deliver" arm (no credential, no compute
 * target, a 501, or a `protocol_unsupported` ack) and is deliberately reported
 * as lane-wide `transport_unavailable` rather than as a batch rejection —
 * mis-blaming the part is precisely what invariant 4 in `main/sync/AGENTS.md`
 * forbids. A 404 `retry` reports the same way: the route emits no 404 of its
 * own, so one means the route is missing, and the shared 404 fold would name it
 * `session_missing` — this lane's in-band reject for a parent not yet in the cloud.
 */
export function invocationPartBatchEvent(
  result: AgentComponentInvocationSyncClientResult
): SyncLaneBatchEvent {
  if (result.kind === "unavailable") {
    return {
      lane: SyncLane.InvocationParts,
      outcome: DesktopSyncBatchOutcome.Failure,
      reason: SyncReason.TransportUnavailable,
    };
  }
  if (result.kind === "retry") {
    return {
      lane: SyncLane.InvocationParts,
      outcome: DesktopSyncBatchOutcome.Failure,
      reason: invocationRetrySyncReason(result.status, result.forbiddenCode),
    };
  }
  if (result.ack.accepted) {
    return {
      lane: SyncLane.InvocationParts,
      outcome: DesktopSyncBatchOutcome.Success,
    };
  }
  return {
    lane: SyncLane.InvocationParts,
    outcome: DesktopSyncBatchOutcome.Failure,
    // The `Record` is exhaustive over the reasons THIS build declares, which is
    // a compile-time guarantee only. `reason` still arrives over the wire, so a
    // newer cloud returning a reason this build has never heard of must degrade
    // to a generic rather than ship a `failure` span with no cause at all.
    // `ingestion_failed` is the least-wrong generic: the server rejected the
    // part, which is what happened, without inventing a blame class.
    reason:
      INVOCATION_REJECT_SYNC_REASON[result.ack.reason] ??
      SyncReason.IngestionFailed,
  };
}

/**
 * Lane 1 (session metadata): name the lane on the session lane's own batch
 * event, and carry the DLQ depth when that event is the dead-letter arm.
 *
 * ISS-11427: `deadLetteredCount` was emitted by no lane-1 arm at all, so
 * `@sync.dead_lettered_count` — the one sync measure ISS-7497 certifies as
 * unbiased, because the dead-letter span is ERROR and retained whole — was
 * unpopulated on the only lane that was actually abandoning sessions. The 457
 * dead-letter spans in the 14 days to 2026-09-28 were all `session_metadata`,
 * and nothing on the wire said how many SESSIONS they stood for.
 *
 * Attached ONLY on the dead-letter arm, the same rule and for the same reason as
 * {@link componentInventoryBatchEvent}: the value is the tracker's standing
 * depth, so putting it on an ordinary failure would report a backlog as if it
 * had just been abandoned. The count is DEPTH, not "abandoned by this batch" —
 * that is what the attribute contract declares it to be.
 *
 * An ABSENT count is omitted rather than sent as `0`: a lane whose depth could
 * not be read has not measured zero, and the attribute is optional precisely so
 * absence stays absence.
 */
export function sessionMetadataBatchEvent(
  event: DesktopSyncBatchEventInput,
  deadLetteredCount: number | undefined
): SyncLaneBatchEvent {
  const carriesDepth =
    event.outcome === DesktopSyncBatchOutcome.DeadLetter &&
    deadLetteredCount !== undefined;
  return {
    ...event,
    lane: SyncLane.SessionMetadata,
    ...(carriesDepth
      ? { deadLetteredCount: clampNonNegativeCount(deadLetteredCount) }
      : {}),
  };
}

/**
 * Lane 3 (component inventory): the cursor-sweep lane's post-send outcome.
 *
 * `deadLetteredCount` is attached ONLY on the dead-letter arm, which is the
 * threshold breach this ticket exists to make visible. Attaching the tracker's
 * size to every ordinary failure would report a standing backlog as if it had
 * just been abandoned.
 */
export function componentInventoryBatchEvent(input: {
  laneFailureReason?: SyncReason;
  rejectedReason?: SyncReason;
  deadLettered?: boolean;
  deadLetteredCount?: number;
}): SyncLaneBatchEvent {
  if (input.laneFailureReason) {
    return {
      lane: SyncLane.ComponentInventory,
      outcome: DesktopSyncBatchOutcome.Failure,
      reason: input.laneFailureReason,
    };
  }
  if (input.rejectedReason) {
    return {
      lane: SyncLane.ComponentInventory,
      outcome: input.deadLettered
        ? DesktopSyncBatchOutcome.DeadLetter
        : DesktopSyncBatchOutcome.Failure,
      reason: input.rejectedReason,
      ...(input.deadLettered && input.deadLetteredCount !== undefined
        ? { deadLetteredCount: clampNonNegativeCount(input.deadLetteredCount) }
        : {}),
    };
  }
  return {
    lane: SyncLane.ComponentInventory,
    outcome: DesktopSyncBatchOutcome.Success,
  };
}

/**
 * Lane 4 (transcript archive): one file's upload attempt.
 *
 * `dead` is the ledger's terminal state (source gone, or bytes no re-upload can
 * fix) and maps to `dead_letter`; an ordinary retryable failure stays `failure`
 * so an outage cannot read as abandonment.
 */
export function transcriptArchiveBatchEvent(input: {
  failed: boolean;
  dead?: boolean;
  reason?: SyncReason;
}): SyncLaneBatchEvent {
  if (!input.failed) {
    return {
      lane: SyncLane.TranscriptArchive,
      outcome: DesktopSyncBatchOutcome.Success,
    };
  }
  return {
    lane: SyncLane.TranscriptArchive,
    outcome: input.dead
      ? DesktopSyncBatchOutcome.DeadLetter
      : DesktopSyncBatchOutcome.Failure,
    reason: input.reason ?? SyncReason.TransportError,
  };
}

/**
 * Lane 3, dead-letter RECOVERY drain: one re-attempt of a previously abandoned
 * batch.
 *
 * A separate entry point from {@link componentInventoryBatchEvent}'s live-cursor
 * arms because recovery sends never reach `applySendOutcome` — and once an
 * install's live cursor is drained (the steady state), recovery is the only
 * drain the lane does. Leaving it uninstrumented would silence lane 3 exactly
 * when its poison backlog is the thing worth watching.
 *
 * A rejection here is reported as an ordinary `failure`, not `dead_letter`: the
 * give-up decision on this path is the tracker's own bounded quarantine, which
 * this send does not make.
 */
export function componentRecoveryBatchEvent(
  outcome: ComponentSyncSendOutcome,
  reason: SyncReason | undefined
): SyncLaneBatchEvent {
  if (outcome === ComponentSyncSendOutcome.Accepted) {
    return {
      lane: SyncLane.ComponentInventory,
      outcome: DesktopSyncBatchOutcome.Success,
    };
  }
  return {
    lane: SyncLane.ComponentInventory,
    outcome: DesktopSyncBatchOutcome.Failure,
    reason: reason ?? SyncReason.TransportError,
  };
}

/**
 * Lane 4: which of the two permanent skip causes a dead-lettered transcript hit.
 *
 * Exhaustive over the lane's own closed skip vocabulary. It serves both the
 * per-attempt permanent skip and the drain queue's acknowledged dead letter,
 * which is where `retries_exhausted` and `environment_unavailable` are decided;
 * folding an unclassified cause into `source_missing` would send an operator
 * hunting a file that is present and readable.
 */
const PERMANENT_SKIP_SYNC_REASON: Record<TranscriptSkipReason, SyncReason> = {
  [TranscriptSkipReason.TooLarge]: SyncReason.LocallyOversized,
  [TranscriptSkipReason.SourceGone]: SyncReason.SourceMissing,
  [TranscriptSkipReason.MaterializedSourceUnavailable]:
    SyncReason.SourceMissing,
  [TranscriptSkipReason.RetriesExhausted]: SyncReason.TransportError,
  // ISS-9884: `lane_gave_up` landed receiver-first with no producer, and
  // `telemetry-contract/sync.ts` names this ticket as the one that puts it on
  // the span. NOT `transport_error`: that would leave the member emitted by
  // nothing and make a 24h environmental give-up indistinguishable from an
  // ordinary transport blip on the SLO, which is exactly what the member was
  // added to end.
  [TranscriptSkipReason.EnvironmentUnavailable]: SyncReason.LaneGaveUp,
};

/**
 * Fold a permanent transcript skip onto the shared enum. An ABSENT cause is a
 * producer that predates the field, and degrades to the generic transport
 * reason rather than to a specific claim it has not earned.
 */
export function permanentSkipSyncReason(
  cause: TranscriptSkipReason | undefined
): SyncReason {
  if (cause === undefined) {
    return SyncReason.TransportError;
  }
  return PERMANENT_SKIP_SYNC_REASON[cause] ?? SyncReason.TransportError;
}

/**
 * The invocation lane's own reading of a retry status, consulted before the
 * shared {@link HTTP_STATUS_SYNC_REASON}, whose 404 row other lanes rely on. A
 * `Map` for the same server-supplied-key reason that table is one.
 */
const INVOCATION_RETRY_STATUS_SYNC_REASON = new Map<number, SyncReason>([
  [404, SyncReason.TransportUnavailable],
]);

/**
 * ISS-11426: the invocation lane's 403 codes, read AHEAD of the status fold.
 *
 * Before this the lane folded every 403 to `target_not_owned`, which was the
 * only honest answer while the server sent a bare 403 — and the same collapse
 * ISS-8599 removed from the transcript control plane. It is not honest now that
 * the two are spelled apart: an org whose session-sync policy is off would page
 * as a device holding a stale compute target, and the two want different
 * responses — an org-admin setting versus an identity the device can re-resolve
 * or relink. ISS-11426 depends on that split: the relink affordance must be
 * offered only where relinking is the remedy.
 *
 * An OBJECT keyed by the closed code union rather than a `Map`, so a third code
 * reds `tsc` here instead of inheriting the status fold silently. The key is
 * server-supplied, but it has already been narrowed to a member of this build's
 * own const by the client's `readForbiddenCode`, so no unvalidated string
 * reaches the lookup.
 *
 * The retry BUDGET is deliberately untouched: 403 has no entry in
 * `INVOCATION_PARTS_ROUTE_PROFILE`, so both codes stay Appendix A's default
 * ENVIRONMENTAL and neither burns a per-part budget — the same no-budget-burn
 * defer this lane has today. This refines what the failure is CALLED, which is
 * the half that was wrong.
 */
const INVOCATION_FORBIDDEN_CODE_SYNC_REASON: Record<
  DesktopAgentComponentInvocationSyncRestErrorCode,
  SyncReason
> = {
  [DesktopAgentComponentInvocationSyncRestErrorCode.FeatureDisabled]:
    SyncReason.FeatureDisabled,
  [DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned]:
    SyncReason.TargetNotOwned,
};

function invocationRetrySyncReason(
  status: number | undefined,
  forbiddenCode: DesktopAgentComponentInvocationSyncRestErrorCode | undefined
): SyncReason {
  if (forbiddenCode !== undefined) {
    return INVOCATION_FORBIDDEN_CODE_SYNC_REASON[forbiddenCode];
  }
  const laneReason =
    status === undefined
      ? undefined
      : INVOCATION_RETRY_STATUS_SYNC_REASON.get(status);
  return laneReason ?? syncReasonForHttpStatus(status);
}

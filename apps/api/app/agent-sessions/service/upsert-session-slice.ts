/**
 * ISS-8619 (PRD-699 §7.6): the ingest apply for ONE session, as five phases with
 * typed handoffs — admission/identity → gating → detail upsert → children →
 * links/derived. Each phase is its own module; this file is the order they run
 * in and the result they add up to.
 *
 * The order is the contract, and it is why the phases hand off TYPED values
 * rather than sharing one mutable scope:
 *   • {@link resolveRevisionAdmission} is payload-only, so a held row's
 *     `ack_omitted` retry never reaches a lock (ISS-8271);
 *   • `resolveSessionSliceIdentity` takes the locks that make `existing` mean
 *     anything, so nothing before it may read the row;
 *   • `resolveSessionSliceGate` decides every refusal before a column is
 *     touched, and returns a union whose no-write arm IS the result;
 *   • `writeSessionDetail` is the only phase that resolves the `artifactId` the
 *     two after it write against; and
 *   • `persistSessionSliceChildren` must precede `persistSessionSliceLinks`
 *     only in the sense that the reopen it performs is part of settling the
 *     session row itself.
 * A phase can only see what its parameters name, so re-ordering two of them now
 * fails to compile rather than silently changing what a lane reads.
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { persistSessionOperationEvidence } from "./attribution/persist-operation-evidence";
import { resolveProjectId } from "./project-resolution";
import type {
  AgentSessionUpsertTx,
  SessionProjectResolution,
  UpsertSessionsContext,
} from "./records";
import {
  emitSessionBranchDetailChanged,
  readSessionBranchIds,
} from "./session-branch-detail-signal";
import { captureCommittedSessionMetadata } from "./session-ingest-metadata-activity";
import { persistSessionSliceChildren } from "./session-slice-children";
import { writeSessionDetail } from "./session-slice-detail-write";
import {
  resolveRevisionAdmission,
  resolveSessionSliceGate,
} from "./session-slice-gating";
import { resolveSessionSliceIdentity } from "./session-slice-identity";
import { persistSessionSliceLinks } from "./session-slice-links";
import type { UpsertSessionSliceResult } from "./session-slice-result";
import { normalizeTokenUsage } from "./synced-payload";

type UpsertSessionSliceInput = {
  context: UpsertSessionsContext;
  /**
   * ISS-7516: the sending machine's data-sync level, resolved ONCE for the batch
   * and fanned out here — the same batch-level shape as `includeFrustration`,
   * because it is a property of the device, not of any one session.
   * `undefined` when the desktop reported none; the column is then left ALONE
   * rather than written NULL, so an older build's batch cannot erase a level a
   * newer build already recorded for the same session.
   */
  dataSyncLevel: DataSyncLevel | undefined;
  includeFrustration: boolean;
  projectResolution: SessionProjectResolution;
  /**
   * ISS-8131: whether this batch opted into the row-level ack
   * (`wantsAcceptedSessionIds`). Batch-level, like `dataSyncLevel` — it is a
   * property of the sending build. A HOLD is only expressible to a client that
   * echoes accepted ids; without the echo, omitting a session reads as
   * delivered, so a hold would be silent data loss. Internal signature only,
   * never a wire field.
   */
  rowLevelAck: boolean;
  session: SyncedAgentSession;
  slugMap: Map<string, string>;
  syncTimestamp: Date;
};

export async function upsertSessionSlice(
  tx: AgentSessionUpsertTx,
  input: UpsertSessionSliceInput
): Promise<UpsertSessionSliceResult> {
  const {
    context,
    dataSyncLevel,
    includeFrustration,
    projectResolution,
    rowLevelAck,
    session,
    slugMap,
    syncTimestamp,
  } = input;
  // ISS-8271: revision admission runs FIRST — before ref/advisory locks and
  // any DB read — so a held row's deliberate ack_omitted retries stay a pure
  // no-op instead of re-acquiring locks that serialize real writers
  // (davetho, #6120).
  const revisionAdmission = resolveRevisionAdmission(session);
  if (revisionAdmission.held) {
    return revisionAdmission.held;
  }
  const normalizedTokenUsage = normalizeTokenUsage(session.tokenUsageByModel);
  const projectId = resolveProjectId(session, projectResolution);

  const identity = await resolveSessionSliceIdentity(tx, {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
    session,
  });

  const gating = resolveSessionSliceGate({
    computeTargetId: context.computeTargetId,
    effectiveDataRevision: revisionAdmission.effectiveDataRevision,
    existing: identity.existing,
    organizationId: context.organizationId,
    rowLevelAck,
    session,
    syncTimestamp,
  });
  if (gating.refusal) {
    return gating.refusal;
  }
  const { gate } = gating;

  const detail = await writeSessionDetail(tx, {
    context,
    dataSyncLevel,
    gate,
    identity,
    includeFrustration,
    normalizedTokenUsage,
    projectId,
    projectResolution,
    session,
    syncTimestamp,
  });

  const children = await persistSessionSliceChildren(tx, {
    artifactId: detail.artifactId,
    existing: identity.existing,
    guardedSessionEndedAt: detail.guardedSessionEndedAt,
    guardedStatus: gate.guardedStatus,
    normalizedTokenUsage,
    organizationId: context.organizationId,
    session,
    shouldReplace: gate.shouldReplace,
    shouldUpdateTokenEventCosts: gate.shouldUpdateTokenEventCosts,
  });
  await captureCommittedSessionMetadata(
    tx,
    context.organizationId,
    detail.metadataSnapshot,
    detail.artifactId
  );

  // A replacement can retract the last PR-only membership. Preserve its owner
  // before the link phase so that branch also learns its session was removed.
  const previousBranchIds = await readSessionBranchIds(
    tx,
    context.organizationId,
    detail.artifactId
  );
  const links = await persistSessionSliceLinks(tx, {
    artifactId: detail.artifactId,
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
    projectId,
    // ISS-11427: `null` on the create arm, which is exactly right — a session
    // the cloud is storing for the first time cannot have been holding anything.
    monitoredActivityHeldSince:
      identity.existing?.monitoredActivityHeldSince ?? null,
    monitoredActivityHoldPartRetained:
      identity.existing?.monitoredActivityHoldPartRetained ?? null,
    session,
    shouldUpdatePullRequestLinks: detail.shouldUpdatePullRequestLinks,
    slugMap,
    syncTimestamp,
  });
  // ISS-12552: evidence rows only; the batch syncs the evidence links after
  // the slice commits. With the attribution flag off, the payload carries no
  // evidence, so links are exactly what the slug lane above wrote.
  const evidence = await persistSessionOperationEvidence(tx, {
    organizationId: context.organizationId,
    agentSessionId: detail.artifactId,
    evidence: session.operationEvidence,
    fresh: gate.shouldUpdateTokenEventCosts,
  });
  const evidenceSnapshotWritten = evidence.snapshotWritten;
  // ISS-12552: branch participation is written from the slice's branch refs,
  // and the requests that implemented each branch from the evidence snapshot
  // (the write-to-commit join), so only a slice that changed one of them can
  // change what this session implements. The batch derives it after the
  // slice commits.
  const derivesImplementation =
    evidenceSnapshotWritten ||
    session.artifactRefs?.some(
      (ref) => ref.kind === ArtifactRefTargetKind.Branch
    ) === true;

  await emitSessionBranchDetailChanged(
    tx,
    context.organizationId,
    detail.artifactId,
    previousBranchIds
  );

  return {
    persisted: true,
    retryRequired: links.retryRequired,
    monitoredActivityOutcomeCounts: links.monitoredActivityOutcomeCounts,
    unmodelledStatus: gate.unmodelledStatus,
    droppedContradictorySessionEnd: detail.droppedContradictorySessionEnd,
    droppedImplausibleCreatedAt: detail.droppedImplausibleCreatedAt,
    observedRepositoryFullNames: links.observedRepositoryFullNames,
    indexKeyProjections: detail.indexKeyProjections + links.indexKeyProjections,
    droppedOverflowUsageBuckets: links.droppedOverflowUsageBuckets,
    unstorableCounterFields: [
      ...detail.unstorableCounterFields,
      ...children.unstorableCounterFields,
    ],
    activityTilingSkipReason: children.activityTilingSkipReason,
    heldRevisionReason: null,
    ...(evidenceSnapshotWritten
      ? {
          evidenceLinksSessionId: detail.artifactId,
          evidenceBindingSessionIds: evidence.bindingChangedSessionIds,
        }
      : {}),
    ...(derivesImplementation
      ? { implementationEvidenceSessionId: detail.artifactId }
      : {}),
  };
}

import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  isLifecycleBranchReadOnlyRelation,
  isLifecycleBranchWriteRelation,
  type SyncedBranchLifecycleEvent,
} from "@repo/api/src/types/session-artifact-link";

export type DesktopBranchLifecycleEvidence = {
  linkId?: string | null;
  method?: string | null;
  observedAt?: string | null;
  relation: ArtifactRefRelation | null | undefined;
};

/** Build lifecycle boundary events for a persisted desktop branch link. */
export function branchLifecycleEventsForBranchLink(
  evidence: DesktopBranchLifecycleEvidence
): SyncedBranchLifecycleEvent[] {
  const kind = branchLifecycleKindForBranchRelation(evidence.relation);
  return kind ? [buildBranchLifecycleEvent(evidence, kind)] : [];
}

/** Build lifecycle boundary events for a persisted desktop PR link. */
export function branchLifecycleEventsForPrLink(
  evidence: DesktopBranchLifecycleEvidence
): SyncedBranchLifecycleEvent[] {
  if (evidence.relation === ArtifactRefRelation.Created) {
    return [
      buildBranchLifecycleEvent(evidence, BranchLifecycleBoundaryKind.PrRaised),
    ];
  }
  if (evidence.relation !== ArtifactRefRelation.Reviewed) {
    return [];
  }
  const kind =
    evidence.method === ArtifactRefMethod.PrReviewFeedbackCommand
      ? BranchLifecycleBoundaryKind.ReviewFeedback
      : BranchLifecycleBoundaryKind.ReadOnlyReference;
  return [buildBranchLifecycleEvent(evidence, kind)];
}

function branchLifecycleKindForBranchRelation(
  relation: ArtifactRefRelation | null | undefined
): BranchLifecycleBoundaryKind | null {
  if (isLifecycleBranchWriteRelation(relation)) {
    return BranchLifecycleBoundaryKind.BranchWrite;
  }
  if (isLifecycleBranchReadOnlyRelation(relation)) {
    return BranchLifecycleBoundaryKind.ReadOnlyReference;
  }
  return null;
}

function buildBranchLifecycleEvent(
  evidence: DesktopBranchLifecycleEvidence,
  kind: BranchLifecycleBoundaryKind
): SyncedBranchLifecycleEvent {
  const observedAt = validTimestamp(evidence.observedAt);
  const event: SyncedBranchLifecycleEvent = {
    kind,
    ...(evidence.linkId
      ? { evidenceId: `desktop-artifact-link:${evidence.linkId}` }
      : {}),
  };
  return observedAt ? { ...event, observedAt } : event;
}

function validTimestamp(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

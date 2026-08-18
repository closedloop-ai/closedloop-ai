import { BranchSessionRole } from "@repo/api/src/types/branch";
import {
  type ArtifactRefRelation,
  BRANCH_PUSH_METHODS,
  deriveSessionPrPurposeFromMetadata,
  isLifecycleBranchReadOnlyRelation,
  isLifecycleBranchWriteRelation,
  SessionArtifactLinkKind,
  SessionPrPurpose,
  type SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";

const MIN_CONFIDENCE = 0.5;

/**
 * Target identity for the branch/PR currently being classified. Callers may pass
 * pre-scoped evidence, or provide target fields so evidence carrying a different
 * branch or PR identity is ignored.
 */
export type BranchSessionRoleTarget = {
  repositoryFullName?: string | null;
  branchName?: string | null;
  prNumber?: number | null;
};

/**
 * Link evidence for one session relative to a branch. This is intentionally a
 * lightweight, persistence-agnostic shape so cloud and desktop readers can adapt
 * their own rows without importing database models.
 */
export type BranchSessionRoleEvidence = {
  linkKind: SessionArtifactLinkKind;
  linkKinds?: readonly SessionArtifactLinkKind[];
  relation?: ArtifactRefRelation | null;
  relationTypes?: readonly SessionPrRelationType[];
  method?: string | null;
  confidence?: number | null;
  repositoryFullName?: string | null;
  branchName?: string | null;
  prNumber?: number | null;
};

/**
 * Classify a branch-linked session from already persisted branch/PR evidence.
 * Build evidence wins over review/read-only evidence; ambiguous, low-confidence,
 * missing, or foreign-target evidence falls back to `related`.
 */
export function classifyBranchSessionRole({
  evidence,
  target,
}: {
  evidence: readonly BranchSessionRoleEvidence[];
  target?: BranchSessionRoleTarget;
}): BranchSessionRole {
  let hasReviewEvidence = false;
  for (const item of evidence) {
    const role = classifySingleEvidence(item, target);
    if (role === BranchSessionRole.Build) {
      return BranchSessionRole.Build;
    }
    if (role === BranchSessionRole.Review) {
      hasReviewEvidence = true;
    }
  }
  return hasReviewEvidence
    ? BranchSessionRole.Review
    : BranchSessionRole.Related;
}

function classifySingleEvidence(
  evidence: BranchSessionRoleEvidence,
  target: BranchSessionRoleTarget | undefined
): BranchSessionRole | null {
  if (!isConfident(evidence.confidence)) {
    return null;
  }
  const branchRole = isBranchEvidence(evidence, target)
    ? classifyBranchEvidence(evidence)
    : null;
  const prRole = isPrEvidence(evidence, target)
    ? classifyPrEvidence(evidence)
    : null;
  if (
    branchRole === BranchSessionRole.Build ||
    prRole === BranchSessionRole.Build
  ) {
    return BranchSessionRole.Build;
  }
  if (
    branchRole === BranchSessionRole.Review ||
    prRole === BranchSessionRole.Review
  ) {
    return BranchSessionRole.Review;
  }
  return null;
}

function classifyBranchEvidence(
  evidence: BranchSessionRoleEvidence
): BranchSessionRole | null {
  if (isBuildBranchEvidence(evidence)) {
    return BranchSessionRole.Build;
  }
  if (isReviewBranchEvidence(evidence)) {
    return BranchSessionRole.Review;
  }
  return null;
}

function classifyPrEvidence(
  evidence: BranchSessionRoleEvidence
): BranchSessionRole | null {
  const purpose = deriveSessionPrPurposeFromMetadata({
    relationTypes: evidence.relationTypes
      ? Array.from(evidence.relationTypes)
      : undefined,
    confidence: evidence.confidence ?? undefined,
  });
  if (purpose === SessionPrPurpose.Authored) {
    return BranchSessionRole.Build;
  }
  if (
    purpose === SessionPrPurpose.Reviewed ||
    purpose === SessionPrPurpose.Referenced
  ) {
    return BranchSessionRole.Review;
  }
  return null;
}

function matchesBranchTarget(
  evidence: BranchSessionRoleEvidence,
  target: BranchSessionRoleTarget | undefined
): boolean {
  if (!target) {
    return true;
  }
  return (
    matchesOptionalIdentity(
      evidence.repositoryFullName,
      target.repositoryFullName
    ) && matchesOptionalIdentity(evidence.branchName, target.branchName)
  );
}

function matchesPrTarget(
  evidence: BranchSessionRoleEvidence,
  target: BranchSessionRoleTarget | undefined
): boolean {
  if (!target) {
    return true;
  }
  return (
    matchesOptionalIdentity(
      evidence.repositoryFullName,
      target.repositoryFullName
    ) && matchesOptionalIdentity(evidence.prNumber, target.prNumber)
  );
}

function matchesOptionalIdentity<T>(
  evidenceValue: T | null | undefined,
  targetValue: T | null | undefined
): boolean {
  return (
    evidenceValue === undefined ||
    evidenceValue === null ||
    targetValue === undefined ||
    targetValue === null ||
    evidenceValue === targetValue
  );
}

function isConfident(confidence: number | null | undefined): boolean {
  return (
    confidence === undefined ||
    confidence === null ||
    (Number.isFinite(confidence) && confidence >= MIN_CONFIDENCE)
  );
}

function isPrEvidence(
  evidence: BranchSessionRoleEvidence,
  target: BranchSessionRoleTarget | undefined
): boolean {
  return (
    hasLinkKind(evidence, SessionArtifactLinkKind.SessionPr) &&
    matchesPrTarget(evidence, target)
  );
}

function isBranchEvidence(
  evidence: BranchSessionRoleEvidence,
  target: BranchSessionRoleTarget | undefined
): boolean {
  return (
    hasLinkKind(evidence, SessionArtifactLinkKind.SessionBranch) &&
    matchesBranchTarget(evidence, target)
  );
}

function hasLinkKind(
  evidence: BranchSessionRoleEvidence,
  linkKind: SessionArtifactLinkKind
): boolean {
  return (
    evidence.linkKind === linkKind ||
    (evidence.linkKinds ?? []).includes(linkKind)
  );
}

function isBuildBranchEvidence(evidence: BranchSessionRoleEvidence): boolean {
  return (
    (evidence.method !== undefined &&
      evidence.method !== null &&
      BRANCH_PUSH_METHODS.has(evidence.method)) ||
    isLifecycleBranchWriteRelation(evidence.relation)
  );
}

function isReviewBranchEvidence(evidence: BranchSessionRoleEvidence): boolean {
  return isLifecycleBranchReadOnlyRelation(evidence.relation);
}

import type { ArtifactLink } from "@repo/api/src/types/artifact";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { deriveImplementationEvidence } from "@/app/agent-sessions/service/attribution/derive-implementation-evidence";
import {
  ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY,
  ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY,
  isAttributionEvidenceEnabledForOrganization,
  isAttributionEvidenceReadOffForOrganization,
  isAttributionEvidenceReadOnForOrganization,
  readAttributionEvidenceForRequest,
} from "@/lib/attribution-evidence-policy-feature";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * ISS-12552: a PRODUCES link onto a branch changes the
 * documents its implementation rows associate, and a session's link to a
 * branch is what makes it implement the branch at all, so the
 * branch's implementation evidence is derived again on the link write's
 * transaction.
 */
export async function refreshBranchImplementationEvidence(
  tx: TransactionClient,
  organizationId: string,
  branchId: string
): Promise<void> {
  await deriveImplementationEvidence(tx, {
    organizationId,
    branchIds: [branchId],
  });
}

/**
 * ISS-12552 (PRD-800 "Rollout"): the link routes read the organization's
 * attribution answer here, before the link write, so a link write that the
 * answer turns off looks up nothing (flag-off parity). `linkType` is the
 * created link's; a delete passes none, since it cannot know the link's type
 * without reading it. Call it inside `runWithAttributionEvidenceGate`.
 */
export async function readLinkWriteAttributionEvidence(
  organizationId: string,
  linkType?: string
): Promise<void> {
  if (linkType === undefined || canDeriveImplementation(linkType)) {
    await readAttributionEvidenceForRequest(organizationId);
  }
}

/**
 * The branch a link write derives implementation evidence for, or null.
 * The flag is answered first, through {@link attributionEvidenceOnForLinkWrite}
 * (which never evaluates it inside a transaction), so a link write with the
 * flag off looks nothing up: no branch read is added to main's statements.
 */
export async function derivedImplementationBranchId(
  organizationId: string,
  link: { linkType: string; sourceId: string; targetId: string }
): Promise<string | null> {
  if (
    !canDeriveImplementation(link.linkType) ||
    isAttributionEvidenceReadOffForOrganization(organizationId) ||
    !(await attributionEvidenceOnForLinkWrite(organizationId))
  ) {
    return null;
  }
  return await implementationBranchId(organizationId, link);
}

/**
 * ISS-12552: the flag answer a link write derives on. Outside a transaction it
 * is the memoized organization gate. Inside one (a caller whose link joins its
 * own transaction) only an answer this request already read counts: an unread
 * answer is never evaluated there, because that can call PostHog while the
 * transaction holds its connection. It reads as off, the same fail-closed
 * answer as an unavailable flag, and is logged under that flag's event.
 */
async function attributionEvidenceOnForLinkWrite(
  organizationId: string
): Promise<boolean> {
  if (!withDb.inTransaction()) {
    return await isAttributionEvidenceEnabledForOrganization(organizationId);
  }
  if (isAttributionEvidenceReadOnForOrganization(organizationId)) {
    return true;
  }
  if (!isAttributionEvidenceReadOffForOrganization(organizationId)) {
    log.warn(ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY, {
      level: "warn",
      status: "warn",
      featureFlagKey: ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY,
      organizationId,
      reason: LINK_WRITE_FLAG_UNREAD_IN_TRANSACTION,
    });
  }
  return false;
}

/** The log reason for a link write that found the flag unread in its tx. */
export const LINK_WRITE_FLAG_UNREAD_IN_TRANSACTION =
  "link_write_flag_unread_in_transaction" as const;

/** {@link derivedImplementationBranchId} for a link about to be deleted. */
export async function deletedLinkImplementationBranchId(
  id: string,
  organizationId: string
): Promise<string | null> {
  if (isAttributionEvidenceReadOffForOrganization(organizationId)) {
    return null;
  }
  const existing = await withDb((db) =>
    db.artifactLink.findFirst({
      where: { id, organizationId },
      select: { sourceId: true, targetId: true, linkType: true },
    })
  );
  return existing
    ? await derivedImplementationBranchId(organizationId, existing)
    : null;
}

/**
 * The record a link write runs on its transaction: the branch's implementation
 * evidence derived again, then the caller's receipt. Undefined when there is
 * neither, so the link is written as on main.
 */
export function linkWriteRecord(
  organizationId: string,
  derivedBranchId: string | null,
  recordCreated: RecordWriteInTransaction<ArtifactLink> | undefined
): RecordWriteInTransaction<ArtifactLink> | undefined {
  if (derivedBranchId === null && !recordCreated) {
    return;
  }
  return async (tx, link) => {
    if (derivedBranchId !== null) {
      await refreshBranchImplementationEvidence(
        tx,
        organizationId,
        derivedBranchId
      );
    }
    await recordCreated?.(tx, link);
  };
}

function canDeriveImplementation(linkType: string): boolean {
  return linkType === LinkType.Produces || linkType === LinkType.RelatesTo;
}

/**
 * The branch whose implementation evidence a link write changes: the target
 * of a PRODUCES link, or of a session's RELATES_TO link; null for any other.
 */
async function implementationBranchId(
  organizationId: string,
  link: { linkType: string; sourceId: string; targetId: string }
): Promise<string | null> {
  if (!canDeriveImplementation(link.linkType)) {
    return null;
  }
  const branch = await findArtifactOfType(
    organizationId,
    link.targetId,
    ArtifactType.Branch
  );
  if (!branch || link.linkType === LinkType.Produces) {
    return branch;
  }
  return (await findArtifactOfType(
    organizationId,
    link.sourceId,
    ArtifactType.Session
  ))
    ? branch
    : null;
}

async function findArtifactOfType(
  organizationId: string,
  id: string,
  type: ArtifactType
): Promise<string | null> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { id, organizationId, type },
      select: { id: true },
    })
  );
  return artifact?.id ?? null;
}

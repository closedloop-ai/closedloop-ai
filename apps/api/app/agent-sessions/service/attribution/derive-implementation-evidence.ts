/**
 * ISS-12552: implementation evidence. A session that wrote
 * to a branch (existing repository participation `wrote`) gets one
 * `implementation` row targeting the branch, whether or not anything produced
 * it (PRD-800 "Links without evidence": branch write participation counts
 * as implementation work). The documents that produced the branch, of
 * any kind (an issue, a plan), are its associated artifacts, possibly none;
 * the association is informational and none of them gets a creation or
 * revision from it. A branch and its pull request are one recipient, keyed by
 * repository and head ref, so duplicate branch rows for one head ref collapse.
 *
 * Each row also names the requests that implemented its branch (Daveth
 * Oakhurst, 2026-10-20): `anchors.requestKeys` holds what the Desktop's
 * write-to-commit join placed on that branch. It is absent when the session's
 * Desktop predates the join, which leaves the row on the agent and phase
 * fallback, and empty when the join placed no request on the branch. The
 * join names a branch, not a repository, so its requests go only to the
 * branch in the session's own repository: two repositories with the
 * same branch name never both get them. A session whose repository is not
 * recorded keeps the branch-name match.
 *
 * Runs at sync ingest (for the session), when a link that produces a branch
 * or ties a session to it is written or deleted (for the branch), and in the
 * historical backfill (for
 * the branches each page's sessions link to). Known limit: a push to an
 * existing branch is not participation `wrote` today (ISS-8786).
 */
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationClaim } from "@repo/api/src/types/operation-claims";
import { operationClaimSchema } from "@repo/api/src/types/operation-claims-schema";
import { ProvenanceRelationshipKind } from "@repo/api/src/types/provenance-relationship";
import { Prisma } from "@repo/database";
import { ATTRIBUTION_POLICY_VERSION } from "@repo/lib/attribution/classify-operation";
import { log } from "@repo/observability/log";
import { participationProvenanceKind } from "../provenance-eligibility";
import type { AgentSessionUpsertTx } from "../records";

/** Stored on implementation rows, which no Desktop extractor produced. */
const REPOSITORY_EVIDENCE_EXTRACTOR_VERSION = 0;

type Scope =
  | { organizationId: string; sessionIds: readonly string[] }
  | { organizationId: string; branchIds: readonly string[] };

export async function deriveImplementationEvidence(
  tx: AgentSessionUpsertTx,
  scope: Scope
): Promise<void> {
  const { organizationId } = scope;
  const scopeIds = "sessionIds" in scope ? scope.sessionIds : scope.branchIds;
  if (scopeIds.length === 0) {
    return;
  }
  const links = await readBranchWrites(tx, organizationId, scope);
  const existingCount = links[0]?.existingCount ?? 0;
  const requestsBySession = new Map<string, Map<string, Set<string>> | null>();
  const rows = new Map<string, ImplementationRow>();
  for (const link of links) {
    if (
      !(link.sourceId && link.targetId && link.repositoryFullName) ||
      link.branchName === null ||
      participationProvenanceKind(link) !==
        ProvenanceRelationshipKind.Contribution
    ) {
      continue;
    }
    const recipient = `${link.repositoryFullName}:${link.branchName}`;
    const key = `${link.sourceId}\u0000${recipient}`;
    const held = rows.get(key);
    const associated = new Set([
      ...(held?.associatedArtifactIds ?? []),
      ...link.producerIds,
    ]);
    if (!requestsBySession.has(link.sourceId)) {
      requestsBySession.set(
        link.sourceId,
        joinRepositoryActivity(organizationId, {
          sourceId: link.sourceId,
          repositoryActivity: link.repositoryActivity,
        })
      );
    }
    const requestKeys = joinedRequestKeys(
      requestsBySession.get(link.sourceId),
      link
    );
    rows.set(key, {
      agentSessionId: link.sourceId,
      claimKey: `implementation:${recipient}`,
      branchId: held?.branchId ?? link.targetId,
      repository: link.repositoryFullName,
      headRef: link.branchName,
      associatedArtifactIds: [...associated].sort(),
      ...(requestKeys ? { requestKeys } : {}),
    });
  }
  if (rows.size === 0 && existingCount === 0) {
    return;
  }
  await tx.agentSessionOperationEvidence.deleteMany({
    where: {
      organizationId,
      source: OperationSource.Repository,
      ...("sessionIds" in scope
        ? { agentSessionId: { in: [...scopeIds] } }
        : { targetArtifactId: { in: [...scopeIds] } }),
    },
  });
  if (rows.size === 0) {
    return;
  }
  await tx.agentSessionOperationEvidence.createMany({
    data: [...rows.values()].map((row) => ({
      organizationId,
      agentSessionId: row.agentSessionId,
      claimKey: row.claimKey,
      targetArtifactId: row.branchId,
      relationshipKind: AttributionRelationshipKind.Implementation,
      outcome: OperationEvidenceOutcome.Committed,
      operationKind: OperationKind.Unsupported,
      source: OperationSource.Repository,
      anchors: {
        associatedArtifactIds: row.associatedArtifactIds,
        repositoryOutput: { repository: row.repository, headRef: row.headRef },
        ...(row.requestKeys ? { requestKeys: row.requestKeys } : {}),
      },
      extractorVersion: REPOSITORY_EVIDENCE_EXTRACTOR_VERSION,
      policyVersion: ATTRIBUTION_POLICY_VERSION,
    })),
    skipDuplicates: true,
  });
}

type ImplementationRow = {
  agentSessionId: string;
  claimKey: string;
  branchId: string;
  repository: string;
  headRef: string;
  associatedArtifactIds: string[];
  /** Absent when the session's Desktop recorded no repository activity. */
  requestKeys?: string[];
};

type BranchWrite = {
  existingCount: number;
  sourceId: string | null;
  targetId: string | null;
  branchParticipation: string | null;
  metadata: unknown;
  repositoryFullName: string | null;
  branchName: string | null;
  /** The documents that produced the branch, of any kind; possibly none. */
  producerIds: string[];
  /** The snapshot's repository activity; null when it has none. */
  repositoryActivity: unknown;
  /** The repository the session itself ran in, when recorded. */
  sessionRepository: string | null;
};

/**
 * One statement, because it runs inside every slice that carries branch refs
 * and the ingest statement budget is fixed: the scope's session-to-branch
 * links with each branch's head ref and producing documents, and how many
 * repository evidence rows the scope already holds. The count rides on every
 * row, and on a lone all-null row when the scope has no branch links.
 */
function readBranchWrites(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  scope: Scope
): Promise<BranchWrite[]> {
  const [linkScope, evidenceScope] =
    "sessionIds" in scope
      ? [
          Prisma.sql`l.source_id = ANY(${scope.sessionIds}::uuid[])`,
          Prisma.sql`e.agent_session_id = ANY(${scope.sessionIds}::uuid[])`,
        ]
      : [
          Prisma.sql`l.target_id = ANY(${scope.branchIds}::uuid[])`,
          Prisma.sql`e.target_artifact_id = ANY(${scope.branchIds}::uuid[])`,
        ];
  return tx.$queryRaw<BranchWrite[]>(Prisma.sql`
    SELECT existing.count AS "existingCount",
           link.source_id AS "sourceId",
           link.target_id AS "targetId",
           link.branch_participation AS "branchParticipation",
           link.metadata,
           branch.repository_full_name AS "repositoryFullName",
           branch.branch_name AS "branchName",
           COALESCE(link.producer_ids, ARRAY[]::uuid[]) AS "producerIds",
           snapshot.repository_activity AS "repositoryActivity",
           detail.repository_full_name AS "sessionRepository"
    FROM (
      SELECT count(*)::int AS count
      FROM agent_session_operation_evidence e
      WHERE e.organization_id = ${organizationId}::uuid
        AND e.source = ${OperationSource.Repository}
        AND ${evidenceScope}
    ) AS existing
    LEFT JOIN LATERAL (
      SELECT l.source_id, l.target_id, l.branch_participation, l.metadata,
        ARRAY(
          SELECT p.source_id
          FROM artifact_links p
          JOIN artifacts producer ON producer.id = p.source_id
          WHERE p.organization_id = ${organizationId}::uuid
            AND p.target_id = l.target_id
            AND p.link_type = ${LinkType.Produces}::"LinkType"
            AND producer.organization_id = ${organizationId}::uuid
            AND producer.type = ${ArtifactType.Document}::"ArtifactType"
          ORDER BY p.source_id
        ) AS producer_ids
      FROM artifact_links l
      JOIN artifacts session ON session.id = l.source_id
      JOIN artifacts target ON target.id = l.target_id
      WHERE l.organization_id = ${organizationId}::uuid
        AND l.link_type = ${LinkType.RelatesTo}::"LinkType"
        AND session.organization_id = ${organizationId}::uuid
        AND session.type = ${ArtifactType.Session}::"ArtifactType"
        AND target.organization_id = ${organizationId}::uuid
        AND target.type = ${ArtifactType.Branch}::"ArtifactType"
        AND ${linkScope}
    ) AS link ON true
    LEFT JOIN branch_detail branch ON branch.artifact_id = link.target_id
    LEFT JOIN agent_session_operation_evidence_snapshots snapshot
      ON snapshot.agent_session_id = link.source_id
     AND snapshot.organization_id = ${organizationId}::uuid
    LEFT JOIN session_detail detail ON detail.artifact_id = link.source_id
  `);
}

/**
 * The requests the session's join placed on this branch: none for a branch
 * outside the session's repository, and undefined when the session has no
 * join (an older Desktop). A session whose repository is unknown matches by
 * branch name. Repository names compare case-insensitively, as GitHub
 * resolves them.
 */
function joinedRequestKeys(
  joined: Map<string, Set<string>> | null | undefined,
  link: {
    branchName: string | null;
    repositoryFullName: string | null;
    sessionRepository: string | null;
  }
): string[] | undefined {
  if (!joined) {
    return undefined;
  }
  const inSessionRepository =
    !link.sessionRepository ||
    link.sessionRepository.toLowerCase() ===
      link.repositoryFullName?.toLowerCase();
  return inSessionRepository && link.branchName !== null
    ? [...(joined.get(link.branchName) ?? [])].sort()
    : [];
}

/**
 * The requests each branch's commits prove, from the session's stored
 * implementation-join claims; null when the snapshot holds none. The claims
 * were parsed at ingest, so a stored value that is not a list is a write
 * defect: it is logged and the session stays on the fallback.
 */
function joinRepositoryActivity(
  organizationId: string,
  link: { sourceId: string; repositoryActivity: unknown }
): Map<string, Set<string>> | null {
  if (link.repositoryActivity === null) {
    return null;
  }
  if (!Array.isArray(link.repositoryActivity)) {
    log.warn("stored implementation joins are not a claim list", {
      level: "warn",
      status: "warn",
      organizationId,
      agentSessionId: link.sourceId,
    });
    return null;
  }
  const claims: OperationClaim[] = link.repositoryActivity.flatMap((value) => {
    const parsed = operationClaimSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const byBranch = new Map<string, Set<string>>();
  for (const claim of claims) {
    if (claim.branch) {
      const requests = byBranch.get(claim.branch) ?? new Set<string>();
      for (const key of claim.requestKeys ?? []) {
        requests.add(key);
      }
      byBranch.set(claim.branch, requests);
    }
  }
  return byBranch;
}

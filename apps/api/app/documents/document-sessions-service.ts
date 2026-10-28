import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import type { BranchSession } from "@repo/api/src/types/branch";
import type { DocumentSessionsResponse } from "@repo/api/src/types/document-sessions";
import { RELATED_SESSION_ELIGIBLE_KINDS } from "@repo/api/src/types/provenance-relationship";
import { withDb } from "@repo/database";
import {
  readEvidenceProvenanceContributions,
  strongestContributionsBySession,
} from "@/app/agent-sessions/service/evidence-provenance";
import {
  listEligibleSessionContributions,
  type SessionProvenanceContribution,
  selectLatestEligibleContributions,
} from "@/app/agent-sessions/service/provenance-eligibility";
import { branchTraceService } from "@/app/branches/branch-trace-service";
import { isAttributionEvidenceEnabledForOrganization } from "@/lib/attribution-evidence-policy-feature";
import { displayUserName } from "@/lib/user-display-name";
import { documentService } from "./document-service";

/** The same provenance population as Related Sessions, hydrated without its chip cap. */
async function readSessions(
  organizationId: string,
  documentId: string,
  signal?: AbortSignal
): Promise<DocumentSessionsResponse | null> {
  const document = await documentService.findByIdSimple(
    documentId,
    organizationId
  );
  if (!document) {
    return null;
  }
  const contributions = await readContributions(organizationId, documentId);
  const identities =
    contributions.length === 0
      ? []
      : await withDb((db) =>
          db.sessionDetail.findMany({
            where: {
              artifactId: {
                in: contributions.map((row) => row.sessionArtifactId),
              },
              artifact: { is: { organizationId } },
            },
            select: {
              artifactId: true,
              externalSessionId: true,
              artifact: { select: { name: true, slug: true } },
            },
          })
        );
  const identityById = new Map(identities.map((row) => [row.artifactId, row]));
  const qualifying = contributions.map((contribution) => {
    const row = identityById.get(contribution.sessionArtifactId);
    // Provenance already established this org-scoped population. A missing
    // identity must still reach hydration, which preserves unavailable evidence.
    return {
      observedAtMs: contribution.occurredAt.getTime(),
      identity: {
        artifactId: contribution.sessionArtifactId,
        name: row?.artifact.name ?? null,
        slug: row?.artifact.slug ?? null,
        navigableRef: row?.artifact.slug ?? contribution.sessionArtifactId,
        ...(row?.externalSessionId
          ? { externalSessionId: row.externalSessionId }
          : {}),
      },
    };
  });
  // Reuse the Branches hydration, timestamp validation, trace fold, and partial
  // evidence handling; only the provenance population differs between hosts.
  const { trace, details } = await branchTraceService.buildSessionTimelineTrace(
    organizationId,
    qualifying,
    signal
  );
  const sessions = details.map(toTimelineSession);
  const cost =
    sessions.length > 0
      ? sessions.reduce<number | null>((total, session) => {
          if (total === null || session.estimatedCostUsd === null) {
            return null;
          }
          return total + session.estimatedCostUsd;
        }, 0)
      : null;
  return {
    detail: {
      id: documentId,
      sessions,
      mergedTrace: trace.items,
      estimatedCostUsd: cost,
      attributedCostUsd: cost,
    },
    trace,
  };
}

function toTimelineSession(detail: AgentSessionDetail): BranchSession {
  return {
    sessionId: detail.id,
    slug: detail.slug,
    name: detail.name,
    navigableRef: detail.slug ?? detail.id,
    externalSessionId: detail.externalSessionId,
    harness: detail.harness,
    startedAt: detail.startedAt.toISOString(),
    endedAt: detail.endedAt?.toISOString() ?? null,
    isPrimary: false,
    inputTokens: detail.inputTokens,
    outputTokens: detail.outputTokens,
    cacheReadTokens: detail.cacheReadTokens,
    cacheWriteTokens: detail.cacheWriteTokens,
    estimatedCostUsd: detail.estimatedCost,
    evenSplitCostUsd: detail.estimatedCost,
    ownerUserId: detail.assignee?.id ?? null,
    ownerUserName: detail.assignee ? displayUserName(detail.assignee) : null,
  };
}

export const documentSessionsService = { readSessions };

/**
 * ISS-12552: the same population Related Sessions reads, from operation
 * evidence while `attribution-evidence-policy` is on for the organization
 * (PRD-800 "Rollout").
 */
async function readContributions(
  organizationId: string,
  documentId: string
): Promise<SessionProvenanceContribution[]> {
  if (await isAttributionEvidenceEnabledForOrganization(organizationId)) {
    return selectLatestEligibleContributions(
      strongestContributionsBySession(
        await readEvidenceProvenanceContributions({
          organizationId,
          artifactIds: [documentId],
          kinds: RELATED_SESSION_ELIGIBLE_KINDS,
        }),
        RELATED_SESSION_ELIGIBLE_KINDS
      ),
      RELATED_SESSION_ELIGIBLE_KINDS
    );
  }
  return listEligibleSessionContributions({
    organizationId,
    artifactId: documentId,
  });
}

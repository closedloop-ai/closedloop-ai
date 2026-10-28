import { RELATED_SESSION_ELIGIBLE_KINDS } from "@repo/api/src/types/provenance-relationship";
import {
  RELATED_SESSIONS_DISPLAY_CAP,
  type RelatedSessionSummary,
  type RelatedSessionsResult,
} from "@repo/api/src/types/related-session";
import type { Prisma } from "@repo/database";
import { withDb } from "@repo/database";
import { isAttributionEvidenceEnabledForOrganization } from "@/lib/attribution-evidence-policy-feature";
import {
  readEvidenceProvenanceContributions,
  readLatestEvidenceProvenanceContributionsForTargets,
  strongestContributionsBySession,
} from "./evidence-provenance";
import {
  readLatestRelatedSessionContributionsForTargets,
  readSessionProvenanceEvidence,
  type SessionProvenanceContribution,
  selectLatestEligibleContributions,
  type TargetedSessionProvenanceContribution,
} from "./provenance-eligibility";
import { projectDisplayedSessionStatus } from "./session-status-projection";

/**
 * ISS-7234 / ISS-7235 — the Related Sessions read: sessions that wrote,
 * revised, or commented on an artifact, newest contribution first.
 *
 * Eligibility comes from the shared provenance classifier in
 * `provenance-eligibility`, batched across the page's target artifacts. The
 * session projection stays org-scoped and intentionally narrow: it hydrates only
 * the display fields this cross-artifact read returns.
 *
 * ISS-7235 changed what this returns. It used to hand back raw
 * `AgentSessionListItem` rows in `SESSION_DEFAULT_ORDER_BY` — the session's own
 * recency. That is a different fact from the one the field states: a session
 * that opened months ago and last ran an hour ago would have sorted above one
 * that revised THIS artifact this morning, and the field would have presented
 * that as the newest contribution. So the read now returns the dated,
 * contribution-ordered rows the field renders, and the projection is used for
 * the per-session display fields only, joined back onto the contribution order.
 */
export async function listRelatedSessions(
  organizationId: string,
  artifactId: string,
  limit: number = RELATED_SESSIONS_DISPLAY_CAP
): Promise<RelatedSessionsResult> {
  // ISS-12552 (PRD-800 "Rollout"): the organization's answer.
  const evidence = (await isAttributionEvidenceEnabledForOrganization(
    organizationId
  ))
    ? strongestContributionsBySession(
        await readEvidenceProvenanceContributions({
          organizationId,
          artifactIds: [artifactId],
          kinds: RELATED_SESSION_ELIGIBLE_KINDS,
        }),
        RELATED_SESSION_ELIGIBLE_KINDS
      )
    : await readSessionProvenanceEvidence({
        organizationId,
        artifactId,
        kinds: RELATED_SESSION_ELIGIBLE_KINDS,
      });
  const contributions = selectLatestEligibleContributions(
    evidence,
    RELATED_SESSION_ELIGIBLE_KINDS
  );
  const rowLimit = Math.max(1, limit);
  const shown = contributions.slice(0, rowLimit);
  const sessions = await listRelatedSessionProjectionsByArtifactIds(
    organizationId,
    shown.map((contribution) => contribution.sessionArtifactId)
  );
  const sessionById = new Map(
    sessions.map((session) => [session.artifactId, session])
  );
  return buildRelatedSessionsResult(contributions.length, shown, sessionById);
}

/**
 * Page-shaped Related Sessions read for a bounded set of artifacts.
 *
 * Every artifact id passed here is assumed to have already passed the route's
 * org/type gate. The service still org-scopes both the provenance and session
 * projection reads so the result cannot be assembled from cross-tenant edges.
 */
export async function listRelatedSessionsForArtifacts(
  organizationId: string,
  artifactIds: readonly string[],
  limit: number = RELATED_SESSIONS_DISPLAY_CAP,
  options?: RelatedSessionFilter
): Promise<Record<string, RelatedSessionsResult>> {
  const ids = [...new Set(artifactIds)];
  const results = Object.create(null) as Record<string, RelatedSessionsResult>;
  if (ids.length === 0) {
    return results;
  }

  const rowLimit = Math.max(1, limit);
  const filter = {
    ...(options?.sessionArtifactIds === undefined
      ? {}
      : { sessionArtifactIds: options.sessionArtifactIds }),
    ...(options?.sessionSearch === undefined
      ? {}
      : { sessionSearch: options.sessionSearch }),
  };
  // ISS-12552 (PRD-800 "Rollout"): the organization's answer.
  const page = (await isAttributionEvidenceEnabledForOrganization(
    organizationId
  ))
    ? await readLatestEvidenceProvenanceContributionsForTargets({
        organizationId,
        artifactIds: ids,
        kinds: RELATED_SESSION_ELIGIBLE_KINDS,
        limit: rowLimit,
        ...filter,
      })
    : await readLatestRelatedSessionContributionsForTargets({
        organizationId,
        artifactIds: ids,
        limit: rowLimit,
        ...filter,
      });
  const contributionsByArtifact = groupContributionsByArtifact(
    page.contributions
  );
  const sessionIds: string[] = [];
  for (const artifactId of ids) {
    for (const contribution of contributionsByArtifact.get(artifactId) ?? []) {
      sessionIds.push(contribution.sessionArtifactId);
    }
  }

  const sessions = await listRelatedSessionProjectionsByArtifactIds(
    organizationId,
    sessionIds
  );
  const sessionById = new Map(
    sessions.map((session) => [session.artifactId, session])
  );

  for (const artifactId of ids) {
    const shown = contributionsByArtifact.get(artifactId) ?? [];
    results[artifactId] = buildRelatedSessionsResult(
      page.totalByTarget.get(artifactId) ?? 0,
      shown,
      sessionById
    );
  }

  return results;
}

const relatedSessionSummarySelect = {
  artifactId: true,
  nameOverride: true,
  awaitingInputSince: true,
  sessionEndedAt: true,
  lastActivityAt: true,
  sessionStartedAt: true,
  endsWithError: true,
  artifact: {
    select: {
      slug: true,
      name: true,
      status: true,
      // ISS-12251 D-1: a session's Owner is its artifact's assignee.
      assignee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
    },
  },
} satisfies Prisma.SessionDetailSelect;

type RelatedSessionProjection = Prisma.SessionDetailGetPayload<{
  select: typeof relatedSessionSummarySelect;
}>;

function buildRelatedSessionsResult(
  total: number,
  shown: readonly SessionProvenanceContribution[],
  sessionById: ReadonlyMap<string, RelatedSessionProjection>
): RelatedSessionsResult {
  const items: RelatedSessionSummary[] = [];
  let dropped = 0;

  for (const contribution of shown) {
    const session = sessionById.get(contribution.sessionArtifactId);
    // A contribution whose session the org-scoped projection did not return is
    // DROPPED, not rendered from the edge alone. The projection is the second
    // org check on this path; emitting a bare id past it would turn a filtered
    // row into a visible one.
    if (session === undefined) {
      dropped++;
      continue;
    }
    items.push({
      sessionArtifactId: session.artifactId,
      slug: session.artifact.slug,
      name: session.nameOverride ?? session.artifact.name,
      status: projectDisplayedSessionStatus({
        status: session.artifact.status,
        awaitingInputSince: session.awaitingInputSince,
        sessionEndedAt: session.sessionEndedAt,
        lastActivityAt: session.lastActivityAt,
        sessionStartedAt: session.sessionStartedAt,
        endsWithError: session.endsWithError,
      }),
      owner: session.artifact.assignee
        ? {
            id: session.artifact.assignee.id,
            firstName: session.artifact.assignee.firstName,
            lastName: session.artifact.assignee.lastName,
            avatarUrl: session.artifact.assignee.avatarUrl,
          }
        : null,
      kind: contribution.kind,
      contributedAt: contribution.occurredAt.toISOString(),
    });
  }

  // `total` must describe sessions the reader could REACH, not edges we read.
  // Subtracting the drops is what keeps it that way: a row discarded inside the
  // cap would otherwise leave `total > items.length` for a reason the cap did
  // not cause, and the field renders that difference as "+N more" — an offer to
  // reveal sessions that are not there. Drops BEYOND the cap are unknowable
  // without fetching them, so `total` stays an upper bound there, never an
  // overstatement caused by something we already observed.
  return { items, total: total - dropped };
}

async function listRelatedSessionProjectionsByArtifactIds(
  organizationId: string,
  artifactIds: readonly string[]
): Promise<RelatedSessionProjection[]> {
  const ids = [...new Set(artifactIds)];
  if (ids.length === 0) {
    return [];
  }

  return await withDb((db) =>
    db.sessionDetail.findMany({
      where: {
        artifactId: { in: ids },
        artifact: { is: { organizationId } },
      },
      select: relatedSessionSummarySelect,
    })
  );
}

function groupContributionsByArtifact(
  contributions: readonly TargetedSessionProvenanceContribution[]
): Map<string, TargetedSessionProvenanceContribution[]> {
  const grouped = new Map<string, TargetedSessionProvenanceContribution[]>();
  for (const contribution of contributions) {
    const held = grouped.get(contribution.targetId);
    if (held === undefined) {
      grouped.set(contribution.targetId, [contribution]);
      continue;
    }
    held.push(contribution);
  }
  return grouped;
}

/** Narrows a Related Sessions read to some sessions, or to a search. */
export type RelatedSessionFilter = {
  sessionArtifactIds?: readonly string[];
  sessionSearch?: string;
};

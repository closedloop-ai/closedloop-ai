/**
 * Shared real-Postgres fixture for the session→PR link lane
 * (`persistSessionPrArtifactLinks`).
 *
 * Extracted from `pr-links-replace-lock.integration.test.ts` and
 * `pr-links-paginated-merge.integration.test.ts` (ISS-9859): the two suites
 * are one contract read from two sides — page 0 replaces, later parts merge —
 * and a hand-written copy of the seed and the readers in each would let them
 * drift on what a "linked PR" even is. Only the PR→branch resolution differs
 * per suite, so that is the one thing a caller supplies.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, type TransactionClient, withDb } from "@repo/database";
import { createTestOrganization } from "@/__tests__/utils/db-helpers";
import { persistSessionPrArtifactLinks } from "@/app/agent-sessions/service/artifact-links/pr-links";
import {
  type SessionPullRequestDetailMap,
  sessionPullRequestDetailKey,
} from "@/app/agent-sessions/service/artifact-links/pull-request-details";
import type { SessionPrLinkWriteMode } from "@/app/agent-sessions/service/artifact-links/session-pr-link-merge";

export const SESSION_PR_LINK_REPO = "acme/web";

export type SessionPrLinkBranch = "branch-1" | "branch-2";

export type SessionPrLinkFixture = {
  organizationId: string;
  sessionArtifactId: string;
  branchArtifactIds: Record<SessionPrLinkBranch, string>;
  /** Verified-detail resolution for every PR number the suite declares. */
  detailMap: SessionPullRequestDetailMap;
};

export function prRef(
  prNumber: number,
  relationType: SessionPrRelationType = SessionPrRelationType.Created
) {
  return { repositoryFullName: SESSION_PR_LINK_REPO, prNumber, relationType };
}

/**
 * One session artifact plus two branch artifacts, named after `label`, with
 * each listed PR number resolving to the branch the suite assigns it.
 */
export async function seedSessionPrLinkFixture(
  label: string,
  branchByPrNumber: Record<number, SessionPrLinkBranch>
): Promise<SessionPrLinkFixture> {
  const organizationId = await createTestOrganization();
  return withDb(async (db) => {
    const session = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: `session-${label}`,
        status: SESSION_STATUS.ACTIVE,
      },
      select: { id: true },
    });
    const branchArtifactIds: Record<SessionPrLinkBranch, string> = {
      "branch-1": await createBranchArtifact(db, organizationId, label, 1),
      "branch-2": await createBranchArtifact(db, organizationId, label, 2),
    };
    return {
      organizationId,
      sessionArtifactId: session.id,
      branchArtifactIds,
      detailMap: new Map(
        Object.entries(branchByPrNumber).map(([prNumber, branch]) => [
          sessionPullRequestDetailKey(SESSION_PR_LINK_REPO, Number(prNumber)),
          {
            prDetailId: `prd-${prNumber}`,
            branchArtifactId: branchArtifactIds[branch],
          },
        ])
      ),
    };
  });
}

/**
 * Run the lane once. `mode` omitted takes the parameter's own default, which is
 * the path every payload not marked `prRefsPaginated: true` takes in
 * production, page 0 (`false`) included.
 */
export function persistSessionPrLinks(
  fixture: SessionPrLinkFixture,
  refs: Parameters<typeof persistSessionPrArtifactLinks>[3],
  mode?: SessionPrLinkWriteMode
) {
  return withDb((db) =>
    persistSessionPrArtifactLinks(
      db,
      fixture.organizationId,
      fixture.sessionArtifactId,
      refs,
      fixture.detailMap,
      mode
    )
  );
}

/** Every PR number the session's links declare, ascending. */
export async function linkedPrNumbers(
  fixture: SessionPrLinkFixture
): Promise<number[]> {
  const links = await withDb((db) =>
    db.artifactLink.findMany({
      where: {
        organizationId: fixture.organizationId,
        sourceId: fixture.sessionArtifactId,
        linkType: LinkType.RelatesTo,
      },
      select: { metadata: true },
    })
  );
  return links
    .flatMap((link) => {
      const metadata = link.metadata as { prRefs?: { prNumber: number }[] };
      return (metadata.prRefs ?? []).map((ref) => ref.prNumber);
    })
    .sort((left, right) => left - right);
}

export function sessionPrLinkRow(
  fixture: SessionPrLinkFixture,
  branch: SessionPrLinkBranch
) {
  return withDb((db) =>
    db.artifactLink.findUniqueOrThrow({
      where: {
        sourceId_targetId_linkType: {
          sourceId: fixture.sessionArtifactId,
          targetId: fixture.branchArtifactIds[branch],
          linkType: LinkType.RelatesTo,
        },
      },
      select: {
        metadata: true,
        branchParticipation: true,
        branchParticipationMethod: true,
        branchParticipationObservedAt: true,
      },
    })
  );
}

export async function sessionPrLinkMetadata(
  fixture: SessionPrLinkFixture,
  branch: SessionPrLinkBranch
): Promise<Record<string, unknown>> {
  const link = await sessionPrLinkRow(fixture, branch);
  return link.metadata as Record<string, unknown>;
}

async function createBranchArtifact(
  db: TransactionClient,
  organizationId: string,
  label: string,
  ordinal: number
): Promise<string> {
  const branch = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.BRANCH,
      name: `branch-${ordinal}-${label}`,
      status: BranchStatus.Open,
    },
    select: { id: true },
  });
  return branch.id;
}

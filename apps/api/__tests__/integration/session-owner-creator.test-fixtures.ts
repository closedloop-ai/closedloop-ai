import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import {
  type createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { createTestBranchArtifact } from "./usage-typed-sql-statements.test-helpers";

type OrganizationTracker = ReturnType<
  typeof createCommittedTestOrganizationTracker
>;

export const OWNED_BY_A_COST = 1.5;
export const CREATED_BY_A_COST = 20;

/**
 * ISS-12251: two sessions that keep three people apart. Each session's
 * recording user (`compute_targets.user_id`) is a third person; one session is
 * owned (assigned) by A and created by C, the other owned by C and created by
 * A. Swapping the Owner and Created-by predicates, or keying either on the
 * recording user, changes every answer read from it. The names sort
 * A < recorder < C, so the Owner sort answers differently on every wrong
 * column.
 */
export type OwnerCreatorFixture = {
  organizationId: string;
  personA: string;
  personC: string;
  recorder: string;
  /** Owner A, created by C, linked to a merged PR. */
  ownedByA: string;
  /** Owner C, created by A, no PR. */
  createdByA: string;
};

export async function seedOwnerCreatorSplit(
  organizations: OrganizationTracker
): Promise<OwnerCreatorFixture> {
  const organizationId = await organizations.create();
  const [{ id: personA }, { id: personC }, { id: recorder }] =
    await Promise.all([
      createTestUser(organizationId, { firstName: "Ada", lastName: "A" }),
      createTestUser(organizationId, { firstName: "Cy", lastName: "C" }),
      createTestUser(organizationId, { firstName: "Bo", lastName: "B" }),
    ]);
  const branchArtifactId = await createTestBranchArtifact(
    organizationId,
    "owned-by-a"
  );
  const ownedByA = await linkValidSessionToBranch({
    organizationId,
    userId: recorder,
    branchArtifactId,
    label: "owned-by-a",
    linkKind: SessionArtifactLinkKind.SessionPr,
    cost: { estimatedCost: OWNED_BY_A_COST },
  });
  const createdByA = await createTestSessionDetail({
    organizationId,
    userId: recorder,
    label: "created-by-a",
    cost: { estimatedCost: CREATED_BY_A_COST },
  });
  await withDb(async (db) => {
    await db.artifact.update({
      where: { id: ownedByA },
      data: { assigneeId: personA, createdById: personC },
      select: { id: true },
    });
    await db.artifact.update({
      where: { id: createdByA },
      data: { assigneeId: personC, createdById: personA },
      select: { id: true },
    });
  });
  return { organizationId, personA, personC, recorder, ownedByA, createdByA };
}

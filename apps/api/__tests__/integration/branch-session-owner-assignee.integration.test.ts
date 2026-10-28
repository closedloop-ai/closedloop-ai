import { randomUUID } from "node:crypto";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BRANCH_PUSH_METHOD_VALUES,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  closedloopKey,
  FIRST_PUSHED_AT,
  seedBranch,
} from "@/__tests__/support/branches/contributor-parity.test-fixtures";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { branchOwnerIdentityLateralSql } from "@/app/branches/branch-read-service/branch-session-identity-sql";
import { resolveBranchDetailIdentityData } from "@/app/branches/branch-read-service/identity-attribution";
import {
  readSessionUsageLinks,
  SESSION_USAGE_BRANCH_ID_CHUNK_SIZE,
} from "@/app/branches/branch-read-service/session-usage-link-read";

/**
 * ISS-12251 (PLN-2176 T-3.3, operator rulings 2026-10-13) splits the two people
 * a Branch reads off a linked session:
 *
 *  - the session's Owner is its assignee, for the session-level surfaces that
 *    say "owner": the linked-session chip, the "Session owner" timeline grouping
 *    and the per-owner usage rollup;
 *  - the Branch Owner's push rung names the person who pushed, the pushing
 *    session's creator, so reassigning that session must not move it.
 *
 * ISS-12463: the Branch Owner is the branch's own assignee, seeded once from
 * that rung, so reassigning the session must not move the branch assignee.
 *
 * The fixture keeps creator, recorder (`compute_targets.user_id`) and assignee
 * apart on one pushing session, reassigned after the push.
 */

const tracker = createCommittedTestOrganizationTracker();
const BRANCH_NAME = "feature/owner-assignee";

type Fixture = {
  organizationId: string;
  branchId: string;
  sessionId: string;
  pusher: string;
  recorder: string;
  owner: string;
};

describe.skipIf(!keys().DATABASE_URL)(
  "Branch session owner is the session's assignee, Branch Owner its pusher (ISS-12251)",
  () => {
    afterEach(() => tracker.cleanup());

    it("reads the assignee as the linked session's owner on the Prisma and raw link reads", async () => {
      const fixture = await seedFixture();
      const padding = Array.from(
        { length: SESSION_USAGE_BRANCH_ID_CHUNK_SIZE - 1 },
        () => randomUUID()
      );

      for (const branchIds of [
        [fixture.branchId],
        [fixture.branchId, ...padding],
      ]) {
        const links = await withDb((db) =>
          readSessionUsageLinks(db, fixture.organizationId, branchIds, {
            includeReviewedIdentityEvidence: true,
          })
        );
        expect(links.map((link) => link.source.session?.ownerUserId)).toEqual([
          fixture.owner,
        ]);
      }
    });

    it("keeps the pusher on the SQL observed-push rung after the pushing session is reassigned", async () => {
      const fixture = await seedFixture();

      const rows = await withDb((db) =>
        db.$queryRaw<{ ownerKey: string | null }[]>(Prisma.sql`
          SELECT branch_owner_identity.observed_owner_key AS "ownerKey"
          FROM artifacts a
          JOIN branch_detail b ON b.artifact_id = a.id
          ${branchOwnerIdentityLateralSql()}
          WHERE a.organization_id = ${fixture.organizationId}::uuid
            AND a.id = ${fixture.branchId}::uuid
            AND a.type = ${ArtifactType.Branch}::"ArtifactType"
        `)
      );

      expect(rows).toEqual([{ ownerKey: closedloopKey(fixture.pusher) }]);
    });

    it("keeps the pusher as the Branch assignee and Owner while the session owner follows the assignee", async () => {
      const fixture = await seedFixture();

      const branch = await withDb((db) =>
        db.artifact.findUniqueOrThrow({
          where: { id: fixture.branchId },
          select: { assigneeId: true },
        })
      );
      const { usageByBranch, identityByBranch } = await withDb((db) =>
        resolveBranchDetailIdentityData(db, fixture.organizationId, {
          id: fixture.branchId,
          assigneeId: branch.assigneeId,
          branch: { firstPushedAt: FIRST_PUSHED_AT },
          pullRequestDetails: [],
        })
      );

      expect(branch.assigneeId).toBe(fixture.pusher);
      expect(
        identityByBranch.get(fixture.branchId)?.ownerIdentity.person?.userId
      ).toBe(fixture.pusher);
      const usage = usageByBranch.get(fixture.branchId);
      expect(usage?.sessionOwnerById.get(fixture.sessionId)).toBe(
        fixture.owner
      );
    });
  }
);

async function seedFixture(): Promise<Fixture> {
  const organizationId = await tracker.create();
  const [{ id: pusher }, { id: recorder }, { id: owner }] = await Promise.all([
    createTestUser(organizationId),
    createTestUser(organizationId),
    createTestUser(organizationId),
  ]);
  const branchId = await seedBranch(organizationId, BRANCH_NAME);
  const sessionId = await linkValidSessionToBranch({
    organizationId,
    userId: recorder,
    branchArtifactId: branchId,
    label: "owner-assignee",
    linkKind: SessionArtifactLinkKind.SessionBranch,
  });
  await withDb(async (db) => {
    await db.artifact.update({
      where: { id: sessionId },
      data: { createdById: pusher, assigneeId: pusher },
      select: { id: true },
    });
    await db.artifactLink.updateMany({
      where: { organizationId, sourceId: sessionId, targetId: branchId },
      data: {
        branchParticipationMethod: BRANCH_PUSH_METHOD_VALUES[0],
        branchParticipationObservedAt: FIRST_PUSHED_AT,
      },
    });
  });
  // The push link's writer seeds the branch assignee (ISS-12463).
  await withDb.tx((tx) => seedBranchOwners(tx, organizationId, [branchId]));
  await withDb(async (db) => {
    // Reassigned after the push: the session's Owner moves, its pusher does not.
    await db.artifact.update({
      where: { id: sessionId },
      data: { assigneeId: owner },
      select: { id: true },
    });
  });
  return { organizationId, branchId, sessionId, pusher, recorder, owner };
}

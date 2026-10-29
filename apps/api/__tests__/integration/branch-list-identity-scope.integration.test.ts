import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { Prisma, withDb } from "@repo/database";
import { afterEach, describe, expect, it } from "vitest";
import {
  closedloopKey,
  FIRST_PUSHED_AT,
  HAS_DATABASE,
  type IdentitySqlRow,
  readIdentityProjections,
  seedBranch,
  seedGitHubComment,
  seedNativeComment,
} from "@/__tests__/utils/branch-identity-sql-fixture";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  explainAnalyze,
  explainIndexPathsWithout,
  relationLoops,
  relationScans,
} from "@/__tests__/utils/explain-plan";
import { branchCollaboratorIdentityCtesSql } from "@/app/branches/branch-list-sql/branch-list-identity-sql";
import { BRANCH_COMMENT_EVIDENCE_MAX_ROWS as COMMENT_EVIDENCE_LIMIT } from "@/app/branches/branch-read-service/identity-evidence-limits";

/**
 * ISS-12775 — the Collaborator identity reads every branch of its scope in one
 * pass. These cases hold what the one-branch oracle suites cannot see: branches
 * sharing a scope keep their own evidence, the JS projector's label wins when two
 * reads name one person differently, and the plan stays one pass.
 */

const describeIfDb = HAS_DATABASE ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

type CollaboratorRow = Pick<
  IdentitySqlRow,
  "collaboratorKeys" | "collaboratorLabels" | "collaboratorAvailability"
>;

describeIfDb("branch list collaborator identity scope (ISS-12775)", () => {
  it("keeps each branch's PR-comment collaborator to that branch in a shared scope", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const branches: { branchId: string; userId: string }[] = [];
      for (const index of [0, 1]) {
        const user = await createTestUser(organizationId);
        const branchId = await seedBranch(
          organizationId,
          `pr-comment-only-${index}`,
          { firstPushedAt: FIRST_PUSHED_AT }
        );
        await seedGitHubComment({
          organizationId,
          branchId,
          label: `pr-comment-only-${index}`,
          author: {
            userId: user.id,
            providerUserId: `${7100 + index}`,
            providerLogin: `commenter-${index}`,
            displayName: `Commenter ${index}`,
            providerDetail: { actorType: GitHubActorType.User },
          },
        });
        branches.push({ branchId, userId: user.id });
      }

      const scoped = await readScopedIdentity(
        organizationId,
        branches.map(({ branchId }) => branchId)
      );

      for (const { branchId, userId } of branches) {
        const { expected } = await readIdentityProjections(
          organizationId,
          branchId
        );
        expect(scoped.get(branchId)).toEqual({
          collaboratorKeys: expected.collaboratorKeys,
          collaboratorLabels: expected.collaboratorLabels,
          collaboratorAvailability: expected.collaboratorAvailability,
        });
        expect(scoped.get(branchId)?.collaboratorKeys).toEqual([
          closedloopKey(userId),
        ]);
      }
    });
  });

  it("ranks PR comments per branch, so a branch at the evidence cap leaves the next branch's commenter", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const branches: { branchId: string; userId: string }[] = [];
      for (const index of [0, 1]) {
        const user = await createTestUser(organizationId);
        const branchId = await seedBranch(organizationId, `capped-${index}`, {
          firstPushedAt: FIRST_PUSHED_AT,
        });
        await seedGitHubComment({
          organizationId,
          branchId,
          label: `capped-${index}`,
          author: {
            userId: user.id,
            providerUserId: `${7200 + index}`,
            providerLogin: `capped-${index}`,
            displayName: `Capped ${index}`,
            providerDetail: { actorType: GitHubActorType.User },
          },
        });
        branches.push({ branchId, userId: user.id });
      }
      // The first branch's comments all sort before the second's, so a rank
      // taken across the scope would put the second branch's one comment past
      // the cap.
      await fillPullRequestCommentsToCap(branches[0].branchId);

      const scoped = await readScopedIdentity(
        organizationId,
        branches.map(({ branchId }) => branchId)
      );

      for (const { branchId, userId } of branches) {
        const { expected } = await readIdentityProjections(
          organizationId,
          branchId
        );
        expect(scoped.get(branchId)).toEqual({
          collaboratorKeys: expected.collaboratorKeys,
          collaboratorLabels: expected.collaboratorLabels,
          collaboratorAvailability: expected.collaboratorAvailability,
        });
        expect(scoped.get(branchId)?.collaboratorKeys).toEqual([
          closedloopKey(userId),
        ]);
      }
    });
  });

  it("labels a PR author both pull request reads name the way the JS projector does", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "pr-author-tie", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      // The login read labels the person by their own name; the provider-id
      // read, with no author row, by the PR's login. One key, two labels.
      await withDb(async (db) => {
        await db.gitHubUserConnection.create({
          data: {
            organizationId,
            userId: user.id,
            githubUserId: "4242",
            login: "octo-author",
            normalizedLogin: "octo-author",
          },
          select: { id: true },
        });
        await db.pullRequestDetail.create({
          data: {
            organizationId,
            branchArtifactId: branchId,
            repositoryFullName: "acme/pr-author-tie",
            number: 1,
            authorLogin: "octo-author",
            authorActorType: GitHubActorType.User,
            authorProviderUserId: "4242",
          },
          select: { id: true },
        });
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);
      expect(sql.collaboratorKeys).toEqual([closedloopKey(user.id)]);
    });
  });

  it("resolves verified GitHub connections once for the scope, not once per evidence row", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchIds: string[] = [];
      for (const branch of [0, 1]) {
        const branchId = await seedBranch(
          organizationId,
          `verified-${branch}`,
          {
            firstPushedAt: FIRST_PUSHED_AT,
          }
        );
        for (const comment of [0, 1]) {
          await seedGitHubComment({
            organizationId,
            branchId,
            label: `verified-${branch}-${comment}`,
            author: {
              userId: user.id,
              providerUserId: `${8100 + branch * 10 + comment}`,
              providerLogin: `verified-${branch}-${comment}`,
              displayName: `Verified ${branch}-${comment}`,
              providerDetail: { actorType: GitHubActorType.User },
            },
          });
        }
        branchIds.push(branchId);
      }

      const plan = await explainAnalyze(
        scopedIdentitySql(organizationId, branchIds)
      );

      expect(
        relationLoops(plan, "github_user_connections", "connection")
      ).toEqual([1]);
    });
  });

  it("can read every live comment index-only through comments_thread_live_cover_idx", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const branchId = await seedBranch(organizationId, "cover-index", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      const commenter = await createTestUser(organizationId);
      await seedNativeComment({
        organizationId,
        artifactId: branchId,
        authorId: commenter.id,
      });

      // An index-only scan is priced on the pages the visibility map marks
      // all-visible, which VACUUM sets; fresh rows have none.
      await withDb((db) => db.$executeRaw`VACUUM (ANALYZE) comments`);

      // comments_thread_id_created_at_idx also serves a thread lookup, and
      // which of the two wins is a cost near-tie the rows earlier suites left
      // on the shared database decide. Dropped here, the question is only
      // whether the cover index serves every read index-only.
      const plan = await explainIndexPathsWithout(
        scopedIdentitySql(organizationId, [branchId]),
        ["comments_thread_id_created_at_idx"]
      );

      // Branch, session, PR and direct comment reads.
      expect(
        relationScans(plan, "comments").map((scan) => [
          scan["Node Type"],
          scan["Index Name"],
        ])
      ).toEqual(
        Array.from({ length: 4 }, () => [
          "Index Only Scan",
          "comments_thread_live_cover_idx",
        ])
      );
    });
  });
});

function scopedIdentitySql(
  organizationId: string,
  branchIds: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH ${branchCollaboratorIdentityCtesSql(Prisma.sql`
      SELECT a.id FROM artifacts a
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.id IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
    `)}
    SELECT
      branch_collaborator_identity.branch_id AS "branchId",
      branch_collaborator_identity.collaborator_keys AS "collaboratorKeys",
      branch_collaborator_identity.collaborator_labels AS "collaboratorLabels",
      branch_collaborator_identity.collaborator_availability AS "collaboratorAvailability"
    FROM branch_collaborator_identity
  `;
}

async function readScopedIdentity(
  organizationId: string,
  branchIds: readonly string[]
): Promise<Map<string, CollaboratorRow>> {
  const rows = await withDb((db) =>
    db.$queryRaw<(CollaboratorRow & { branchId: string })[]>(
      scopedIdentitySql(organizationId, branchIds)
    )
  );
  return new Map(rows.map(({ branchId, ...row }) => [branchId, row]));
}

/** Tops the branch's one seeded PR comment thread up to the cap with older comments. */
async function fillPullRequestCommentsToCap(branchId: string): Promise<void> {
  await withDb(
    (db) => db.$executeRaw`
      WITH seed AS (
        SELECT c.thread_id, c.author_id, c.body, c.body_format, gcp.external_author_id
        FROM github_comment_thread_projections tp
        INNER JOIN github_comment_projections gcp ON gcp.thread_id = tp.thread_id
        INNER JOIN comments c ON c.id = gcp.comment_id
        WHERE tp.branch_artifact_id = ${branchId}::uuid
      ),
      filled AS (
        INSERT INTO comments (id, thread_id, author_id, body, body_format, created_at, updated_at)
        SELECT gen_random_uuid(), seed.thread_id, seed.author_id, seed.body,
          seed.body_format, ${FIRST_PUSHED_AT}, now()
        FROM seed CROSS JOIN generate_series(2, ${COMMENT_EVIDENCE_LIMIT}::int)
        RETURNING id, thread_id
      )
      INSERT INTO github_comment_projections (comment_id, thread_id, external_author_id)
      SELECT filled.id, filled.thread_id, seed.external_author_id
      FROM filled INNER JOIN seed ON seed.thread_id = filled.thread_id
    `
  );
}

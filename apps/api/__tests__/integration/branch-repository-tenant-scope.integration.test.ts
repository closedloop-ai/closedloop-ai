import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  ArtifactType,
  GitHubInstallationStatus,
  Prisma,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { branchSelectedPullRequestLateralSql } from "@/app/branches/branch-associated-pull-request-sql";
import type { BranchListOperationQuery } from "@/app/branches/branch-list-query";
import { branchListDimensionCteSql } from "@/app/branches/branch-list-sql/branch-list-dimension-sql";

/**
 * ISS-10298 (davetho review on #7545) — `branch_detail.repository_id` and
 * `pull_request_detail.repository_id` are single-column FKs to
 * `github_installation_repositories`, which carries no `organization_id`, so no
 * constraint ties the row they select to the artifact's tenant. Resolving one by
 * id alone let a corrupt cross-tenant pointer hand a FOREIGN `full_name` to
 * pull-request selection and to the Branch list's Repository facet.
 *
 * TWO organizations, because one cannot tell a scoped join from an unscoped one:
 * the leaking pointer must reference a repository row that genuinely exists and
 * genuinely belongs to somebody else.
 *
 * What each branch pins:
 *
 * - `feat/relation-control` — the tenant's OWN pointer, whose repository row
 *   names a repository its `branch_detail` column does NOT. Ownership resolves
 *   through the relation, so an ownership predicate that rejected every row
 *   would fall back to the stale column and red this case. It is the positive
 *   control for both absences below.
 * - `feat/adopts-own-pull-request` — a FOREIGN pointer with the tenant's own
 *   pull request. The fallback must keep the branch's own repository, so the
 *   pull request stays selected: degrade, never drop.
 * - `feat/adopts-foreign-pull-request` — the leak itself. The foreign row used
 *   to establish ownership, so this branch adopted a pull request in the other
 *   tenant's repository.
 * - `feat/faceted` — the only eligible branch, so the Repository facet is
 *   reachable. Its control is the same relation-over-column precedence.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const NOW = new Date("2026-08-20T12:00:00.000Z");
/**
 * The tenant's repository row keeps the provider's casing while `branch_detail`
 * stores the lowercased copy. Eligibility compares them case-insensitively, so
 * they agree there, while the Repository facet is deliberately un-normalized —
 * which is what makes "resolved through the relation" observable rather than
 * coincidental.
 */
const TENANT_REPOSITORY_DISPLAY_NAME = "Acme/Widgets";
const TENANT_REPOSITORY = "acme/widgets";
/** A name only the `branch_detail` COLUMN carries, never the repository row. */
const TENANT_STALE_REPOSITORY = "acme/widgets-before-rename";
/** The other tenant's repository. No query in this file may surface it. */
const FOREIGN_REPOSITORY = "evil-org/secret-repo";
const TENANT_GITHUB_REPO_ID = "github-repo-acme-widgets";

type DimensionRow = { id: string; repository: string };
type SelectedPullRequestRow = { number: number | null };

function operationQuery(): BranchListOperationQuery {
  return {
    pageMode: BranchListPageMode.Server,
    limit: 25,
    offset: 0,
    sortKey: BranchListSortKey.Name,
    sortDir: BranchListSortDirection.Asc,
    evaluationNow: NOW,
  } as BranchListOperationQuery;
}

/** The Repository facet's own column, read straight off the dimension CTE. */
function readDimensionRows(organizationId: string): Promise<DimensionRow[]> {
  return withDb((db) =>
    db.$queryRaw<DimensionRow[]>(Prisma.sql`
      SELECT dims.id::text AS id, dims.repository
      FROM (${branchListDimensionCteSql(organizationId, operationQuery(), NOW)}) dims
    `)
  );
}

/** Pull-request selection, which the status and Pull-request facets read. */
function readSelectedPullRequest(
  branchArtifactId: string
): Promise<SelectedPullRequestRow[]> {
  return withDb((db) =>
    db.$queryRaw<SelectedPullRequestRow[]>(Prisma.sql`
      SELECT selected_pull_request.number
      FROM artifacts a
      INNER JOIN branch_detail b ON b.artifact_id = a.id
      LEFT JOIN LATERAL (${branchSelectedPullRequestLateralSql()})
        selected_pull_request ON TRUE
      WHERE a.id = ${branchArtifactId}::uuid
    `)
  );
}

/**
 * An ACTIVE installation owned by `organizationId` plus one repository row on
 * it. The foreign organization's installation is a real, CLAIMED one — a
 * pointer into an unclaimed install would be rejected by the nullable
 * `organization_id` for a second reason and would not prove the scoping.
 */
async function createInstallationRepository(params: {
  organizationId: string;
  fullName: string;
  githubRepoId: string;
}): Promise<string> {
  return await withDb(async (db) => {
    const installation = await db.gitHubInstallation.create({
      data: {
        organizationId: params.organizationId,
        installationId: `installation-${params.organizationId}`,
        accountId: `account-${params.organizationId}`,
        accountLogin: params.fullName.split("/")[0] ?? "acme",
        accountType: "Organization",
        senderLogin: "fixture-user",
        senderId: `sender-${params.organizationId}`,
        status: GitHubInstallationStatus.ACTIVE,
      },
      select: { id: true },
    });
    const repository = await db.gitHubInstallationRepository.create({
      data: {
        installationId: installation.id,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: params.githubRepoId,
          fullName: params.fullName,
        }),
        name: params.fullName.split("/").at(-1) ?? params.fullName,
        owner: params.fullName.split("/")[0] ?? "acme",
        private: false,
      },
      select: { id: true },
    });
    return repository.id;
  });
}

/**
 * The second authority arm `cloudBranchEligibilitySql` reads. It must agree
 * with the installation repository on both the provider id and the lowercased
 * name, or no branch is an eligible list row and the facet assertion below
 * would be vacuous.
 */
async function seedRepositoryAuthority(organizationId: string) {
  await withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: TENANT_GITHUB_REPO_ID,
          fullName: TENANT_REPOSITORY,
        }),
        owner: "acme",
        name: "widgets",
        htmlUrl: `https://github.com/${TENANT_REPOSITORY}`,
      },
      select: { id: true },
    })
  );
}

async function seedBranch(params: {
  organizationId: string;
  userId: string;
  branchName: string;
  branchRepositoryId: string;
  branchRepositoryFullName: string;
  pullRequestRepositoryFullName: string;
  pullRequestNumber: number;
}): Promise<string> {
  const artifactId = await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId: params.organizationId,
        type: ArtifactType.BRANCH,
        name: params.branchName,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId: params.organizationId,
        repositoryFullName: params.branchRepositoryFullName,
        repositoryId: params.branchRepositoryId,
        branchName: params.branchName,
        firstPushedAt: new Date(NOW.getTime() - 86_400_000),
        pushSource: BranchPushSource.Session,
        lastActivityAt: NOW,
      },
      select: { artifactId: true },
    });
    await db.pullRequestDetail.create({
      data: {
        organizationId: params.organizationId,
        branchArtifactId: artifact.id,
        number: params.pullRequestNumber,
        prState: GitHubPRState.Open,
        isDraft: false,
        repositoryFullName: params.pullRequestRepositoryFullName,
        githubCreatedAt: new Date(NOW.getTime() - 86_400_000),
        lastVerifiedAt: new Date(NOW.getTime() - 1_800_000),
      },
      select: { id: true },
    });
    return artifact.id;
  });
  await linkValidSessionToBranch({
    organizationId: params.organizationId,
    branchArtifactId: artifactId,
    userId: params.userId,
    label: params.branchName,
  });
  return artifactId;
}

describeIfDb(
  "branch repository joins are scoped to the artifact's tenant",
  () => {
    it("degrades a cross-tenant repository pointer instead of reading its name", async () => {
      const tenantOrganizationId = await committedOrganizations.create();
      const foreignOrganizationId = await committedOrganizations.create();
      const foreignRepositoryId = await createInstallationRepository({
        organizationId: foreignOrganizationId,
        fullName: FOREIGN_REPOSITORY,
        githubRepoId: "github-repo-evil-secret",
      });
      const tenantRepositoryId = await createInstallationRepository({
        organizationId: tenantOrganizationId,
        fullName: TENANT_REPOSITORY_DISPLAY_NAME,
        githubRepoId: TENANT_GITHUB_REPO_ID,
      });
      await seedRepositoryAuthority(tenantOrganizationId);
      const user = await createTestUser(tenantOrganizationId);
      const seed = (
        branchName: string,
        branchRepositoryId: string,
        branchRepositoryFullName: string,
        pullRequestRepositoryFullName: string,
        pullRequestNumber: number
      ) =>
        seedBranch({
          organizationId: tenantOrganizationId,
          userId: user.id,
          branchName,
          branchRepositoryId,
          branchRepositoryFullName,
          pullRequestRepositoryFullName,
          pullRequestNumber,
        });
      const [
        relationControlBranchId,
        adoptsOwnBranchId,
        adoptsForeignBranchId,
        facetedBranchId,
      ] = await Promise.all([
        seed(
          "feat/relation-control",
          tenantRepositoryId,
          TENANT_STALE_REPOSITORY,
          TENANT_REPOSITORY,
          1
        ),
        seed(
          "feat/adopts-own-pull-request",
          foreignRepositoryId,
          TENANT_REPOSITORY,
          TENANT_REPOSITORY,
          2
        ),
        seed(
          "feat/adopts-foreign-pull-request",
          foreignRepositoryId,
          TENANT_REPOSITORY,
          FOREIGN_REPOSITORY,
          3
        ),
        seed(
          "feat/faceted",
          tenantRepositoryId,
          TENANT_REPOSITORY,
          TENANT_REPOSITORY,
          4
        ),
      ]);

      const [
        dimensionRows,
        relationControl,
        adoptsOwn,
        adoptsForeign,
        faceted,
      ] = await Promise.all([
        readDimensionRows(tenantOrganizationId),
        readSelectedPullRequest(relationControlBranchId),
        readSelectedPullRequest(adoptsOwnBranchId),
        readSelectedPullRequest(adoptsForeignBranchId),
        readSelectedPullRequest(facetedBranchId),
      ]);
      const repositoryById = new Map(
        dimensionRows.map((row) => [row.id, row.repository])
      );

      // POSITIVE CONTROLS, asserted first. Ownership reads the branch's own
      // repository RELATION ahead of its denormalized column, and the Repository
      // facet shows the repository ROW's casing rather than the lowercased copy
      // — so a predicate that resolved nothing for anybody reds here before it
      // could satisfy either absence below.
      expect(relationControl[0]?.number).toBe(1);
      expect(faceted[0]?.number).toBe(4);
      expect(repositoryById.get(facetedBranchId)).toBe(
        TENANT_REPOSITORY_DISPLAY_NAME
      );

      // A foreign pointer establishes no ownership, so it resolves to nothing
      // and ownership falls back to the branch's own repository column. Its own
      // pull request is still SELECTED — degrade, never drop.
      expect(adoptsOwn[0]?.number).toBe(2);

      // The leak: the foreign repository row used to supply the name ownership
      // was tested against, so this branch adopted a pull request that lives in
      // the other tenant's repository.
      expect(adoptsForeign[0]?.number).toBeNull();
      expect([...repositoryById.values()]).not.toContain(FOREIGN_REPOSITORY);
    });
  }
);

import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
} from "@repo/api/src/types/branch-list-contract";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";

/**
 * ISS-10298 AC1/AC2 — a server page hydrates and projects O(page), not
 * O(corpus).
 *
 * Both spies DELEGATE to the real implementation, so the read under assertion is
 * the production one and the page it returns is real. The corpus is deliberately
 * far larger than the page: an implementation that still reads every eligible
 * branch before slicing shows up as a hydration batch the size of the corpus,
 * which is exactly what this path used to do.
 *
 * `total` is asserted beside the batch size on purpose. Bounding hydration is
 * only correct while the totals and facets still describe the whole corpus —
 * a page-bounded read that also narrowed the counts would pass the batch
 * assertion alone and would be the capability loss the ticket forbids.
 */

const hydrationBatchSizes: number[] = [];
const projectionBatchSizes: number[] = [];

vi.mock("@/app/branches/branch-read-service/persisted-row-read", async () => {
  const actual = await import(
    "@/app/branches/branch-read-service/persisted-row-read"
  );
  return {
    ...actual,
    getBranchRowsById: vi.fn(
      (
        db: Parameters<typeof actual.getBranchRowsById>[0],
        organizationId: string,
        branchIds: string[],
        candidates: Parameters<typeof actual.getBranchRowsById>[3]
      ) => {
        hydrationBatchSizes.push(branchIds.length);
        return actual.getBranchRowsById(
          db,
          organizationId,
          branchIds,
          candidates
        );
      }
    ),
  };
});

vi.mock("@/app/branches/branch-list-projection", async () => {
  const actual = await import("@/app/branches/branch-list-projection");
  return {
    ...actual,
    projectBranchListRows: vi.fn(
      (
        db: Parameters<typeof actual.projectBranchListRows>[0],
        organizationId: string,
        rows: Parameters<typeof actual.projectBranchListRows>[2],
        ...rest: [
          Parameters<typeof actual.projectBranchListRows>[3],
          Parameters<typeof actual.projectBranchListRows>[4],
          Parameters<typeof actual.projectBranchListRows>[5],
        ]
      ) => {
        projectionBatchSizes.push(rows.length);
        return actual.projectBranchListRows(db, organizationId, rows, ...rest);
      }
    ),
  };
});

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

const NOW = new Date("2026-08-20T12:00:00.000Z");
const CORPUS_BRANCHES = 60;
// The smallest size the Branches server-page contract accepts.
const PAGE_LIMIT = BRANCH_LIST_SERVER_PAGE_SIZE;
const REPOSITORY_FULL_NAME = "acme/widgets";

beforeEach(() => {
  hydrationBatchSizes.length = 0;
  projectionBatchSizes.length = 0;
});

afterEach(() => committedOrganizations.cleanup());

async function seedCorpus(organizationId: string): Promise<void> {
  const user = await createTestUser(organizationId);
  await withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `repo-${organizationId}`,
          fullName: REPOSITORY_FULL_NAME,
        }),
        owner: "acme",
        name: "widgets",
        htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}`,
      },
      select: { id: true },
    })
  );
  for (let index = 0; index < CORPUS_BRANCHES; index += 1) {
    const branchName = `feat/branch-${String(index).padStart(3, "0")}`;
    const artifactId = await withDb(async (db) => {
      const artifact = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.BRANCH,
          name: branchName,
          status: BranchStatus.Open,
        },
        select: { id: true },
      });
      await db.branchDetail.create({
        data: {
          artifactId: artifact.id,
          organizationId,
          repositoryFullName: REPOSITORY_FULL_NAME,
          branchName,
          firstPushedAt: new Date(NOW.getTime() - 86_400_000),
          pushSource: BranchPushSource.Session,
          lastActivityAt: NOW,
        },
        select: { artifactId: true },
      });
      return artifact.id;
    });
    await linkValidSessionToBranch({
      organizationId,
      branchArtifactId: artifactId,
      userId: user.id,
      label: branchName,
    });
  }
}

describeIfDb("Branch list server page — bounded hydration", () => {
  it("hydrates and projects at most one page while the total spans the corpus", async () => {
    const organizationId = await committedOrganizations.create();
    await seedCorpus(organizationId);
    const { branchReadService } = await import(
      "@/app/branches/branch-read-service"
    );

    const response = await branchReadService.listBranches(organizationId, {
      pageMode: BranchListPageMode.Server,
      limit: PAGE_LIMIT,
      offset: 0,
    } as Parameters<typeof branchReadService.listBranches>[1]);

    expect(response.items).toHaveLength(PAGE_LIMIT);
    // The corpus is still what the totals and facets describe.
    expect(response.total).toBe(CORPUS_BRANCHES);
    expect(response.facets?.names.options).toHaveLength(CORPUS_BRANCHES);
    // ...and nothing beyond one page was ever hydrated or projected.
    expect(hydrationBatchSizes).not.toHaveLength(0);
    expect(projectionBatchSizes).not.toHaveLength(0);
    expect(Math.max(...hydrationBatchSizes)).toBeLessThanOrEqual(PAGE_LIMIT);
    expect(Math.max(...projectionBatchSizes)).toBeLessThanOrEqual(PAGE_LIMIT);
  });
});

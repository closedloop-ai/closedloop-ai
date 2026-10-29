import { BranchPushSource } from "@repo/api/src/types/artifact";
import type { BranchListResponse } from "@repo/api/src/types/branch";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { DEFAULT_BRANCH_STATUS_ORDERING } from "@repo/api/src/types/branch-status-order";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { createBranchListEnrichmentDomain } from "@/app/branches/branch-list-enrichment";
import type { BranchListOperationQuery } from "@/app/branches/branch-list-query";
import { withBranchProductReadSnapshot } from "@/app/branches/branch-product-read-snapshot";
import {
  type BranchReadClient,
  listServerPageBranches,
} from "@/app/branches/branch-read-service/server-page-list";

/**
 * ISS-10298 (davetho review on #7545) — the SQL page/total/facet read and the
 * eligibility read that hydrates the selected ids are two statements. If a
 * selected branch were deleted or became ineligible between them, hydration
 * would drop it while the envelope kept the earlier total: an offset client then
 * receives a SHORT page and never sees the branch that moved into the vacated
 * slot.
 *
 * They are one consistent snapshot, and this is what makes that a contract
 * rather than a coincidence: `withBranchProductReadSnapshot` runs the whole list
 * read inside one REPEATABLE READ transaction, so every statement in it reads
 * the snapshot the first one took. A mutation COMMITTED between the two reads is
 * therefore invisible to the second — which is only observable if the mutation
 * really does land between them, so the interception below commits it from a
 * SEPARATE connection the moment the page statement resolves.
 *
 * `deleted_at` is the mutation because `branchCandidateWhereClause` filters on
 * it directly (`b.deleted_at IS NULL`), so a torn read drops the row for a
 * production reason rather than a contrived one.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const NOW = new Date("2026-08-20T12:00:00.000Z");
const REPOSITORY = "acme/widgets";
/**
 * The smallest page size the contract offers, plus one branch, so the first page
 * is FULL and a second one exists. A torn read shortens the first page and
 * leaves the overflow branch reachable at no offset at all.
 */
const PAGE_LIMIT = BRANCH_LIST_SERVER_PAGE_SIZE;
/** Zero-padded so the ascending name sort is the seeding order. */
const BRANCH_NAMES = Array.from(
  { length: PAGE_LIMIT + 1 },
  (_unused, index) => `feat/branch-${String(index).padStart(2, "0")}`
);

function operationQuery(): BranchListOperationQuery {
  return {
    pageMode: BranchListPageMode.Server,
    limit: PAGE_LIMIT,
    offset: 0,
    sortKey: BranchListSortKey.Name,
    sortDir: BranchListSortDirection.Asc,
    evaluationNow: NOW,
  } as BranchListOperationQuery;
}

/**
 * Commit `mutate` on its own connection once the page statement has resolved
 * and before the eligibility read that consumes its ids. The page read is the
 * first `$queryRaw` the list read issues, so the first call IS the seam.
 */
function mutatingBetweenReads<Client extends BranchReadClient>(
  db: Client,
  mutate: () => Promise<unknown>
): Client {
  let seamPassed = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "$queryRaw" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args);
        if (!seamPassed) {
          seamPassed = true;
          await mutate();
        }
        return result;
      };
    },
  });
}

/**
 * Run the list read, soft-deleting `artifactId` at the seam between its two
 * statements.
 *
 * The mutation is scheduled OUTSIDE the read transaction on purpose. `withDb`
 * joins an ambient transaction through an `AsyncLocalStorage` store, so a
 * `withDb` call made from inside the snapshot callback would run the delete on
 * the snapshot's OWN connection — which every read after it then sees, proving
 * nothing about isolation. Registering the continuation out here binds it to the
 * outer context, so it commits on a connection of its own; the seam then
 * releases it and awaits it, which is what orders the commit strictly between
 * the two reads.
 */
async function readListDeletingBetweenReads(
  organizationId: string,
  artifactId: string
): Promise<BranchListResponse> {
  let release: (() => void) | undefined;
  const seam = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mutation = seam.then(() => softDeleteBranch(artifactId));
  return await withBranchProductReadSnapshot(organizationId, (db) =>
    listServerPageBranches(
      mutatingBetweenReads(db as BranchReadClient, async () => {
        release?.();
        await mutation;
      }),
      organizationId,
      undefined,
      operationQuery(),
      NOW,
      createBranchListEnrichmentDomain(),
      DEFAULT_BRANCH_STATUS_ORDERING
    )
  );
}

async function seedCorpus(organizationId: string) {
  const user = await createTestUser(organizationId);
  await withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `public-${organizationId}`,
          fullName: REPOSITORY,
        }),
        owner: "acme",
        name: "widgets",
        htmlUrl: `https://github.com/${REPOSITORY}`,
      },
      select: { id: true },
    })
  );
  const byName = new Map<string, string>();
  for (const branchName of BRANCH_NAMES) {
    byName.set(
      branchName,
      await seedBranch(organizationId, user.id, branchName)
    );
  }
  return byName;
}

async function seedBranch(
  organizationId: string,
  userId: string,
  branchName: string
) {
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
        repositoryFullName: REPOSITORY,
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
    userId,
    label: branchName,
  });
  return artifactId;
}

function softDeleteBranch(artifactId: string) {
  return withDb((db) =>
    db.branchDetail.update({
      where: { artifactId },
      data: { deletedAt: NOW },
      select: { artifactId: true },
    })
  );
}

describeIfDb("Branch list page and hydration share one snapshot", () => {
  it("returns a full page when a selected branch is deleted between the two reads", async () => {
    const organizationId = await committedOrganizations.create();
    const branchIdByName = await seedCorpus(organizationId);
    const selectedIds = BRANCH_NAMES.slice(0, PAGE_LIMIT).map(
      (branchName) => branchIdByName.get(branchName) ?? ""
    );
    const deletedId = selectedIds.at(-1) ?? "";

    const response = await readListDeletingBetweenReads(
      organizationId,
      deletedId
    );

    // The mutation is the whole premise, so prove it landed before reading
    // anything into the page: an interceptor that never fired would make every
    // assertion below a restatement of the ordinary path.
    await expect(
      withDb((db) =>
        db.branchDetail.findFirst({
          where: { artifactId: deletedId, deletedAt: { not: null } },
          select: { artifactId: true },
        })
      )
    ).resolves.not.toBeNull();

    // A full page, in the order the page statement named, with the branch that
    // was deleted mid-read still on it. Selection and hydration disagreeing
    // would drop it and leave a short page under an unchanged total.
    expect(response.items.map((item) => item.id)).toEqual(selectedIds);
    expect(response.total).toBe(BRANCH_NAMES.length);
    expect(response.hasMore).toBe(true);
    // And nothing was skipped: the overflow branch is still reached at the next
    // offset rather than having slid into a vacated slot on this one.
    expect(response.items.map((item) => item.id)).not.toContain(
      branchIdByName.get(BRANCH_NAMES[PAGE_LIMIT] ?? "")
    );
    expect(response.items).toHaveLength(PAGE_LIMIT);
  });
});

import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { ExternalCommentProvider, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readRepositoryPullRequestsFromProjection } from "@/app/integrations/github/projection-read";
import { GitHubServerSyncStatus } from "@/app/integrations/github/sync-service";
import {
  deleteFixture,
  mockProviderSuccess,
  PROVIDER_AUTHOR_ID,
  PROVIDER_AUTHOR_LOGIN,
  PROVIDER_BASE_BRANCH,
  refreshTombstoned,
  SEEDED_BRANCH_BASE,
  seedWriterFixture,
  type WriterFixture,
  wireClerkGitHubToken,
} from "../support/integrations/github/pr-lifecycle-writer.test-fixtures";

/**
 * ISS-8162 AC-2 is a producer-to-READER contract, and neither half of it is
 * observable from a mocked Prisma call: a payload can carry `base_ref_name`
 * into `updateMany` and still never reach the column (a guarded where that
 * matches nothing, a nested create the transaction rolls back), and the read
 * can serve a column the writer filled through a select or a mapping that drops
 * it. Both spellings ship the same unmeasured "" the ticket exists to remove.
 *
 * So these cases carry the contract end to end on a REAL Postgres: drive the
 * production producer, let it persist, then read the persisted row back through
 * the production `readRepositoryPullRequestsFromProjection`. Nothing between the
 * two is mocked; only GitHub itself, Clerk and the user-token client mint are.
 *
 * The counterfactual for every case is the state that shipped: a producer that
 * leaves `base_ref_name` / `author_login` unwritten makes the read serve the
 * absent form, which is what the "before" half of the first settle case pins as
 * the legacy row's behavior and what every "after" assertion rejects.
 */

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

// The tombstoned settle runs on the USER lane: it mints a client from the
// caller's own GitHub token and reads that token from Clerk (PLN-1742 M5 tail).
// Without both stubs the settle denies with `no_credential` before reaching the
// writer under test.
vi.mock("@repo/github/user-token-auth", () => ({
  getUserTokenOctokit: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(),
}));

const hasDatabase = Boolean(keys().DATABASE_URL);

describe.skipIf(!hasDatabase)(
  "ISS-8162 PR projection producer round-trip (real Postgres)",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
      wireClerkGitHubToken();
      vi.mocked(getUserTokenOctokit).mockReturnValue({
        rest: {
          users: {
            getAuthenticated: vi
              .fn()
              .mockResolvedValue({ data: { id: 4242, login: "iss-6421" } }),
          },
        },
      } as never);
    });

    // ISS-8176: the tombstoned settle learns a PR's base from GitHub. It writes
    // the PR row and the owning Branch's base in one transaction, so a payload
    // that stamps only the Branch commits cleanly and still leaves this read
    // serving the absent form. ISS-10992: the same write records the author's
    // provider identity (`ensurePullRequestAuthorIdentity`), pinned here on the
    // persisted row and the organization's external-author row.
    it("serves the base and author the tombstoned settle persisted", async () => {
      const fixture = await seedWriterFixture("projection-tombstone", {
        createPullRequest: true,
        tombstoned: true,
        withSyncAuthority: true,
      });
      try {
        const legacy = await readProjectedPullRequest(fixture);
        expect(legacy.baseBranch).toBe("");
        expect(legacy.author).toBe("");
        expect(legacy.baseBranch).not.toBe(SEEDED_BRANCH_BASE);

        mockProviderSuccess(fixture);
        await expect(refreshTombstoned(fixture, 0)).resolves.toMatchObject({
          status: GitHubServerSyncStatus.Refreshed,
        });

        const projected = await readProjectedPullRequest(fixture);
        expect(projected.baseBranch).toBe(PROVIDER_BASE_BRANCH);
        expect(projected.author).toBe(PROVIDER_AUTHOR_LOGIN);
        await expect(readPersistedAuthor(fixture)).resolves.toEqual({
          authorProviderUserId: PROVIDER_AUTHOR_ID,
          authorActorType: GitHubActorType.User,
        });
        await expect(
          withDb((db) =>
            db.externalCommentAuthor.findUnique({
              where: {
                organizationId_provider_providerUserId: {
                  organizationId: fixture.organizationId,
                  provider: ExternalCommentProvider.GITHUB,
                  providerUserId: PROVIDER_AUTHOR_ID,
                },
              },
              select: {
                providerUserId: true,
                user: { select: { active: true } },
              },
            })
          )
        ).resolves.toEqual({
          providerUserId: PROVIDER_AUTHOR_ID,
          user: { active: false },
        });
      } finally {
        await deleteFixture(fixture.organizationId);
      }
    });

    // The absent-author half, which only a real column can tell apart: this
    // payload's type always carries `authorLogin`, so passing GitHub's null
    // through would CLEAR a login another producer measured, and the read
    // renders a cleared login as "not measured". Omitting the key preserves it.
    // Both spellings look identical on a mocked Prisma call — the stored row is
    // the only place they differ.
    it("keeps a measured login when the tombstoned settle sees no provider author", async () => {
      const fixture = await seedWriterFixture("projection-tombstone-absent", {
        createPullRequest: true,
        tombstoned: true,
        withSyncAuthority: true,
      });
      try {
        await stampMeasuredAuthor(fixture);
        mockProviderSuccess(fixture, {
          authorLogin: null,
          authorProviderUserId: undefined,
          authorActorType: undefined,
        });

        await expect(refreshTombstoned(fixture, 0)).resolves.toMatchObject({
          status: GitHubServerSyncStatus.Refreshed,
        });

        const projected = await readProjectedPullRequest(fixture);
        expect(projected.author).toBe(PROVIDER_AUTHOR_LOGIN);
        expect(projected.baseBranch).toBe(PROVIDER_BASE_BRANCH);
      } finally {
        await deleteFixture(fixture.organizationId);
      }
    });
  }
);

/** The one PR the fixture repository projects, as the production read serves it. */
async function readProjectedPullRequest(fixture: WriterFixture) {
  const { pullRequests } = await readRepositoryPullRequestsFromProjection(
    { repositoryId: fixture.repositoryId },
    fixture.organizationId,
    { limit: 30, targetNumbers: [] }
  );
  const [projected] = pullRequests;
  if (!projected) {
    throw new Error(
      "the projection read served no row for the fixture repository"
    );
  }
  return projected;
}

function readPersistedAuthor(fixture: WriterFixture) {
  return withDb((db) =>
    db.pullRequestDetail.findFirstOrThrow({
      where: {
        organizationId: fixture.organizationId,
        branchArtifactId: fixture.branchArtifactId,
        number: fixture.pullRequestNumber,
      },
      select: { authorProviderUserId: true, authorActorType: true },
    })
  );
}

/** An author some earlier producer already measured on the seeded PR row. */
async function stampMeasuredAuthor(fixture: WriterFixture): Promise<void> {
  if (!fixture.pullRequestId) {
    throw new Error("the unattributed case requires a seeded pull request");
  }
  await withDb((db) =>
    db.pullRequestDetail.update({
      where: { id: fixture.pullRequestId as string },
      data: { authorLogin: PROVIDER_AUTHOR_LOGIN },
      select: { id: true },
    })
  );
}

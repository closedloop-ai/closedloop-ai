import { randomUUID } from "node:crypto";
import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { InsightsScope } from "@repo/api/src/types/insights";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactType,
  GitHubInstallationStatus,
  type Prisma,
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
import { isMergedPrPopulationUnmeasured } from "@/app/insights/delivery-measurement";
import { readDeliveryPullRequestFacts } from "@/app/insights/delivery-pull-request-facts";
import {
  censusMergedPrVerification,
  countDistinctMergedPrsFrom,
  fetchMergedPrs,
} from "@/app/insights/merged-pr-queries";
import type { InsightsScopeContext } from "@/app/insights/service/scope";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const WINDOW_START = new Date("2026-08-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-08-31T23:59:59.999Z");
const LAST_ACTIVITY_AT = new Date("2026-08-15T09:00:00.000Z");
const MERGED_AT = new Date("2026-08-15T12:00:00.000Z");
const VERIFIED_AT = new Date("2026-08-15T13:00:00.000Z");
const REPO_FULL_NAME = "acme/population";
const DEFAULT_BRANCH = "main";
const OVERSIZED_PR_NUMBER = 2_147_483_648;

describeIfDb("org merged pull request population real-db admission", () => {
  it("uses installed repository identity before stale PR denormalized names", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const repository = await seedRepository(organizationId, REPO_FULL_NAME);

      await seedBranchWithPullRequest({
        organizationId,
        userId: user.id,
        repository,
        branchName: "repo-precedence",
        prNumber: 101,
        prRepositoryFullName: "acme/stale-denormalized",
        linkMetadata: sessionPrMetadata([canonicalPrRef(REPO_FULL_NAME, 101)]),
        additions: 10,
        deletions: 5,
      });

      await expect(
        dashboardMergedPrs(insightsContext(organizationId, user.id))
      ).resolves.toBe(1);
    });
  });

  it("dedupes an App row with a stale PR name against its Desktop twin", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const repository = await seedRepository(organizationId, REPO_FULL_NAME);
      const ctx = insightsContext(organizationId, user.id);

      await seedBranchWithPullRequest({
        organizationId,
        userId: user.id,
        repository,
        branchName: "app-stale-name",
        prNumber: 102,
        prRepositoryFullName: "acme/stale-denormalized",
        linkMetadata: sessionPrMetadata([canonicalPrRef(REPO_FULL_NAME, 102)]),
        additions: 10,
        deletions: 5,
      });
      await seedBranchWithPullRequest({
        organizationId,
        userId: user.id,
        repository,
        branchName: "desktop-canonical-name",
        prNumber: 102,
        prRepositoryId: null,
        prRepositoryFullName: REPO_FULL_NAME,
        linkMetadata: sessionPrMetadata([canonicalPrRef(REPO_FULL_NAME, 102)]),
        additions: 10,
        deletions: 5,
      });

      const deliveryRows = await fetchMergedPrs(ctx, WINDOW_START, WINDOW_END);

      // Two projection rows, one pull request: the dashboard's fold collapses
      // the twin where the row scan above still holds both.
      expect(deliveryRows).toHaveLength(2);
      expect(await dashboardMergedPrs(ctx)).toBe(1);
      await expect(countDistinctMergedPrsFrom(ctx, WINDOW_START)).resolves.toBe(
        1
      );
    });
  });

  it("normalizes repository identity in both canonical and legacy SQL admission arms", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const repository = await seedRepository(organizationId, REPO_FULL_NAME);

      await seedBranchWithPullRequest({
        organizationId,
        userId: user.id,
        repository,
        branchName: "canonical-dot-git",
        prNumber: 111,
        linkMetadata: sessionPrMetadata([
          canonicalPrRef("Acme/Population.git", 111),
        ]),
        additions: 10,
        deletions: 5,
      });
      await expect(
        dashboardMergedPrs(insightsContext(organizationId, user.id))
      ).resolves.toBe(1);

      await seedBranchWithPullRequest({
        organizationId,
        userId: user.id,
        repository,
        branchName: "canonical-slashes",
        prNumber: 112,
        linkMetadata: sessionPrMetadata([
          canonicalPrRef("/ACME/Population/", 112),
        ]),
        additions: 10,
        deletions: 5,
      });
      await expect(
        dashboardMergedPrs(insightsContext(organizationId, user.id))
      ).resolves.toBe(2);

      await seedBranchWithPullRequest({
        organizationId,
        userId: user.id,
        repository,
        branchName: "legacy-dot-git-slashes",
        prNumber: 113,
        linkMetadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          repositoryFullName: "/Acme/Population.git/",
          prNumber: 113,
        },
        additions: 10,
        deletions: 5,
      });

      await expect(
        dashboardMergedPrs(insightsContext(organizationId, user.id))
      ).resolves.toBe(3);
    });
  });

  it("fails closed on malformed or oversized session PR identity metadata", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const repository = await seedRepository(organizationId, REPO_FULL_NAME);

      for (const malformed of malformedMetadataCases()) {
        await seedBranchWithPullRequest({
          organizationId,
          userId: user.id,
          repository,
          branchName: malformed.branchName,
          prNumber: malformed.prNumber,
          linkMetadata: malformed.metadata,
          additions: 10,
          deletions: 5,
        });
      }

      await expect(
        dashboardMergedPrs(insightsContext(organizationId, user.id))
      ).resolves.toBe(0);
    });
  });

  /**
   * ISS-8424 + ISS-8426: the verification census must not call a population
   * "not yet measured" when the rows it saw are ones the count can NEVER admit.
   *
   * Every row seeded here carries `lastVerifiedAt` — verification has already
   * run — and is still excluded, because its session→PR link names no matching
   * `repo#number`. The em dash the census drives means "come back after a
   * sync"; for these rows no sync will ever change the answer, so the honest
   * render is the measured `0` the count returns in the same breath.
   */
  it("reports a verified-but-inadmissible population as measured, not unmeasured", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const repository = await seedRepository(organizationId, REPO_FULL_NAME);
      const ctx = insightsContext(organizationId, user.id);

      for (const malformed of malformedMetadataCases()) {
        await seedBranchWithPullRequest({
          organizationId,
          userId: user.id,
          repository,
          branchName: `census-${malformed.branchName}`,
          prNumber: malformed.prNumber,
          linkMetadata: malformed.metadata,
          additions: 10,
          deletions: 5,
        });
      }

      const census = await censusMergedPrVerification(
        ctx,
        WINDOW_START,
        WINDOW_END
      );

      // The count and the census must agree about the same rows: an empty
      // population the count states as 0 is measured, not pending.
      await expect(dashboardMergedPrs(ctx)).resolves.toBe(0);
      expect(census.hasSessionLinkedMergedPrs).toBe(false);
      expect(isMergedPrPopulationUnmeasured(census)).toBe(false);
    });
  });

  /**
   * The reused-branch case ISS-8426 unified the count on: one branch, two PR
   * rows, a link that names only the first. The second PR is admitted by no
   * arm of the population, so the census must not count it as evidence that
   * verification is still owed.
   */
  it("does not read a reused branch's unnamed sibling PR as a pending population", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const repository = await seedRepository(organizationId, REPO_FULL_NAME);
      const ctx = insightsContext(organizationId, user.id);

      await seedBranchWithPullRequest({
        organizationId,
        userId: user.id,
        repository,
        branchName: "reused-branch",
        prNumber: 301,
        prState: GitHubPRState.Closed,
        linkMetadata: sessionPrMetadata([canonicalPrRef(REPO_FULL_NAME, 301)]),
        additions: 10,
        deletions: 5,
        siblingPullRequest: { number: 302 },
      });

      const census = await censusMergedPrVerification(
        ctx,
        WINDOW_START,
        WINDOW_END
      );

      await expect(dashboardMergedPrs(ctx)).resolves.toBe(0);
      expect(census.hasSessionLinkedMergedPrs).toBe(false);
      expect(isMergedPrPopulationUnmeasured(census)).toBe(false);
    });
  });

  /**
   * The counterpart that must stay true: a genuinely admissible merged row
   * whose verification has NOT landed is still the unmeasured state ISS-8424
   * exists to render. Without this, tightening the linked probe to the
   * population predicate could be "fixed" by making it unreachable.
   */
  it("still reports an admissible unverified population as unmeasured", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const repository = await seedRepository(organizationId, REPO_FULL_NAME);
      const ctx = insightsContext(organizationId, user.id);

      await seedBranchWithPullRequest({
        organizationId,
        userId: user.id,
        repository,
        branchName: "awaiting-verification",
        prNumber: 401,
        lastVerifiedAt: null,
        linkMetadata: sessionPrMetadata([canonicalPrRef(REPO_FULL_NAME, 401)]),
        additions: 10,
        deletions: 5,
      });

      const census = await censusMergedPrVerification(
        ctx,
        WINDOW_START,
        WINDOW_END
      );

      await expect(dashboardMergedPrs(ctx)).resolves.toBe(0);
      expect(census.hasSessionLinkedMergedPrs).toBe(true);
      expect(isMergedPrPopulationUnmeasured(census)).toBe(true);
    });
  });
});

type SeedRepository = {
  repositoryId: string;
  githubRepoId: string;
  fullName: string;
};

type SeedPullRequestBranchInput = {
  organizationId: string;
  userId: string;
  repository: SeedRepository;
  branchName: string;
  prNumber: number;
  linkMetadata: Prisma.InputJsonObject;
  prRepositoryId?: string | null;
  prRepositoryFullName?: string | null;
  additions: number;
  deletions: number;
  /** Defaults to MERGED; pass CLOSED to leave the named PR out of the window. */
  prState?: GitHubPRState;
  /** Defaults to VERIFIED_AT; pass null for a row verification has not reached. */
  lastVerifiedAt?: Date | null;
  /**
   * A second merged PR row on the SAME branch artifact that no session link
   * names — the reused-branch shape ISS-8426 unified the count on.
   */
  siblingPullRequest?: { number: number };
};

type MalformedMetadataCase = {
  branchName: string;
  prNumber: number;
  metadata: Prisma.InputJsonObject;
};

async function seedRepository(
  organizationId: string,
  fullName: string
): Promise<SeedRepository> {
  const [owner, name] = fullName.split("/");
  if (!(owner && name)) {
    throw new Error(`Expected owner/name repository fixture, got ${fullName}`);
  }
  const githubRepoId = `repo-${randomUUID().slice(0, 8)}`;
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: randomUUID(),
        accountId: `acct-${randomUUID().slice(0, 8)}`,
        accountLogin: owner,
        accountType: "Organization",
        status: GitHubInstallationStatus.ACTIVE,
        senderLogin: "sender",
        senderId: `sender-${randomUUID().slice(0, 8)}`,
        repositories: {
          create: {
            ...persistedGitHubRepositoryAuthority({
              githubRepoId,
              fullName,
              defaultBranch: DEFAULT_BRANCH,
            }),
            name,
            owner,
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
  const repository = installation.repositories[0];
  if (!repository) {
    throw new Error("pull-request population: failed to seed repository");
  }
  return { repositoryId: repository.id, githubRepoId, fullName };
}

async function seedBranchWithPullRequest(
  input: SeedPullRequestBranchInput
): Promise<void> {
  const branchArtifactId = await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId: input.organizationId,
        type: ArtifactType.BRANCH,
        name: `population-${input.branchName}`,
        status: BranchStatus.Open,
        createdById: input.userId,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId: input.organizationId,
        repositoryId: input.repository.repositoryId,
        repositoryFullName: input.repository.fullName,
        branchName: input.branchName,
        firstPushedAt: LAST_ACTIVITY_AT,
        pushSource: BranchPushSource.Session,
        lastActivityAt: LAST_ACTIVITY_AT,
      },
      select: { artifactId: true },
    });
    const pullRequest = await db.pullRequestDetail.create({
      data: {
        organizationId: input.organizationId,
        branchArtifactId: artifact.id,
        repositoryId:
          input.prRepositoryId === undefined
            ? input.repository.repositoryId
            : input.prRepositoryId,
        repositoryFullName:
          input.prRepositoryFullName ?? input.repository.fullName,
        number: input.prNumber,
        prState: input.prState ?? GitHubPRState.Merged,
        // A merge is `merged_at` (ISS-11589 D1), so a PR the fixture calls
        // Closed is closed WITHOUT a merge instant.
        ...(input.prState === GitHubPRState.Closed
          ? { mergedAt: null, closedAt: MERGED_AT }
          : { mergedAt: MERGED_AT }),
        additions: input.additions,
        deletions: input.deletions,
        isCurrent: true,
        lastVerifiedAt:
          input.lastVerifiedAt === undefined
            ? VERIFIED_AT
            : input.lastVerifiedAt,
        headRefName: input.branchName,
        headRefOid: "a".repeat(40),
      },
      select: { id: true },
    });
    if (input.siblingPullRequest) {
      await db.pullRequestDetail.create({
        data: {
          organizationId: input.organizationId,
          branchArtifactId: artifact.id,
          repositoryId: input.repository.repositoryId,
          repositoryFullName: input.repository.fullName,
          number: input.siblingPullRequest.number,
          prState: GitHubPRState.Merged,
          mergedAt: MERGED_AT,
          additions: input.additions,
          deletions: input.deletions,
          isCurrent: false,
          lastVerifiedAt: VERIFIED_AT,
          headRefName: input.branchName,
          headRefOid: "b".repeat(40),
        },
        select: { id: true },
      });
    }
    await db.branchDetail.update({
      where: { artifactId: artifact.id },
      data: { currentPullRequestDetailId: pullRequest.id },
      select: { artifactId: true },
    });
    return artifact.id;
  });
  await linkValidSessionToBranch({
    organizationId: input.organizationId,
    userId: input.userId,
    branchArtifactId,
    label: input.branchName,
    sessionTimestamp: LAST_ACTIVITY_AT,
    metadata: input.linkMetadata,
  });
}

function malformedMetadataCases(): MalformedMetadataCase[] {
  return [
    {
      branchName: "missing-relation-types",
      prNumber: 201,
      metadata: sessionPrMetadata([
        {
          repositoryFullName: REPO_FULL_NAME,
          prNumber: 201,
        },
      ]),
    },
    {
      branchName: "scalar-pr-refs",
      prNumber: 202,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        prRefs: "not-an-array",
      },
    },
    {
      branchName: "mixed-invalid-ref",
      prNumber: 203,
      metadata: sessionPrMetadata([
        canonicalPrRef(REPO_FULL_NAME, 203),
        {
          repositoryFullName: REPO_FULL_NAME,
          prNumber: 404,
        },
      ]),
    },
    {
      branchName: "oversized-canonical-number",
      prNumber: 204,
      metadata: sessionPrMetadata([
        canonicalPrRef(REPO_FULL_NAME, OVERSIZED_PR_NUMBER),
      ]),
    },
    {
      branchName: "oversized-legacy-number",
      prNumber: 205,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        repositoryFullName: REPO_FULL_NAME,
        prNumber: OVERSIZED_PR_NUMBER,
      },
    },
  ];
}

function sessionPrMetadata(
  prRefs: Prisma.InputJsonValue
): Prisma.InputJsonObject {
  return {
    linkKind: SessionArtifactLinkKind.SessionPr,
    prRefs,
  };
}

function canonicalPrRef(
  repositoryFullName: string,
  prNumber: number
): Prisma.InputJsonObject {
  return {
    repositoryFullName,
    prNumber,
    relationTypes: [SessionPrRelationType.Created],
  };
}

function insightsContext(
  organizationId: string,
  userId: string
): InsightsScopeContext {
  return {
    organizationId,
    userId,
    scope: InsightsScope.Org,
  };
}

/** The dashboard's Merged PRs figure over the test window, from the shared fold. */
async function dashboardMergedPrs(
  scope: Parameters<typeof readDeliveryPullRequestFacts>[0]
): Promise<number> {
  return (
    await readDeliveryPullRequestFacts(scope, {
      start: WINDOW_START,
      end: WINDOW_END,
      priorStart: null,
      priorEnd: WINDOW_START,
    })
  ).merged;
}

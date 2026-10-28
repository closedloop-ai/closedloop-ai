import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import {
  BranchRefreshReason,
  BranchRefreshStatus,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  readReceipts,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import {
  type SeededOrg,
  SHARED_BRANCH_NAME,
  SHARED_REPO_FULL_NAME,
  seedTwoOrgFixture,
} from "@/__tests__/utils/two-org-fixture";
import { branchService } from "./branch-service";

vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteFlagMock(await importOriginal())
);
vi.mock("@/lib/auth/with-any-auth", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteAuthMock()
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);
vi.mock(
  "@/lib/operation-receipts/operation-receipt-writer",
  async (importOriginal) =>
    (
      await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
    ).failingReceiptWriterMock(await importOriginal())
);

vi.mock("@/lib/github/installation-client", async (importOriginal) => {
  const { GitHubProviderResultStatus } = await import("@repo/github");
  return {
    ...(await importOriginal<object>()),
    readWithInstallationClient: async () => ({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    }),
  };
});

import { POST as refreshBranch } from "@/app/branches/[id]/refresh/route";

const harness = createReceiptRouteHarness();
const organizations = createCommittedTestOrganizationTracker();
type World = { organizationId: string; userId: string };
const ACTOR_BUCKET = "branch_refresh:actor";
const ACTOR_BUCKET_LIMIT = 5;
const budgetOrganizationIds: string[] = [];

/**
 * ISS-12552: an API-key branch refresh records one receipt
 * inside the transaction that spends the caller's refresh budget. The GitHub
 * projections the refresh then writes record nothing.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 branch refresh receipts",
  () => {
    afterEach(async () => {
      await clearBudgets(budgetOrganizationIds.splice(0));
      await harness.cleanup();
    });

    it("records exactly one field update naming the branch", async () => {
      const { world, branchId } = await seedRefreshableBranch();

      const response = await sendRefresh(branchId);

      expect(response.status).toBe(200);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.UpdateFields,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: branchId,
          createdArtifactId: null,
          changedFields: [],
          route: "/branches/[id]/refresh",
        },
      ]);
    });

    it("gives the refresh budget back when the receipt cannot be stored", async () => {
      const { world, branchId } = await seedRefreshableBranch();
      failReceiptInserts();

      const response = await sendRefresh(branchId);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countBudgetRows(world.organizationId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records nothing when the caller's budget is spent", async () => {
      const { world, branchId } = await seedRefreshableBranch();
      await exhaustActorBudget(world);

      const response = await sendRefresh(branchId);
      const body = (await response.json()) as {
        data: { status: string; reason: string };
      };

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.BudgetExhausted,
      });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const { world, branchId } = await seedRefreshableBranch();
      turnAttributionFlagOff();

      const response = await sendRefresh(branchId);

      expect(response.status).toBe(200);
      expect(await countBudgetRows(world.organizationId)).toBe(2);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

/**
 * A listed branch (a session wrote it) on an active repository, carrying a
 * current pull request, so the refresh reaches its budget. The GitHub read
 * that follows is stubbed unavailable; it writes no receipt either way.
 */
async function seedRefreshableBranch() {
  const { orgA, orgB } = await seedTwoOrgFixture();
  for (const org of [orgA, orgB]) {
    organizations.track(org.organizationId);
    budgetOrganizationIds.push(org.organizationId);
  }
  await attachCurrentPullRequest(orgA);
  receiptRouteState.context = createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      id: orgA.userId,
      organizationId: orgA.organizationId,
    },
    authMethod: "api_key",
    apiKeyScopes: ["read", "write"],
    apiKeyId: randomUUID(),
  });
  const world: World = {
    organizationId: orgA.organizationId,
    userId: orgA.userId,
  };
  return { world, branchId: orgA.branchArtifactId };
}

async function attachCurrentPullRequest(org: SeededOrg) {
  const result = await branchService.upsertBranchArtifact({
    organizationId: org.organizationId,
    repositoryId: org.repositoryId,
    repositoryFullName: SHARED_REPO_FULL_NAME,
    branchName: SHARED_BRANCH_NAME,
    projectId: org.projectId,
    pullRequest: {
      githubId: `pr-${randomUUID()}`,
      number: 7,
      title: "Receipt refresh",
      htmlUrl: `https://github.com/${SHARED_REPO_FULL_NAME}/pull/7`,
      state: GitHubPRState.Open,
      headRepositoryObservation: {
        authority: {
          repository: {
            provider: VcsProviderKind.GitHub,
            providerRepositoryId: "repo-a",
            fullName: SHARED_REPO_FULL_NAME,
          },
          evidence: {
            availability: RepositoryDefaultAvailability.Available,
            completeness: RepositoryDefaultCompleteness.Complete,
            defaultBranch: "main",
          },
          provenance: {
            source: RepositoryDefaultSource.PullRequestRest,
            mechanism: GitHubFetchMechanism.Rest,
            trigger: GitHubFetchTrigger.UserAction,
            credentialType: GitHubFetchCredentialType.GitHubApp,
            observationKey: "iss12552-refresh",
            observedAt: "2026-10-01T00:00:00.000Z",
          },
        },
      },
    },
  });
  if (!result.ok) {
    throw new Error("Failed to seed the ISS-12552 current pull request");
  }
}

function sendRefresh(branchId: string) {
  return refreshBranch(
    apiKeyRouteRequest("POST", `/branches/${branchId}/refresh`),
    receiptRouteParams({ id: branchId })
  );
}

async function exhaustActorBudget(world: World) {
  const now = Date.now();
  await withDb((db) =>
    db.oAuthRateLimit.create({
      data: {
        bucket: ACTOR_BUCKET,
        subject: `${world.organizationId}:api_key:${world.userId}`,
        requestCount: ACTOR_BUCKET_LIMIT,
        windowStartedAt: new Date(now),
        windowExpiresAt: new Date(now + 60_000),
      },
      select: { id: true },
    })
  );
}

/** Both refresh buckets' rows: the caller's and the organization's. */
function countBudgetRows(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.oAuthRateLimit.count({
      where: { subject: { startsWith: organizationId } },
    })
  );
}

/** Rate-limit rows carry no organization key, so the org delete leaves them. */
async function clearBudgets(organizationIds: string[]) {
  for (const organizationId of organizationIds) {
    await withDb((db) =>
      db.oAuthRateLimit.deleteMany({
        where: { subject: { startsWith: organizationId } },
      })
    );
  }
}

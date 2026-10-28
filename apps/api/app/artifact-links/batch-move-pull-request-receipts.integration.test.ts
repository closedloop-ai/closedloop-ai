import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  freshPullRequest,
  routeContext,
} from "@/__tests__/integration/branch-artifact-flow-helpers";
import {
  seedBranchTestContext,
  type TestContext,
} from "@/__tests__/integration/branch-artifact-test-helpers";
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
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
} from "@/__tests__/utils/db-helpers";

const github = vi.hoisted(() => ({
  livePullRequest: null as unknown,
}));

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
    acquireInstallationClient: async () => ({
      status: GitHubProviderResultStatus.Success,
      value: {},
    }),
  };
});
vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSinglePullRequest: async () => github.livePullRequest,
}));

import { POST as batchMove } from "@/app/artifact-links/batch-move/route";
import { POST as linkPullRequest } from "@/app/artifact-links/pull-requests/route";

const harness = createReceiptRouteHarness();
const branchOrganizations = createCommittedTestOrganizationTracker();
const branchOrganizationIds: string[] = [];

/**
 * ISS-12552: an API-key batch move records one move receipt per
 * artifact, and an API-key pull request link records the branch upsert's
 * receipt, each in the write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 batch move and pull request link receipts",
  () => {
    afterEach(async () => {
      await harness.cleanup();
      const orgIds = branchOrganizationIds.splice(0);
      await withDb((db) =>
        db.artifactOperationReceipt.deleteMany({
          where: { organizationId: { in: orgIds } },
        })
      );
      await branchOrganizations.cleanup();
    });

    it("POST /artifact-links/batch-move keeps every project when a receipt cannot be stored", async () => {
      const { world, artifactId, targetProjectId } = await seedMove();
      failReceiptInserts();

      const response = await sendMove(artifactId, targetProjectId);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readProjectId(artifactId)).toBe(world.projectId);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a batch move naming the artifact, and a repeat as a no-op", async () => {
      const { world, artifactId, targetProjectId } = await seedMove();

      const statuses = [
        (await sendMove(artifactId, targetProjectId)).status,
        (await sendMove(artifactId, targetProjectId)).status,
      ];

      expect(statuses).toEqual([200, 200]);
      const receipt = {
        operationKind: OperationKind.Move,
        source: OperationSource.Api,
        targetArtifactId: artifactId,
        createdArtifactId: null,
        route: "/artifact-links/batch-move",
      };
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          ...receipt,
          outcome: OperationReceiptOutcome.Committed,
          changedFields: ["projectId"],
        },
        {
          ...receipt,
          outcome: OperationReceiptOutcome.NoOp,
          changedFields: [],
        },
      ]);
    });

    it("POST /artifact-links/pull-requests leaves no branch when its receipt cannot be stored", async () => {
      const ctx = await seedPullRequestContext();
      const headBranch = `receipt-${randomUUID().slice(0, 8)}`;
      failReceiptInserts();

      const response = await sendPullRequestLink(ctx, headBranch);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countBranches(ctx, headBranch)).toBe(0);
      expect(await countReceipts(ctx.organizationId)).toBe(0);
    });

    it("records a pull request link as a committed create naming the branch", async () => {
      const ctx = await seedPullRequestContext();
      const headBranch = `receipt-${randomUUID().slice(0, 8)}`;

      const response = await sendPullRequestLink(ctx, headBranch);
      const { data } = (await response.json()) as { data: { id: string } };

      expect(response.status).toBe(200);
      expect(await readReceipts(ctx.organizationId)).toEqual([
        {
          operationKind: OperationKind.Create,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: data.id,
          createdArtifactId: data.id,
          changedFields: [],
          route: "/artifact-links/pull-requests",
        },
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const { world, artifactId, targetProjectId } = await seedMove();
      turnAttributionFlagOff();
      const moved = await sendMove(artifactId, targetProjectId);
      const ctx = await seedPullRequestContext();
      turnAttributionFlagOff();
      const linked = await sendPullRequestLink(
        ctx,
        `receipt-${randomUUID().slice(0, 8)}`
      );

      expect([moved.status, linked.status]).toEqual([200, 200]);
      expect(await readProjectId(artifactId)).toBe(targetProjectId);
      expect(await countReceipts(world.organizationId)).toBe(0);
      expect(await countReceipts(ctx.organizationId)).toBe(0);
    });
  }
);

async function seedMove() {
  const world = await harness.seedWorld();
  const artifactId = await harness.seedDocument(world, "Moved");
  const targetProjectId = await createTestProject(
    world.organizationId,
    world.userId
  );
  return { world, artifactId, targetProjectId };
}

function sendMove(artifactId: string, targetProjectId: string) {
  return batchMove(
    apiKeyRouteRequest("POST", "/artifact-links/batch-move", {
      artifactId,
      targetProjectId,
      includeDownstream: false,
    }),
    receiptRouteParams({})
  );
}

/**
 * A GitHub-connected organization with an API-key caller in it. The receipt
 * harness does not seed a repository, so this context comes from the branch
 * suites' seed and its receipts are cleaned here.
 */
async function seedPullRequestContext(): Promise<TestContext> {
  const ctx = await seedBranchTestContext();
  branchOrganizations.track(ctx.organizationId);
  branchOrganizationIds.push(ctx.organizationId);
  receiptRouteState.context = createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      id: ctx.userId,
      organizationId: ctx.organizationId,
    },
    authMethod: "api_key",
    apiKeyScopes: ["read", "write"],
    apiKeyId: randomUUID(),
  });
  return ctx;
}

function sendPullRequestLink(ctx: TestContext, headBranch: string) {
  const number = Math.floor(Math.random() * 100_000) + 1;
  const live = freshPullRequest(ctx, {
    branchName: headBranch,
    headSha: "receipt-head-sha",
    number,
    title: "Receipt PR",
  });
  github.livePullRequest = live;
  return linkPullRequest(
    apiKeyRouteRequest("POST", "/artifact-links/pull-requests", {
      projectId: ctx.projectId,
      title: live.title,
      externalUrl: live.htmlUrl,
      number,
      githubId: live.githubId,
      headBranch,
      baseBranch: "main",
      headSha: live.headSha,
      state: GitHubPRState.Open,
    }),
    routeContext({})
  );
}

async function readProjectId(artifactId: string) {
  const row = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: { projectId: true },
    })
  );
  return row.projectId;
}

function countBranches(ctx: TestContext, branchName: string) {
  return withDb((db) =>
    db.branchDetail.count({
      where: { organizationId: ctx.organizationId, branchName },
    })
  );
}

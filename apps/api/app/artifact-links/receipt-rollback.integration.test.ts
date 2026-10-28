import { randomUUID } from "node:crypto";
import { BranchHeadShaSource, LinkType } from "@repo/api/src/types/artifact";
import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  failRejectedReceiptInserts,
  forcedReceiptFailures,
  forcedRejectedReceiptFailures,
  receiptRouteParams,
  receiptRouteRequest,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

const repoDefaults = vi.hoisted(() => ({
  repository: "acme/receipt-rollback",
  overridden: false,
}));
const REPOSITORY = repoDefaults.repository;

// ISS-12552: receipts are recorded only while attribution-evidence-policy is on.
vi.mock(
  "@/lib/attribution-evidence-policy-feature",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attribution-evidence-policy-feature")
    >()),
    isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  })
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
// The branch route needs a project whose primary repository resolves; only
// the branch test asks for one, so document seeding keeps the real resolver.
vi.mock("@/app/projects/repository-resolver", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/projects/repository-resolver")>();
  return {
    ...actual,
    loadProjectRepoDefaults: (
      input: Parameters<typeof actual.loadProjectRepoDefaults>[0]
    ) =>
      repoDefaults.overridden
        ? Promise.resolve({
            primary: {
              installationRepositoryId: null,
              fullName: repoDefaults.repository,
            },
          })
        : actual.loadProjectRepoDefaults(input),
  };
});

import { DELETE as deleteLink } from "@/app/artifact-links/[id]/route";
import { POST as createBranch } from "@/app/artifact-links/branches/route";
import { POST as createLink } from "@/app/artifact-links/route";
import { BranchUpsertField } from "@/app/branches/branch-upsert-changed-fields";

const harness = createReceiptRouteHarness();

/**
 * ISS-12552: a link write and its operation receipt share one transaction, so
 * a receipt that cannot be stored leaves no write behind.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 link writes roll back with their receipt",
  () => {
    afterEach(async () => {
      repoDefaults.overridden = false;
      await harness.cleanup();
    });

    it("POST /artifact-links leaves no link", async () => {
      const world = await harness.seedWorld();
      const sourceId = await harness.seedDocument(world, "Source");
      const targetId = await harness.seedDocument(world, "Target");
      failReceiptInserts();

      const response = await createLink(
        receiptRouteRequest("POST", "/artifact-links", {
          sourceId,
          targetId,
          linkType: LinkType.RelatesTo,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countLinks(sourceId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /artifact-links/[id] keeps the link", async () => {
      const world = await harness.seedWorld();
      const sourceId = await harness.seedDocument(world, "Source");
      const targetId = await harness.seedDocument(world, "Target");
      const link = await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId: world.organizationId,
            sourceId,
            targetId,
            linkType: LinkType.RelatesTo,
          },
          select: { id: true },
        })
      );
      failReceiptInserts();

      const response = await deleteLink(
        receiptRouteRequest("DELETE", `/artifact-links/${link.id}`),
        receiptRouteParams({ id: link.id })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countLinks(sourceId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /artifact-links/branches leaves no branch", async () => {
      const world = await harness.seedWorld();
      await grantRepositoryAuthority(world.organizationId);
      repoDefaults.overridden = true;
      failReceiptInserts();

      const response = await createBranch(
        receiptRouteRequest("POST", "/artifact-links/branches", {
          projectId: world.projectId,
          branchName: "feat/receipt-rollback",
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(
        await withDb((db) =>
          db.artifact.count({
            where: {
              organizationId: world.organizationId,
              type: ArtifactType.BRANCH,
            },
          })
        )
      ).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 a rejected receipt that cannot be stored",
  () => {
    afterEach(async () => {
      await harness.cleanup();
    });

    it("leaves the route's own 4xx answer, never a 500", async () => {
      const world = await harness.seedWorld();
      const sourceId = await harness.seedDocument(world, "Source");
      failRejectedReceiptInserts();

      const response = await createLink(
        receiptRouteRequest("POST", "/artifact-links", {
          sourceId,
          targetId: randomUUID(),
          linkType: LinkType.RelatesTo,
        }),
        receiptRouteParams({})
      );

      expect(forcedRejectedReceiptFailures()).toBe(1);
      expect(response.status).toBe(404);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 branch upsert receipts (PRD-800)",
  () => {
    afterEach(async () => {
      repoDefaults.overridden = false;
      await harness.cleanup();
    });

    it("records a created branch as a committed create naming it, and the same branch again as a no-op", async () => {
      const world = await harness.seedWorld();
      await grantRepositoryAuthority(world.organizationId);
      repoDefaults.overridden = true;
      const upsert = () =>
        createBranch(
          receiptRouteRequest("POST", "/artifact-links/branches", {
            projectId: world.projectId,
            branchName: "feat/receipt-upsert",
          }),
          receiptRouteParams({})
        );

      const first = await upsert();
      const second = await upsert();

      expect([first.status, second.status]).toEqual([200, 200]);
      const branch = await withDb((db) =>
        db.artifact.findFirstOrThrow({
          where: {
            organizationId: world.organizationId,
            type: ArtifactType.BRANCH,
          },
          select: { id: true },
        })
      );
      const receipts = await withDb((db) =>
        db.artifactOperationReceipt.findMany({
          where: { organizationId: world.organizationId },
          orderBy: { createdAt: "asc" },
          select: {
            operationKind: true,
            outcome: true,
            targetArtifactId: true,
            createdArtifactId: true,
          },
        })
      );
      expect(receipts).toEqual([
        {
          operationKind: OperationKind.Create,
          outcome: OperationReceiptOutcome.Committed,
          targetArtifactId: branch.id,
          createdArtifactId: branch.id,
        },
        {
          operationKind: OperationKind.Create,
          outcome: OperationReceiptOutcome.NoOp,
          targetArtifactId: branch.id,
          createdArtifactId: null,
        },
      ]);
    });
  }
);

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 branch upserts onto an existing branch",
  () => {
    afterEach(async () => {
      repoDefaults.overridden = false;
      await harness.cleanup();
    });

    it("records an unchanged upsert as a no-op and a moved head sha as a field update naming it", async () => {
      const world = await harness.seedWorld();
      await grantRepositoryAuthority(world.organizationId);
      repoDefaults.overridden = true;
      const upsert = (headSha: string) =>
        createBranch(
          receiptRouteRequest("POST", "/artifact-links/branches", {
            projectId: world.projectId,
            branchName: "feat/receipt-moved-fields",
            headSha,
            headShaSource: BranchHeadShaSource.McpInput,
          }),
          receiptRouteParams({})
        );

      const statuses = [
        (await upsert("1111111")).status,
        (await upsert("1111111")).status,
        (await upsert("2222222")).status,
      ];

      expect(statuses).toEqual([200, 200, 200]);
      const receipts = await withDb((db) =>
        db.artifactOperationReceipt.findMany({
          where: { organizationId: world.organizationId },
          orderBy: { createdAt: "asc" },
          select: { operationKind: true, outcome: true, changedFields: true },
        })
      );
      expect(receipts).toEqual([
        {
          operationKind: OperationKind.Create,
          outcome: OperationReceiptOutcome.Committed,
          changedFields: [],
        },
        {
          operationKind: OperationKind.Create,
          outcome: OperationReceiptOutcome.NoOp,
          changedFields: [],
        },
        {
          operationKind: OperationKind.UpdateFields,
          outcome: OperationReceiptOutcome.Committed,
          changedFields: [BranchUpsertField.HeadSha],
        },
      ]);
    });

    it("records a newly added source link as a field update naming it", async () => {
      const world = await harness.seedWorld();
      const sourceArtifactId = await harness.seedDocument(world, "Source");
      await grantRepositoryAuthority(world.organizationId);
      repoDefaults.overridden = true;
      const upsert = (body: Record<string, unknown>) =>
        createBranch(
          receiptRouteRequest("POST", "/artifact-links/branches", {
            projectId: world.projectId,
            branchName: "feat/receipt-source-link",
            ...body,
          }),
          receiptRouteParams({})
        );

      expect((await upsert({})).status).toBe(200);
      expect((await upsert({ sourceArtifactId })).status).toBe(200);

      const latest = await withDb((db) =>
        db.artifactOperationReceipt.findFirstOrThrow({
          where: { organizationId: world.organizationId },
          orderBy: { createdAt: "desc" },
          select: { operationKind: true, outcome: true, changedFields: true },
        })
      );
      expect(latest).toEqual({
        operationKind: OperationKind.UpdateFields,
        outcome: OperationReceiptOutcome.Committed,
        changedFields: [BranchUpsertField.SourceLink],
      });
    });
  }
);

function countLinks(sourceId: string): Promise<number> {
  return withDb((db) => db.artifactLink.count({ where: { sourceId } }));
}

async function grantRepositoryAuthority(organizationId: string) {
  const [owner, name] = REPOSITORY.split("/");
  await withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `repo-${randomUUID()}`,
          fullName: REPOSITORY,
        }),
        owner,
        name,
        htmlUrl: `https://github.com/${REPOSITORY}`,
      },
    })
  );
}

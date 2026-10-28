import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { useSessionCaller } from "@/__tests__/support/lib/session-caller.test-helpers";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";

const drive = vi.hoisted(() => ({
  docs: [] as { id: string; name: string }[],
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
vi.mock("@/lib/integration-encryption", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integration-encryption")>()),
  resolveEncryptedIntegrationToken: async () => "receipt-token",
}));
vi.mock("@repo/google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/google")>()),
  revokeToken: async () => undefined,
  listDocsInFolder: async () => drive.docs,
  exportDocAsMarkdown: async (docId: string) => `# ${docId}`,
}));
vi.mock("@repo/linear", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/linear")>()),
  revokeToken: async () => undefined,
}));
vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  deleteInstallation: async () => ({ success: true }),
}));
vi.mock("@/lib/public-github-repos-feature", () => ({
  isPublicGithubReposEnabled: async () => true,
}));
vi.mock("@/lib/github/github-client-resolver", () => ({
  getGitHubClient: async () => ({
    ok: false,
    error: { reason: "not_connected" },
  }),
}));
vi.mock("@repo/github/bounded-fetch", () => ({
  boundedFetch: async () =>
    Response.json({
      id: 4242,
      full_name: "acme/receipts",
      name: "receipts",
      owner: { login: "acme" },
      html_url: "https://github.com/acme/receipts",
      private: false,
      default_branch: "main",
    }),
}));

import {
  POST as addPublicRepository,
  DELETE as removePublicRepository,
} from "@/app/integrations/github/public-repositories/route";
import { DELETE as disconnectGitHub } from "@/app/integrations/github/route";
import { POST as importGoogleDocs } from "@/app/integrations/google/import/route";
import { DELETE as disconnectGoogle } from "@/app/integrations/google/route";
import { DELETE as disconnectLinear } from "@/app/integrations/linear/route";

const harness = createReceiptRouteHarness();
const PUBLIC_REPOSITORIES = "/integrations/github/public-repositories";
const installationIds: string[] = [];

/**
 * ISS-12552: an API-key integration write records its receipt
 * in the write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)("ISS-12552 integration receipts", () => {
  beforeEach(() => {
    drive.docs = [{ id: `doc-${randomUUID()}`, name: "Receipt doc" }];
  });
  afterEach(async () => {
    const ids = installationIds.splice(0);
    await withDb((db) =>
      db.gitHubInstallation.deleteMany({ where: { id: { in: ids } } })
    );
    await harness.cleanup();
  });

  it("DELETE /integrations/github keeps the installation when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const installationId = await seedInstallation(world.organizationId);
    failReceiptInserts();

    await expect(
      disconnectGitHub(
        apiKeyRouteRequest("DELETE", "/integrations/github"),
        receiptRouteParams({})
      )
    ).rejects.toThrow();

    expect(forcedReceiptFailures()).toBe(1);
    expect(await readInstallationStatus(installationId)).toBe(
      GitHubInstallationStatus.ACTIVE
    );
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("DELETE /integrations/github records a disconnect, then nothing to disconnect as a no-op", async () => {
    const world = await harness.seedWorld();
    await seedInstallation(world.organizationId);

    const first = await disconnectGitHub(
      apiKeyRouteRequest("DELETE", "/integrations/github"),
      receiptRouteParams({})
    );
    await withDb((db) =>
      db.gitHubInstallation.deleteMany({
        where: { id: { in: installationIds } },
      })
    );
    const second = await disconnectGitHub(
      apiKeyRouteRequest("DELETE", "/integrations/github"),
      receiptRouteParams({})
    );

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await readReceipts(world.organizationId)).toEqual(
      [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
        (outcome) => organizationWrite(outcome, "/integrations/github")
      )
    );
  });

  it("DELETE /integrations/google keeps the integration when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    await withDb((db) =>
      db.googleIntegration.create({
        data: {
          organizationId: world.organizationId,
          googleUserId: randomUUID(),
        },
      })
    );
    failReceiptInserts();

    const response = await disconnectGoogle(
      apiKeyRouteRequest("DELETE", "/integrations/google"),
      receiptRouteParams({})
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(
      await withDb((db) =>
        db.googleIntegration.count({
          where: { organizationId: world.organizationId },
        })
      )
    ).toBe(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("DELETE /integrations/linear keeps the integration when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    await seedLinearIntegration(world.organizationId);
    failReceiptInserts();

    const response = await disconnectLinear(
      apiKeyRouteRequest("DELETE", "/integrations/linear"),
      receiptRouteParams({})
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(
      await withDb((db) =>
        db.linearIntegration.count({
          where: { organizationId: world.organizationId },
        })
      )
    ).toBe(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /integrations/github/public-repositories adds nothing when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    failReceiptInserts();

    await expect(
      addPublicRepository(addRepositoryRequest(), receiptRouteParams({}))
    ).rejects.toThrow();

    expect(forcedReceiptFailures()).toBe(1);
    expect(await countPublicRepositories(world.organizationId)).toBe(0);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /integrations/github/public-repositories records an organization write naming the route", async () => {
    const world = await harness.seedWorld();

    const response = await addPublicRepository(
      addRepositoryRequest(),
      receiptRouteParams({})
    );

    expect(response.status).toBe(200);
    expect(await readReceipts(world.organizationId)).toEqual([
      organizationWrite(OperationReceiptOutcome.Committed, PUBLIC_REPOSITORIES),
    ]);
  });

  it("POST /integrations/github/public-repositories writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    turnAttributionFlagOff();

    const response = await addPublicRepository(
      addRepositoryRequest(),
      receiptRouteParams({})
    );

    expect(response.status).toBe(200);
    expect(await countPublicRepositories(world.organizationId)).toBe(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("DELETE /integrations/github/public-repositories keeps the repository when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const repositoryId = await seedPublicRepository(world.organizationId);
    failReceiptInserts();

    await expect(
      removePublicRepository(
        apiKeyRouteRequest(
          "DELETE",
          `${PUBLIC_REPOSITORIES}?id=${repositoryId}`
        ),
        receiptRouteParams({})
      )
    ).rejects.toThrow();

    expect(forcedReceiptFailures()).toBe(1);
    expect(await countPublicRepositories(world.organizationId)).toBe(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /integrations/google/import creates no document whose receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    await seedGoogleIntegration(world.organizationId);
    failReceiptInserts();

    const response = await importGoogleDocs(
      importRequest(world.projectId),
      receiptRouteParams({})
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.importedCount).toBe(0);
    expect(body.data.failures).toHaveLength(1);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await countImportedDocuments(world.projectId)).toBe(0);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /integrations/google/import records a create receipt per imported document", async () => {
    const world = await harness.seedWorld();
    await seedGoogleIntegration(world.organizationId);
    drive.docs = ["First", "Second"].map((name) => ({
      id: `doc-${randomUUID()}`,
      name,
    }));

    const response = await importGoogleDocs(
      importRequest(world.projectId),
      receiptRouteParams({})
    );
    const body = await response.json();
    const createdIds: string[] = body.data.artifacts.map(
      (artifact: { id: string }) => artifact.id
    );

    expect(response.status).toBe(200);
    expect(createdIds).toHaveLength(2);
    const receipts = await readReceipts(world.organizationId);
    expect(receipts.map((receipt) => receipt.targetArtifactId).sort()).toEqual(
      [...createdIds].sort()
    );
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        operationKind: OperationKind.Create,
        outcome: OperationReceiptOutcome.Committed,
        createdArtifactId: receipt.targetArtifactId,
        route: "/integrations/google/import",
      });
    }
  });

  it("POST /integrations/google/import writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    await seedGoogleIntegration(world.organizationId);
    turnAttributionFlagOff();

    const response = await importGoogleDocs(
      importRequest(world.projectId),
      receiptRouteParams({})
    );

    expect(response.status).toBe(200);
    expect(await countImportedDocuments(world.projectId)).toBe(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });
});

/**
 * ISS-12552: flag-off behavior equals main for integration writes. With
 * `attribution-evidence-policy` off, or for a session caller, each write runs
 * as it does on main, with no transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 integration writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      const ids = installationIds.splice(0);
      await withDb((db) =>
        db.gitHubInstallation.deleteMany({ where: { id: { in: ids } } })
      );
      await harness.cleanup();
    });

    it("DELETE /integrations/github marks the installation uninstalled outside any transaction, for an API-key caller", async () => {
      const world = await harness.seedWorld();
      const installationId = await seedInstallation(world.organizationId);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await disconnectGitHub(
        apiKeyRouteRequest("DELETE", "/integrations/github"),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({ disconnected: true });
      expect(transactions.opened).toBe(0);
      expect(await readInstallationStatus(installationId)).toBe(
        GitHubInstallationStatus.UNINSTALLED
      );
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /integrations/github marks the installation uninstalled outside any transaction, for a session caller", async () => {
      const world = await harness.seedWorld();
      const installationId = await seedInstallation(world.organizationId);
      useSessionCaller();
      const transactions = countTransactions();

      const response = await disconnectGitHub(
        apiKeyRouteRequest("DELETE", "/integrations/github"),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(await readInstallationStatus(installationId)).toBe(
        GitHubInstallationStatus.UNINSTALLED
      );
    });

    it("POST /integrations/github/public-repositories adds the repository outside any transaction", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await addPublicRepository(
        addRepositoryRequest(),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).not.toHaveProperty(
        "operationReceipt"
      );
      expect(transactions.opened).toBe(0);
      expect(await countPublicRepositories(world.organizationId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /integrations/github/public-repositories removes the repository outside any transaction", async () => {
      const world = await harness.seedWorld();
      const repositoryId = await seedPublicRepository(world.organizationId);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await removePublicRepository(
        apiKeyRouteRequest(
          "DELETE",
          `${PUBLIC_REPOSITORIES}?id=${repositoryId}`
        ),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({ deleted: true });
      expect(transactions.opened).toBe(0);
      expect(await countPublicRepositories(world.organizationId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /integrations/google deletes the integration outside any transaction", async () => {
      const world = await harness.seedWorld();
      await seedGoogleIntegration(world.organizationId);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await disconnectGoogle(
        apiKeyRouteRequest("DELETE", "/integrations/google"),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({ disconnected: true });
      expect(transactions.opened).toBe(0);
      expect(
        await withDb((db) =>
          db.googleIntegration.count({
            where: { organizationId: world.organizationId },
          })
        )
      ).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /integrations/linear deletes the integration outside any transaction", async () => {
      const world = await harness.seedWorld();
      await seedLinearIntegration(world.organizationId);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await disconnectLinear(
        apiKeyRouteRequest("DELETE", "/integrations/linear"),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({ disconnected: true });
      expect(transactions.opened).toBe(0);
      expect(
        await withDb((db) =>
          db.linearIntegration.count({
            where: { organizationId: world.organizationId },
          })
        )
      ).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function organizationWrite(outcome: string, route: string) {
  return {
    operationKind: OperationKind.OrganizationWrite,
    outcome,
    source: OperationSource.Api,
    targetArtifactId: null,
    createdArtifactId: null,
    changedFields: [],
    route,
  };
}

function addRepositoryRequest() {
  return apiKeyRouteRequest("POST", PUBLIC_REPOSITORIES, {
    url: "https://github.com/acme/receipts",
  });
}

function importRequest(projectId: string) {
  return apiKeyRouteRequest("POST", "/integrations/google/import", {
    folderId: "receipt_folder_0123456789abcdef",
    projectId,
  });
}

function countPublicRepositories(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.publicRepository.count({ where: { organizationId } })
  );
}

function countImportedDocuments(projectId: string): Promise<number> {
  return withDb((db) => db.artifact.count({ where: { projectId } }));
}

function readInstallationStatus(id: string) {
  return withDb(async (db) => {
    const row = await db.gitHubInstallation.findUnique({
      where: { id },
      select: { status: true },
    });
    return row?.status;
  });
}

async function seedGoogleIntegration(organizationId: string): Promise<void> {
  await withDb((db) =>
    db.googleIntegration.create({
      data: { organizationId, googleUserId: randomUUID() },
    })
  );
}

async function seedInstallation(organizationId: string): Promise<string> {
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: randomUUID(),
        accountId: randomUUID(),
        accountLogin: "acme",
        accountType: "Organization",
        senderLogin: "acme",
        senderId: randomUUID(),
        status: GitHubInstallationStatus.ACTIVE,
      },
      select: { id: true },
    })
  );
  installationIds.push(installation.id);
  return installation.id;
}

async function seedLinearIntegration(organizationId: string): Promise<void> {
  await withDb((db) =>
    db.linearIntegration.create({
      data: {
        organizationId,
        linearOrgId: randomUUID(),
        linearOrgName: "Receipts",
      },
    })
  );
}

async function seedPublicRepository(organizationId: string): Promise<string> {
  const row = await withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        githubRepoId: randomUUID(),
        fullName: "acme/receipts",
        owner: "acme",
        name: "receipts",
        htmlUrl: "https://github.com/acme/receipts",
      },
      select: { id: true },
    })
  );
  return row.id;
}

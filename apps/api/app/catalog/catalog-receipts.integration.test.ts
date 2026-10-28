import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { catalogAssetKey } from "@repo/aws/catalog-assets";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildZipWithEntries } from "@/__tests__/fixtures/zip-helpers";
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

const assets = vi.hoisted(() => ({
  zipBytes: Buffer.alloc(0) as Buffer,
  repoComponents: [] as { kind: string; name: string; content: string }[],
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
vi.mock("@/lib/auth/org-admin", () => ({
  requireOrgAdmin: async () => null,
  getOrgAdminStatus: async () => ({ isAdmin: true, reason: "admin" }),
}));
vi.mock("@repo/aws/catalog-assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/aws/catalog-assets")>()),
  headCatalogAsset: async () => ({ contentLength: 10 }),
  resolveCatalogBucket: () => "receipt-test-bucket",
  getCatalogAssetBytes: async () => assets.zipBytes,
}));
vi.mock("@/app/catalog/pack-repo-import", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/catalog/pack-repo-import")>()),
  fetchRepoComponents: async () => assets.repoComponents,
}));

import { POST as importRepo } from "@/app/catalog/[id]/import-repo/route";
import { POST as importZip } from "@/app/catalog/[id]/import-zip/route";
import {
  DELETE as archiveItem,
  PATCH as updateItem,
} from "@/app/catalog/[id]/route";
import { POST as confirmUpload } from "@/app/catalog/confirm/route";
import { POST as createItem } from "@/app/catalog/route";

const harness = createReceiptRouteHarness();
const REPO_FULL_NAME = "acme/shared-assets";
const installationIds: string[] = [];

/**
 * ISS-12552: an API-key catalog write records an organization
 * write receipt in the write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)("ISS-12552 catalog receipts", () => {
  beforeEach(() => {
    assets.zipBytes = buildZipWithEntries([
      { name: "skills/review/SKILL.md", content: "# Review" },
    ]);
    assets.repoComponents = [
      { kind: "skill", name: "repo-skill", content: "# Repo skill" },
    ];
  });
  afterEach(async () => {
    const ids = installationIds.splice(0);
    await withDb((db) =>
      db.gitHubInstallation.deleteMany({ where: { id: { in: ids } } })
    );
    await harness.cleanup();
  });

  it("POST /catalog rolls the item back when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    failReceiptInserts();

    const response = await createItem(
      apiKeyRouteRequest("POST", "/catalog", {
        targetKind: "skill",
        name: "Receipt skill",
        content: "# Body",
      }),
      receiptRouteParams({})
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await countCatalogItems(world.organizationId)).toBe(0);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /catalog records an organization write naming the route", async () => {
    const world = await harness.seedWorld();

    const response = await createItem(
      apiKeyRouteRequest("POST", "/catalog", {
        targetKind: "skill",
        name: "Receipt skill",
        content: "# Body",
      }),
      receiptRouteParams({})
    );

    expect(response.status).toBe(200);
    expect(await readReceipts(world.organizationId)).toEqual([
      organizationWrite(OperationReceiptOutcome.Committed, "/catalog"),
    ]);
  });

  it("POST /catalog writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    turnAttributionFlagOff();

    const response = await createItem(
      apiKeyRouteRequest("POST", "/catalog", {
        targetKind: "skill",
        name: "Receipt skill",
      }),
      receiptRouteParams({})
    );

    expect(response.status).toBe(200);
    expect(await countCatalogItems(world.organizationId)).toBe(1);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("PATCH /catalog/[id] keeps the old name when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const itemId = await seedCatalogItem(world, { name: "Before" });
    failReceiptInserts();

    const response = await updateItem(
      apiKeyRouteRequest("PATCH", `/catalog/${itemId}`, { name: "After" }),
      receiptRouteParams({ id: itemId })
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect((await readCatalogItem(itemId))?.name).toBe("Before");
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("DELETE /catalog/[id] keeps the item live when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const itemId = await seedCatalogItem(world, { name: "Archive me" });
    failReceiptInserts();

    const response = await archiveItem(
      apiKeyRouteRequest("DELETE", `/catalog/${itemId}`),
      receiptRouteParams({ id: itemId })
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect((await readCatalogItem(itemId))?.archived).toBe(false);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("DELETE /catalog/[id] records a repeat archive as a no-op", async () => {
    const world = await harness.seedWorld();
    const itemId = await seedCatalogItem(world, { name: "Archive me" });
    const archive = () =>
      archiveItem(
        apiKeyRouteRequest("DELETE", `/catalog/${itemId}`),
        receiptRouteParams({ id: itemId })
      );

    const statuses = [(await archive()).status, (await archive()).status];

    expect(statuses).toEqual([200, 200]);
    expect(await readReceipts(world.organizationId)).toEqual(
      [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
        (outcome) => organizationWrite(outcome, "/catalog/[id]")
      )
    );
  });

  it("POST /catalog/[id]/import-zip creates no component when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const packId = await seedPack(world, { withZip: true });
    failReceiptInserts();

    const response = await importZip(
      apiKeyRouteRequest("POST", `/catalog/${packId}/import-zip`),
      receiptRouteParams({ id: packId })
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await countChildren(packId)).toBe(0);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /catalog/[id]/import-repo creates no component when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const packId = await seedPack(world, { withZip: false });
    await seedInstallationRepository(world.organizationId);
    failReceiptInserts();

    const response = await importRepo(
      apiKeyRouteRequest("POST", `/catalog/${packId}/import-repo`, {
        repoFullName: REPO_FULL_NAME,
      }),
      receiptRouteParams({ id: packId })
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect(await countChildren(packId)).toBe(0);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /catalog/confirm keeps the asset key unset when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const itemId = await seedCatalogItem(world, { name: "Logo owner" });
    failReceiptInserts();

    const response = await confirmUpload(
      apiKeyRouteRequest("POST", "/catalog/confirm", {
        catalogItemId: itemId,
        fileType: "logo",
        s3Key: catalogAssetKey(world.organizationId, itemId, "logo"),
      }),
      receiptRouteParams({})
    );

    expect(response.status).toBe(500);
    expect(forcedReceiptFailures()).toBe(1);
    expect((await readCatalogItem(itemId))?.logoAssetKey).toBeNull();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });
});

/**
 * ISS-12552: flag-off behavior equals main for catalog writes. With
 * `attribution-evidence-policy` off, or for a session caller, the archive and
 * the asset confirm run their single update as main does, with no transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 catalog writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("DELETE /catalog/[id] archives outside any transaction, for an API-key caller", async () => {
      const world = await harness.seedWorld();
      const itemId = await seedCatalogItem(world, { name: "Archive me" });
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await archiveItem(
        apiKeyRouteRequest("DELETE", `/catalog/${itemId}`),
        receiptRouteParams({ id: itemId })
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({ deleted: true });
      expect(transactions.opened).toBe(0);
      expect((await readCatalogItem(itemId))?.archived).toBe(true);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /catalog/[id] archives outside any transaction, for a session caller", async () => {
      const world = await harness.seedWorld();
      const itemId = await seedCatalogItem(world, { name: "Archive me" });
      useSessionCaller();
      const transactions = countTransactions();

      const response = await archiveItem(
        apiKeyRouteRequest("DELETE", `/catalog/${itemId}`),
        receiptRouteParams({ id: itemId })
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect((await readCatalogItem(itemId))?.archived).toBe(true);
    });

    it("POST /catalog/confirm stores the asset key outside any transaction", async () => {
      const world = await harness.seedWorld();
      const itemId = await seedCatalogItem(world, { name: "Logo owner" });
      const s3Key = catalogAssetKey(world.organizationId, itemId, "logo");
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await confirmUpload(
        apiKeyRouteRequest("POST", "/catalog/confirm", {
          catalogItemId: itemId,
          fileType: "logo",
          s3Key,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).not.toHaveProperty(
        "operationReceipt"
      );
      expect(transactions.opened).toBe(0);
      expect((await readCatalogItem(itemId))?.logoAssetKey).toBe(s3Key);
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

type World = { organizationId: string; userId: string };

function countCatalogItems(organizationId: string): Promise<number> {
  return withDb((db) => db.catalogItem.count({ where: { organizationId } }));
}

function countChildren(packId: string): Promise<number> {
  return withDb((db) =>
    db.catalogItem.count({ where: { parentPackId: packId } })
  );
}

function readCatalogItem(id: string) {
  return withDb((db) =>
    db.catalogItem.findUnique({
      where: { id },
      select: { name: true, archived: true, logoAssetKey: true },
    })
  );
}

async function seedCatalogItem(
  world: World,
  input: { name: string }
): Promise<string> {
  const row = await withDb((db) =>
    db.catalogItem.create({
      data: {
        organizationId: world.organizationId,
        targetKind: "skill",
        source: "org_custom",
        scope: "org",
        name: input.name,
        createdById: world.userId,
      },
      select: { id: true },
    })
  );
  return row.id;
}

async function seedPack(
  world: World,
  input: { withZip: boolean }
): Promise<string> {
  const row = await withDb((db) =>
    db.catalogItem.create({
      data: {
        organizationId: world.organizationId,
        targetKind: "pack",
        source: "org_custom",
        scope: "org",
        name: "Receipt pack",
        createdById: world.userId,
        ...(input.withZip ? { zipAssetKey: "packs/receipt.zip" } : {}),
      },
      select: { id: true },
    })
  );
  return row.id;
}

async function seedInstallationRepository(
  organizationId: string
): Promise<void> {
  const [owner, name] = REPO_FULL_NAME.split("/");
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: randomUUID(),
        accountId: randomUUID(),
        accountLogin: owner,
        accountType: "Organization",
        senderLogin: owner,
        senderId: randomUUID(),
        status: GitHubInstallationStatus.ACTIVE,
        repositories: {
          create: {
            githubRepoId: randomUUID(),
            fullName: REPO_FULL_NAME,
            owner,
            name,
            private: false,
          },
        },
      },
      select: { id: true },
    })
  );
  installationIds.push(installation.id);
}

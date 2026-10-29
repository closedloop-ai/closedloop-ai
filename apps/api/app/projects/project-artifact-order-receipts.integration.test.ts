import { randomUUID } from "node:crypto";
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import { BulkRankMutationSource } from "@repo/api/src/types/project-artifact-bulk-rank";
import {
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectHierarchyOperation,
  ProjectHierarchyPlacement,
  ProjectHierarchySource,
} from "@repo/api/src/types/project-hierarchy-transaction";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
import { artifactBulkRankService } from "@/app/documents/artifact-bulk-rank-service";
import { projectArtifactPlacementService } from "@/app/documents/project-artifact-placement-service";

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
vi.mock("@/lib/manual-artifact-ordering-feature", () => ({
  isManualArtifactOrderingEnabled: vi.fn(async () => true),
  withProjectArtifactPlacementGate: (
    _auth: unknown,
    onEnabled: () => unknown
  ) => onEnabled(),
}));

import { POST as hierarchyTransaction } from "@/app/projects/[id]/artifacts/hierarchy-transactions/route";
import { POST as recoverPlacement } from "@/app/projects/[id]/artifacts/placement/[transactionId]/verification/route";
import { POST as placeArtifacts } from "@/app/projects/[id]/artifacts/placement/route";
import { POST as rankArtifacts } from "@/app/projects/[id]/artifacts/rank/route";

const harness = createReceiptRouteHarness();
const callerApiKeySchema = z.object({ apiKeyId: z.string() });
type World = Awaited<ReturnType<typeof harness.seedWorld>>;

/**
 * ISS-12552: an API-key rank, placement, hierarchy transaction
 * or placement recovery records one move receipt per artifact in the write's
 * own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 project artifact order receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("rank rolls the order back when a receipt cannot be stored", async () => {
      const { world, first, second } = await seedTwoRoots();
      const before = await readSortOrders([first, second]);
      failReceiptInserts();

      const response = await sendRank(world, [second, first]);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readSortOrders([first, second])).toEqual(before);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("rank records one move per root, a root already in its slot as a no-op", async () => {
      const { world, first, second } = await seedTwoRoots();
      // Ascending sort order lists `first` on top, already at grid slot 0.
      await setSortOrder(first, 0);
      await setSortOrder(second, 5);

      const response = await sendRank(world, [first, second]);

      expect(response.status).toBe(200);
      expect(await moveReceipts(world)).toEqual([
        {
          targetArtifactId: first,
          outcome: OperationReceiptOutcome.NoOp,
          changedFields: [],
          route: "/projects/[id]/artifacts/rank",
        },
        {
          targetArtifactId: second,
          outcome: OperationReceiptOutcome.Committed,
          changedFields: ["sortOrder"],
          route: "/projects/[id]/artifacts/rank",
        },
      ]);
    });

    it("placement rolls the move back when a receipt cannot be stored", async () => {
      const { world, first, second } = await seedTwoRoots();
      const before = await readSortOrders([first, second]);
      failReceiptInserts();

      const response = await sendPlacement(world, second, first);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readSortOrders([first, second])).toEqual(before);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("placement records a committed move for each artifact it moved", async () => {
      const { world, first, second } = await seedTwoRoots();

      const response = await sendPlacement(world, second, first);
      const body = (await response.json()) as {
        data: { affectedArtifactIds: string[] };
      };

      expect(response.status).toBe(200);
      expect(body.data.affectedArtifactIds.length).toBeGreaterThan(0);
      expect(await moveReceipts(world)).toEqual(
        body.data.affectedArtifactIds.map((artifactId) => ({
          targetArtifactId: artifactId,
          outcome: OperationReceiptOutcome.Committed,
          changedFields: [],
          route: "/projects/[id]/artifacts/placement",
        }))
      );
    });

    it("hierarchy transaction rolls the move back when a receipt cannot be stored", async () => {
      const { world, first, second } = await seedTwoRoots();
      const before = await readSortOrders([first, second]);
      failReceiptInserts();

      const response = await sendHierarchyMove(world, first);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readSortOrders([first, second])).toEqual(before);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("hierarchy transaction records a move for each changed artifact", async () => {
      const { world, first } = await seedTwoRoots();

      const response = await sendHierarchyMove(world, first);
      const body = (await response.json()) as {
        data: { changedArtifactIds: string[] };
      };

      expect(response.status).toBe(200);
      const expectedTargets =
        body.data.changedArtifactIds.length > 0
          ? body.data.changedArtifactIds
          : [first];
      expect(
        (await moveReceipts(world)).map((receipt) => receipt.targetArtifactId)
      ).toEqual(expectedTargets);
    });

    it("recovery records a no-op per placed artifact when nothing drifted, and rolls back with a failing receipt", async () => {
      const { world, first, second } = await seedTwoRoots();
      const placed = await sendPlacement(world, second, first);
      const { data } = (await placed.json()) as {
        data: { transactionId: string };
      };
      await clearReceipts(world);

      failReceiptInserts();
      const failed = await sendRecover(world, data.transactionId);
      expect(failed.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);

      turnReceiptInsertsBackOn();
      const response = await sendRecover(world, data.transactionId);

      expect(response.status).toBe(200);
      expect(await moveReceipts(world)).toEqual([
        {
          targetArtifactId: second,
          outcome: OperationReceiptOutcome.NoOp,
          changedFields: [],
          route:
            "/projects/[id]/artifacts/placement/[transactionId]/verification",
        },
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const { world, first, second } = await seedTwoRoots();
      turnAttributionFlagOff();

      const statuses = [
        (await sendRank(world, [second, first])).status,
        (await sendPlacement(world, first, second)).status,
        (await sendHierarchyMove(world, second)).status,
      ];

      expect(statuses).toEqual([200, 200, 200]);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

async function seedTwoRoots() {
  const world = await harness.seedWorld();
  await seedCallerApiKey(world);
  const first = await harness.seedDocument(world, "First root");
  const second = await harness.seedDocument(world, "Second root");
  return { world, first, second };
}

async function sendRank(world: World, orderedArtifactIds: string[]) {
  const state = await artifactBulkRankService.getRankState(
    world.projectId,
    world.organizationId
  );
  return rankArtifacts(
    apiKeyRouteRequest("POST", `/projects/${world.projectId}/artifacts/rank`, {
      orderedArtifactIds,
      expectedRankEpoch: state.rankEpoch,
      source: BulkRankMutationSource.Api,
      idempotencyKey: randomUUID(),
    }),
    receiptRouteParams({ id: world.projectId })
  );
}

async function sendPlacement(
  world: World,
  artifactId: string,
  beforeArtifactId: string
) {
  return placeArtifacts(
    apiKeyRouteRequest(
      "POST",
      `/projects/${world.projectId}/artifacts/placement`,
      {
        kind: ProjectArtifactPlacementKind.Place,
        sourceArtifactIds: [artifactId],
        destinationProjectId: world.projectId,
        position: ProjectArtifactPlacementPosition.Before,
        targetArtifactId: beforeArtifactId,
        expectedProjectVersions: {
          [world.projectId]: await projectVersion(world),
        },
        idempotencyKey: randomUUID(),
        source: ProjectArtifactPlacementSource.Api,
      }
    ),
    receiptRouteParams({ id: world.projectId })
  );
}

async function sendHierarchyMove(world: World, artifactId: string) {
  return hierarchyTransaction(
    apiKeyRouteRequest(
      "POST",
      `/projects/${world.projectId}/artifacts/hierarchy-transactions`,
      {
        operation: ProjectHierarchyOperation.Move,
        artifactIds: [artifactId],
        placement: ProjectHierarchyPlacement.End,
        expectedRevisions: [
          {
            projectId: world.projectId,
            revision: await projectVersion(world, true),
          },
        ],
        idempotencyKey: randomUUID(),
        source: ProjectHierarchySource.Api,
      }
    ),
    receiptRouteParams({ id: world.projectId })
  );
}

async function sendRecover(world: World, transactionId: string) {
  return recoverPlacement(
    apiKeyRouteRequest(
      "POST",
      `/projects/${world.projectId}/artifacts/placement/${transactionId}/verification`,
      {
        expectedProjectVersions: {
          [world.projectId]: await projectVersion(world),
        },
      }
    ),
    receiptRouteParams({ id: world.projectId, transactionId })
  );
}

async function projectVersion(
  world: World,
  includeAllTypes = false
): Promise<string> {
  const state = await projectArtifactPlacementService.getProjectPlacementState(
    world.projectId,
    world.organizationId,
    { userId: world.userId, authMethod: "api_key" },
    includeAllTypes
  );
  if (!state) {
    throw new Error("Expected the ISS-12552 project placement state");
  }
  return state.projectVersion;
}

function turnReceiptInsertsBackOn(): void {
  receiptRouteState.failReceiptInsert = false;
}

async function readSortOrders(ids: string[]) {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
      select: { id: true, sortOrder: true },
    })
  );
  return rows;
}

function setSortOrder(artifactId: string, sortOrder: number) {
  return withDb((db) =>
    db.artifact.update({
      where: { id: artifactId },
      data: { sortOrder },
      select: { id: true },
    })
  );
}

async function moveReceipts(world: World) {
  const receipts = await readReceipts(world.organizationId);
  return receipts
    .filter((receipt) => receipt.operationKind === OperationKind.Move)
    .map(({ targetArtifactId, outcome, changedFields, route }) => ({
      targetArtifactId,
      outcome,
      changedFields,
      route,
    }));
}

function clearReceipts(world: World) {
  return withDb((db) =>
    db.artifactOperationReceipt.deleteMany({
      where: { organizationId: world.organizationId },
    })
  );
}

/**
 * Placement re-checks that the caller's API key is live and holds the write
 * scope, so the key the harness put on the request needs its row.
 */
async function seedCallerApiKey(world: World) {
  const { apiKeyId } = callerApiKeySchema.parse(receiptRouteState.context);
  await withDb((db) =>
    db.apiKey.create({
      data: {
        id: apiKeyId,
        organizationId: world.organizationId,
        userId: world.userId,
        name: "ISS-12552 receipts",
        scopes: [ApiKeyScope.Read, ApiKeyScope.Write],
        keyHash: `iss12552-${apiKeyId}`,
        keyPrefix: "sk_live_test",
      },
      select: { id: true },
    })
  );
}

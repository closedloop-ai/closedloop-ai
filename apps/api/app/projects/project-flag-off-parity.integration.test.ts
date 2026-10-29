import { randomUUID } from "node:crypto";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { ProjectStatus } from "@repo/api/src/types/project";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

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

import {
  POST as favoriteArtifact,
  DELETE as unfavoriteArtifact,
} from "@/app/artifacts/[id]/favorite/route";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import {
  POST as favoriteProject,
  DELETE as unfavoriteProject,
} from "@/app/projects/[id]/favorite/route";
import { PUT as updateProject } from "@/app/projects/[id]/route";

const harness = createReceiptRouteHarness();
const customFieldIds = new Set<string>();
type World = Awaited<ReturnType<typeof harness.seedWorld>>;

/**
 * ISS-12552: flag-off behavior equals main for favorites and the project PUT.
 * With `attribution-evidence-policy` off, or for a session caller, they run
 * exactly as they do on main.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 favorite and project writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      const ids = [...customFieldIds];
      customFieldIds.clear();
      await withDb(async (db) => {
        await db.customFieldValue.deleteMany({
          where: { customFieldId: { in: ids } },
        });
        await db.customField.deleteMany({ where: { id: { in: ids } } });
      });
      await harness.cleanup();
    });

    it("an artifact favorite and its removal open no transaction, as on main", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Favorite");
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const added = await favoriteArtifact(
        apiKeyRouteRequest("POST", `/artifacts/${documentId}/favorite`),
        receiptRouteParams({ id: documentId })
      );
      const repeated = await favoriteArtifact(
        apiKeyRouteRequest("POST", `/artifacts/${documentId}/favorite`),
        receiptRouteParams({ id: documentId })
      );
      const favorited = await countArtifactFavorites(documentId);
      const removed = await unfavoriteArtifact(
        apiKeyRouteRequest("DELETE", `/artifacts/${documentId}/favorite`),
        receiptRouteParams({ id: documentId })
      );

      expect([added.status, repeated.status, removed.status]).toEqual([
        200, 200, 200,
      ]);
      expect(await added.json()).toEqual({
        success: true,
        data: { favorited: true },
      });
      expect(transactions.calls).toBe(0);
      expect(favorited).toBe(1);
      expect(await countArtifactFavorites(documentId)).toBe(0);
    });

    it("a project favorite opens no transaction for a session caller, as on main", async () => {
      const world = await harness.seedWorld();
      useSessionCaller();
      const transactions = countTransactions();

      const added = await favoriteProject(
        apiKeyRouteRequest("POST", `/projects/${world.projectId}/favorite`),
        receiptRouteParams({ id: world.projectId })
      );
      const removed = await unfavoriteProject(
        apiKeyRouteRequest("DELETE", `/projects/${world.projectId}/favorite`),
        receiptRouteParams({ id: world.projectId })
      );

      expect([added.status, removed.status]).toEqual([200, 200]);
      expect(transactions.calls).toBe(0);
    });

    it("PUT half-applies a refused custom field like main, for an API-key caller", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();

      expect(await putWithRefusedSecondField(world)).toEqual({
        status: 400,
        projectStatus: ProjectStatus.InProgress,
        values: 1,
      });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PUT half-applies a refused custom field like main, for a session caller", async () => {
      const world = await harness.seedWorld();
      useSessionCaller();

      expect(await putWithRefusedSecondField(world)).toEqual({
        status: 400,
        projectStatus: ProjectStatus.InProgress,
        values: 1,
      });
    });
  }
);

function useSessionCaller(): void {
  const apiKeyContext = receiptRouteState.context as AuthContext;
  receiptRouteState.context = createTestAuthContext({
    user: apiKeyContext.user,
    authMethod: "session",
  });
}

/**
 * PUT a status change with two custom fields where the second is refused only
 * at write time (a value that turned invalid after the preflight), and read
 * back what stayed stored.
 */
async function putWithRefusedSecondField(world: World) {
  const textFieldId = await seedProjectField(world, CustomFieldType.Text);
  const enumFieldId = await seedProjectField(world, CustomFieldType.Enum);
  vi.spyOn(
    customFieldValuesService,
    "validateValueForEntity"
  ).mockResolvedValue(undefined);

  const response = await updateProject(
    apiKeyRouteRequest("PUT", `/projects/${world.projectId}`, {
      status: ProjectStatus.InProgress,
      customFields: {
        [textFieldId]: "applied first",
        [enumFieldId]: randomUUID(),
      },
    }),
    receiptRouteParams({ id: world.projectId })
  );

  return await withDb(async (db) => {
    const project = await db.project.findUniqueOrThrow({
      where: { id: world.projectId },
      select: { status: true },
    });
    return {
      status: response.status,
      projectStatus: project.status,
      values: await db.customFieldValue.count({
        where: { entityId: world.projectId },
      }),
    };
  });
}

async function seedProjectField(
  world: World,
  fieldType: CustomFieldType
): Promise<string> {
  const field = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId: world.organizationId,
        name: `ISS-12552 project parity ${fieldType} ${randomUUID()}`,
        fieldType,
        entityTypes: [CustomFieldEntityType.Project],
      },
      select: { id: true },
    })
  );
  customFieldIds.add(field.id);
  return field.id;
}

function countArtifactFavorites(artifactId: string): Promise<number> {
  return withDb((db) => db.favoriteArtifact.count({ where: { artifactId } }));
}

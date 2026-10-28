import { OperationReceiptOutcome } from "@repo/api/src/types/attribution-evidence";
import { MovePosition } from "@repo/api/src/types/project-artifact-move";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  receiptRouteParams,
  receiptRouteRequest,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

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

import { POST as moveArtifact } from "@/app/projects/[id]/artifacts/move/route";
import { PUT as updateProject } from "@/app/projects/[id]/route";
import { POST as createProject } from "@/app/projects/route";

const harness = createReceiptRouteHarness();

/**
 * ISS-12552: a project write and its operation receipt share one
 * transaction, so a receipt that cannot be stored leaves no write behind.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 project writes roll back with their receipt",
  () => {
    afterEach(() => harness.cleanup());

    it("POST /projects leaves no project", async () => {
      const world = await harness.seedWorld();
      const teamId = await seedTeam(world.organizationId);
      failReceiptInserts();

      const response = await createProject(
        receiptRouteRequest("POST", "/projects", {
          name: "Rolled back",
          teamIds: [teamId],
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(
        await withDb((db) =>
          db.project.count({
            where: {
              organizationId: world.organizationId,
              name: "Rolled back",
            },
          })
        )
      ).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PUT /projects/[id] keeps the project unchanged", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await updateProject(
        receiptRouteRequest("PUT", `/projects/${world.projectId}`, {
          name: "Renamed",
        }),
        receiptRouteParams({ id: world.projectId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(
        await withDb((db) =>
          db.project.findUniqueOrThrow({
            where: { id: world.projectId },
            select: { name: true },
          })
        )
      ).toEqual({ name: "Test Project" });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /projects/[id]/artifacts/move keeps the order", async () => {
      const world = await harness.seedWorld();
      await harness.seedDocument(world, "First");
      await harness.seedDocument(world, "Second");
      const before = await readOrder(world.projectId);
      failReceiptInserts();

      const response = await moveArtifact(
        receiptRouteRequest(
          "POST",
          `/projects/${world.projectId}/artifacts/move`,
          {
            artifactId: before.at(-1)?.id,
            position: MovePosition.Top,
          }
        ),
        receiptRouteParams({ id: world.projectId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readOrder(world.projectId)).toEqual(before);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 project writes that change nothing (PRD-800 'No-op writes')",
  () => {
    afterEach(() => harness.cleanup());

    it("records a move to the artifact's own slot as a no-op, and a real move as committed", async () => {
      const world = await harness.seedWorld();
      await harness.seedDocument(world, "First");
      await harness.seedDocument(world, "Second");
      const [top, bottom] = await readOrder(world.projectId);
      const move = (artifactId: string | undefined) =>
        moveArtifact(
          receiptRouteRequest(
            "POST",
            `/projects/${world.projectId}/artifacts/move`,
            { artifactId, position: MovePosition.Top }
          ),
          receiptRouteParams({ id: world.projectId })
        );

      const stayed = await move(top?.id);
      const moved = await move(bottom?.id);

      expect([stayed.status, moved.status]).toEqual([200, 200]);
      expect(await receiptsOf(world.organizationId)).toEqual([
        { outcome: OperationReceiptOutcome.NoOp, changedFields: [] },
        {
          outcome: OperationReceiptOutcome.Committed,
          changedFields: ["sortOrder"],
        },
      ]);
    });

    it("records a PUT that changes nothing as a no-op, and one that renames as committed", async () => {
      const world = await harness.seedWorld();
      const put = (body: object) =>
        updateProject(
          receiptRouteRequest("PUT", `/projects/${world.projectId}`, body),
          receiptRouteParams({ id: world.projectId })
        );

      const unchanged = await put({ name: "Test Project" });
      const renamed = await put({ name: "Renamed", priority: null });

      expect([unchanged.status, renamed.status]).toEqual([200, 200]);
      expect(await receiptsOf(world.organizationId)).toEqual([
        { outcome: OperationReceiptOutcome.NoOp, changedFields: [] },
        {
          outcome: OperationReceiptOutcome.Committed,
          changedFields: ["name"],
        },
      ]);
    });
  }
);

function receiptsOf(organizationId: string) {
  return withDb((db) =>
    db.artifactOperationReceipt.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: { outcome: true, changedFields: true },
    })
  );
}

async function seedTeam(organizationId: string): Promise<string> {
  const team = await withDb((db) =>
    db.team.create({
      data: { organizationId, name: "Receipts", slug: "receipts" },
      select: { id: true },
    })
  );
  return team.id;
}

function readOrder(projectId: string) {
  return withDb((db) =>
    db.artifact.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "asc" }],
      select: { id: true, sortOrder: true },
    })
  );
}

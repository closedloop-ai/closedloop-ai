import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { Priority } from "@repo/api/src/types/common";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
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
import { createTestSessionDetail } from "@/__tests__/utils/db-helpers";
import { AgentSessionBulkAssignField } from "./write-contract";

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
  getOrgAdminStatus: vi.fn(async () => ({ isAdmin: false })),
}));
vi.mock(
  "@/app/documents/single-priority-side-effects",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    emitSinglePrioritySideEffects: vi.fn(),
  })
);
vi.mock("./bulk-assign-side-effects", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitBulkAssignSideEffects: vi.fn(),
}));

import { PATCH as updateSession } from "@/app/agent-sessions/[id]/route";
import { POST as bulkAssign } from "@/app/agent-sessions/bulk-assign/route";
import { POST as bulkAssignV2 } from "@/app/agent-sessions/bulk-assign/v2/route";
import { POST as createSession } from "@/app/agent-sessions/route";

const harness = createReceiptRouteHarness();
type World = Awaited<ReturnType<typeof harness.seedWorld>>;

/**
 * ISS-12552: an API-key session write records its receipt in
 * the write's own transaction, one per session for a bulk assignment.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 agent session write receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("POST /agent-sessions rolls the create back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedComputeTarget(world);
      const externalSessionId = `receipt-${randomUUID()}`;
      failReceiptInserts();

      const response = await createSession(
        apiKeyRouteRequest("POST", "/agent-sessions", {
          computeTargetId,
          externalSessionId,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countSessionDetails(computeTargetId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /agent-sessions records a create, and its idempotent retry as a no-op", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedComputeTarget(world);
      const body = { computeTargetId, externalSessionId: randomUUID() };
      const post = () =>
        createSession(
          apiKeyRouteRequest("POST", "/agent-sessions", body),
          receiptRouteParams({})
        );

      const statuses = [(await post()).status, (await post()).status];
      const [detail] = await withDb((db) =>
        db.sessionDetail.findMany({
          where: { computeTargetId },
          select: { artifactId: true },
        })
      );

      expect(statuses).toEqual([200, 200]);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.Create,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: detail?.artifactId,
          createdArtifactId: detail?.artifactId,
          changedFields: [],
          route: "/agent-sessions",
        },
        {
          operationKind: OperationKind.Create,
          outcome: OperationReceiptOutcome.NoOp,
          source: OperationSource.Api,
          targetArtifactId: detail?.artifactId,
          createdArtifactId: null,
          changedFields: [],
          route: "/agent-sessions",
        },
      ]);
    });

    it("PATCH keeps the status when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedSession(world);
      failReceiptInserts();

      const response = await patchSession(sessionId, {
        status: SESSION_STATUS.INACTIVE,
      });

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect((await readSessionRow(sessionId)).status).toBe(
        SESSION_STATUS.ACTIVE
      );
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PATCH keeps the name when the rename's receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedSession(world);
      failReceiptInserts();

      const response = await patchSession(sessionId, { name: "Renamed" });

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect((await readSessionRow(sessionId)).nameOverride).toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PATCH keeps the priority when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedSession(world);
      failReceiptInserts();

      const response = await patchSession(sessionId, {
        priority: Priority.High,
      });

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect((await readSessionRow(sessionId)).priority).toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PATCH records one field update per write, naming what moved", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedSession(world);

      const statuses = [
        (await patchSession(sessionId, { status: SESSION_STATUS.INACTIVE }))
          .status,
        (await patchSession(sessionId, { status: SESSION_STATUS.INACTIVE }))
          .status,
        (await patchSession(sessionId, { name: "Renamed" })).status,
        (await patchSession(sessionId, { priority: Priority.High })).status,
      ];

      expect(statuses).toEqual([200, 200, 200, 200]);
      expect(await readReceipts(world.organizationId)).toEqual(
        [["status"], [], ["name"], ["priority"]].map((changedFields) => ({
          operationKind: OperationKind.UpdateFields,
          outcome:
            changedFields.length > 0
              ? OperationReceiptOutcome.Committed
              : OperationReceiptOutcome.NoOp,
          source: OperationSource.Api,
          targetArtifactId: sessionId,
          createdArtifactId: null,
          changedFields,
          route: "/agent-sessions/[id]",
        }))
      );
    });

    it("bulk-assign keeps every project when a receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionIds = [await seedSession(world), await seedSession(world)];
      failReceiptInserts();

      const response = await bulkAssign(
        apiKeyRouteRequest("POST", "/agent-sessions/bulk-assign", {
          sessionIds,
          field: AgentSessionBulkAssignField.Project,
          value: world.projectId,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readProjectIds(sessionIds)).toEqual([null, null]);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("bulk-assign v2 keeps every project when a receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sessionIds = [await seedSession(world), await seedSession(world)];
      failReceiptInserts();

      const response = await bulkAssignV2(
        apiKeyRouteRequest("POST", "/agent-sessions/bulk-assign/v2", {
          sessionIds,
          field: AgentSessionBulkAssignField.Project,
          value: world.projectId,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readProjectIds(sessionIds)).toEqual([null, null]);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("bulk-assign records one receipt per session, a no-op for one already there", async () => {
      const world = await harness.seedWorld();
      const moved = await seedSession(world);
      const alreadyThere = await seedSession(world);
      await withDb((db) =>
        db.artifact.update({
          where: { id: alreadyThere },
          data: { projectId: world.projectId },
          select: { id: true },
        })
      );

      const response = await bulkAssign(
        apiKeyRouteRequest("POST", "/agent-sessions/bulk-assign", {
          sessionIds: [moved, alreadyThere],
          field: AgentSessionBulkAssignField.Project,
          value: world.projectId,
        }),
        receiptRouteParams({})
      );
      const receipts = await readReceipts(world.organizationId);

      expect(response.status).toBe(200);
      expect(receipts).toHaveLength(2);
      expect(receipts).toEqual(
        expect.arrayContaining(
          [
            {
              targetArtifactId: moved,
              outcome: OperationReceiptOutcome.Committed,
              changedFields: ["projectId"],
            },
            {
              targetArtifactId: alreadyThere,
              outcome: OperationReceiptOutcome.NoOp,
              changedFields: [],
            },
          ].map((expected) => ({
            ...expected,
            operationKind: OperationKind.UpdateFields,
            source: OperationSource.Api,
            createdArtifactId: null,
            route: "/agent-sessions/bulk-assign",
          }))
        )
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedSession(world);
      turnAttributionFlagOff();

      const response = await patchSession(sessionId, {
        status: SESSION_STATUS.INACTIVE,
      });

      expect(response.status).toBe(200);
      expect((await readSessionRow(sessionId)).status).toBe(
        SESSION_STATUS.INACTIVE
      );
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function patchSession(sessionId: string, body: Record<string, unknown>) {
  return updateSession(
    apiKeyRouteRequest("PATCH", `/agent-sessions/${sessionId}`, body),
    receiptRouteParams({ id: sessionId })
  );
}

function seedSession(world: World): Promise<string> {
  return createTestSessionDetail({
    organizationId: world.organizationId,
    userId: world.userId,
    label: "receipt",
  });
}

async function seedComputeTarget(world: World): Promise<string> {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId: world.organizationId,
        userId: world.userId,
        machineName: `receipt-${randomUUID().slice(0, 8)}`,
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  return target.id;
}

function countSessionDetails(computeTargetId: string): Promise<number> {
  return withDb((db) => db.sessionDetail.count({ where: { computeTargetId } }));
}

async function readSessionRow(sessionId: string) {
  const row = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        status: true,
        priority: true,
        session: { select: { nameOverride: true } },
      },
    })
  );
  return {
    status: row.status,
    priority: row.priority,
    nameOverride: row.session?.nameOverride ?? null,
  };
}

async function readProjectIds(
  sessionIds: readonly string[]
): Promise<(string | null)[]> {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: { id: { in: [...sessionIds] } },
      select: { id: true, projectId: true },
    })
  );
  const byId = new Map(rows.map((row) => [row.id, row.projectId]));
  return sessionIds.map((id) => byId.get(id) ?? null);
}

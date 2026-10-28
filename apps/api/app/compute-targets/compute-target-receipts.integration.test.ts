import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { MEMBER_PACK_INSTALL_OPERATION_ID } from "@repo/api/src/types/member-pack-install";
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
import { useSessionCaller } from "@/__tests__/support/lib/session-caller.test-helpers";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";

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

import { POST as createCommand } from "@/app/compute-targets/[id]/commands/route";
import { POST as installPack } from "@/app/compute-targets/[id]/member-installs/route";
import { DELETE as deleteTarget } from "@/app/compute-targets/[id]/route";
import { POST as registerTarget } from "@/app/compute-targets/register/route";

const harness = createReceiptRouteHarness();
const MACHINE_NAME = "receipt-machine";

/**
 * ISS-12552: an API-key compute target write records an
 * organization write receipt in the write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 compute target receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("POST /compute-targets/register registers nothing when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await registerTarget(
        registerRequest(),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countTargets(world.organizationId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /compute-targets/register records an organization write naming the route", async () => {
      const world = await harness.seedWorld();

      const response = await registerTarget(
        registerRequest(),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await readReceipts(world.organizationId)).toEqual([
        organizationWrite(
          OperationReceiptOutcome.Committed,
          "/compute-targets/register"
        ),
      ]);
    });

    it("POST /compute-targets/register writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();

      const response = await registerTarget(
        registerRequest(),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await countTargets(world.organizationId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /compute-targets/[id] keeps the target when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const targetId = await seedTarget(world, []);
      failReceiptInserts();

      const response = await deleteTarget(
        apiKeyRouteRequest("DELETE", `/compute-targets/${targetId}`),
        receiptRouteParams({ id: targetId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readTarget(targetId)).not.toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /compute-targets/[id]/commands queues nothing when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const targetId = await seedTarget(world, []);
      failReceiptInserts();

      const response = await createCommand(
        commandRequest(targetId, "receipt-key"),
        receiptRouteParams({ id: targetId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countCommands(targetId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /compute-targets/[id]/commands records a deduplicated retry as a no-op", async () => {
      const world = await harness.seedWorld();
      const targetId = await seedTarget(world, []);
      const send = () =>
        createCommand(
          commandRequest(targetId, "receipt-key"),
          receiptRouteParams({ id: targetId })
        );

      const statuses = [(await send()).status, (await send()).status];

      expect(statuses).toEqual([200, 200]);
      expect(await countCommands(targetId)).toBe(1);
      expect(await readReceipts(world.organizationId)).toEqual(
        [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
          (outcome) =>
            organizationWrite(outcome, "/compute-targets/[id]/commands")
        )
      );
    });

    it("POST /compute-targets/[id]/member-installs queues nothing when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const targetId = await seedTarget(world, [
        MEMBER_PACK_INSTALL_OPERATION_ID,
      ]);
      failReceiptInserts();

      const response = await installPack(
        apiKeyRouteRequest(
          "POST",
          `/compute-targets/${targetId}/member-installs`,
          { packId: randomUUID(), harness: "claude" }
        ),
        receiptRouteParams({ id: targetId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countCommands(targetId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

/**
 * ISS-12552: flag-off behavior equals main for queued desktop commands. With
 * `attribution-evidence-policy` off, or for a session caller, the command is
 * inserted as main inserts it, with one autocommit statement and no
 * transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 compute target writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("POST /compute-targets/[id]/commands queues the command outside any transaction, for an API-key caller", async () => {
      const world = await harness.seedWorld();
      const targetId = await seedTarget(world, []);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await createCommand(
        commandRequest(targetId, "parity-key"),
        receiptRouteParams({ id: targetId })
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).not.toHaveProperty(
        "operationReceipt"
      );
      expect(transactions.opened).toBe(0);
      expect(await countCommands(targetId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /compute-targets/[id]/commands queues the command outside any transaction, for a session caller", async () => {
      const world = await harness.seedWorld();
      const targetId = await seedTarget(world, []);
      useSessionCaller();
      const transactions = countTransactions();

      const response = await createCommand(
        commandRequest(targetId, "parity-key"),
        receiptRouteParams({ id: targetId })
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(await countCommands(targetId)).toBe(1);
    });

    it("POST /compute-targets/[id]/member-installs queues the install outside any transaction", async () => {
      const world = await harness.seedWorld();
      const targetId = await seedTarget(world, [
        MEMBER_PACK_INSTALL_OPERATION_ID,
      ]);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await installPack(
        apiKeyRouteRequest(
          "POST",
          `/compute-targets/${targetId}/member-installs`,
          { packId: randomUUID(), harness: "claude" }
        ),
        receiptRouteParams({ id: targetId })
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(await countCommands(targetId)).toBe(1);
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

function registerRequest() {
  return apiKeyRouteRequest("POST", "/compute-targets/register", {
    machineName: MACHINE_NAME,
    platform: "darwin",
    supportedOperations: [],
  });
}

function commandRequest(targetId: string, idempotencyKey: string) {
  return apiKeyRouteRequest("POST", `/compute-targets/${targetId}/commands`, {
    operationId: "receipt_probe",
    method: "GET",
    path: "/api/gateway/health",
    idempotencyKey,
  });
}

function countTargets(organizationId: string): Promise<number> {
  return withDb((db) => db.computeTarget.count({ where: { organizationId } }));
}

function countCommands(computeTargetId: string): Promise<number> {
  return withDb((db) =>
    db.desktopCommand.count({ where: { computeTargetId } })
  );
}

function readTarget(id: string) {
  return withDb((db) =>
    db.computeTarget.findUnique({
      where: { id },
      select: { platform: true },
    })
  );
}

async function seedTarget(
  world: { organizationId: string; userId: string },
  supportedOperations: string[]
): Promise<string> {
  const row = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId: world.organizationId,
        userId: world.userId,
        machineName: MACHINE_NAME,
        platform: "darwin",
        supportedOperations,
      },
      select: { id: true },
    })
  );
  return row.id;
}

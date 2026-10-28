import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import {
  SessionMeshForbiddenCode,
  sessionMeshPresenceValidator,
  sessionMeshPublishValidator,
} from "@repo/api/src/types/session-mesh";
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
  receiptRouteRequest,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";
import { createTestUser } from "@/__tests__/utils/db-helpers";

const meshRollout = vi.hoisted(() => ({ on: true }));

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
vi.mock("@/lib/feature-flag-identity", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFeatureFlagEnabledForAnyIdentity: async () => meshRollout.on,
}));

import { POST as acknowledge } from "@/app/session-mesh/acknowledge/route";
import { POST as feedback } from "@/app/session-mesh/feedback/route";
import { POST as disposition } from "@/app/session-mesh/inbox/disposition/route";
import { POST as publish } from "@/app/session-mesh/messages/route";
import {
  POST as heartbeat,
  DELETE as unregister,
} from "@/app/session-mesh/presence/route";
import { sessionMeshService } from "@/app/session-mesh/service";
import { POST as subscribe } from "@/app/session-mesh/subscriptions/route";

const harness = createReceiptRouteHarness();
const NO_PARAMS = receiptRouteParams({});
const REPOSITORY = "github.com/receipts/mesh";
const PATHS = ["src/shared.ts"];
const CALLER_AGENT = "claude:caller";
const AUTHOR_AGENT = "codex:author";

type World = Awaited<ReturnType<typeof harness.seedWorld>>;

/**
 * ISS-12552: an API-key Session Mesh write records a receipt in
 * the write's own transaction; a request the mesh wrapper refuses records none.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 session mesh write receipts",
  () => {
    afterEach(async () => {
      meshRollout.on = true;
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("POST /session-mesh/presence rolls the heartbeat back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await heartbeat(
        apiKeyRouteRequest("POST", "/session-mesh/presence", presenceBody()),
        NO_PARAMS
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countPresence(world.organizationId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /session-mesh/presence keeps the registration live when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      await register(world.organizationId, world.userId, CALLER_AGENT);
      failReceiptInserts();

      const response = await unregister(
        apiKeyRouteRequest("DELETE", "/session-mesh/presence", {
          agentId: CALLER_AGENT,
        }),
        NO_PARAMS
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countLivePresence(world.organizationId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /session-mesh/messages rolls the message back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      await register(world.organizationId, world.userId, CALLER_AGENT);
      failReceiptInserts();

      const response = await publish(
        apiKeyRouteRequest(
          "POST",
          "/session-mesh/messages",
          publishBody(CALLER_AGENT, "rollback")
        ),
        NO_PARAMS
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countMessages(world.organizationId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /session-mesh/acknowledge leaves the delivery open when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const messageId = await seedDelivery(world);
      failReceiptInserts();

      const response = await acknowledge(
        apiKeyRouteRequest("POST", "/session-mesh/acknowledge", {
          agentId: CALLER_AGENT,
          messageIds: [messageId],
        }),
        NO_PARAMS
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await deliveryStatus(messageId)).toBe("queued");
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /session-mesh/inbox/disposition leaves the delivery open when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const messageId = await seedDelivery(world);
      failReceiptInserts();

      const response = await disposition(
        apiKeyRouteRequest("POST", "/session-mesh/inbox/disposition", {
          agentId: CALLER_AGENT,
          messageId,
          status: "dismissed",
        }),
        NO_PARAMS
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await deliveryStatus(messageId)).toBe("queued");
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /session-mesh/feedback rolls the feedback back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await feedback(
        apiKeyRouteRequest("POST", "/session-mesh/feedback", {
          idempotencyKey: "feedback-rollback",
          kind: "useful",
          rationale: "avoided a conflict",
        }),
        NO_PARAMS
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countMetricEvents(world.organizationId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST /session-mesh/subscriptions rolls the subscription back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await subscribe(
        apiKeyRouteRequest("POST", "/session-mesh/subscriptions", {
          repository: REPOSITORY,
          muted: true,
        }),
        NO_PARAMS
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countSubscriptions(world.organizationId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a session mesh write per write, and a replayed publish as a no-op", async () => {
      const world = await harness.seedWorld();
      const replay = () =>
        publish(
          apiKeyRouteRequest(
            "POST",
            "/session-mesh/messages",
            publishBody(CALLER_AGENT, "replayed")
          ),
          NO_PARAMS
        );

      const statuses = [
        (
          await heartbeat(
            apiKeyRouteRequest(
              "POST",
              "/session-mesh/presence",
              presenceBody()
            ),
            NO_PARAMS
          )
        ).status,
        (await replay()).status,
        (await replay()).status,
      ];

      expect(statuses).toEqual([200, 200, 200]);
      expect(await readReceipts(world.organizationId)).toEqual(
        [
          ["/session-mesh/presence", OperationReceiptOutcome.Committed],
          ["/session-mesh/messages", OperationReceiptOutcome.Committed],
          ["/session-mesh/messages", OperationReceiptOutcome.NoOp],
        ].map(([route, outcome]) => ({
          operationKind: OperationKind.SessionMeshWrite,
          outcome,
          source: OperationSource.Api,
          targetArtifactId: null,
          createdArtifactId: null,
          changedFields: [],
          route,
        }))
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();

      const response = await heartbeat(
        apiKeyRouteRequest("POST", "/session-mesh/presence", presenceBody()),
        NO_PARAMS
      );

      expect(response.status).toBe(200);
      expect(await countPresence(world.organizationId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("with the flag off unregister, acknowledge and subscribe open no transaction, as on main", async () => {
      const world = await harness.seedWorld();
      const messageId = await seedDelivery(world);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const statuses = [
        await unregister(
          apiKeyRouteRequest("DELETE", "/session-mesh/presence", {
            agentId: AUTHOR_AGENT,
          }),
          NO_PARAMS
        ),
        await acknowledge(
          apiKeyRouteRequest("POST", "/session-mesh/acknowledge", {
            agentId: CALLER_AGENT,
            messageIds: [messageId],
          }),
          NO_PARAMS
        ),
        await subscribe(
          apiKeyRouteRequest("POST", "/session-mesh/subscriptions", {
            repository: REPOSITORY,
            muted: true,
          }),
          NO_PARAMS
        ),
      ].map((response) => response.status);

      expect(statuses).toEqual([200, 200, 200]);
      expect(transactions.opened).toBe(0);
      expect(await deliveryStatus(messageId)).toBe("acknowledged");
      expect(await countSubscriptions(world.organizationId)).toBe(1);
    });

    it("records nothing, not even a rejection, for an MCP write the mesh rollout refuses", async () => {
      const world = await harness.seedWorld();
      meshRollout.on = false;

      const response = await heartbeat(
        receiptRouteRequest("POST", "/session-mesh/presence", presenceBody()),
        NO_PARAMS
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: SessionMeshForbiddenCode.Disabled,
      });
      expect(await countPresence(world.organizationId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function presenceBody(agentId = CALLER_AGENT) {
  return {
    agentId,
    harness: "claude",
    workspace: { repository: REPOSITORY, revision: "sha-1", paths: PATHS },
  };
}

function publishBody(authorAgentId: string, idempotencyKey: string) {
  return {
    authorAgentId,
    idempotencyKey,
    kind: "discovery",
    workspace: { repository: REPOSITORY, revision: "sha-1", paths: PATHS },
    summary: "Shared entry point found.",
  };
}

async function register(
  organizationId: string,
  userId: string,
  agentId: string
) {
  const result = await sessionMeshService.upsertPresence({
    organizationId,
    userId,
    presence: sessionMeshPresenceValidator.parse(presenceBody(agentId)),
  });
  if (!result.ok) {
    throw new Error("Failed to seed the ISS-12552 mesh presence");
  }
}

/** A message another member published, queued for the caller's agent. */
async function seedDelivery(world: World): Promise<string> {
  const author = await createTestUser(world.organizationId);
  await register(world.organizationId, world.userId, CALLER_AGENT);
  await register(world.organizationId, author.id, AUTHOR_AGENT);
  const published = await sessionMeshService.publish({
    organizationId: world.organizationId,
    userId: author.id,
    message: sessionMeshPublishValidator.parse(
      publishBody(AUTHOR_AGENT, "seeded")
    ),
  });
  if (!published.ok || published.value.deliveries !== 1) {
    throw new Error("Failed to seed the ISS-12552 mesh delivery");
  }
  return published.value.message.id;
}

async function deliveryStatus(messageId: string): Promise<string | undefined> {
  const delivery = await withDb((db) =>
    db.sessionMeshDelivery.findFirst({
      where: { messageId, recipientAgentId: CALLER_AGENT },
      select: { status: true },
    })
  );
  return delivery?.status;
}

function countPresence(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.sessionMeshPresence.count({ where: { organizationId } })
  );
}

function countLivePresence(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.sessionMeshPresence.count({
      where: { organizationId, expiresAt: { gt: new Date() } },
    })
  );
}

function countMessages(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.sessionMeshMessage.count({ where: { organizationId } })
  );
}

function countMetricEvents(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.sessionMeshMetricEvent.count({ where: { organizationId } })
  );
}

function countSubscriptions(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.sessionMeshSubscription.count({ where: { organizationId } })
  );
}

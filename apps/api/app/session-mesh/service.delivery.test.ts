import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MeshDb,
  meshDbState,
  resetMeshDb,
} from "@/__tests__/support/session-mesh/session-mesh-db.test-helpers";
import { sessionMeshService } from "./service";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (
    await import(
      "@/__tests__/support/session-mesh/session-mesh-db.test-helpers"
    )
  ).meshWithDb(),
}));

const NOW = new Date("2026-09-25T12:00:00.000Z");
const ORG = "0199a1b2-0000-7000-8000-000000000001";
const USER = "0199a1b2-0000-7000-8000-000000000002";
const MESSAGE_ID = "0199a1b2-0000-7000-8000-0000000000aa";

let db: MeshDb;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = resetMeshDb();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sessionMeshService delivery reads and writes", () => {
  it("reads the inbox excluding muted repositories and held work", async () => {
    db.sessionMeshSubscription.findMany.mockResolvedValue([
      { repository: "muted/one" },
      { repository: "muted/two" },
    ]);
    const rows = [{ id: "d-1" }, { id: "d-2" }];
    db.sessionMeshDelivery.findMany.mockResolvedValue(rows);

    await expect(
      sessionMeshService.inbox({
        organizationId: ORG,
        userId: USER,
        agentId: "agent-1",
      })
    ).resolves.toEqual(rows);
    expect(db.sessionMeshSubscription.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, userId: USER, muted: true },
      select: { repository: true },
    });
    expect(db.sessionMeshDelivery.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        recipientUserId: USER,
        recipientAgentId: "agent-1",
        status: { in: ["queued", "attempted"] },
        message: {
          expiresAt: { gt: NOW },
          repository: { notIn: ["muted/one", "muted/two"] },
        },
      },
      include: { message: true },
      orderBy: { queuedAt: "asc" },
      take: 200,
    });
  });

  it("returns a stored subscription as-is", async () => {
    db.sessionMeshSubscription.findFirst.mockResolvedValue({
      muted: true,
      digestOnly: false,
    });
    const input = { organizationId: ORG, userId: USER, repository: "r" };

    await expect(sessionMeshService.subscription(input)).resolves.toEqual({
      muted: true,
      digestOnly: false,
    });
    expect(db.sessionMeshSubscription.findFirst).toHaveBeenCalledWith({
      where: input,
      select: { muted: true, digestOnly: true },
    });
  });

  it("defaults a missing subscription to unmuted, immediate delivery", async () => {
    db.sessionMeshSubscription.findFirst.mockResolvedValue(null);

    await expect(
      sessionMeshService.subscription({
        organizationId: ORG,
        userId: USER,
        repository: "r",
      })
    ).resolves.toEqual({ muted: false, digestOnly: false });
  });

  it("reads one live message for its recipient agent", async () => {
    const delivery = { id: "d-1", message: { id: MESSAGE_ID } };
    db.sessionMeshDelivery.findFirst.mockResolvedValue(delivery);

    await expect(
      sessionMeshService.messageForRecipient({
        organizationId: ORG,
        userId: USER,
        agentId: "agent-1",
        messageId: MESSAGE_ID,
      })
    ).resolves.toEqual(delivery);
    expect(db.sessionMeshDelivery.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        recipientUserId: USER,
        recipientAgentId: "agent-1",
        messageId: MESSAGE_ID,
        message: { expiresAt: { gt: NOW } },
      },
      include: { message: true },
    });
  });

  it("acknowledges only still-open deliveries for the owned agent", async () => {
    db.sessionMeshDelivery.updateMany.mockResolvedValue({ count: 2 });

    await expect(
      sessionMeshService.acknowledge({
        organizationId: ORG,
        userId: USER,
        ack: { agentId: "agent-1", messageIds: [MESSAGE_ID] },
      })
    ).resolves.toEqual({ count: 2 });
    expect(db.sessionMeshDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        recipientUserId: USER,
        recipientAgentId: "agent-1",
        messageId: { in: [MESSAGE_ID] },
        status: { in: ["queued", "attempted", "held", "delivered"] },
      },
      data: { acknowledgedAt: NOW, status: "acknowledged" },
    });
  });

  it("upserts a subscription on the org/user/repository key", async () => {
    const input = {
      organizationId: ORG,
      userId: USER,
      repository: "r",
      muted: false,
      digestOnly: true,
    };
    db.sessionMeshSubscription.upsert.mockResolvedValue({ id: "sub-1" });

    await expect(sessionMeshService.upsertSubscription(input)).resolves.toEqual(
      { id: "sub-1" }
    );
    expect(db.sessionMeshSubscription.upsert).toHaveBeenCalledWith({
      where: {
        organizationId_userId_repository: {
          organizationId: ORG,
          userId: USER,
          repository: "r",
        },
      },
      create: input,
      update: { muted: false, digestOnly: true },
    });
  });
});

describe("sessionMeshService.disposition", () => {
  const baseWhere = {
    organizationId: ORG,
    recipientUserId: USER,
    recipientAgentId: "agent-1",
    messageId: MESSAGE_ID,
  };

  it.each([
    {
      status: "delivered" as const,
      eligible: ["queued", "attempted", "held"],
      stamps: {
        deliveredAt: NOW,
        attemptedAt: NOW,
        attemptCount: { increment: 1 },
      },
    },
    {
      status: "acknowledged" as const,
      eligible: ["delivered", "held", "queued", "attempted"],
      stamps: { acknowledgedAt: NOW },
    },
    {
      status: "held" as const,
      eligible: ["queued", "attempted", "held", "delivered"],
      stamps: { heldAt: NOW },
    },
    {
      status: "refused" as const,
      eligible: ["queued", "attempted", "held", "delivered"],
      stamps: { refusedAt: NOW },
    },
    {
      status: "dismissed" as const,
      eligible: ["queued", "attempted", "held", "delivered"],
      stamps: { dismissedAt: NOW },
    },
  ])(
    "moves an eligible delivery to $status with only its own timestamp",
    async ({ status, eligible, stamps }) => {
      db.sessionMeshDelivery.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        sessionMeshService.disposition({
          organizationId: ORG,
          userId: USER,
          agentId: "agent-1",
          messageId: MESSAGE_ID,
          status,
        })
      ).resolves.toEqual({ count: 1 });
      expect(meshDbState.calls).toEqual([{ kind: "tx", options: undefined }]);
      // Strict: without a reason, no failureReason/reason key is written.
      expect(
        db.sessionMeshDelivery.updateMany.mock.calls[0]?.[0]
      ).toStrictEqual({
        where: { ...baseWhere, status: { in: eligible } },
        data: { status, ...stamps },
      });
      expect(db.sessionMeshMetricEvent.create.mock.calls[0]?.[0]).toStrictEqual(
        {
          data: {
            organizationId: ORG,
            userId: USER,
            agentId: "agent-1",
            messageId: MESSAGE_ID,
            eventType: `delivery_${status}`,
            metadata: {},
          },
          select: { id: true },
        }
      );
    }
  );

  it("records a supplied reason on the delivery and the metric event", async () => {
    db.sessionMeshDelivery.updateMany.mockResolvedValue({ count: 1 });

    await sessionMeshService.disposition({
      organizationId: ORG,
      userId: USER,
      agentId: "agent-1",
      messageId: MESSAGE_ID,
      status: "refused",
      reason: "busy",
    });

    expect(db.sessionMeshDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        ...baseWhere,
        status: { in: ["queued", "attempted", "held", "delivered"] },
      },
      data: { status: "refused", refusedAt: NOW, failureReason: "busy" },
    });
    expect(
      db.sessionMeshMetricEvent.create.mock.calls[0]?.[0].data.metadata
    ).toEqual({ reason: "busy" });
  });

  it("records no metric event when nothing was eligible to move", async () => {
    db.sessionMeshDelivery.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      sessionMeshService.disposition({
        organizationId: ORG,
        userId: USER,
        agentId: "agent-1",
        messageId: MESSAGE_ID,
        status: "held",
      })
    ).resolves.toEqual({ count: 0 });
    expect(db.sessionMeshMetricEvent.create).not.toHaveBeenCalled();
  });
});

describe("sessionMeshService.deliveryHistory", () => {
  it("deliveryHistory returns only the messages of the first page", async () => {
    const row = {
      id: "d-1",
      status: "delivered",
      message: { expiresAt: new Date(NOW.getTime() + 1000) },
    };
    db.sessionMeshDelivery.findMany.mockResolvedValue([row]);

    await expect(
      sessionMeshService.deliveryHistory({
        organizationId: ORG,
        userId: USER,
        agentId: "agent-1",
      })
    ).resolves.toEqual([row]);
  });
});

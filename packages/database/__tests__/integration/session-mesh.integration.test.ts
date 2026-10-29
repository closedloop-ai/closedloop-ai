import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../../scripts/seed/__tests__/fixtures/ephemeral-db";

describe.skipIf(!process.env.DATABASE_URL)(
  "Session Mesh PostgreSQL invariants",
  () => {
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
    });

    afterEach(async () => {
      if (!ctx) {
        return;
      }
      await ctx.prisma.sessionMeshMessage.deleteMany({
        where: { organizationId: ctx.organizationId },
      });
      await ctx.prisma.sessionMeshPresence.deleteMany({
        where: { organizationId: ctx.organizationId },
      });
    });

    afterAll(async () => {
      if (ctx) {
        await teardownEphemeralDb(ctx);
      }
    });

    function messageData(idempotencyKey: string) {
      return {
        id: randomUUID(),
        organizationId: ctx.organizationId,
        authorUserId: ctx.userId,
        authorAgentId: "claude:source",
        idempotencyKey,
        kind: "discovery",
        repository: "github.com/example/repo",
        revision: "source-branch-sha",
        summary: "Authorization is enforced at the shared API entry point.",
        expiresAt: new Date(Date.now() + 60_000),
      };
    }

    it("arbitrates concurrent retries once at the database boundary", async () => {
      const data = messageData("same-publish-retried");
      const results = await Promise.allSettled([
        ctx.prisma.sessionMeshMessage.create({
          data: { ...data, id: randomUUID() },
        }),
        ctx.prisma.sessionMeshMessage.create({ data }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ code: "P2002" }),
        }),
      ]);
      expect(
        await ctx.prisma.sessionMeshMessage.count({
          where: { organizationId: ctx.organizationId },
        })
      ).toBe(1);
    });

    it("deduplicates a recipient delivery without inventing delivery or acknowledgement", async () => {
      const message = await ctx.prisma.sessionMeshMessage.create({
        data: messageData("queued-only"),
      });
      const data = {
        organizationId: ctx.organizationId,
        messageId: message.id,
        recipientUserId: ctx.userId,
        recipientAgentId: "codex:recipient",
      };
      const delivery = await ctx.prisma.sessionMeshDelivery.create({ data });
      expect(delivery).toMatchObject({
        status: "queued",
        attemptCount: 0,
        deliveredAt: null,
        acknowledgedAt: null,
      });
      expect(delivery.queuedAt).toBeInstanceOf(Date);
      await expect(
        ctx.prisma.sessionMeshDelivery.create({ data })
      ).rejects.toMatchObject({ code: "P2002" });
      expect(
        await ctx.prisma.sessionMeshDelivery.count({
          where: { messageId: message.id },
        })
      ).toBe(1);
    });

    it("cascades message expiry cleanup to its deliveries", async () => {
      const message = await ctx.prisma.sessionMeshMessage.create({
        data: messageData("cleanup"),
      });
      await ctx.prisma.sessionMeshDelivery.create({
        select: { id: true },
        data: {
          organizationId: ctx.organizationId,
          messageId: message.id,
          recipientUserId: ctx.userId,
          recipientAgentId: "codex:recipient",
        },
      });
      await ctx.prisma.sessionMeshMessage.delete({ where: { id: message.id } });
      expect(
        await ctx.prisma.sessionMeshDelivery.count({
          where: { messageId: message.id },
        })
      ).toBe(0);
    });

    it("allows overlapping branches but refuses duplicate org agent identity", async () => {
      const shared = {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        repository: "github.com/example/repo",
        expiresAt: new Date(Date.now() + 60_000),
      };
      await ctx.prisma.sessionMeshPresence.create({
        select: { id: true },
        data: { ...shared, agentId: "claude:source", revision: "sha-one" },
      });
      await ctx.prisma.sessionMeshPresence.create({
        select: { id: true },
        data: { ...shared, agentId: "codex:recipient", revision: "sha-two" },
      });
      await expect(
        ctx.prisma.sessionMeshPresence.create({
          data: { ...shared, agentId: "claude:source", revision: "sha-three" },
        })
      ).rejects.toMatchObject({ code: "P2002" });
      expect(
        await ctx.prisma.sessionMeshPresence.count({
          where: {
            organizationId: ctx.organizationId,
            repository: shared.repository,
          },
        })
      ).toBe(2);
    });
  }
);

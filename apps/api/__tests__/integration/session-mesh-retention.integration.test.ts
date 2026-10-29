import { withDb } from "@repo/database";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { sessionMeshRetentionService } from "@/app/session-mesh/retention-service";

describe.skipIf(!process.env.DATABASE_URL)(
  "Session Mesh retention against PostgreSQL",
  () => {
    const tracker = createCommittedTestOrganizationTracker();
    afterEach(() => tracker.cleanup());

    it("expires old content and cascades inbox rows while retaining the reporting window", async () => {
      const organizationId = await tracker.create();
      const user = await createTestUser(organizationId);
      const now = new Date();
      const daysAgo = (days: number) =>
        new Date(now.getTime() - days * 86_400_000);
      const expiredMessageId = crypto.randomUUID();
      const retainedMessageId = crypto.randomUUID();
      await withDb(async (db) => {
        await db.sessionMeshMessage.createMany({
          data: [
            {
              id: expiredMessageId,
              organizationId,
              authorUserId: user.id,
              idempotencyKey: "expired",
              kind: "decision",
              repository: "github.com/example/repo",
              revision: "sha",
              summary: "Old evidence",
              createdAt: daysAgo(121),
              expiresAt: daysAgo(120),
            },
            {
              id: retainedMessageId,
              organizationId,
              authorUserId: user.id,
              idempotencyKey: "retained",
              kind: "decision",
              repository: "github.com/example/repo",
              revision: "sha",
              summary: "Retained for reporting",
              createdAt: daysAgo(61),
              expiresAt: daysAgo(60),
            },
          ],
        });
        await db.sessionMeshDelivery.createMany({
          data: [
            {
              organizationId,
              messageId: expiredMessageId,
              recipientUserId: user.id,
              recipientAgentId: "codex:peer",
            },
            {
              organizationId,
              messageId: retainedMessageId,
              recipientUserId: user.id,
              recipientAgentId: "codex:peer",
            },
          ],
        });
        await db.sessionMeshPresence.createMany({
          data: [
            {
              organizationId,
              userId: user.id,
              agentId: "codex:expired",
              repository: "github.com/example/repo",
              revision: "sha",
              expiresAt: daysAgo(31),
            },
            {
              organizationId,
              userId: user.id,
              agentId: "codex:recent",
              repository: "github.com/example/repo",
              revision: "sha",
              expiresAt: daysAgo(1),
            },
          ],
        });
        await db.sessionMeshMetricEvent.createMany({
          data: [
            {
              organizationId,
              userId: user.id,
              eventType: "delivery_useful",
              idempotencyKey: "old-metric",
              createdAt: daysAgo(91),
            },
            {
              organizationId,
              userId: user.id,
              eventType: "delivery_useful",
              idempotencyKey: "recent-metric",
              createdAt: daysAgo(89),
            },
          ],
        });
      });
      const result = await sessionMeshRetentionService.sweep(now);
      expect(result.presences).toBeGreaterThanOrEqual(1);
      expect(result.messages).toBeGreaterThanOrEqual(1);
      expect(result.metrics).toBeGreaterThanOrEqual(1);
      const rows = await withDb(async (db) => ({
        messages: await db.sessionMeshMessage.findMany({
          where: { organizationId },
          select: { id: true },
        }),
        deliveries: await db.sessionMeshDelivery.findMany({
          where: { organizationId },
          select: { messageId: true },
        }),
        presences: await db.sessionMeshPresence.findMany({
          where: { organizationId },
          select: { agentId: true },
        }),
        metrics: await db.sessionMeshMetricEvent.findMany({
          where: { organizationId },
          select: { idempotencyKey: true },
        }),
      }));
      expect(rows).toEqual({
        messages: [{ id: retainedMessageId }],
        deliveries: [{ messageId: retainedMessageId }],
        presences: [{ agentId: "codex:recent" }],
        metrics: [{ idempotencyKey: "recent-metric" }],
      });
      expect(await sessionMeshRetentionService.sweep(now)).toEqual({
        presences: 0,
        messages: 0,
        metrics: 0,
        hasMore: false,
      });
    });
  }
);

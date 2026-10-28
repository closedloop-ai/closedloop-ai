import { withDb } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { readSessionMeshInsights } from "@/app/session-mesh/service/insights";

const from = new Date("2026-09-01T00:00:00Z");
const to = new Date("2026-09-02T00:00:00Z");

describe.skipIf(!process.env.DATABASE_URL)(
  "Session Mesh reporting reconciliation",
  () => {
    const tracker = createCommittedTestOrganizationTracker();
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    });
    afterEach(async () => {
      vi.useRealTimers();
      await tracker.cleanup();
    });

    it("attributes individual-user metrics without importing a colleague's activity or savings", async () => {
      const organizationId = await tracker.create();
      const recipient = await createTestUser(organizationId);
      const colleague = await createTestUser(organizationId);
      const foreign = await createTestUser(await tracker.create());
      const requestId = crypto.randomUUID();
      const replyId = crypto.randomUUID();
      await withDb.tx(async (db) => {
        await db.sessionMeshPresence.createMany({
          data: [recipient, colleague].map((user) => ({
            organizationId,
            userId: user.id,
            agentId: `codex:${user.id}`,
            repository: "example/shared",
            revision: "sha",
            harness: "codex",
            capabilities: ["poll_inbox"],
            expiresAt: new Date("2026-09-25T12:01:00Z"),
          })),
        });
        await db.sessionMeshMessage.createMany({
          data: [
            {
              id: requestId,
              organizationId,
              authorUserId: recipient.id,
              idempotencyKey: requestId,
              kind: "request",
              repository: "example/shared",
              revision: "sha",
              summary: "Need context",
              createdAt: from,
              expiresAt: to,
            },
            {
              id: replyId,
              organizationId,
              authorUserId: colleague.id,
              idempotencyKey: replyId,
              kind: "reply",
              replyToMessageId: requestId,
              repository: "example/shared",
              revision: "sha",
              summary: "Shared evidence",
              createdAt: new Date(from.getTime() + 60_000),
              expiresAt: to,
            },
          ],
        });
        await db.sessionMeshDelivery.createMany({
          data: [recipient, colleague].map((user, index) => ({
            organizationId,
            messageId: index === 0 ? replyId : requestId,
            recipientUserId: user.id,
            recipientAgentId: `codex:${user.id}`,
            deliveredAt: new Date(from.getTime() + 120_000),
            ...(index === 0
              ? { acknowledgedAt: new Date(from.getTime() + 180_000) }
              : {}),
          })),
        });
        await db.sessionMeshMetricEvent.createMany({
          // `messageId` is load-bearing since ISS-11435: `useful` counts the
          // DELIVERIES a recipient rated, joined on message identity, so a
          // verdict that names no message is deliberately not one of them. The
          // message each user rates is the one delivered to them above.
          data: [recipient, colleague].map((user, index) => ({
            organizationId,
            userId: user.id,
            messageId: index === 0 ? replyId : requestId,
            eventType: "delivery_useful",
            createdAt: from,
            metadata: {
              estimatedTimeSavedMinutes: index === 0 ? 5 : 50,
              estimatedCostSavedUsd: index === 0 ? 1 : 10,
            },
          })),
        });
        // A verdict with no message identity: its savings still aggregate (the
        // savings sums read the event population), but it must NOT be counted as
        // a rated delivery, so `useful` stays 1 rather than becoming 2.
        await db.sessionMeshMetricEvent.createMany({
          data: [
            {
              organizationId,
              userId: recipient.id,
              eventType: "delivery_useful",
              createdAt: from,
              metadata: {},
            },
          ],
        });
      });
      const mine = await readSessionMeshInsights(
        organizationId,
        { from, to },
        recipient.id
      );
      const theirs = await readSessionMeshInsights(
        organizationId,
        { from, to },
        colleague.id
      );
      expect(mine).toMatchObject({
        scope: { userId: recipient.id },
        participation: { active: 1, eligible: 1 },
        deliveries: { delivered: 1, acknowledged: 1, useful: 1 },
        requestResponseLatencyMs: 60_000,
        estimatedTimeSavedMinutes: 5,
        estimatedCostSavedUsd: 1,
      });
      expect(theirs).toMatchObject({
        participation: { active: 1, eligible: 1 },
        deliveries: { delivered: 1, acknowledged: 0, useful: 1 },
        requestResponseLatencyMs: null,
        estimatedTimeSavedMinutes: 50,
        estimatedCostSavedUsd: 10,
      });
      expect(mine.trend).toEqual([
        { day: "2026-09-01", published: 1, delivered: 1, acknowledged: 1 },
      ]);
      const unavailable = await readSessionMeshInsights(
        organizationId,
        { from, to },
        foreign.id
      );
      expect(unavailable).toMatchObject({
        participation: { active: 0, eligible: 0 },
        deliveries: { delivered: 0, acknowledged: 0, useful: 0 },
        estimatedTimeSavedMinutes: null,
        estimatedCostSavedUsd: null,
        trend: [],
      });
      const organization = await readSessionMeshInsights(organizationId, {
        from,
        to,
      });
      expect(organization).toMatchObject({
        scope: { kind: "org" },
        participation: { active: 2, eligible: 2 },
        deliveries: { delivered: 2, acknowledged: 1, useful: 2 },
        requestResponseLatencyMs: 60_000,
        estimatedTimeSavedMinutes: 55,
        estimatedCostSavedUsd: 11,
      });
      expect(organization.trend).toEqual([
        { day: "2026-09-01", published: 2, delivered: 2, acknowledged: 1 },
      ]);
      expect(organization.provenance.notes).toContain(
        "Mesh history is retained for 90 days; All time means all retained Mesh history, not a lifetime total."
      );
    });

    it("refuses windows older than retained history instead of presenting measured zeros", async () => {
      const organizationId = await tracker.create();
      await expect(
        readSessionMeshInsights(organizationId, {
          from: new Date("2025-01-01T00:00:00Z"),
          to: new Date("2025-01-31T00:00:00Z"),
        })
      ).rejects.toThrow("Invalid bounded Session Mesh reporting window");
    });

    it("counts each event only in its own interval and measures first replies rather than every reply", async () => {
      const organizationId = await tracker.create();
      const user = await createTestUser(organizationId);
      const requestIds = Array.from({ length: 3 }, () => crypto.randomUUID());
      const replyIds = Array.from({ length: 4 }, () => crypto.randomUUID());
      const message = (
        id: string,
        kind: string,
        at: string,
        replyToMessageId?: string
      ) => ({
        id,
        organizationId,
        authorUserId: user.id,
        idempotencyKey: id,
        kind,
        repository: "github.com/example/metrics",
        revision: "sha",
        summary: "Bounded evidence",
        createdAt: new Date(at),
        expiresAt: new Date("2026-09-03T00:00:00Z"),
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      await withDb(async (db) => {
        await db.sessionMeshMessage.createMany({
          data: [
            message(requestIds[0], "request", "2026-08-31T23:59:00Z"),
            message(
              replyIds[0],
              "reply",
              "2026-09-01T00:00:00Z",
              requestIds[0]
            ),
            message(requestIds[1], "request", "2026-09-01T01:00:00Z"),
            message(
              replyIds[1],
              "reply",
              "2026-09-01T01:01:00Z",
              requestIds[1]
            ),
            message(requestIds[2], "request", "2026-09-01T02:00:00Z"),
            message(
              replyIds[2],
              "reply",
              "2026-09-01T02:28:00Z",
              requestIds[2]
            ),
            message(
              replyIds[3],
              "reply",
              "2026-09-01T03:00:00Z",
              requestIds[2]
            ),
          ],
        });
        await db.sessionMeshDelivery.createMany({
          data: [
            {
              organizationId,
              recipientUserId: user.id,
              recipientAgentId: "codex:peer",
              messageId: requestIds[0],
              queuedAt: new Date("2026-08-31T23:59:00Z"),
              deliveredAt: new Date("2026-08-31T23:59:30Z"),
              acknowledgedAt: new Date("2026-09-01T00:05:00Z"),
              status: "acknowledged",
            },
            {
              organizationId,
              recipientUserId: user.id,
              recipientAgentId: "codex:peer",
              messageId: requestIds[1],
              queuedAt: new Date("2026-09-01T01:00:00Z"),
              deliveredAt: new Date("2026-09-01T01:00:30Z"),
              acknowledgedAt: new Date("2026-09-02T01:00:00Z"),
              status: "dismissed",
            },
          ],
        });
      });
      const report = await readSessionMeshInsights(organizationId, {
        from,
        to,
      });
      expect(report.deliveries).toMatchObject({
        delivered: 1,
        acknowledged: 1,
      });
      expect(report.trend).toEqual([
        { day: "2026-09-01", published: 6, delivered: 1, acknowledged: 1 },
      ]);
      expect(report.requestResponseLatencyMs).toBe(10 * 60_000);
      expect(report.estimatedTimeSavedMinutes).toBeNull();
    });

    it("aggregates beyond the former 10000-row cap without truncating or leaking another organization", async () => {
      const organizationId = await tracker.create();
      const user = await createTestUser(organizationId);
      await withDb(async (db) => {
        for (let offset = 0; offset < 10_001; offset += 500) {
          await db.sessionMeshMessage.createMany({
            data: Array.from(
              { length: Math.min(500, 10_001 - offset) },
              (_, index) => ({
                id: crypto.randomUUID(),
                organizationId,
                authorUserId: user.id,
                idempotencyKey: `large-report-${offset + index}`,
                kind: "decision",
                repository: "github.com/example/metrics",
                revision: "sha",
                summary: "Bounded evidence",
                createdAt: new Date("2026-09-01T10:00:00Z"),
                expiresAt: new Date("2026-09-03T00:00:00Z"),
              })
            ),
          });
        }
      });
      const report = await readSessionMeshInsights(organizationId, {
        from,
        to,
      });
      expect(report.trend).toEqual([
        { day: "2026-09-01", published: 10_001, delivered: 0, acknowledged: 0 },
      ]);
      const foreignReport = await readSessionMeshInsights(
        await tracker.create(),
        { from, to }
      );
      expect(foreignReport.trend).toEqual([]);
    });

    it("refuses corrupt persisted savings instead of silently coercing them to zero", async () => {
      const organizationId = await tracker.create();
      await withDb((db) =>
        db.sessionMeshMetricEvent.createMany({
          data: {
            organizationId,
            eventType: "delivery_useful",
            metadata: { estimatedTimeSavedMinutes: "" },
            createdAt: new Date("2026-09-01T10:00:00Z"),
          },
        })
      );
      await expect(
        readSessionMeshInsights(organizationId, { from, to })
      ).rejects.toThrow("Invalid persisted Session Mesh attribution");
    });
  }
);

import {
  type SessionMeshPresenceInput,
  sessionMeshContextValidator,
  sessionMeshPresenceValidator,
  sessionMeshPublishValidator,
} from "@repo/api/src/types/session-mesh";
import type { User } from "@repo/api/src/types/user";
import { withDb } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { sessionMeshService } from "@/app/session-mesh/service";

describe.skipIf(!process.env.DATABASE_URL)(
  "Session Mesh real service boundaries",
  () => {
    const tracker = createCommittedTestOrganizationTracker();
    let author: User;
    let peer: User;
    let foreign: User;
    const repository = "github.com/mesh-test/shared";
    const paths = ["src/service.ts"];

    beforeEach(async () => {
      const organizationId = await tracker.create();
      author = await createTestUser(organizationId);
      peer = await createTestUser(organizationId);
      foreign = await createTestUser(await tracker.create());
    });
    afterEach(() => tracker.cleanup());

    async function register(
      user: User,
      agentId: string,
      revision: string,
      context?: SessionMeshPresenceInput["context"]
    ) {
      const result = await sessionMeshService.upsertPresence({
        organizationId: user.organizationId,
        userId: user.id,
        presence: sessionMeshPresenceValidator.parse({
          agentId,
          harness: agentId.startsWith("codex:") ? "codex" : "claude",
          workspace: { repository, revision, dirtyStateHash: revision, paths },
          ...(context === undefined ? {} : { context }),
        }),
      });
      if (!result.ok) {
        throw new Error("registration refused");
      }
      return result.value;
    }
    async function publish(idempotencyKey = "shared-discovery") {
      const result = await sessionMeshService.publish({
        organizationId: author.organizationId,
        userId: author.id,
        message: sessionMeshPublishValidator.parse({
          authorAgentId: "claude:author",
          idempotencyKey,
          kind: "discovery",
          workspace: {
            repository,
            revision: "sha-author",
            dirtyStateHash: "dirty-author",
            paths,
          },
          summary: "Shared service authorization entry point found.",
        }),
      });
      if (!result.ok) {
        throw new Error("publish refused");
      }
      return result.value;
    }
    async function startPair() {
      await register(author, "claude:author", "sha-author");
      await register(peer, "codex:peer", "sha-peer");
    }
    function inbox(user = peer) {
      return sessionMeshService.inbox({
        organizationId: user.organizationId,
        userId: user.id,
        agentId: "codex:peer",
      });
    }

    async function seedDeliveries(recipient: User, repositories: string[]) {
      const queuedAt = Date.now() - 60_000;
      const messages = repositories.map((messageRepository) => {
        const id = crypto.randomUUID();
        return {
          id,
          organizationId: recipient.organizationId,
          authorUserId: recipient.id,
          idempotencyKey: id,
          kind: "discovery",
          repository: messageRepository,
          revision: "seed-sha",
          summary: "Pagination fixture",
          expiresAt: new Date(Date.now() + 300_000),
        };
      });
      await withDb.tx(async (db) => {
        await db.sessionMeshMessage.createMany({ data: messages });
        await db.sessionMeshDelivery.createMany({
          data: messages.map((message, index) => ({
            organizationId: recipient.organizationId,
            recipientUserId: recipient.id,
            recipientAgentId: "codex:peer",
            messageId: message.id,
            queuedAt: new Date(queuedAt + index),
          })),
        });
      });
      return messages.map((message) => message.id);
    }

    it("reads accepted near-limit messages without duplicating their overlap beyond the wire budget", async () => {
      const largePaths = Array.from({ length: 126 }, (_, index) =>
        `${index}/`.padEnd(1000, "x")
      );
      const workspace = {
        repository,
        revision: "large-sha",
        paths: largePaths,
      };
      for (const [user, agentId] of [
        [author, "claude:author"],
        [peer, "codex:peer"],
      ] as const) {
        const registration = await sessionMeshService.upsertPresence({
          organizationId: user.organizationId,
          userId: user.id,
          presence: sessionMeshPresenceValidator.parse({ agentId, workspace }),
        });
        expect(registration.ok).toBe(true);
      }
      const result = await sessionMeshService.publish({
        organizationId: author.organizationId,
        userId: author.id,
        message: sessionMeshPublishValidator.parse({
          authorAgentId: "claude:author",
          idempotencyKey: "large-overlap",
          kind: "claim",
          workspace,
          summary: "Large but valid overlap",
        }),
      });
      expect(result.ok).toBe(true);
      const deliveries = await inbox();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.message.paths).toEqual(largePaths);
      expect(deliveries[0]?.relevance).toMatchObject({
        pathOverlap: largePaths.slice(0, 8),
        pathOverlapCount: 126,
        symbolOverlapCount: 0,
      });
      expect(Buffer.byteLength(JSON.stringify(deliveries))).toBeLessThan(
        240 * 1024
      );
      const history = await sessionMeshService.deliveryHistoryPage({
        organizationId: peer.organizationId,
        userId: peer.id,
        agentId: "codex:peer",
      });
      expect(history.messages).toHaveLength(1);
      expect(history.messages[0]?.message.paths).toEqual(largePaths);
    });

    it("pages all 501 roster entries without truncation or foreign-organization leakage", async () => {
      const agentIds = Array.from(
        { length: 501 },
        (_, index) => `codex:${String(index).padStart(4, "0")}`
      );
      const presence = (user: User, agentId: string) => ({
        organizationId: user.organizationId,
        userId: user.id,
        agentId,
        repository,
        revision: "seed-sha",
        expiresAt: new Date(Date.now() + 300_000),
      });
      await withDb((db) =>
        db.sessionMeshPresence.createMany({
          data: [
            ...agentIds.map((agentId) => presence(author, agentId)),
            presence(foreign, "codex:foreign"),
          ],
        })
      );
      let cursor: string | undefined;
      const collected: string[] = [];
      const cursors = new Set<string>();
      do {
        const page = await sessionMeshService.rosterPage(
          author.organizationId,
          undefined,
          cursor
        );
        expect(page.agents.length).toBeLessThanOrEqual(500);
        collected.push(...page.agents.map((row) => row.agentId));
        cursor = page.nextCursor;
        if (cursor) {
          expect(cursor).toBe(page.agents.at(-1)?.agentId);
          expect(cursors.has(cursor)).toBe(false);
          cursors.add(cursor);
        }
      } while (cursor);
      expect(cursors.size).toBeGreaterThan(0);
      expect(collected).toEqual(agentIds);
      expect(
        (
          await sessionMeshService.rosterPage(foreign.organizationId)
        ).agents.map((row) => row.agentId)
      ).toEqual(["codex:foreign"]);
    });

    it("pages all 201 recipient history entries and refuses foreign recipients even with a valid cursor", async () => {
      const messageIds = await seedDeliveries(
        peer,
        Array.from({ length: 201 }, () => repository)
      );
      const foreignIds = await seedDeliveries(foreign, [repository]);
      const recipient = {
        organizationId: peer.organizationId,
        userId: peer.id,
        agentId: "codex:peer",
      };
      const first = await sessionMeshService.deliveryHistoryPage(recipient);
      expect(first.messages.length).toBeLessThanOrEqual(200);
      expect(first.nextCursor).toBe(first.messages.at(-1)?.id);
      if (!first.nextCursor) {
        throw new Error("missing history continuation");
      }
      let cursor: string | undefined = first.nextCursor;
      const cursors = new Set<string>();
      const collected = first.messages.map((row) => row.messageId);
      while (cursor) {
        expect(cursors.has(cursor)).toBe(false);
        cursors.add(cursor);
        const page = await sessionMeshService.deliveryHistoryPage({
          ...recipient,
          cursor,
        });
        expect(page.messages.length).toBeLessThanOrEqual(200);
        collected.push(...page.messages.map((row) => row.messageId));
        cursor = page.nextCursor;
      }
      expect(collected.sort()).toEqual(messageIds.sort());
      expect(
        await sessionMeshService.deliveryHistoryPage({
          ...recipient,
          userId: foreign.id,
          cursor: first.nextCursor,
        })
      ).toEqual({ messages: [] });
      expect(
        await sessionMeshService.deliveryHistoryPage({
          ...recipient,
          organizationId: foreign.organizationId,
          cursor: first.nextCursor,
        })
      ).toEqual({ messages: [] });
      const foreignPage = await sessionMeshService.deliveryHistoryPage({
        ...recipient,
        organizationId: foreign.organizationId,
        userId: foreign.id,
      });
      expect(foreignPage.messages.map((row) => row.messageId)).toEqual(
        foreignIds
      );
    });

    it("filters muted repositories before taking the oldest 200 inbox entries", async () => {
      const activeRepository = "github.com/mesh-test/unmuted";
      const ids = await seedDeliveries(peer, [
        ...Array.from({ length: 200 }, () => repository),
        activeRepository,
      ]);
      await sessionMeshService.upsertSubscription({
        organizationId: peer.organizationId,
        userId: peer.id,
        repository,
        muted: true,
        digestOnly: false,
      });
      expect(await inbox()).toMatchObject([
        { messageId: ids.at(-1), message: { repository: activeRepository } },
      ]);
      expect(await inbox(foreign)).toEqual([]);
    });

    it("routes overlapping work across different SHAs and dirty states, never across organizations", async () => {
      await startPair();
      await register(foreign, "codex:foreign", "sha-foreign");
      const published = await publish();
      expect(published.deliveries).toBe(1);
      expect(await inbox()).toHaveLength(1);
      expect(await inbox(author)).toEqual([]);
      expect(await inbox(foreign)).toEqual([]);
      expect(
        (await sessionMeshService.roster(author.organizationId))
          .map((row) => row.agentId)
          .sort()
      ).toEqual(["claude:author", "codex:peer"]);
    });

    it("replays an offline retry without creating another message or delivery", async () => {
      await startPair();
      const first = await publish();
      const retry = await publish();
      expect(retry).toMatchObject({
        idempotent: true,
        message: { id: first.message.id },
      });
      expect(await inbox()).toHaveLength(1);
    });

    it("deduplicates concurrent publish retries with the same idempotency key", async () => {
      await startPair();
      const results = await Promise.all([
        publish("concurrent-publish"),
        publish("concurrent-publish"),
      ]);
      expect(new Set(results.map((result) => result.message.id)).size).toBe(1);
      expect(
        results.every((result) => result.idempotent || result.deliveries === 1)
      ).toBe(true);
      expect(await inbox()).toHaveLength(1);
    });

    it("refuses replies from a session that did not receive the original request", async () => {
      await startPair();
      const request = await publish("reply-source");
      const rejected = await sessionMeshService.publish({
        organizationId: author.organizationId,
        userId: author.id,
        message: sessionMeshPublishValidator.parse({
          authorAgentId: "claude:author",
          idempotencyKey: "reply-unreceived",
          kind: "reply",
          replyToMessageId: request.message.id,
          workspace: { repository, revision: "sha-author", paths },
          summary: "I was not a recipient.",
        }),
      });
      expect(rejected).toEqual({ ok: false, error: 403 });
    });

    it("routes an explicit reply to the original author after that session unregisters", async () => {
      await startPair();
      const original = await publish("author-offline-source");
      await sessionMeshService.unregisterPresence({
        organizationId: author.organizationId,
        userId: author.id,
        agentId: "claude:author",
      });
      const reply = await sessionMeshService.publish({
        organizationId: peer.organizationId,
        userId: peer.id,
        message: sessionMeshPublishValidator.parse({
          authorAgentId: "codex:peer",
          idempotencyKey: "reply-to-offline-author",
          kind: "reply",
          replyToMessageId: original.message.id,
          recipientAgentIds: ["claude:author"],
          workspace: { repository, revision: "sha-peer", paths },
          summary: "Your requested investigation is complete.",
        }),
      });
      expect(reply).toMatchObject({ ok: true, value: { deliveries: 1 } });
      if (!reply.ok) {
        throw new Error("reply to offline author refused");
      }
      expect(
        await sessionMeshService.inbox({
          organizationId: author.organizationId,
          userId: author.id,
          agentId: "claude:author",
        })
      ).toMatchObject([
        {
          messageId: reply.value.message.id,
          message: {
            replyToMessageId: original.message.id,
            authorAgentId: "codex:peer",
          },
        },
      ]);
    });

    it("retains canonical ownership after unregister without advertising a live session", async () => {
      await startPair();
      expect(
        await sessionMeshService.unregisterPresence({
          organizationId: author.organizationId,
          userId: author.id,
          agentId: "claude:author",
        })
      ).toMatchObject({ count: 1 });
      expect(
        (await sessionMeshService.roster(author.organizationId)).map(
          (row) => row.agentId
        )
      ).toEqual(["codex:peer"]);
      expect(
        await sessionMeshService.resolveCurrentPresence({
          organizationId: author.organizationId,
          userId: author.id,
          agentId: "claude:author",
        })
      ).toBeNull();
      const retained = await withDb((db) =>
        db.sessionMeshPresence.findFirst({
          where: {
            organizationId: author.organizationId,
            agentId: "claude:author",
          },
        })
      );
      expect(retained?.userId).toBe(author.id);
      await expect(
        register(peer, "claude:author", "hijacked-sha")
      ).rejects.toThrow("registration refused");
      expect(
        await sessionMeshService.recordFeedback({
          organizationId: author.organizationId,
          userId: author.id,
          agentId: "claude:author",
          idempotencyKey: "late-overhead",
          kind: "coordination_overhead",
          coordinationOverheadMs: 27,
          rationale: "Background work reported after session shutdown",
        })
      ).toMatchObject({ ok: true });
    });

    it("exposes normal roster context but redacts restricted snapshot contents", async () => {
      const normal = sessionMeshContextValidator.parse({
        summary: "Investigating authorization",
        artifactRefs: ["ISS-123"],
        revision: "sha-author",
      });
      await register(author, "claude:author", "sha-author", normal);
      await register(
        peer,
        "codex:peer",
        "sha-peer",
        sessionMeshContextValidator.parse({
          sensitivity: "restricted",
          summary: "private evidence",
          artifactRefs: ["ISS-private"],
        })
      );
      const roster = await sessionMeshService.roster(author.organizationId);
      expect(
        roster.find((row) => row.agentId === "claude:author")?.context
      ).toEqual(normal);
      expect(
        roster.find((row) => row.agentId === "codex:peer")?.context
      ).toEqual({ sensitivity: "restricted" });
      expect(JSON.stringify(roster)).not.toContain("private evidence");
      expect(await sessionMeshService.roster(foreign.organizationId)).toEqual(
        []
      );
    });

    it.each(["queued", "attempted", "held"])(
      "retains expired %s delivery history without offering stale context to a native inbox",
      async (status) => {
        await startPair();
        const publication = await publish(`expired-${status}`);
        await withDb.tx(async (db) => {
          await db.sessionMeshMessage.updateMany({
            where: {
              organizationId: author.organizationId,
              id: publication.message.id,
            },
            data: { expiresAt: new Date("2000-01-01T00:00:00.000Z") },
          });
          await db.sessionMeshDelivery.updateMany({
            where: {
              organizationId: peer.organizationId,
              messageId: publication.message.id,
            },
            data: { status },
          });
        });
        const recipient = {
          organizationId: peer.organizationId,
          userId: peer.id,
          agentId: "codex:peer",
        };
        expect(await inbox()).toEqual([]);
        expect(
          await sessionMeshService.deliveryHistory(recipient)
        ).toMatchObject([
          { messageId: publication.message.id, status: "expired" },
        ]);
        expect(
          await sessionMeshService.messageForRecipient({
            ...recipient,
            messageId: publication.message.id,
          })
        ).toBeNull();
        const stored = await withDb((db) =>
          db.sessionMeshDelivery.findFirst({
            where: {
              organizationId: peer.organizationId,
              messageId: publication.message.id,
            },
          })
        );
        expect(stored?.status).toBe(status);
      }
    );

    it("keeps canonical identity with the first owner under a competing registration", async () => {
      const results = await Promise.allSettled([
        register(author, "codex:contested", "sha-author"),
        register(peer, "codex:contested", "sha-peer"),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === "fulfilled"
      );
      expect(fulfilled).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1);
      const stored = await withDb((db) =>
        db.sessionMeshPresence.findMany({
          where: {
            organizationId: author.organizationId,
            agentId: "codex:contested",
          },
        })
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.userId).toBe(fulfilled[0]?.value.userId);
    });

    it("prevents another organization from recording a recipient delivery", async () => {
      await startPair();
      const published = await publish();
      const result = await sessionMeshService.disposition({
        organizationId: foreign.organizationId,
        userId: foreign.id,
        agentId: "codex:peer",
        messageId: published.message.id,
        status: "delivered",
      });
      expect(result.count).toBe(0);
      expect((await inbox())[0]?.status).toBe("queued");
    });

    it("mutes pending messages as well as newly published notifications", async () => {
      await startPair();
      await publish();
      await sessionMeshService.upsertSubscription({
        organizationId: peer.organizationId,
        userId: peer.id,
        repository,
        muted: true,
        digestOnly: false,
      });
      expect(await inbox()).toEqual([]);
      expect((await publish("after-mute")).deliveries).toBe(0);
    });

    it("holds digest-only work in history without injecting it into a native inbox", async () => {
      await startPair();
      await sessionMeshService.upsertSubscription({
        organizationId: peer.organizationId,
        userId: peer.id,
        repository,
        muted: false,
        digestOnly: true,
      });
      await publish("digest-only");
      expect(await inbox()).toEqual([]);
      expect(
        await sessionMeshService.deliveryHistory({
          organizationId: peer.organizationId,
          userId: peer.id,
          agentId: "codex:peer",
        })
      ).toMatchObject([{ status: "held" }]);
    });

    it("does not broadcast restricted context without a canonical explicit recipient", async () => {
      await startPair();
      const restrictedResult = await sessionMeshService.publish({
        organizationId: author.organizationId,
        userId: author.id,
        message: sessionMeshPublishValidator.parse({
          authorAgentId: "claude:author",
          idempotencyKey: "restricted-no-target",
          kind: "discovery",
          workspace: { repository, revision: "sha-author", paths },
          sensitivity: "restricted",
          summary: "Private evidence",
        }),
      });
      expect(restrictedResult).toMatchObject({ ok: true });
      if (!restrictedResult.ok) {
        throw new Error("restricted publish refused");
      }
      expect(restrictedResult.value.deliveries).toBe(0);
    });

    it("records receipt retries once and keeps delivered totals after acknowledgement", async () => {
      await startPair();
      const published = await publish();
      const delivery = {
        organizationId: peer.organizationId,
        userId: peer.id,
        agentId: "codex:peer",
        messageId: published.message.id,
      };
      const readDelivery = () =>
        withDb((db) =>
          db.sessionMeshDelivery.findFirstOrThrow({
            where: {
              organizationId: peer.organizationId,
              recipientUserId: peer.id,
              recipientAgentId: "codex:peer",
              messageId: published.message.id,
            },
          })
        );
      expect(await readDelivery()).toMatchObject({
        attemptCount: 0,
        attemptedAt: null,
      });
      expect(
        (
          await sessionMeshService.disposition({
            ...delivery,
            status: "delivered",
          })
        ).count
      ).toBe(1);
      const confirmed = await readDelivery();
      expect(confirmed).toMatchObject({
        attemptCount: 1,
        attemptedAt: expect.any(Date),
        deliveredAt: confirmed.attemptedAt,
      });
      expect(
        (
          await sessionMeshService.disposition({
            ...delivery,
            status: "delivered",
          })
        ).count
      ).toBe(0);
      expect(
        (
          await sessionMeshService.disposition({
            ...delivery,
            status: "acknowledged",
          })
        ).count
      ).toBe(1);
      expect(
        (
          await sessionMeshService.disposition({
            ...delivery,
            status: "delivered",
          })
        ).count
      ).toBe(0);
      expect(await readDelivery()).toMatchObject({
        attemptCount: 1,
        attemptedAt: confirmed.attemptedAt,
        deliveredAt: confirmed.deliveredAt,
        status: "acknowledged",
      });
      const insights = await sessionMeshService.insights(author.organizationId);
      expect(insights.deliveries).toMatchObject({
        delivered: 1,
        acknowledged: 1,
      });
    });

    it("deduplicates concurrent recipient feedback attribution", async () => {
      await startPair();
      const published = await publish("feedback-source");
      // ISS-11435 counts `useful` over the DELIVERED cohort — a rated delivery,
      // not a rated event — so the delivery has to be marked delivered the way
      // the native hook marks it in production before it can be counted.
      await sessionMeshService.disposition({
        organizationId: peer.organizationId,
        userId: peer.id,
        agentId: "codex:peer",
        messageId: published.message.id,
        status: "delivered",
      });
      const results = await Promise.all([
        sessionMeshService.recordFeedback({
          organizationId: peer.organizationId,
          userId: peer.id,
          agentId: "codex:peer",
          messageId: published.message.id,
          idempotencyKey: "feedback-retry",
          kind: "useful",
          estimatedTimeSavedMinutes: 3,
          rationale: "Avoided duplicate investigation",
        }),
        sessionMeshService.recordFeedback({
          organizationId: peer.organizationId,
          userId: peer.id,
          agentId: "codex:peer",
          messageId: published.message.id,
          idempotencyKey: "feedback-retry",
          kind: "useful",
          estimatedTimeSavedMinutes: 3,
          rationale: "Avoided duplicate investigation",
        }),
      ]);
      expect(results).toEqual([
        { ok: true, value: expect.anything() },
        { ok: true, value: expect.anything() },
      ]);
      const insights = await sessionMeshService.insights(author.organizationId);
      expect(insights.deliveries.useful).toBe(1);
      expect(insights.estimatedTimeSavedMinutes).toBe(3);
    });

    it("reports a bounded UTC trend and measured request/reply latency", async () => {
      await startPair();
      const requestResult = await sessionMeshService.publish({
        organizationId: author.organizationId,
        userId: author.id,
        message: sessionMeshPublishValidator.parse({
          authorAgentId: "claude:author",
          idempotencyKey: "latency-request",
          kind: "request",
          workspace: { repository, revision: "sha-author", paths },
          summary: "Who owns authorization?",
        }),
      });
      if (!requestResult.ok) {
        throw new Error("request refused");
      }
      const replyResult = await sessionMeshService.publish({
        organizationId: peer.organizationId,
        userId: peer.id,
        message: sessionMeshPublishValidator.parse({
          authorAgentId: "codex:peer",
          idempotencyKey: "latency-reply",
          kind: "reply",
          replyToMessageId: requestResult.value.message.id,
          workspace: { repository, revision: "sha-peer", paths },
          summary: "I own authorization.",
        }),
      });
      expect(replyResult).toMatchObject({ ok: true });
      const insights = await sessionMeshService.insights(
        author.organizationId,
        {
          from: new Date(Date.now() - 86_400_000),
          to: new Date(),
        }
      );
      expect(insights.trend).toHaveLength(1);
      expect(insights.trend[0]?.published).toBeGreaterThanOrEqual(2);
      expect(insights.requestResponseLatencyMs).not.toBeNull();
    });
  }
);

import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { createTestOrganization, createTestUser } from "../utils/db-helpers";

const env = keys();
const hasDatabase =
  !!env.DATABASE_URL && process.env.RUN_DB_INTEGRATION_TESTS === "true";

describe.skipIf(!hasDatabase)(
  "Loop events replay unique index integration",
  () => {
    it("rejects duplicate system event IDs for the same loop", async () => {
      const orgId = await createTestOrganization({
        clerkId: `org_replay_${Date.now()}`,
        slug: `org-replay-${Date.now()}`,
      });
      const user = await createTestUser(orgId, {
        clerkId: `clerk_replay_${Date.now()}`,
        email: `replay-${Date.now()}@example.com`,
      });

      const loop = await withDb((db) =>
        db.loop.create({
          data: {
            organizationId: orgId,
            userId: user.id,
            command: "CHAT",
          },
        })
      );

      await withDb((db) =>
        db.loopEvent.create({
          data: {
            loopId: loop.id,
            type: "output",
            data: { chunk: "hello", timestamp: new Date().toISOString() },
            eventSource: "system",
            eventId: "system-event-1",
          },
        })
      );

      await expect(
        withDb((db) =>
          db.loopEvent.create({
            data: {
              loopId: loop.id,
              type: "output",
              data: {
                chunk: "hello-again",
                timestamp: new Date().toISOString(),
              },
              eventSource: "system",
              eventId: "system-event-1",
            },
          })
        )
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("rejects duplicate runner replay IDs for the same loop", async () => {
      const orgId = await createTestOrganization({
        clerkId: `org_runner_${Date.now()}`,
        slug: `org-runner-${Date.now()}`,
      });
      const user = await createTestUser(orgId, {
        clerkId: `clerk_runner_${Date.now()}`,
        email: `runner-${Date.now()}@example.com`,
      });

      const loop = await withDb((db) =>
        db.loop.create({
          data: {
            organizationId: orgId,
            userId: user.id,
            command: "CHAT",
          },
        })
      );

      await withDb((db) =>
        db.loopEvent.create({
          data: {
            loopId: loop.id,
            type: "started",
            data: { loopId: loop.id, timestamp: new Date().toISOString() },
            eventSource: "runner",
            eventId: "jti-abc:11111111-1111-4111-8111-111111111111",
            runnerTokenJti: "jti-abc",
            runnerNonce: "11111111-1111-4111-8111-111111111111",
          },
        })
      );

      await expect(
        withDb((db) =>
          db.loopEvent.create({
            data: {
              loopId: loop.id,
              type: "started",
              data: { loopId: loop.id, timestamp: new Date().toISOString() },
              eventSource: "runner",
              eventId: "jti-abc:11111111-1111-4111-8111-111111111111",
              runnerTokenJti: "jti-abc",
              runnerNonce: "11111111-1111-4111-8111-111111111111",
            },
          })
        )
      ).rejects.toMatchObject({ code: "P2002" });
    });
  }
);

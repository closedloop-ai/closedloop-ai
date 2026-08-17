import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { loopsService } from "@/app/loops/service";

/**
 * DB-backed coverage for the loop lifecycle reads and writes.
 *
 * Seeds the Loop row directly rather than going through `loopsService.create`,
 * which reaps stale pendings, enforces a concurrency limit, and authorizes
 * additional repos before it writes — none of which these methods depend on.
 * Seeding the row keeps each case about the method under test.
 *
 * `parseError` is worth pinning because it guards a JSON column against its own
 * history: `Loop.error` is `Json`, so a row written by an older build (or by
 * hand) can hold a shape the current contract does not admit, and the read must
 * degrade to null rather than hand a malformed object to the API.
 */

const LOOP_NOT_FOUND = /Loop not found/;

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

type Scope = { organizationId: string; userId: string; loopId: string };

async function seedLoop(over: Record<string, unknown> = {}): Promise<Scope> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const loop = await withDb((db) =>
    db.loop.create({
      data: {
        organizationId,
        userId: user.id,
        command: LoopCommand.Plan,
        status: LoopStatus.Pending,
        ...over,
      },
    })
  );
  return { organizationId, userId: user.id, loopId: loop.id };
}

describeIfDb("loopsService.findById — org scoping", () => {
  it("returns a loop to its owning organization", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop();

      const loop = await loopsService.findById(
        scope.loopId,
        scope.organizationId
      );

      expect(loop?.id).toBe(scope.loopId);
    });
  });

  it("does not return it to a foreign organization", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop();
      const foreignOrg = await createTestOrganization();

      expect(await loopsService.findById(scope.loopId, foreignOrg)).toBeNull();
    });
  });

  it("returns null for an id that does not exist", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop();

      expect(
        await loopsService.findById(
          "00000000-0000-4000-8000-000000000000",
          scope.organizationId
        )
      ).toBeNull();
    });
  });
});

describeIfDb("loopsService — malformed stored error JSON", () => {
  it("returns a well-formed error object unchanged", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop({
        error: { code: "TIMEOUT", message: "ran too long" },
      });

      const loop = await loopsService.findById(
        scope.loopId,
        scope.organizationId
      );

      expect(loop?.error).toEqual({
        code: "TIMEOUT",
        message: "ran too long",
      });
    });
  });

  it("degrades a malformed stored error to null rather than serving it", async () => {
    // `Loop.error` is a Json column, so a row written by an older build can
    // hold a shape the current contract does not admit. Each of these is a
    // DIFFERENT way the guard can fail: not an object, missing a key, or a key
    // present with the wrong type.
    for (const malformed of [
      "just a string",
      42,
      { code: "NO_MESSAGE" },
      { message: "no code" },
      { code: 500, message: "numeric code" },
      { code: "OK", message: { nested: true } },
    ]) {
      await autoRollbackTransaction(async () => {
        const scope = await seedLoop({ error: malformed });

        const loop = await loopsService.findById(
          scope.loopId,
          scope.organizationId
        );

        expect(loop?.error).toBeNull();
      });
    }
  });

  it("treats an absent error as null", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop();

      const loop = await loopsService.findById(
        scope.loopId,
        scope.organizationId
      );

      expect(loop?.error).toBeNull();
    });
  });
});

describeIfDb("loopsService.updateStatus", () => {
  it("advances a loop and records the supplied timestamps", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop();
      const startedAt = new Date("2026-08-08T10:00:00.000Z");

      await loopsService.updateStatus(
        scope.loopId,
        scope.organizationId,
        LoopStatus.Running,
        { startedAt }
      );

      const loop = await loopsService.findById(
        scope.loopId,
        scope.organizationId
      );
      expect(loop?.status).toBe(LoopStatus.Running);
      expect(loop?.startedAt).toEqual(startedAt);
    });
  });

  it("records token totals on completion", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop({ status: LoopStatus.Running });

      await loopsService.updateStatus(
        scope.loopId,
        scope.organizationId,
        LoopStatus.Completed,
        { tokensInput: 1200, tokensOutput: 340 }
      );

      const loop = await loopsService.findById(
        scope.loopId,
        scope.organizationId
      );
      expect(loop?.status).toBe(LoopStatus.Completed);
      expect(loop?.tokensInput).toBe(1200);
      expect(loop?.tokensOutput).toBe(340);
    });
  });

  it("does not update a loop belonging to a different organization", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop();
      const foreignOrg = await createTestOrganization();

      await loopsService
        .updateStatus(scope.loopId, foreignOrg, LoopStatus.Completed)
        .catch(() => undefined);

      // Whether it throws or no-ops, the row must be untouched.
      const loop = await loopsService.findById(
        scope.loopId,
        scope.organizationId
      );
      expect(loop?.status).toBe(LoopStatus.Pending);
    });
  });
});

describeIfDb("loopsService.addEvent", () => {
  it("appends an event to a live loop", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop({ status: LoopStatus.Running });

      const accepted = await loopsService.addEvent(
        scope.loopId,
        scope.organizationId,
        { type: "progress", data: { step: "planning" } }
      );

      expect(accepted).toBe(true);
      const events = await withDb((db) =>
        db.loopEvent.findMany({ where: { loopId: scope.loopId } })
      );
      expect(events).toHaveLength(1);
    });
  });

  it("THROWS for a loop in another organization, and writes nothing", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop({ status: LoopStatus.Running });
      const foreignOrg = await createTestOrganization();

      // Not-found and org-scoped-out are the same case: the lookup is
      // org-scoped, so a foreign caller cannot distinguish "exists elsewhere"
      // from "does not exist" — the right disclosure boundary.
      await expect(
        loopsService.addEvent(scope.loopId, foreignOrg, {
          type: "progress",
          data: {},
        })
      ).rejects.toThrow(LOOP_NOT_FOUND);

      const events = await withDb((db) =>
        db.loopEvent.findMany({ where: { loopId: scope.loopId } })
      );
      expect(events).toHaveLength(0);
    });
  });

  it("THROWS for a loop that does not exist", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop();

      await expect(
        loopsService.addEvent(
          "00000000-0000-4000-8000-000000000000",
          scope.organizationId,
          { type: "progress", data: {} }
        )
      ).rejects.toThrow(LOOP_NOT_FOUND);
    });
  });

  it("returns false — without throwing — for an event on a finished loop", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedLoop({ status: LoopStatus.Completed });

      // The boolean is NOT about existence. A late event from a runner that has
      // not noticed the loop finished is ignored, not an error.
      const accepted = await loopsService.addEvent(
        scope.loopId,
        scope.organizationId,
        { type: "progress", data: {} }
      );

      expect(accepted).toBe(false);
    });
  });
});

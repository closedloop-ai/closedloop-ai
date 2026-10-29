/**
 * ISS-8674 — the counter must never disagree with the rows it summarizes.
 *
 * `ComputeTarget.queuedCommandCount` is a denormalized count, and a
 * denormalized count that drifts is worse than the unbounded aggregate it
 * replaced, because it still looks authoritative. That risk is the reason this
 * file exists, and it is why every case below asserts the INVARIANT —
 * `queued_command_count` equals `count(*) WHERE status = 'queued'` — rather than
 * a number the test computed for itself. A test that only checked an expected
 * literal would pass against a counter and a table that had drifted together in
 * the same direction.
 *
 * These run against real Postgres because the guarantee is a real Postgres one:
 * the `desktop_commands_queued_count_sync` trigger, not application code, owns
 * every write to the counter. A mocked-Prisma test cannot observe a trigger, so
 * it could not fail for the defect this file is about.
 *
 * Each case replays the exact write one production path issues, named at the
 * case. That is the coverage argument for the trigger: because it fires on the
 * ROW rather than in a call site, covering the write shapes covers every caller
 * that can ever issue them — including raw SQL, the seed reset, and an
 * operator clearing a wedged queue by hand during the incident this metric
 * exists to report.
 *
 * The TRUNCATE trigger is pinned by DDL in
 * packages/database/__tests__/iss8674-queued-command-count-migration.test.ts
 * rather than exercised here on purpose: `TRUNCATE desktop_commands` takes an
 * ACCESS EXCLUSIVE lock on a table every other integration suite shares, so
 * proving it live would risk the run it is meant to protect.
 *
 * Not included by the default vitest config. Run explicitly:
 *
 *   DATABASE_URL=... pnpm --filter api exec vitest run \
 *     __tests__/integration/queued-command-count-drift.integration.test.ts \
 *     --config vitest.config.integration.mts
 */
import { randomUUID } from "node:crypto";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withFixtureClient } from "@/__tests__/utils/fixture-db";
import {
  countQueuedCommandsByTarget,
  countTargetsAwaitingSweep,
  listQueueDepthSweepPage,
  markQueueDepthSwept,
  reconcileQueuedCounters,
  type TargetBacklog,
} from "../../lib/desktop-command-dispatch-queries";

// Every sibling suite in this directory self-skips without a database, and so
// must this one: the integration config can be run without DATABASE_URL set,
// and a suite that connects anyway fails as a defect rather than skipping.
const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const TARGET_ID = randomUUID();
const OTHER_TARGET_ID = randomUUID();
const SENTINEL_TARGET_ID = randomUUID();

/**
 * The constraint by name. Matching the name rather than the message text is
 * what proves the refusal came from THIS check and not from some other write
 * failure that happened to reject the same statement.
 */
const CHECK_VIOLATION_RE = /compute_targets_queued_command_count_check/;

/**
 * The invariant itself, read from the database with no transaction wrapping
 * the pair. `withDb`, not `withDb.tx`: the two queries in the `Promise.all`
 * below each get their own connection and their own READ COMMITTED snapshot,
 * so a write landing between them would make `counter` and
 * `actualQueuedRows` genuinely disagree here (tamsinb, review of #6414).
 * That is fine only because every case in this file is single-writer against
 * the row it just wrote and awaits that write before calling this — nothing
 * else is racing it. A caller that needed the pair to agree under a
 * concurrent writer would have to read both inside one `withDb.tx`.
 */
async function readReconciliation(computeTargetId: string): Promise<{
  counter: number;
  actualQueuedRows: number;
}> {
  return await withDb(async (db) => {
    const [target, actualQueuedRows] = await Promise.all([
      db.computeTarget.findUniqueOrThrow({
        where: { id: computeTargetId },
        select: { queuedCommandCount: true },
      }),
      db.desktopCommand.count({
        where: { computeTargetId, status: DesktopCommandStatus.Queued },
      }),
    ]);
    return { counter: target.queuedCommandCount, actualQueuedRows };
  });
}

/**
 * Checks the invariant AND the depth, together. The invariant alone would hold
 * over a trigger that never fired against a table that was never written, so
 * each case also names the depth it expects to have produced.
 *
 * Throws rather than asserting: Biome's `noMisplacedAssertion` reserves
 * `expect` for a test body, and a throw from a helper fails the calling test
 * all the same. The message carries both sides of the comparison, so a failure
 * says whether the counter drifted from the rows or the write simply did not
 * land.
 */
async function expectDepth(
  computeTargetId: string,
  expectedDepth: number
): Promise<void> {
  const { counter, actualQueuedRows } =
    await readReconciliation(computeTargetId);
  if (counter !== actualQueuedRows) {
    throw new Error(
      `counter drifted from the rows on ${computeTargetId}: queued_command_count=${counter}, actual queued rows=${actualQueuedRows}`
    );
  }
  if (counter !== expectedDepth) {
    throw new Error(
      `depth on ${computeTargetId} reconciles at ${counter} but the write should have left ${expectedDepth}`
    );
  }
}

async function enqueue(
  computeTargetId: string,
  count: number
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await withDb((db) =>
    db.desktopCommand.createMany({
      data: ids.map((id) => ({
        id,
        computeTargetId,
        operationId: "desktop.gateway.request",
        requestFingerprint: id,
        requestPayload: { path: "/api/desktop/health" },
        status: DesktopCommandStatus.Queued,
      })),
    })
  );
  return ids;
}

beforeAll(async () => {
  // File-level hooks run even when every describe is skipped, so the guard has
  // to repeat here — otherwise a run without DATABASE_URL still tries to seed.
  if (!hasDatabase) {
    return;
  }
  await withDb(async (db) => {
    await db.organization.create({
      data: {
        id: ORG_ID,
        clerkId: `clerk_org_${ORG_ID}`,
        name: "ISS-8674 drift org",
        slug: `iss8674-${ORG_ID}`,
      },
      select: { id: true },
    });
    await db.user.create({
      data: {
        id: USER_ID,
        organizationId: ORG_ID,
        clerkId: `clerk_user_${USER_ID}`,
        email: `iss8674.${USER_ID}@example.com`,
        firstName: "Drift",
        lastName: "Probe",
      },
      select: { id: true },
    });
    await db.computeTarget.createMany({
      data: [
        {
          id: TARGET_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
          machineName: `iss8674-primary-${TARGET_ID}`,
          platform: "darwin",
        },
        {
          id: OTHER_TARGET_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
          machineName: `iss8674-other-${OTHER_TARGET_ID}`,
          platform: "darwin",
        },
        {
          id: SENTINEL_TARGET_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
          machineName: `iss8674-sentinel-${SENTINEL_TARGET_ID}`,
          platform: "cloud",
          isCloudSentinel: true,
        },
      ],
    });
  });
});

afterAll(async () => {
  if (!hasDatabase) {
    return;
  }
  // `users.organization_id` has no cascade, so the org cannot be deleted while
  // its user exists. Compute targets do cascade to their commands.
  await withDb(async (db) => {
    await db.computeTarget.deleteMany({ where: { organizationId: ORG_ID } });
    await db.user.deleteMany({ where: { organizationId: ORG_ID } });
    await db.organization.delete({ where: { id: ORG_ID } });
  });
});

beforeEach(async () => {
  if (!hasDatabase) {
    return;
  }
  await withDb((db) =>
    db.desktopCommand.deleteMany({
      where: {
        computeTargetId: {
          in: [TARGET_ID, OTHER_TARGET_ID, SENTINEL_TARGET_ID],
        },
      },
    })
  );
});

describeIfDb(
  "queued command counter stays reconciled with its rows (ISS-8674)",
  () => {
    // The counter starts at its true value rather than at a placeholder, which is
    // what lets a rendered 0 be read as a measurement. A fresh target genuinely
    // holds no command.
    it("reports zero for a target that has never held a command", async () => {
      await expectDepth(TARGET_ID, 0);
    });

    // `createCommand` — the enqueue every dispatch path begins with.
    it("counts an enqueue", async () => {
      await enqueue(TARGET_ID, 3);

      await expectDepth(TARGET_ID, 3);
    });

    // `acknowledgeCommand`, accepted branch: queued -> accepted.
    it("uncounts an acknowledgement", async () => {
      const [first] = await enqueue(TARGET_ID, 3);

      await withDb((db) =>
        db.desktopCommand.update({
          where: { id: first },
          data: { status: DesktopCommandStatus.Accepted },
        })
      );

      await expectDepth(TARGET_ID, 2);
    });

    // `acknowledgeCommand`, rejected branch: queued -> failed. The dispatch that
    // never reached a desktop must leave the backlog, not sit in it forever —
    // ISS-8673 has 45.6% of production dispatches taking this path.
    it("uncounts a failed dispatch", async () => {
      const [first, second] = await enqueue(TARGET_ID, 3);

      await withDb((db) =>
        db.desktopCommand.updateMany({
          where: { id: { in: [first, second] } },
          data: {
            status: DesktopCommandStatus.Failed,
            error: "peer hop timed out",
            finishedAt: new Date(),
          },
        })
      );

      await expectDepth(TARGET_ID, 1);
    });

    // `requeueUndeliveredCommands` — the reverse transition, accepted -> queued.
    // A counter that only ever decremented would go permanently wrong here, and
    // this is the direction an increment-on-create implementation forgets.
    it("re-counts a command a reconnect returns to the queue", async () => {
      const ids = await enqueue(TARGET_ID, 2);
      await withDb((db) =>
        db.desktopCommand.updateMany({
          where: { id: { in: ids } },
          data: { status: DesktopCommandStatus.Accepted },
        })
      );
      await expectDepth(TARGET_ID, 0);

      await withDb((db) =>
        db.desktopCommand.updateMany({
          where: {
            computeTargetId: TARGET_ID,
            id: { in: ids },
            status: {
              in: [DesktopCommandStatus.Accepted, DesktopCommandStatus.Running],
            },
          },
          data: { status: DesktopCommandStatus.Queued },
        })
      );

      await expectDepth(TARGET_ID, 2);
    });

    // `markCommandExpired`.
    it("uncounts an expiry", async () => {
      await enqueue(TARGET_ID, 2);

      await withDb((db) =>
        db.desktopCommand.updateMany({
          where: { computeTargetId: TARGET_ID },
          data: {
            status: DesktopCommandStatus.Expired,
            finishedAt: new Date(),
            error: "Command expired",
          },
        })
      );

      await expectDepth(TARGET_ID, 0);
    });

    // POST /compute-targets/[id]/commands creates AND dispatches with no capacity
    // gate, so a fresh `accepted` row can carry the newest createdAt. Both writes
    // land back to back with nothing between them; the counter has to survive
    // that, not just the drain's paced transitions.
    it("stays reconciled across the un-gated create-and-dispatch path", async () => {
      for (let index = 0; index < 5; index++) {
        const [id] = await enqueue(TARGET_ID, 1);
        await withDb((db) =>
          db.desktopCommand.update({
            where: { id },
            data: { status: DesktopCommandStatus.Accepted },
          })
        );
      }

      await expectDepth(TARGET_ID, 0);
    });

    // The lost-update case. `SET x = x + 1` re-reads under the row lock; a
    // plpgsql read-then-write would drop increments here and the counter would
    // silently undercount a busy target forever.
    it("loses no increment when writers race on one target", async () => {
      const parallelWriters = 24;

      await Promise.all(
        Array.from({ length: parallelWriters }, () => enqueue(TARGET_ID, 1))
      );

      await expectDepth(TARGET_ID, parallelWriters);
    });

    it("loses no decrement when writers race to drain one target", async () => {
      const ids = await enqueue(TARGET_ID, 24);

      await Promise.all(
        ids.map((id) =>
          withDb((db) =>
            db.desktopCommand.update({
              where: { id },
              data: { status: DesktopCommandStatus.Accepted },
            })
          )
        )
      );

      await expectDepth(TARGET_ID, 0);
    });

    // The operator's manual repair of a wedged queue, and the seed reset's
    // deleteMany. Neither goes through any application write path, which is the
    // whole reason the counter is maintained by a trigger.
    it("uncounts rows deleted out from under the application", async () => {
      await enqueue(TARGET_ID, 4);

      await withDb(
        (db) =>
          db.$executeRaw`DELETE FROM "desktop_commands" WHERE "compute_target_id" = ${TARGET_ID}::uuid AND "status" = 'queued'`
      );

      await expectDepth(TARGET_ID, 0);
    });

    // The counter moves with the row or not at all. An application increment
    // issued as a second statement outside the row's transaction could not make
    // this guarantee.
    it("rolls the counter back with the transaction that enqueued", async () => {
      await enqueue(TARGET_ID, 1);

      await expect(
        withDb.tx(async (tx) => {
          await tx.desktopCommand.create({
            data: {
              computeTargetId: TARGET_ID,
              operationId: "desktop.gateway.request",
              requestFingerprint: randomUUID(),
              requestPayload: { path: "/api/desktop/health" },
              status: DesktopCommandStatus.Queued,
            },
            select: { id: true },
          });
          throw new Error("rollback");
        })
      ).rejects.toThrow("rollback");

      await expectDepth(TARGET_ID, 1);
    });

    // Both status guards, falsified in one case. Every other case here creates
    // rows through `enqueue`, which always writes `queued` — so without this one,
    // deleting `IF NEW."status" = 'queued'` from the trigger's INSERT branch, or
    // `IF OLD."status" = 'queued'` from its DELETE branch, leaves the whole suite
    // green while a non-queued command inflates the gauge. Raw SQL because no
    // application path creates a command in any other status, and the trigger's
    // guarantee is explicitly that it holds for writers the application does not
    // own.
    it("does not count a command that was never queued, or its deletion", async () => {
      await enqueue(TARGET_ID, 2);
      const strayId = randomUUID();

      await withDb(
        (db) =>
          db.$executeRaw`INSERT INTO "desktop_commands" ("id", "compute_target_id", "operation_id", "request_fingerprint", "request_payload", "status") VALUES (${strayId}::uuid, ${TARGET_ID}::uuid, 'op', ${strayId}, '{"path":"/api/desktop/health"}'::jsonb, ${DesktopCommandStatus.Done})`
      );
      await expectDepth(TARGET_ID, 2);

      await withDb(
        (db) =>
          db.$executeRaw`DELETE FROM "desktop_commands" WHERE "id" = ${strayId}::uuid`
      );
      await expectDepth(TARGET_ID, 2);
    });

    // The trigger moves a row between two targets rather than assuming the owner
    // is fixed. No application path reassigns `compute_target_id` today, so this
    // is reachable only by raw SQL — which is exactly the writer the trigger
    // exists to cover, and the reason that branch is not dead code. Without a
    // case here the branch ships unexercised and its docstring's claim is
    // unbacked.
    it("moves a queued command's depth when its owning target changes", async () => {
      const ids = await enqueue(TARGET_ID, 3);
      await enqueue(OTHER_TARGET_ID, 1);

      await withDb(
        (db) =>
          db.$executeRaw`UPDATE "desktop_commands" SET "compute_target_id" = ${OTHER_TARGET_ID}::uuid WHERE "id" = ${ids[0]}::uuid`
      );

      await expectDepth(TARGET_ID, 2);
      await expectDepth(OTHER_TARGET_ID, 2);
    });

    // A per-event `last_sequence_acked` write is by far the most frequent update
    // to this table. The trigger is narrowed to `UPDATE OF status,
    // compute_target_id` so those never reach it; if that narrowing were widened
    // to a bare `UPDATE`, the guards inside the function still have to hold. This
    // pins the outcome either way.
    it("ignores an update that does not touch status", async () => {
      const ids = await enqueue(TARGET_ID, 2);

      await withDb((db) =>
        db.desktopCommand.update({
          where: { id: ids[0] },
          data: { lastSequenceAcked: 7 },
        })
      );

      await expectDepth(TARGET_ID, 2);
    });

    // A write that sets status to the value it already holds must not double
    // count. `acknowledgeCommand` can issue exactly this on a redelivered ack.
    it("ignores a status write that changes nothing", async () => {
      const ids = await enqueue(TARGET_ID, 2);

      await withDb((db) =>
        db.desktopCommand.update({
          where: { id: ids[0] },
          data: { status: DesktopCommandStatus.Queued },
        })
      );

      await expectDepth(TARGET_ID, 2);
    });

    it("keeps each target's depth to itself", async () => {
      await enqueue(TARGET_ID, 3);
      await enqueue(OTHER_TARGET_ID, 1);

      await expectDepth(TARGET_ID, 3);
      await expectDepth(OTHER_TARGET_ID, 1);
    });

    // An under-count is the one drift a wrong trigger could persist silently, so
    // it is refused at the column rather than gauged. The write fails loudly
    // instead of the metric quietly reporting a drained backlog.
    it("refuses to persist a negative depth", async () => {
      await expect(
        withDb(
          (db) =>
            db.$executeRaw`UPDATE "compute_targets" SET "queued_command_count" = -1 WHERE "id" = ${TARGET_ID}::uuid`
        )
      ).rejects.toThrow(CHECK_VIOLATION_RE);

      await expectDepth(TARGET_ID, 0);
    });
  }
);

describeIfDb("the sampler read over the counter (ISS-8674)", () => {
  it("returns each target's real depth, deepest first", async () => {
    await enqueue(OTHER_TARGET_ID, 2);
    await enqueue(TARGET_ID, 5);

    const page = await countQueuedCommandsByTarget(10);
    const mine = page.backlogs.filter(
      (backlog) =>
        backlog.computeTargetId === TARGET_ID ||
        backlog.computeTargetId === OTHER_TARGET_ID
    );

    // The real depth, not a cap: this is the half Option B would have given up.
    expect(mine).toEqual([
      { computeTargetId: TARGET_ID, queuedCount: 5 },
      { computeTargetId: OTHER_TARGET_ID, queuedCount: 2 },
    ]);
  });

  // Sentinels run no executor, so a queued row on one can never be taken. It
  // must not hold a slot in the capped page against a real desktop.
  it("omits a cloud sentinel that is holding queued rows", async () => {
    await enqueue(SENTINEL_TARGET_ID, 9);
    await enqueue(TARGET_ID, 1);

    const page = await countQueuedCommandsByTarget(10);

    expect(
      page.backlogs.map((backlog) => backlog.computeTargetId)
    ).not.toContain(SENTINEL_TARGET_ID);
    expect(page.backlogs).toContainEqual({
      computeTargetId: TARGET_ID,
      queuedCount: 1,
    });
    // The sentinel's own counter still tracks its rows — it is the READ that
    // scopes sentinels out, not the trigger, so nothing silently stops
    // maintaining a row's count.
    await expectDepth(SENTINEL_TARGET_ID, 9);
  });

  // The property Option A was chosen FOR. A per-target LIMITed count (Option B)
  // would have returned the cap here, so an operator watching a runaway queue
  // would read the cap instead of the real number — and a runaway queue is the
  // incident this metric exists to report. The depth returned is the true row
  // count, unbounded above, while the READ that produced it stayed bounded.
  it("reports a deep backlog at its real depth, not a capped one", async () => {
    const deepBacklog = 2000;
    await enqueue(TARGET_ID, deepBacklog);

    const page = await countQueuedCommandsByTarget(10);

    expect(page.backlogs).toContainEqual({
      computeTargetId: TARGET_ID,
      queuedCount: deepBacklog,
    });
    await expectDepth(TARGET_ID, deepBacklog);
  });

  // A drained target is absent from the BACKLOG read — that is what the `gt: 0`
  // predicate is for. Its zero still reaches the gauge, from the sweep page,
  // which carries every non-sentinel target's real depth including 0, so one
  // series keeps one zero convention.
  it("omits a target whose backlog has drained", async () => {
    const ids = await enqueue(TARGET_ID, 2);
    await withDb((db) =>
      db.desktopCommand.updateMany({
        where: { id: { in: ids } },
        data: { status: DesktopCommandStatus.Done, finishedAt: new Date() },
      })
    );

    const page = await countQueuedCommandsByTarget(10);

    expect(
      page.backlogs.map((backlog) => backlog.computeTargetId)
    ).not.toContain(TARGET_ID);
  });
});

describeIfDb("the completeness sweep over real rows (ISS-8674)", () => {
  const EPOCH = new Date(0);

  beforeEach(async () => {
    // Return the fixture targets to the head of the rotation so each case
    // starts from "never swept" rather than inheriting the previous case's
    // stamps — otherwise a case passes or fails on file order.
    await withDb((db) =>
      db.computeTarget.updateMany({
        where: { organizationId: ORG_ID },
        data: { queuedDepthSweptAt: EPOCH },
      })
    );
  });

  // The rotation key, against real ordering rather than a mocked `orderBy`.
  // A target already swept must sort BEHIND one that never was, which is what
  // makes the per-tick cap a deferral instead of the permanent omission that
  // primary-key order produced.
  it("serves least-recently-swept first, so a swept target yields to an unswept one", async () => {
    await markQueueDepthSwept([TARGET_ID], new Date("2026-09-01T12:00:00Z"));

    const mine = (await listOwnSweepPage([TARGET_ID, OTHER_TARGET_ID])).map(
      (entry) => entry.computeTargetId
    );

    expect(mine).toEqual([OTHER_TARGET_ID, TARGET_ID]);
  });

  // The epoch default is load-bearing: Postgres sorts NULLs LAST in an
  // ascending btree, so a nullable column would have buried a freshly
  // registered target behind the entire fleet. It must sort to the HEAD.
  //
  // Asserted over this file's own targets, not global page[0]: another
  // suite's never-swept target ties on the epoch and can win page[0] on id
  // order (ISS-11075).
  it("puts a never-swept target at the head of the rotation", async () => {
    await markQueueDepthSwept(
      [TARGET_ID, OTHER_TARGET_ID],
      new Date("2026-09-01T12:00:00Z")
    );
    // Sorts after both swept targets by id, so only the sweep key can put it
    // ahead of them. It also sorts behind every foreign never-swept target,
    // hence the wide page in `listOwnSweepPage`.
    const freshId = `ffffffff${randomUUID().slice(8)}`;
    await withDb((db) =>
      db.computeTarget.create({
        data: {
          id: freshId,
          organizationId: ORG_ID,
          userId: USER_ID,
          machineName: `iss8674-fresh-${freshId}`,
          platform: "darwin",
        },
        select: { id: true },
      })
    );

    try {
      const mine = (
        await listOwnSweepPage([freshId, TARGET_ID, OTHER_TARGET_ID])
      ).map((entry) => entry.computeTargetId);

      expect(mine).toEqual([freshId, expect.any(String), expect.any(String)]);
    } finally {
      // Removed here, not in an afterEach: a target left behind stays at the
      // head of the rotation and silently changes what every later case in this
      // file sweeps.
      await withDb((db) =>
        db.computeTarget.deleteMany({ where: { id: freshId } })
      );
    }
  });

  // The sweep carries measured depths, so a target the backlog page's cap
  // dropped is still gauged at its REAL value rather than a filled-in zero.
  it("carries each target's real depth, not a placeholder", async () => {
    await enqueue(TARGET_ID, 6);

    const mine = await listOwnSweepPage([TARGET_ID]);

    expect(mine).toEqual([{ computeTargetId: TARGET_ID, queuedCount: 6 }]);
  });

  // Sentinels run no executor; the sweep scopes them out exactly as every other
  // fleet read here does.
  it("omits cloud sentinels from the rotation", async () => {
    const page = await listQueueDepthSweepPage(500);

    expect(page.map((entry) => entry.computeTargetId)).not.toContain(
      SENTINEL_TARGET_ID
    );
  });

  // The user-visible half of the rotation. `listByOwner` and
  // `listAvailableForOrg` order the compute-target lists by `updatedAt DESC`,
  // and Prisma rewrites `@updatedAt` on every `updateMany` whatever `data`
  // names — so stamping through Prisma would reshuffle that list every five
  // minutes from internal bookkeeping alone, until an idle target outranked one
  // the user actually used. Only a real database can show this.
  it("advances the rotation key without touching updated_at", async () => {
    const before = await withDb((db) =>
      db.computeTarget.findUniqueOrThrow({
        where: { id: TARGET_ID },
        select: { updatedAt: true, queuedDepthSweptAt: true },
      })
    );

    await markQueueDepthSwept([TARGET_ID], new Date("2026-09-01T12:00:00Z"));

    const after = await withDb((db) =>
      db.computeTarget.findUniqueOrThrow({
        where: { id: TARGET_ID },
        select: { updatedAt: true, queuedDepthSweptAt: true },
      })
    );
    expect(after.queuedDepthSweptAt).not.toEqual(before.queuedDepthSweptAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  // The progress number against real rows. The `lt`-not-`lte` boundary itself
  // is pinned on the query's exact call shape in
  // desktop-command-dispatch-queries.test.ts; what this case adds is that the
  // predicate reconciles against real stamped rows at all.
  it("counts only the targets still behind the cycle start", async () => {
    const cycleStart = new Date();
    await markQueueDepthSwept([TARGET_ID, OTHER_TARGET_ID], cycleStart);

    const awaiting = await countTargetsAwaitingSweep(cycleStart);
    const stillBehind = await withDb((db) =>
      db.computeTarget.count({
        where: {
          organizationId: ORG_ID,
          isCloudSentinel: false,
          queuedDepthSweptAt: { lt: cycleStart },
        },
      })
    );

    expect(stillBehind).toBe(0);
    // The fixture's own targets are all caught up, so whatever remains belongs
    // to other rows in the database — never negative, and never fewer than the
    // scoped count proves.
    expect(awaiting).toBeGreaterThanOrEqual(stillBehind);
  });

  // Completeness, end to end. Page the fleet one target per tick and prove the
  // whole of it is reached before ANY target is reached twice — the property
  // the decision comment asked for, and the one primary-key order could never
  // provide, because past the cap it returned the same head forever.
  it("reaches every target in the fleet before repeating one", async () => {
    const cycleStart = new Date();
    const fleetSize = await withDb((db) =>
      db.computeTarget.count({ where: { isCloudSentinel: false } })
    );
    const seen: string[] = [];

    for (let tick = 0; tick < fleetSize; tick++) {
      const [target] = await listQueueDepthSweepPage(1);
      if (!target) {
        break;
      }
      seen.push(target.computeTargetId);
      await markQueueDepthSwept([target.computeTargetId], new Date());
    }

    // Every tick produced a target, and no target was served twice within one
    // full cycle. A rotation that failed to advance repeats on tick 2.
    expect(seen).toHaveLength(fleetSize);
    expect(new Set(seen).size).toBe(fleetSize);
    // And the cycle is then provably complete: nothing is left behind the
    // instant it started.
    expect(await countTargetsAwaitingSweep(cycleStart)).toBe(0);
  });
});

describeIfDb("counter drift detection over real rows (ISS-8674)", () => {
  // The healthy case. The trigger keeps these equal, so reconciliation must be
  // silent — a detector that fired on a correct fleet would be ignored.
  it("reconciles a healthy counter against its real rows", async () => {
    await enqueue(TARGET_ID, 4);

    const [row] = await reconcileQueuedCounters([TARGET_ID]);

    expect(row).toEqual({
      computeTargetId: TARGET_ID,
      counter: 4,
      actualQueuedRows: 4,
    });
  });

  // The phantom backlog: a counter above the real rows, which renders as a
  // queue that never drains. Manufactured by disabling the trigger, which is
  // exactly the real-world cause this detector exists for.
  it("sees an over-count the trigger could not have produced", async () => {
    await enqueue(TARGET_ID, 2);
    // Toggling the trigger is owner DDL, so it goes on the fixture connection
    // (ISS-5978 took DDL off the runtime role). The DELETE it uncovers stays on
    // `withDb` — that is the production write whose counter must go stale.
    await setQueuedCountTrigger("DISABLE");
    try {
      await withDb(
        (db) =>
          db.$executeRaw`DELETE FROM "desktop_commands" WHERE "compute_target_id" = ${TARGET_ID}::uuid`
      );
    } finally {
      await setQueuedCountTrigger("ENABLE");
    }

    try {
      const [row] = await reconcileQueuedCounters([TARGET_ID]);

      expect(row).toEqual({
        computeTargetId: TARGET_ID,
        counter: 2,
        actualQueuedRows: 0,
      });
    } finally {
      // Repair the drift this case manufactured, with the exact statement
      // migration 20260901120000_iss8674_queued_command_count documents for an
      // operator. `beforeEach` only deletes command ROWS, so without this the
      // bad counter leaks into every later case and they pass or fail on file
      // order — and it doubles as proof the documented remedy works.
      await withDb(
        (db) =>
          db.$executeRaw`UPDATE "compute_targets" SET "queued_command_count" = (SELECT count(*) FROM "desktop_commands" dc WHERE dc."compute_target_id" = "compute_targets"."id" AND dc."status" = 'queued') WHERE "id" = ${TARGET_ID}::uuid`
      );
      await expectDepth(TARGET_ID, 0);
    }
  });

  // A target with no queued rows must come back as a measured 0, not drop out
  // of the result — the LEFT JOIN is what makes that so, and without it the
  // phantom-backlog case above is undetectable because the row is simply absent.
  it("returns a row with zero for a target that has no queued rows", async () => {
    const rows = await reconcileQueuedCounters([TARGET_ID, OTHER_TARGET_ID]);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.actualQueuedRows).toBe(0);
      expect(row.counter).toBe(0);
    }
  });

  // Both numbers from ONE statement, so they cannot be a round trip apart.
  // Read separately, a command enqueued in between reads as drift on a healthy
  // target — worst on the busiest ones, which is how a detector gets ignored.
  it("reads counter and rows from one snapshot, so churn is not drift", async () => {
    await enqueue(TARGET_ID, 3);

    const rows = await Promise.all([
      reconcileQueuedCounters([TARGET_ID]),
      enqueue(TARGET_ID, 5).then(() => reconcileQueuedCounters([TARGET_ID])),
    ]);

    // Whatever instant each landed on, neither ever reports a disagreement,
    // because each read its pair atomically.
    for (const [row] of rows) {
      expect(row.counter).toBe(row.actualQueuedRows);
    }
  });

  // Scoped to the ids it was handed. An unscoped aggregate is the fleet-wide
  // scan ISS-8674 removed, and it would silently return other tenants' targets.
  it("reconciles only the targets it was asked about", async () => {
    await enqueue(TARGET_ID, 3);
    await enqueue(OTHER_TARGET_ID, 1);

    const rows = await reconcileQueuedCounters([TARGET_ID]);

    expect(rows.map((row) => row.computeTargetId)).toEqual([TARGET_ID]);
  });
});

/**
 * Turn the counter-sync trigger off or on, on the connection that owns
 * `desktop_commands`. `ALTER TABLE … DISABLE TRIGGER` is owner DDL, which the
 * ISS-5978 role split took away from the runtime role the app under test uses.
 */
function setQueuedCountTrigger(mode: "DISABLE" | "ENABLE"): Promise<unknown> {
  return withFixtureClient("the queued-count trigger toggle", (client) =>
    client.query(
      `ALTER TABLE "desktop_commands" ${mode} TRIGGER "desktop_commands_queued_count_sync"`
    )
  );
}

/**
 * The sweep page narrowed to this file's own targets, in page order. Another
 * suite's never-swept target ties ours on the epoch and can sort ahead on id,
 * so a narrow global page can drop our rows off its end (ISS-11075). A missing
 * own target still fails the caller's assertion.
 */
async function listOwnSweepPage(
  ownTargetIds: readonly string[]
): Promise<TargetBacklog[]> {
  const own = new Set(ownTargetIds);
  const page = await listQueueDepthSweepPage(500);
  return page.filter((entry) => own.has(entry.computeTargetId));
}

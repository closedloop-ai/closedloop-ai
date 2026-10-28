/**
 * ISS-8896 / ISS-8895 / ISS-8897 — the three guarantees that only real Postgres
 * can witness.
 *
 * The lease (ISS-8896) is a claim about what happens when two API instances
 * race one row. Mocked Prisma cannot answer that: the whole guarantee is that
 * under READ COMMITTED the loser of a conditional `UPDATE` blocks on the row
 * lock, re-evaluates the predicate against the winner's committed row, and
 * updates nothing. A unit test with a stubbed client would assert the shape of
 * a statement and pass just as happily against the process-local map the lease
 * replaces.
 *
 * The candidate page (ISS-8895) is a claim about which rows a `where` admits
 * and where the cap lands relative to it, and the presence split (ISS-8897) is
 * a claim about which column a writer touches. Both are only worth asserting
 * against a real planner and real rows.
 *
 * Not included by the default vitest config. Run explicitly:
 *
 *   DATABASE_URL=... pnpm --filter api exec vitest run \
 *     __tests__/integration/idle-drain-concurrency.integration.test.ts \
 *     --config vitest.config.integration.mts
 */
import { randomUUID } from "node:crypto";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeTargetsService } from "../../app/compute-targets/service";
import { COMMAND_DRAIN_LEASE_TTL_MS } from "../../app/internal/relay/socket-event/service/command-drain";
import {
  acquireCommandDrainLease,
  listIdleDrainCandidates,
  releaseCommandDrainLease,
  renewCommandDrainLease,
} from "../../lib/desktop-command-dispatch-queries";
import {
  IDLE_DRAIN_GIVE_UP_MS,
  IDLE_DRAIN_MIN_SILENCE_MS,
} from "../../lib/desktop-command-idle-drain";

// Every sibling suite in this directory self-skips without a database, and so
// must this one: the integration config can be run without DATABASE_URL set,
// and a suite that connects anyway fails as a defect rather than skipping.
const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const LEASE_TARGET_ID = randomUUID();
const STALE_TARGET_ID = randomUUID();
const STRANDED_TARGET_ID = randomUUID();
const FRESH_TARGET_ID = randomUUID();
const PRESENCE_TARGET_ID = randomUUID();

const MINUTE_MS = 60 * 1000;

/**
 * The page limit every candidate case reads with.
 *
 * Deliberately larger than this file's own fixtures: the read is fleet-wide by
 * design, so a suite sharing a database with its siblings must ask for enough
 * rows that its own targets cannot be pushed off the page by another suite's,
 * and then assert over its own ids rather than over the page's length.
 */
const CANDIDATE_PAGE_LIMIT = 500;

async function seedTarget(
  id: string,
  presenceAt: Date | null,
  queuedCommands: number
): Promise<void> {
  await withDb(async (db) => {
    await db.computeTarget.create({
      data: {
        id,
        organizationId: ORG_ID,
        userId: USER_ID,
        machineName: `iss8896-${id}`,
        platform: "darwin",
        presenceAt,
      },
      select: { id: true },
    });
    if (queuedCommands === 0) {
      return;
    }
    await db.desktopCommand.createMany({
      data: Array.from({ length: queuedCommands }, () => {
        const commandId = randomUUID();
        return {
          id: commandId,
          computeTargetId: id,
          operationId: "desktop.gateway.request",
          requestFingerprint: commandId,
          requestPayload: { path: "/api/desktop/health" },
          status: DesktopCommandStatus.Queued,
        };
      }),
    });
  });
}

async function readLease(computeTargetId: string): Promise<Date | null> {
  const target = await withDb((db) =>
    db.computeTarget.findUniqueOrThrow({
      where: { id: computeTargetId },
      select: { commandDrainLeaseUntil: true },
    })
  );
  return target.commandDrainLeaseUntil;
}

/**
 * Ages the lease a minute into the past — a lapsed holder, without waiting one
 * out. A minute rather than a second because the value is written on this
 * process's clock and compared against the database's.
 */
async function expireLease(computeTargetId: string): Promise<void> {
  await withDb((db) =>
    db.computeTarget.updateMany({
      where: { id: computeTargetId },
      data: { commandDrainLeaseUntil: new Date(Date.now() - MINUTE_MS) },
    })
  );
}

async function candidateIds(): Promise<string[]> {
  const page = await listIdleDrainCandidates(
    CANDIDATE_PAGE_LIMIT,
    new Date(Date.now() - IDLE_DRAIN_MIN_SILENCE_MS)
  );
  return page.candidates.map((candidate) => candidate.computeTargetId);
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
        name: "ISS-8896 lease org",
        slug: `iss8896-${ORG_ID}`,
      },
      select: { id: true },
    });
    await db.user.create({
      data: {
        id: USER_ID,
        organizationId: ORG_ID,
        clerkId: `clerk_user_${USER_ID}`,
        email: `iss8896.${USER_ID}@example.com`,
        firstName: "Lease",
        lastName: "Probe",
      },
      select: { id: true },
    });
  });
  const now = Date.now();
  await seedTarget(LEASE_TARGET_ID, new Date(now), 0);
  await seedTarget(PRESENCE_TARGET_ID, null, 0);
  // Silent for 30 minutes: past the presence window, well short of give-up.
  await seedTarget(STALE_TARGET_ID, new Date(now - 30 * MINUTE_MS), 2);
  // Silent for two days: the give-up population the counter exists to report.
  await seedTarget(
    STRANDED_TARGET_ID,
    new Date(now - 2 * IDLE_DRAIN_GIVE_UP_MS),
    2
  );
  // Heard from one second ago: the presence trigger owns this one.
  await seedTarget(FRESH_TARGET_ID, new Date(now - 1000), 2);
});

afterAll(async () => {
  if (!hasDatabase) {
    return;
  }
  await withDb(async (db) => {
    await db.desktopCommand.deleteMany({
      where: { computeTarget: { organizationId: ORG_ID } },
    });
    await db.computeTarget.deleteMany({ where: { organizationId: ORG_ID } });
    await db.user.deleteMany({ where: { organizationId: ORG_ID } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
  });
});

beforeEach(async () => {
  if (!hasDatabase) {
    return;
  }
  await withDb((db) =>
    db.computeTarget.updateMany({
      where: { id: LEASE_TARGET_ID },
      data: { commandDrainLeaseUntil: null },
    })
  );
});

describeIfDb(
  "ISS-8896 — the release gate bounds the fleet, not the process",
  () => {
    it("admits exactly one of two callers that race the same target", async () => {
      // THE CASE THE TICKET NAMES. Both acquisitions are started before either is
      // awaited, so the two statements are genuinely in flight against one row —
      // a harness that awaited them in turn would remove the concurrency under
      // test and would pass just as well against the process-local map this
      // replaces, which never contended at all.
      const [claimA, claimB] = await Promise.all([
        acquireCommandDrainLease(LEASE_TARGET_ID, COMMAND_DRAIN_LEASE_TTL_MS),
        acquireCommandDrainLease(LEASE_TARGET_ID, COMMAND_DRAIN_LEASE_TTL_MS),
      ]);

      expect([claimA, claimB].filter(Boolean)).toHaveLength(1);
      // And the row records the winner's lease, not a torn value: the loser's
      // write must not have landed at all.
      expect(await readLease(LEASE_TARGET_ID)).toEqual(claimA ?? claimB);
    });

    it("admits exactly one of eight callers, so the gate is not a coin flip that happened to land once", async () => {
      // The positive sibling of the two-caller case with the count raised: a gate
      // that admitted two of eight would still satisfy a "not both" assertion on
      // a pair, and N x ceiling is the defect whatever N is.
      const claims = await Promise.all(
        Array.from({ length: 8 }, () =>
          acquireCommandDrainLease(LEASE_TARGET_ID, COMMAND_DRAIN_LEASE_TTL_MS)
        )
      );

      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it("stamps the expiry from the database's clock, not the caller's", async () => {
      // whitlockk, PR #7119. A caller-computed `now + ttl` is sampled BEFORE the
      // statement's own connection acquisition, which `DB_POOL_ACQUIRE_TIMEOUT_MS`
      // bounds at 30s — twice the TTL — so a claim taken through a stalled pool
      // used to persist an expiry already in the past while its holder went on to
      // dispatch. Asserting against the DATABASE's clock read in the same suite,
      // rather than against this process's, is what makes that observable.
      const claim = await acquireCommandDrainLease(
        LEASE_TARGET_ID,
        COMMAND_DRAIN_LEASE_TTL_MS
      );

      expect(claim).not.toBeNull();
      const [{ dbNow }] = await withDb(
        (db) =>
          db.$queryRaw<{ dbNow: Date }[]>`
            SELECT (now() AT TIME ZONE 'UTC') AS "dbNow"
          `
      );
      expect((claim as Date).getTime()).toBeGreaterThan(dbNow.getTime());
    });

    it("lets the next caller in once the lease has expired, so a crashed holder cannot own a target forever", async () => {
      await expireLease(LEASE_TARGET_ID);

      await expect(
        acquireCommandDrainLease(LEASE_TARGET_ID, COMMAND_DRAIN_LEASE_TTL_MS)
      ).resolves.not.toBeNull();
    });

    it("refuses a second caller while the lease is live", async () => {
      // The negative half stated on its own, so the concurrent cases above cannot
      // be the only thing standing between this and an always-true gate.
      await acquireCommandDrainLease(
        LEASE_TARGET_ID,
        COMMAND_DRAIN_LEASE_TTL_MS
      );

      await expect(
        acquireCommandDrainLease(LEASE_TARGET_ID, COMMAND_DRAIN_LEASE_TTL_MS)
      ).resolves.toBeNull();
    });

    it("restarts the window when the current holder renews across its reads", async () => {
      // The fix for whitlockk's finding. A four-fold TTL rather than the same one, so
      // the new expiry must be tens of seconds past the old: at TIMESTAMP(3) two
      // statements this close could otherwise write the same millisecond and the
      // assertion would be a clock race rather than a claim about the renewal.
      const held = await acquireCommandDrainLease(
        LEASE_TARGET_ID,
        COMMAND_DRAIN_LEASE_TTL_MS
      );

      const renewed = await renewCommandDrainLease(
        LEASE_TARGET_ID,
        held as Date,
        COMMAND_DRAIN_LEASE_TTL_MS * 4
      );

      expect(renewed).not.toBeNull();
      expect((renewed as Date).getTime()).toBeGreaterThan(
        (held as Date).getTime()
      );
      expect(await readLease(LEASE_TARGET_ID)).toEqual(renewed);
    });

    it("refuses a renewal from a holder whose lease lapsed while it was reading", async () => {
      // THE POOL STALL. `countInFlightCommandsForDispatch` and
      // `listQueuedCommandsForDispatch` each take a pooled connection, and one
      // wait is bounded at 30s — twice this TTL — so a holder can come out of
      // them after the row expired and another instance legitimately claimed the
      // target. Expiring the row here is that stall made deterministic; without
      // the refusal below both instances dispatch a full `ceiling - inFlight`
      // against one ceiling, which is the defect the lease exists to stop.
      const stalledHolder = await acquireCommandDrainLease(
        LEASE_TARGET_ID,
        COMMAND_DRAIN_LEASE_TTL_MS
      );
      await expireLease(LEASE_TARGET_ID);
      // A four-fold TTL for the new holder, so its token is tens of seconds past
      // the stalled one by construction. With equal TTLs both acquires can land
      // in the same TIMESTAMP(3) millisecond, the two tokens match, and the
      // renewal below hits the new holder's row (coverage-main run 36969775791).
      const newHolder = await acquireCommandDrainLease(
        LEASE_TARGET_ID,
        COMMAND_DRAIN_LEASE_TTL_MS * 4
      );
      expect(newHolder).not.toBeNull();

      await expect(
        renewCommandDrainLease(
          LEASE_TARGET_ID,
          stalledHolder as Date,
          COMMAND_DRAIN_LEASE_TTL_MS
        )
      ).resolves.toBeNull();
      // And the refused holder has not extended the lease it no longer owns,
      // which would hand the target back to the wrong instance.
      expect(await readLease(LEASE_TARGET_ID)).toEqual(newHolder);
    });

    it("hands the lease back on completion, so the next trigger does not wait out the TTL", async () => {
      const held = await acquireCommandDrainLease(
        LEASE_TARGET_ID,
        COMMAND_DRAIN_LEASE_TTL_MS
      );

      await releaseCommandDrainLease(LEASE_TARGET_ID, held as Date);

      expect(await readLease(LEASE_TARGET_ID)).toBeNull();
    });

    it("does not let an overrunning holder free the lease a newer holder has taken", async () => {
      // The ownership scoping. Without it, a release that ran past its TTL would
      // clear the lease of whoever claimed the target next — reopening the exact
      // concurrent dispatch the lease exists to stop, at the worst moment.
      const staleHolderLease = new Date(Date.now() - MINUTE_MS);
      const newHolderLease = new Date(Date.now() + COMMAND_DRAIN_LEASE_TTL_MS);
      await withDb((db) =>
        db.computeTarget.updateMany({
          where: { id: LEASE_TARGET_ID },
          data: { commandDrainLeaseUntil: newHolderLease },
        })
      );

      await releaseCommandDrainLease(LEASE_TARGET_ID, staleHolderLease);

      expect(await readLease(LEASE_TARGET_ID)).toEqual(newHolderLease);
    });
  }
);

describeIfDb(
  "ISS-8895 — the candidate page is bounded after the filter",
  () => {
    it("drops a target the presence trigger still owns before the cap is applied", async () => {
      // Stamped HERE rather than in `beforeAll`: the presence window is 60s and a
      // contended run can spend longer than that between the two, which would turn
      // a real assertion into a clock race that fails for the wrong reason.
      await withDb((db) =>
        db.computeTarget.updateMany({
          where: { id: FRESH_TARGET_ID },
          data: { presenceAt: new Date() },
        })
      );

      const ids = await candidateIds();

      expect(ids).not.toContain(FRESH_TARGET_ID);
      // The positive sibling: an empty page would satisfy the line above on its
      // own, so the same read must be shown returning the target it should.
      expect(ids).toContain(STALE_TARGET_ID);
    });

    it("admits a target whose presence frame lands exactly on the cutoff", async () => {
      // davetho, PR #7119. `retryStrideTicks` calls
      // `silentMs === IDLE_DRAIN_MIN_SILENCE_MS` due, so the page owes that
      // target a row; the strict `lt` this replaces excluded precisely this
      // instant, and the target waited out another five-minute tick while the
      // ladder considered it eligible. Driven off the value Postgres actually
      // stored rather than off a cutoff computed here: the column is
      // `TIMESTAMP(3)`, which is the resolution the boundary lives at.
      const { presenceAt } = await withDb((db) =>
        db.computeTarget.findUniqueOrThrow({
          where: { id: STALE_TARGET_ID },
          select: { presenceAt: true },
        })
      );
      const cutoff = presenceAt as Date;

      const onCutoff = await listIdleDrainCandidates(
        CANDIDATE_PAGE_LIMIT,
        cutoff
      );

      expect(
        onCutoff.candidates.map((candidate) => candidate.computeTargetId)
      ).toContain(STALE_TARGET_ID);

      // One millisecond earlier the same row must fall out. Without this half,
      // the assertion above passes just as well against a predicate that admits
      // every target whatever its presence clock says.
      const beforeCutoff = await listIdleDrainCandidates(
        CANDIDATE_PAGE_LIMIT,
        new Date(cutoff.getTime() - 1)
      );

      expect(
        beforeCutoff.candidates.map((candidate) => candidate.computeTargetId)
      ).not.toContain(STALE_TARGET_ID);
    });

    it("keeps a target stranded past the give-up horizon on the page, which is what keeps targetsGivenUp countable", async () => {
      // ISS-8895 AC4's trap, pinned against the real predicate rather than
      // against a shape assertion. A give-up floor added to the `where` — the
      // natural next step once the presence filter is in SQL — would drop this
      // row and silently zero the counter that distinguishes "stranded for good"
      // from "presence has it covered".
      expect(await candidateIds()).toContain(STRANDED_TARGET_ID);
    });

    it("never returns a target with no backlog, whatever its presence clock says", async () => {
      // PRESENCE_TARGET_ID has never been present and has no queued command, so
      // only the depth predicate can exclude it — the half of the `where` the
      // presence filter must not have displaced.
      expect(await candidateIds()).not.toContain(PRESENCE_TARGET_ID);
    });

    it("caps the page at the requested size and says when more remain", async () => {
      const page = await listIdleDrainCandidates(
        1,
        new Date(Date.now() - IDLE_DRAIN_MIN_SILENCE_MS)
      );

      expect(page.candidates).toHaveLength(1);
      // This suite alone seeds two matching targets, so the probe row must fire.
      expect(page.hasMore).toBe(true);
    });
  }
);

describeIfDb("ISS-8897 — two clocks, two writers", () => {
  it("moves the presence clock only on a relay presence frame", async () => {
    await withDb((db) =>
      db.computeTarget.updateMany({
        where: { id: PRESENCE_TARGET_ID },
        data: { presenceAt: null },
      })
    );

    await computeTargetsService.recordRelayPresence(
      PRESENCE_TARGET_ID,
      ORG_ID,
      USER_ID
    );

    const afterPresence = await withDb((db) =>
      db.computeTarget.findUniqueOrThrow({
        where: { id: PRESENCE_TARGET_ID },
        select: { presenceAt: true, lastSeenAt: true },
      })
    );
    // A presence frame IS a check-in, so it advances both — the split is about
    // what the OTHER writers may touch, not about starving `lastSeenAt`.
    expect(afterPresence.presenceAt).not.toBeNull();
    expect(afterPresence.lastSeenAt).toEqual(afterPresence.presenceAt);

    await computeTargetsService.heartbeat(PRESENCE_TARGET_ID, ORG_ID, USER_ID);

    const afterHeartbeat = await withDb((db) =>
      db.computeTarget.findUniqueOrThrow({
        where: { id: PRESENCE_TARGET_ID },
        select: { presenceAt: true, lastSeenAt: true },
      })
    );
    // THE CLOCKS GENUINELY DISAGREE, which is the case ISS-8897 AC5 demands:
    // a desktop checking in on a non-relay transport moves `lastSeenAt` and
    // leaves the presence clock where it was. Pointing the drain back at
    // `lastSeenAt` makes this target look covered by a trigger that is not
    // running for it.
    expect(afterHeartbeat.presenceAt).toEqual(afterPresence.presenceAt);
    expect(afterHeartbeat.lastSeenAt.getTime()).toBeGreaterThan(
      (afterPresence.presenceAt as Date).getTime()
    );
  });
});

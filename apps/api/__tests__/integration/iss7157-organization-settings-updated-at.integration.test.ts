/**
 * ISS-7157 — every raw `Organization.settings` writer must advance
 * `updated_at`.
 *
 * `Organization.updatedAt` is declared `@updatedAt` in the Prisma schema, but
 * Prisma applies that at the CLIENT layer, on the `update`/`updateMany` calls
 * ISS-7092/7111/7119/7121 replaced with atomic `jsonb_set` UPDATEs. There is no
 * database default or trigger behind the column, so a raw statement that does
 * not name `updated_at` rewrites `settings` and leaves the timestamp pinned to
 * whatever the last Prisma-layer write set — the column silently stops
 * describing the last mutation of the row.
 *
 * WHY THIS SUITE IS INTEGRATION AND NOT A UNIT ASSERTION ON THE SQL TEXT.
 * Asserting `statement.text` names `"updated_at"` proves the string exists; it
 * proves nothing about whether Postgres, executing that statement against a
 * real row, actually moves the column — a clause in the wrong place, a `SET`
 * list the parser reads differently, a bound value the driver encodes into the
 * wrong zone, or a writer whose statement never runs at all would all keep such
 * an assertion green. Every case here therefore drives the PRODUCTION writer
 * against a real row and reads the column back. The complementary static half —
 * which covers the writer that does not exist yet, and which this suite cannot
 * enumerate — is `__tests__/unit/organization-settings-updated-at-gate`.
 *
 * WHY THE ROW IS BACKDATED FIRST. Comparing `updatedAt` before and after the
 * write would pass on a resolution accident rather than on the fix: the
 * fixture's own creation timestamp is already microseconds old, so the
 * assertion would rest on how far apart two transactions land. Pinning the
 * column to a fixed, unmistakably historic value instead means the only way it
 * can read as recent afterwards is for the writer to have set it.
 *
 * Each case also asserts the write LANDED. A writer that silently no-ops would
 * otherwise leave the backdated timestamp in place and be indistinguishable
 * from the regression this suite exists to catch.
 */
import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  holdOrganizationRowLock,
  type OrganizationRowLockHolder,
} from "@/__tests__/support/organizations/organization-row-lock-holder";
import {
  installOrganizationSettingsWriteBarrier,
  type OrganizationSettingsWriteBarrier,
} from "@/__tests__/support/organizations/organization-settings-write-barrier";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import {
  ONBOARDING_SETTINGS_KEY,
  onboardingService,
} from "@/app/onboarding/service";
import { frustrationSettingService } from "@/app/settings/frustration-setting-service";
import { writeOrganizationSettingsKey } from "@/lib/organization-settings-write";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/** Far enough back that no clock skew can explain it away. */
const BACKDATED_AT = new Date("2000-01-01T00:00:00.000Z");

/** The key the shared writer's case patches, owned by nothing else. */
const SHARED_WRITER_SETTINGS_KEY = "iss7157Marker";
const SHARED_WRITER_SUBJECT = "ISS-7157 probe write";

/**
 * How far AHEAD of the parked writer's own captured time the competing write
 * stamps the column. Large enough that the ordering is decided by this constant
 * rather than by how many milliseconds elapse between the writer capturing
 * `new Date()` and the barrier reporting it parked — the two are microseconds
 * apart, and `updated_at` is `TIMESTAMP(3)`, so a smaller lead would make the
 * case answerable by rounding.
 */
const COMPETING_WRITE_LEAD_MS = 60_000;

/**
 * How long the competing transaction keeps the row lock after the production
 * write has reached it. It is the whole margin the post-lock case is decided
 * by: the writer's pre-lock reading and its post-lock reading are otherwise
 * microseconds apart and `updated_at` is `TIMESTAMP(3)`, so without a held
 * interval the case would be answerable by rounding. Small enough to stay far
 * inside Prisma's 5s interactive-transaction timeout, which the blocked writer
 * is sitting in.
 */
const CONTENDED_HOLD_MS = 300;

type OrganizationRow = {
  readonly settings: Record<string, unknown>;
  readonly updatedAt: Date;
};

async function readOrganization(
  organizationId: string
): Promise<OrganizationRow> {
  const org = await withDb((db) =>
    db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { settings: true, updatedAt: true },
    })
  );
  return {
    settings: (org.settings ?? {}) as Record<string, unknown>,
    updatedAt: org.updatedAt,
  };
}

/**
 * Raw, so the backdating itself cannot be undone by Prisma's own `@updatedAt`
 * — the very client-layer behaviour these writers no longer go through. The
 * value is BOUND and uncast, which is how the Prisma writers on this table
 * store it: `updated_at` is `TIMESTAMP(3)` with no zone, so casting through
 * `timestamptz` would re-read as `BACKDATED_AT` shifted by the session zone.
 */
async function backdateUpdatedAt(organizationId: string): Promise<void> {
  await withDb(
    (db) =>
      db.$executeRaw`
        UPDATE "organizations"
        SET "updated_at" = ${BACKDATED_AT}
        WHERE "id" = ${organizationId}::uuid
      `
  );
}

/**
 * One case per raw `Organization.settings` statement in the codebase. The
 * backfill lane and the run gate both write through
 * `writeOrganizationSettingsKey`, so its case covers both.
 *
 * Each case reads back the value its writer is supposed to have persisted and
 * names what that value should be, rather than carrying an assertion — the
 * assertions all live in the `it` below.
 */
const WRITERS = [
  {
    name: "frustrationSettingService.setFrustrationEnabled",
    write: (organizationId: string) =>
      frustrationSettingService.setFrustrationEnabled(organizationId, true),
    readWritten: (settings: Record<string, unknown>) =>
      settings[SESSION_FRUSTRATION_SETTING_KEY],
    written: true as unknown,
  },
  {
    name: "onboardingService.recordInvitesSent",
    write: (organizationId: string) =>
      onboardingService.recordInvitesSent(organizationId),
    // The timestamp is generated at call time, so the case can only name its
    // TYPE. `null` — the default this sub-key carries until a send is recorded
    // — is not a string, so an unwritten row still reads red.
    readWritten: (settings: Record<string, unknown>) =>
      typeof (settings[ONBOARDING_SETTINGS_KEY] as Record<string, unknown>)
        ?.invitesSentAt === "string",
    written: true as unknown,
  },
  {
    name: "writeOrganizationSettingsKey (backfill lane and run gate)",
    write: (organizationId: string) =>
      writeOrganizationSettingsKey(
        organizationId,
        SHARED_WRITER_SETTINGS_KEY,
        { written: true },
        SHARED_WRITER_SUBJECT
      ),
    readWritten: (settings: Record<string, unknown>) =>
      settings[SHARED_WRITER_SETTINGS_KEY],
    written: { written: true } as unknown,
  },
] as const;

describeIfDb(
  "raw Organization.settings writers advance updated_at (ISS-7157)",
  () => {
    const tracker = createCommittedTestOrganizationTracker();
    let barrier: OrganizationSettingsWriteBarrier | null = null;
    let lockHolder: OrganizationRowLockHolder | null = null;

    afterEach(async () => {
      // Both before `tracker.cleanup()`: while the barrier is installed it
      // parks every non-racer `organizations` write, and the lock holder blocks
      // every write to its row — the cleanup is one of each.
      await barrier?.dispose();
      barrier = null;
      await lockHolder?.dispose();
      lockHolder = null;
      await tracker.cleanup();
    });

    for (const writer of WRITERS) {
      it(`${writer.name} sets updated_at`, async () => {
        const organizationId = await tracker.create();
        await backdateUpdatedAt(organizationId);
        expect((await readOrganization(organizationId)).updatedAt).toEqual(
          BACKDATED_AT
        );

        // Node's clock, because that is the clock the writers bind from:
        // `updated_at` is `TIMESTAMP(3)` with no zone and five Prisma-layer sites
        // still stamp this column from the application, so the raw statements
        // bind rather than reading the database clock. Comparing against a
        // database reading would make this assertion answerable by app/DB skew
        // instead of by the write.
        const startedAt = new Date();
        await writer.write(organizationId);
        const finishedAt = new Date();
        const after = await readOrganization(organizationId);

        expect(writer.readWritten(after.settings)).toEqual(writer.written);
        // Bounded on BOTH sides, and that is the half that does the work. A
        // lower bound alone ("later than the year 2000", or even "later than
        // `startedAt`") is met by a timestamp that landed in the FUTURE — which
        // is exactly what an east-of-UTC session `TimeZone` conversion
        // produces, and what a writer binding a lease deadline rather than now
        // would produce. The column has to land inside the window this write
        // actually occupied, or the zone and the value are not being checked at
        // all.
        expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
          startedAt.getTime()
        );
        expect(after.updatedAt.getTime()).toBeLessThanOrEqual(
          finishedAt.getTime()
        );
      });
    }

    /**
     * The CONTENDED write, which the four cases above cannot reach: each of
     * them owns its row, so nothing else can commit between the writer
     * capturing its timestamp and Postgres locking the row.
     *
     * That gap is real, and it is where the column can go BACKWARDS. The bound
     * value is captured when the caller builds the statement — before
     * `withDb.tx` opens and before any row is locked — so a writer that then
     * waits (behind the run gate's advisory lock, a busy pool, or another write
     * to the same row) resumes and commits a time from before it waited. If it
     * assigns that time outright it overwrites a newer one that committed while
     * it was parked, and `updated_at` reads older than the last mutation of the
     * row — the same silence the missing assignment produced, reached the other
     * way round.
     *
     * Ordered deterministically rather than raced for, with the same
     * statement-level advisory-lock barrier the three settings-race suites use:
     * the production UPDATE is parked at the statement boundary (BEFORE it takes
     * the row lock), the competing stamp is committed inside that window, and
     * only then is the UPDATE let through. Both assertions carry weight — a
     * writer that never ran at all would leave the competing stamp in place and
     * satisfy the timestamp assertion on its own, so the settings read is what
     * proves the parked statement actually landed.
     */
    /**
     * The stamp is read AFTER the row is locked, so it describes when this
     * write actually mutated the row rather than when it was queued.
     *
     * `GREATEST` alone (the first pass at this) makes the column monotonic and
     * stops there. The loser of a contended write still commits the time it
     * captured before it waited, `GREATEST` discards it in favour of the
     * winner's newer stamp, and the column ends up describing the WINNER even
     * though the loser mutated the row afterwards — so a staleness check or
     * sync cursor already past the winner's time never sees the loser's change.
     * The case below is deliberately set up so `GREATEST` cannot rescue it: the
     * competing writer stamps a time in the distant past, so the only value
     * that can make the column recent is the production writer's own.
     *
     * Ordered by a HELD ROW LOCK rather than by the statement-level barrier the
     * other race suites use. That barrier fires before any row is examined, by
     * design, so a statement parked at it holds nothing and has not waited on
     * anything — which is exactly the state this case must not be in. Here the
     * competing transaction takes the row lock, the production write blocks on
     * it for a known interval, and the assertion asks whether the persisted
     * stamp fell inside that interval or before it. Both assertions carry
     * weight: a writer that never ran at all would leave the competing stamp in
     * place, so the settings read is what proves the blocked statement landed.
     */
    it("reads its updated_at stamp after the row lock, not before it waited", async () => {
      const organizationId = await tracker.create();
      const holder = await holdOrganizationRowLock(
        organizationId,
        BACKDATED_AT,
        "the ISS-7157 shared settings writer"
      );
      lockHolder = holder;

      const startedAt = new Date();
      const write = writeOrganizationSettingsKey(
        organizationId,
        SHARED_WRITER_SETTINGS_KEY,
        { written: true },
        SHARED_WRITER_SUBJECT
      );
      await holder.waitUntilContended();
      const releasedAt = new Date(startedAt.getTime() + CONTENDED_HOLD_MS);
      await holder.commitAfter(releasedAt);
      await write;

      const after = await readOrganization(organizationId);

      expect(after.settings[SHARED_WRITER_SETTINGS_KEY]).toEqual({
        written: true,
      });
      // The caller's own bound stamp is captured when the statement is BUILT,
      // which lands at `startedAt` — `CONTENDED_HOLD_MS` before this bound.
      // Only the shared writer's post-lock re-stamp can satisfy it.
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
        releasedAt.getTime()
      );
    });

    it("does not move updated_at backwards behind a newer concurrent write", async () => {
      const organizationId = await tracker.create();
      const active = await installOrganizationSettingsWriteBarrier({
        subject: "the ISS-7157 shared settings writer",
      });
      barrier = active;

      const competingAt = new Date(Date.now() + COMPETING_WRITE_LEAD_MS);
      const write = writeOrganizationSettingsKey(
        organizationId,
        SHARED_WRITER_SETTINGS_KEY,
        { written: true },
        SHARED_WRITER_SUBJECT
      );
      await active.waitUntilBlocked();
      await active.commitCompetingUpdatedAt(organizationId, competingAt);
      await active.release();
      await write;

      const after = await readOrganization(organizationId);

      expect(after.settings[SHARED_WRITER_SETTINGS_KEY]).toEqual({
        written: true,
      });
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
        competingAt.getTime()
      );
    });
  }
);

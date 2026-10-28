import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { buildWhere } from "@/app/agent-sessions/service/query-builder";
import { SESSIONS_SURFACE_DATE_FIELD } from "@/app/agent-sessions/service/session-date-field";
import { resolvePeriodRange } from "@/app/insights/service/period";
import type { InsightsScopeContext } from "@/app/insights/service/scope";
import {
  countSessions,
  fetchSessionRollup,
  sumSessionCost,
} from "@/app/insights/service/session-queries";

/**
 * ISS-10413 AC-2 and ISS-10604, against a real database.
 *
 * ISS-10413 reported the Dashboard's Sessions KPI holding one number across a
 * date change and a Me/Organization change, and blamed an unfiltered read. That
 * diagnosis is wrong — the KPI's producer is `fetchSessionRollup`, which windows
 * and org/owner-scopes like every other tile — but NOTHING IN THE REPO COULD
 * HAVE SHOWN THAT. `service.test.ts` drives this section through a fake
 * `$queryRaw` whose fixture hands back `sessionRollupRows` directly, so the
 * WHERE clause never executes and a rollup that dropped its date bound, its
 * org predicate, or its owner predicate would keep every one of those tests
 * green. This file is the corpus that can fail.
 *
 * ISS-10604 rides the same fixture because it is the same read, and ISS-10541
 * closed it: one date range is now measured against ONE column, and
 * `OWNER_STARTED_BEFORE` — started in January, last active inside June — is the
 * row that used to separate the list from the KPI. The cases below assert the
 * two reads AGREE on it, which is executable where the old pair of constants two
 * files apart was not.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T00:00:00.000Z");
const IN_WINDOW = new Date("2026-06-10T12:00:00.000Z");
/**
 * The straddler's last activity, deliberately LATER than `IN_WINDOW`.
 *
 * With both at 06-10 there was no window this fixture could express the property
 * over: any start past 06-10 dropped all three activity-inside rows at once, so
 * the narrowing case read 0 against 0 — two reads agreeing about an empty set,
 * which is not the straddler failing to separate them (#7678 review, tamsinb).
 * Five days of daylight gives a narrowing that keeps the straddler and drops the
 * two start-inside rows, so both reads land on 1 BECAUSE of the shared basis.
 */
const LATE_IN_WINDOW = new Date("2026-06-15T12:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-01-15T12:00:00.000Z");
const SESSION_COST_USD = 1;
/** The clock the all-time case resolves "all" at: every seeded row is before it. */
const ALL_TIME_NOW = new Date("2026-06-20T12:00:00.000Z");
/** Last active after `ALL_TIME_NOW`'s UTC day ends, so past the all-time `end`. */
const AFTER_ALL_TIME_END = new Date("2026-06-21T06:00:00.000Z");

/**
 * The four rows (five in the all-time case), and what each one is for. Every session below carries an
 * EXPLICIT `lastActivityAt` so the list's null-safe fallback to
 * `sessionStartedAt` is never what decides an assertion.
 */
const OWNER_IN_WINDOW = "owner-in-window";
/** Started before the window, last active inside it — ISS-10604's whole case. */
const OWNER_STARTED_BEFORE = "owner-started-before";
/** Entirely before the window: neither basis may count it. */
const OWNER_FULLY_OUTSIDE = "owner-fully-outside";
/** A colleague's in-window session: org counts it, `me` must not. */
const COLLEAGUE_IN_WINDOW = "colleague-in-window";
/** Seeded only by the all-time case: last active after the all-time `end`. */
const OWNER_FUTURE_ACTIVITY = "owner-future-activity";

const OWNER_EMAIL = "rollup.owner@example.test";
const COLLEAGUE_EMAIL = "rollup.colleague@example.test";

type Seeded = {
  organizationId: string;
  ownerId: string;
};

describeIfDb(
  "ISS-10413 AC-2: the Sessions KPI read narrows on date and owner",
  () => {
    it("counts only sessions this user was active in inside the window", async () => {
      const rollup = await withCorpus((seeded) =>
        fetchSessionRollup(meContext(seeded), {
          start: WINDOW_START,
          end: WINDOW_END,
        })
      );

      // The owner's two rows last active inside June. Two, not three: losing the
      // date bound takes OWNER_FULLY_OUTSIDE, losing the owner predicate takes
      // the colleague's.
      expect(rollup.sessionCount).toBe(2);
    });

    it("widens to the colleague's session under organization scope, and no further", async () => {
      const rollup = await withCorpus((seeded) =>
        fetchSessionRollup(orgContext(seeded), {
          start: WINDOW_START,
          end: WINDOW_END,
        })
      );

      // Three, not four and not six: losing the date window reads 4
      // (OWNER_FULLY_OUTSIDE joins), losing the org predicate reads 6 (the second
      // org's three in-window rows join).
      expect(rollup.sessionCount).toBe(3);
    });

    it("answers differently for the two scopes on one corpus", async () => {
      // The property ISS-10413 actually reported missing, stated as one
      // comparison rather than inferred from two cases that could both be wrong
      // in the same direction. A read ignoring scope returns the same number
      // twice, which is the reported symptom.
      const { me, org } = await withCorpus(async (seeded) => ({
        me: await fetchSessionRollup(meContext(seeded), {
          start: WINDOW_START,
          end: WINDOW_END,
        }),
        org: await fetchSessionRollup(orgContext(seeded), {
          start: WINDOW_START,
          end: WINDOW_END,
        }),
      }));

      expect(org.sessionCount).toBeGreaterThan(me.sessionCount);
    });
  }
);

describeIfDb(
  "ISS-10604: the list and the KPI window on the same activity column",
  () => {
    it("pins the shared Sessions window basis independently of the predicate", () => {
      expect(SESSIONS_SURFACE_DATE_FIELD).toBe("lastActivityAt");
    });

    it("counts the started-before, active-inside session on BOTH sides", async () => {
      // Unconditional since ISS-10541: reinstating `s.session_started_at` in
      // `sessionWindowColumn` turns this red at `kpiCount`.
      const { listCount, kpiCount } = await withCorpus(async (seeded) => {
        const listWhere = await buildWhere(
          { organizationId: seeded.organizationId },
          {
            startDate: WINDOW_START.toISOString(),
            endDate: WINDOW_END.toISOString(),
          },
          SESSIONS_SURFACE_DATE_FIELD
        );
        return {
          listCount: await withDb((db) =>
            db.sessionDetail.count({ where: listWhere })
          ),
          kpiCount: (
            await fetchSessionRollup(orgContext(seeded), {
              start: WINDOW_START,
              end: WINDOW_END,
            })
          ).sessionCount,
        };
      });

      // Three on both sides, and the third row is OWNER_STARTED_BEFORE: it began
      // in January and was last active inside June. Under the retired basis the
      // KPI dropped it and read 2 — the 1,399-versus-1,290 ISS-10541 reported.
      expect(listCount).toBe(3);
      expect(kpiCount).toBe(3);
    });

    it("agrees over a window the straddling session still straddles", async () => {
      // The counterweight: one basis means the straddler cannot separate the two
      // reads over ANY window. Narrowing to 06-11 drops both in-window-by-start
      // rows (their activity is 06-10) and KEEPS the straddler, whose activity is
      // 06-15 — so this window is populated by the straddler ALONE, which is the
      // only row on which the two bases could ever have disagreed. Both reads
      // land on 1.
      const narrowStart = new Date("2026-06-11T00:00:00.000Z");
      const { listCount, kpiCount } = await withCorpus(async (seeded) => {
        const listWhere = await buildWhere(
          { organizationId: seeded.organizationId },
          {
            startDate: narrowStart.toISOString(),
            endDate: WINDOW_END.toISOString(),
          },
          SESSIONS_SURFACE_DATE_FIELD
        );
        return {
          listCount: await withDb((db) =>
            db.sessionDetail.count({ where: listWhere })
          ),
          kpiCount: (
            await fetchSessionRollup(orgContext(seeded), {
              start: narrowStart,
              end: WINDOW_END,
            })
          ).sessionCount,
        };
      });

      // One, not zero: the case is non-empty, so it distinguishes "the two reads
      // agree on the straddler" from "the two reads agree that nothing is here".
      // A KPI still on session start would read 0 against the list's 1.
      expect(listCount).toBe(1);
      expect(kpiCount).toBe(1);
    });

    it("counts and prices a session whose activity is exactly the window's end", async () => {
      // `resolvePeriodRange` ends a window at `stableUtcDayEnd` — 23:59:59.999Z,
      // the last representable instant — so the closing bound is INCLUSIVE, and
      // `fetchSessionRollup`'s raw SQL honours it with `<= ${end}`. The two
      // Prisma reads beside it used `lt`, so a row sitting exactly on the bound
      // was counted by the rendered Sessions tile and dropped from the cost tile
      // and from the prior-window count that is the WoW delta's denominator —
      // the same cohort split at the edge that aligning the COLUMN was supposed
      // to close (#7678 review, marisolashgrove and whitlockk).
      //
      // `IN_WINDOW` is used as the END here precisely because two seeded rows
      // carry it as their last activity, so the inclusive reading is 2 and the
      // exclusive reading is 0 — a gap no rounding could produce.
      const { rollupCount, priorCount, cost } = await withCorpus(
        async (seeded) => ({
          rollupCount: (
            await fetchSessionRollup(orgContext(seeded), {
              start: WINDOW_START,
              end: IN_WINDOW,
            })
          ).sessionCount,
          priorCount: await countSessions(
            orgContext(seeded),
            WINDOW_START,
            IN_WINDOW
          ),
          cost: await sumSessionCost(orgContext(seeded), {
            start: WINDOW_START,
            end: IN_WINDOW,
          }),
        })
      );

      expect(rollupCount).toBe(2);
      expect(priorCount).toBe(rollupCount);
      expect(cost).toBe(rollupCount * SESSION_COST_USD);
    });

    it("counts and prices a session last active after the all-time end, as the list does (ISS-12263)", async () => {
      // The Sessions list sends no bounds for "All", so it lists a session last
      // active after the end of today (UTC). The KPI and the cost read the
      // all-time Sessions window, which must be just as unbounded.
      const range = resolvePeriodRange(InsightsPeriod.All, ALL_TIME_NOW);
      expect(AFTER_ALL_TIME_END.getTime()).toBeGreaterThan(range.end.getTime());
      const { listCount, kpiCount, cost } = await withCorpus(async (seeded) => {
        const listWhere = await buildWhere(
          { organizationId: seeded.organizationId },
          {},
          SESSIONS_SURFACE_DATE_FIELD
        );
        return {
          listCount: await withDb((db) =>
            db.sessionDetail.count({ where: listWhere })
          ),
          kpiCount: (
            await fetchSessionRollup(orgContext(seeded), range.sessionsWindow)
          ).sessionCount,
          cost: await sumSessionCost(orgContext(seeded), range.sessionsWindow),
        };
      }, AFTER_ALL_TIME_END);

      // Five: the org's four seeded rows plus the future one. Bounding at the
      // all-time `end`, as before ISS-12263, reads 4 for both.
      expect(listCount).toBe(5);
      expect(kpiCount).toBe(listCount);
      expect(cost).toBe(listCount * SESSION_COST_USD);
    });

    it("scopes the list count to the viewer the same way the KPI does", async () => {
      // ISS-10413 AC-2's other half applied to the list side, so "the two surfaces
      // disagree" can never be explained away as one of them ignoring the owner.
      const listCount = await withCorpus(async (seeded) => {
        const where = await buildWhere(
          {
            organizationId: seeded.organizationId,
            viewerId: seeded.ownerId,
          },
          {
            startDate: WINDOW_START.toISOString(),
            endDate: WINDOW_END.toISOString(),
            viewerScope: AgentSessionViewerScope.Self,
          },
          SESSIONS_SURFACE_DATE_FIELD
        );
        return await withDb((db) => db.sessionDetail.count({ where }));
      });

      // The owner's two in-window-by-activity rows, without the colleague's.
      expect(listCount).toBe(2);
    });
  }
);

/** ISS-10541 retired the second cohort: a context can no longer ask for the
 *  other basis, so these carry only scope. */
function meContext(seeded: Seeded): InsightsScopeContext {
  return {
    organizationId: seeded.organizationId,
    userId: seeded.ownerId,
    scope: InsightsScope.Me,
  };
}

function orgContext(seeded: Seeded): InsightsScopeContext {
  return {
    organizationId: seeded.organizationId,
    userId: seeded.ownerId,
    scope: InsightsScope.Org,
  };
}

/**
 * Seed the corpus plus a second organization, read, and roll it all back.
 * `futureLastActivityAt` adds one more owner session last active then.
 */
function withCorpus<T>(
  read: (seeded: Seeded) => Promise<T>,
  futureLastActivityAt?: Date
): Promise<T> {
  return autoRollbackTransaction(async () => {
    const seeded = await seedCorpus(futureLastActivityAt);
    // A second organization holding an in-window session of its own. Without
    // it, a rollup that dropped `a.organization_id` entirely would still return
    // the expected numbers.
    await seedCorpus();
    return await read(seeded);
  });
}

async function seedCorpus(futureLastActivityAt?: Date): Promise<Seeded> {
  const organizationId = await createTestOrganization();
  const owner = await createTestUser(organizationId, {
    email: OWNER_EMAIL,
    firstName: null,
    lastName: null,
  });
  const colleague = await createTestUser(organizationId, {
    email: COLLEAGUE_EMAIL,
    firstName: null,
    lastName: null,
  });

  await withDb(async (db) => {
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: owner.id,
        machineName: `session-rollup-${organizationId}`,
        platform: "darwin",
      },
      select: { id: true },
    });

    const createSession = async (
      userId: string,
      label: string,
      startedAt: Date,
      lastActivityAt: Date
    ) => {
      // Created by the recording user, as the ingest create arm sets it; the
      // Me scope matches Created by (ISS-12251 D-4).
      const artifact = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.SESSION,
          name: `session-rollup-${label}`,
          status: SESSION_STATUS.INACTIVE,
          createdById: userId,
        },
        select: { id: true },
      });
      await db.sessionDetail.create({
        data: {
          artifactId: artifact.id,
          computeTargetId: computeTarget.id,
          externalSessionId: `session-rollup-ext-${artifact.id}`,
          harness: "claude",
          sessionStartedAt: startedAt,
          sessionUpdatedAt: lastActivityAt,
          lastActivityAt,
          // One dollar each, so `sumSessionCost` prices a whole number of rows
          // and the boundary case below reads as a ROW COUNT rather than as an
          // arithmetic coincidence.
          estimatedCost: SESSION_COST_USD,
        },
        select: { artifactId: true },
      });
    };

    await createSession(owner.id, OWNER_IN_WINDOW, IN_WINDOW, IN_WINDOW);
    await createSession(
      owner.id,
      OWNER_STARTED_BEFORE,
      BEFORE_WINDOW,
      LATE_IN_WINDOW
    );
    await createSession(
      owner.id,
      OWNER_FULLY_OUTSIDE,
      BEFORE_WINDOW,
      BEFORE_WINDOW
    );
    await createSession(
      colleague.id,
      COLLEAGUE_IN_WINDOW,
      IN_WINDOW,
      IN_WINDOW
    );
    if (futureLastActivityAt) {
      await createSession(
        owner.id,
        OWNER_FUTURE_ACTIVITY,
        futureLastActivityAt,
        futureLastActivityAt
      );
    }
  });

  return { organizationId, ownerId: owner.id };
}

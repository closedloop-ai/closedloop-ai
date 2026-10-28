import { randomUUID } from "node:crypto";
import { InsightsScope } from "@repo/api/src/types/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { analyzeOnSeedingConnection } from "@/__tests__/utils/fixture-db";
import type { InsightsScopeContext } from "@/app/insights/service/scope";
import { fetchUserBreakdown } from "@/app/insights/service/session-queries";

/**
 * ISS-8052 — `fetchUserBreakdown` has a TOTAL order, not just `n DESC`.
 *
 * Two users with the same session count used to fall through to the arrival
 * order of an unordered `GROUP BY`, and that order decides two different things.
 * The visible one is the chart's bar order, which reaches the byte-compared
 * Layer 5.3 fixture. The one that actually loses data is the `LIMIT 50`: at the
 * cut line, an undefined tiebreak decides WHICH tied users appear at all, so the
 * same org could drop a different person from the chart on two reads.
 *
 * WHY THIS FILE EXISTS AT ALL. Nothing already in the repo can fail on that
 * revert. `service.test.ts` drives this query through a fake `$queryRaw` whose
 * fixture holds one row, and the golden corpus ingests into ONE org / ONE user
 * by construction — so the fixture whose byte compare motivates the fix is
 * structurally unable to observe it. A tie needs a second user, and a second
 * user needs a real database.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T00:00:00.000Z");
const IN_WINDOW = new Date("2026-06-10T12:00:00.000Z");
const OUT_OF_WINDOW = new Date("2026-01-15T12:00:00.000Z");

/**
 * SIX users tied on the same count, seeded in DESCENDING email order so the
 * physical row order is the reverse of the contract.
 *
 * Six rather than two, and this is the whole reason the fixture is shaped this
 * way: an unordered `GROUP BY` emits the tied users in hash-bucket order, which
 * varies run to run — measured flipping between two consecutive runs of this
 * very suite. With two tied users a reverted tiebreak is a coin flip and the
 * test catches the bug half the time, which is not evidence of anything. With
 * six there are 720 arrangements and exactly one of them is ascending.
 */
const TIED_EMAILS = [
  "zoe.tied@example.test",
  "yara.tied@example.test",
  "quinn.tied@example.test",
  "iris.tied@example.test",
  "dana.tied@example.test",
  "alice.tied@example.test",
];
/** Sorted HERE, not read back from the query it polices. */
const TIED_EMAILS_ASCENDING = [...TIED_EMAILS].sort();
const BUSIEST_EMAIL = "mid.busiest@example.test";

const TIED_SESSIONS = 2;
const BUSIEST_SESSIONS = 5;

/**
 * THE `LIMIT 50` CUTOFF — where a missing tiebreak stops rearranging bars and
 * starts dropping people (whitlockk, PR #6008).
 *
 * The ordering case above seeds seven users, so every one of them clears the
 * limit and the query returns the same SET however it sorts; revert the
 * tiebreak there and only the ARRANGEMENT moves. This corpus puts 51 users on
 * one count so the limit cuts THROUGH the tie, and `u.email ASC` now decides
 * MEMBERSHIP — who is rendered at all — which is the loss the fix is for.
 *
 * ONE TIEBREAK IS TESTABLE HERE, NOT TWO, and that is a property of the schema
 * rather than a gap in the fixture. Making `s.user_id ASC` decide anything
 * needs two users tied on `u.email`, and `users_organization_id_email_key`
 * (a raw-migration UNIQUE on `(organization_id, email)`, invisible in
 * schema.prisma) forbids exactly that. `fetchUserBreakdown` is org-scoped, so
 * within one read `u.email` is already total and `s.user_id ASC` is
 * unreachable defence — it cannot change an answer, and no corpus can make it.
 * Deleting either tiebreak still has to turn this red; only the email one can
 * be shown to.
 *
 * 51 for 50 rather than a two-way tie, for the reason the tied block above
 * gives: a coin flip that catches the bug half the time is not evidence. With
 * the tiebreak gone the survivors are whichever 50 rows the plan emits first
 * out of 51, in the plan's own order.
 */
const CUTOFF_LIMIT = 50;
const CUTOFF_USERS = 51;
const CUTOFF_SESSIONS = 1;
/** Zero-padded so the string order IS the numeric order; sorted here anyway. */
const CUTOFF_EMAILS_ASCENDING = Array.from(
  { length: CUTOFF_USERS },
  (_, index) => `cut-${String(index).padStart(2, "0")}@example.test`
).sort();
/** The one user the cutoff must drop: highest email, so last on the contract. */
const CUTOFF_DROPPED_EMAIL = CUTOFF_EMAILS_ASCENDING.at(-1);
const CUTOFF_OWNER_EMAIL = "cut-owner@example.test";

describeIfDb("fetchUserBreakdown ordering (ISS-8052)", () => {
  it("breaks an equal session count on the email, ascending", async () => {
    const buckets = await withCorpus((ctx) =>
      fetchUserBreakdown(ctx, WINDOW_START, WINDOW_END)
    );

    // Count first, email second. The busiest user is what stops an email-first
    // comparator from satisfying the tie while destroying the ranking: sorted by
    // email alone `mid.busiest` would land in the middle of the tied block
    // rather than at the front.
    expect(buckets.map((bucket) => bucket.value)).toEqual([
      BUSIEST_SESSIONS,
      ...TIED_EMAILS.map(() => TIED_SESSIONS),
    ]);
    expect(buckets.map((bucket) => bucket.label)).toEqual([
      BUSIEST_EMAIL,
      ...TIED_EMAILS_ASCENDING,
    ]);
  });

  it("counts only in-window sessions and excludes another organization's", async () => {
    // The positive sibling to the ordering case: an ORDER BY that also lost the
    // date bound or the org predicate would still emit three correctly-ordered
    // buckets, just with the wrong numbers in them. Each user also owns one
    // session outside the window, and a second org seeds the same three users'
    // worth of sessions in the same window.
    const scoped = await autoRollbackTransaction(async () => {
      const ctx = await seedCorpus();
      await seedCorpus();
      return await fetchUserBreakdown(ctx, WINDOW_START, WINDOW_END);
    });

    expect(scoped).toHaveLength(TIED_EMAILS.length + 1);
    expect(scoped.map((bucket) => bucket.value)).toEqual([
      BUSIEST_SESSIONS,
      ...TIED_EMAILS.map(() => TIED_SESSIONS),
    ]);
  });

  it("pins which tied user the 50-row cutoff drops", async () => {
    const buckets = await autoRollbackTransaction(async () => {
      const ctx = await seedCutoffCorpus();
      return await fetchUserBreakdown(ctx, WINDOW_START, WINDOW_END);
    });

    // 51 seeded, 50 rendered: somebody is dropped, and WHICH somebody is the
    // whole question. Every count is equal, so only the tiebreak decides it.
    expect(buckets).toHaveLength(CUTOFF_LIMIT);
    expect(buckets.map((bucket) => bucket.value)).toEqual(
      Array.from({ length: CUTOFF_LIMIT }, () => CUTOFF_SESSIONS)
    );

    const labels = buckets.map((bucket) => bucket.label);
    // Membership AND order of the survivors, against a list sorted in the test.
    expect(labels).toEqual(CUTOFF_EMAILS_ASCENDING.slice(0, CUTOFF_LIMIT));
    // Stated separately because it is the claim the fix actually makes: the
    // person the chart omits is a fact about the data, not about the plan.
    expect(labels).not.toContain(CUTOFF_DROPPED_EMAIL);
  });
});

describeIfDb("fetchUserBreakdown person (ISS-12251 D-4)", () => {
  it("credits each session to its creator, not its recorder or its Owner", async () => {
    const { buckets, creator } = await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const [creatorUser, recorderUser, assigneeUser] = await Promise.all(
        ["creator", "recorder", "assignee"].map((role) =>
          createTestUser(organizationId, {
            email: `${role}@example.test`,
            firstName: null,
            lastName: null,
          })
        )
      );
      await withDb(async (db) => {
        const computeTarget = await db.computeTarget.create({
          data: {
            organizationId,
            userId: recorderUser.id,
            machineName: `user-breakdown-person-${organizationId}`,
            platform: "darwin",
          },
          select: { id: true },
        });
        const artifact = await db.artifact.create({
          data: {
            organizationId,
            type: ArtifactType.SESSION,
            name: "user-breakdown-person",
            status: SESSION_STATUS.INACTIVE,
            createdById: creatorUser.id,
            assigneeId: assigneeUser.id,
          },
          select: { id: true },
        });
        await db.sessionDetail.create({
          data: {
            artifactId: artifact.id,
            computeTargetId: computeTarget.id,
            externalSessionId: `user-breakdown-person-${artifact.id}`,
            harness: "claude",
            sessionStartedAt: IN_WINDOW,
            sessionUpdatedAt: IN_WINDOW,
            lastActivityAt: IN_WINDOW,
          },
          select: { artifactId: true },
        });
      });
      const ctx: InsightsScopeContext = {
        organizationId,
        userId: creatorUser.id,
        scope: InsightsScope.Org,
      };
      return {
        buckets: await fetchUserBreakdown(ctx, WINDOW_START, WINDOW_END),
        creator: creatorUser,
      };
    });

    expect(buckets).toEqual([
      { key: creator.id, label: "creator@example.test", value: 1 },
    ]);
  });
});

/** Seed a corpus, run one read against it, and roll the whole thing back. */
function withCorpus<T>(
  read: (ctx: InsightsScopeContext) => Promise<T>
): Promise<T> {
  return autoRollbackTransaction(async () => {
    const ctx = await seedCorpus();
    return await read(ctx);
  });
}

async function seedCorpus(): Promise<InsightsScopeContext> {
  const organizationId = await createTestOrganization();
  // The label is `displayUserName`, which prefers a name when one exists — these
  // users deliberately have none, so the rendered label IS the email the
  // tiebreak sorts on and the assertion reads the ordering key directly.
  const owner = await createTestUser(organizationId, {
    email: BUSIEST_EMAIL,
    firstName: null,
    lastName: null,
  });
  const tied: Awaited<ReturnType<typeof createTestUser>>[] = [];
  for (const email of TIED_EMAILS) {
    tied.push(
      await createTestUser(organizationId, {
        email,
        firstName: null,
        lastName: null,
      })
    );
  }

  await withDb(async (db) => {
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: owner.id,
        machineName: `user-breakdown-${organizationId}`,
        platform: "darwin",
      },
      select: { id: true },
    });

    const createSession = async (
      userId: string,
      startedAt: Date,
      label: string
    ) => {
      // Created by the recording user, as the ingest create arm sets it.
      const artifact = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.SESSION,
          name: `user-breakdown-session-${label}`,
          status: SESSION_STATUS.INACTIVE,
          createdById: userId,
        },
        select: { id: true },
      });
      await db.sessionDetail.create({
        data: {
          artifactId: artifact.id,
          computeTargetId: computeTarget.id,
          externalSessionId: `user-breakdown-ext-${artifact.id}`,
          harness: "claude",
          sessionStartedAt: startedAt,
          sessionUpdatedAt: startedAt,
          lastActivityAt: startedAt,
        },
        select: { artifactId: true },
      });
    };

    // Tied users first, highest email first — the reverse of the contract on
    // both axes.
    for (const [index, user] of [...tied, owner].entries()) {
      const sessions = user.id === owner.id ? BUSIEST_SESSIONS : TIED_SESSIONS;
      for (let n = 0; n < sessions; n++) {
        await createSession(user.id, IN_WINDOW, `${index}-${n}`);
      }
      await createSession(user.id, OUT_OF_WINDOW, `${index}-outside`);
    }
  });

  // The planner's strategy decides the arrival order of an unordered GROUP BY,
  // and it costs that from statistics — see the sibling
  // `token-queries.integration.test.ts` docstring for why this is load-bearing
  // rather than hygiene.
  await analyzeSeededTables();

  return { organizationId, userId: owner.id, scope: InsightsScope.Org };
}

/**
 * 51 users on one session each, one more than the `LIMIT 50`, so the cut lands
 * inside the tie. Batched through `createMany` rather than the per-row helper
 * above because this corpus is an order of magnitude bigger and the row VALUES,
 * not the insert path, are what it tests.
 */
async function seedCutoffCorpus(): Promise<InsightsScopeContext> {
  const organizationId = await createTestOrganization();
  // Owns the compute target and anchors the scope context; deliberately given
  // no sessions, so it never reaches the breakdown and never shifts the cut.
  const owner = await createTestUser(organizationId, {
    email: CUTOFF_OWNER_EMAIL,
    firstName: null,
    lastName: null,
  });

  // Inserted descending, the reverse of the contract, so no arrival order the
  // planner might preserve agrees with the expected answer.
  const seedOrder = [...CUTOFF_EMAILS_ASCENDING]
    .reverse()
    .map((email) => ({ id: randomUUID(), email }));

  await withDb(async (db) => {
    await db.user.createMany({
      data: seedOrder.map(({ id, email }) => ({
        id,
        organizationId,
        clerkId: `clerk_test_user_${id}`,
        email,
        firstName: null,
        lastName: null,
      })),
    });

    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: owner.id,
        machineName: `user-breakdown-cutoff-${organizationId}`,
        platform: "darwin",
      },
      select: { id: true },
    });

    const sessions = seedOrder.flatMap(({ id }) =>
      Array.from({ length: CUTOFF_SESSIONS }, () => ({
        artifactId: randomUUID(),
        userId: id,
      }))
    );

    await db.artifact.createMany({
      data: sessions.map(({ artifactId, userId }) => ({
        id: artifactId,
        organizationId,
        type: ArtifactType.SESSION,
        name: `user-breakdown-cutoff-session-${artifactId}`,
        status: SESSION_STATUS.INACTIVE,
        createdById: userId,
      })),
    });
    await db.sessionDetail.createMany({
      data: sessions.map(({ artifactId }) => ({
        artifactId,
        computeTargetId: computeTarget.id,
        externalSessionId: `user-breakdown-cutoff-ext-${artifactId}`,
        harness: "claude",
        sessionStartedAt: IN_WINDOW,
        sessionUpdatedAt: IN_WINDOW,
        lastActivityAt: IN_WINDOW,
      })),
    });
  });

  await analyzeSeededTables();

  return { organizationId, userId: owner.id, scope: InsightsScope.Org };
}

/** The tables both corpora seed, and the ones the GROUP BY order is costed from. */
const SEEDED_TABLES = ["session_detail", "artifacts", "users"] as const;

/**
 * Fresh statistics for the corpus, on the connection that holds it.
 *
 * Both corpora seed inside `autoRollbackTransaction`, so nothing is committed
 * and the ISS-5978 fixture connection would gather statistics from a table that
 * is, to it, still unseeded. `analyzeOnSeedingConnection` is what keeps that
 * constraint from quietly costing the split's silent ANALYZE skip instead.
 */
function analyzeSeededTables(): Promise<void> {
  return withDb((db) =>
    analyzeOnSeedingConnection(db, SEEDED_TABLES, "the ISS-8052 user breakdown")
  );
}

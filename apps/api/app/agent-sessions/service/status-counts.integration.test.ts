import {
  AGENT_SESSION_COUNTED_STATUSES,
  type AgentSessionStatusCountsResponse,
} from "@repo/api/src/types/agent-session-status-counts";
import {
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "../service";
import { buildAgentSessionStatusCounts } from "./status-counts";

/**
 * ISS-8858 AC3/AC5 against real Postgres: the status counts and the list they
 * summarise describe the SAME population.
 *
 * The unit suite next door executes the predicate against a seeded fake, which
 * proves the clause admits the rows it should. It cannot prove the other half —
 * that `count(where AND status-clause)` and the paged read of the same filters
 * return the same number — because the fake answers both from one evaluator and
 * so agrees with itself by construction. Only a real database, running the real
 * `findSessions` beside the real counts read, can disagree.
 *
 * Every timestamp is relative to NOW rather than pinned. ISS-10629 took the
 * staleness cutoff out of this endpoint's predicate, but the date-window case
 * below still slices the seed on a relative boundary, and the rows are real
 * writes, so fake timers are not an option here.
 *
 * Seeds are COMMITTED and torn down by
 * `createCommittedTestOrganizationTracker`, not wrapped in
 * `autoRollbackTransaction`. Both reads under test open their own transaction
 * boundary at an explicit isolation level — `withStatusCountsSnapshot` and
 * `withSessionListSnapshot` each ask `withDb.tx` for `RepeatableRead` — and
 * `withDb.tx` fails closed rather than joining an ambient transaction it cannot
 * prove is that strong (ISS-4669). A rollback wrapper would therefore make this
 * suite throw before it asserted anything, and, were the guard ever relaxed,
 * would silently downgrade the very snapshot these cases exist to exercise.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const MINUTE_MS = 60_000;
/** A status no producer writes and the display fold does not recognize. */
const UNRECOGNIZED_STATUS = "future-spelling-from-a-newer-producer";

describeIfDb("Sessions status counts against real Postgres (ISS-8858)", () => {
  it("returns, for every displayed status, exactly what the list read returns for that status", async () => {
    const { organizationId } = await seedDisplayedStatusPopulation();

    const counts = await buildAgentSessionStatusCounts(
      scopedInput(organizationId)
    );

    // AC3, counted BOTH ways: the bucket, and the `total` the paged list read
    // reports for the same filters plus that one status. Two independent
    // queries over two independently composed predicates.
    for (const status of AGENT_SESSION_COUNTED_STATUSES) {
      const list = await agentSessionsService.findSessions({
        ...scopedInput(organizationId),
        filters: { quality: "all", statuses: [status] },
      });
      expect(
        counts.countsByStatus[status],
        `count for "${status}" must equal the list total for the same filters`
      ).toBe(list.total);
    }
  });

  it("buckets its population on the persisted column, and never past its own total", async () => {
    const { organizationId } = await seedDisplayedStatusPopulation();

    const counts = await buildAgentSessionStatusCounts(
      scopedInput(organizationId)
    );

    // EXPECTATION CHANGED, not weakened. ISS-10629 moved this endpoint off the
    // display projection and onto equality against `artifacts.status`, so five
    // of the eight seeded rows land in `active`: the plain one, the one
    // awaiting input, the stale one, and BOTH reconciled ones. Each of those
    // stores `active`; only their badges differ, and the badge is not what this
    // reads any more. ISS-10364 retired the three display-only keys this used
    // to also assert as `null` — the response now has exactly the three
    // lifecycle keys, every one a real count.
    expect(counts.countsByStatus).toEqual({
      [SESSION_STATUS.ACTIVE]: 5,
      [SESSION_STATUS.INACTIVE]: 1,
      [SESSION_STATUS.ERROR]: 1,
    });
    expect(counts.total).toBe(8);
    // The buckets no longer partition `total`, and this is the case that says
    // so out loud. `total` is the status-free population, which includes the
    // row storing UNRECOGNIZED_STATUS — a value no bucket names, because no
    // filter can select it either. The shortfall is exactly that one row, and
    // pinning it as an equality is what keeps this able to fail: a
    // `toBeLessThanOrEqual` alone stays green when a bucket silently drops rows.
    expect(sumBuckets(counts)).toBe(counts.total - 1);
    // A bucket larger than its own parent population is the defect class this
    // repo tracks; assert it directly rather than inferring it from the sum.
    for (const count of Object.values(counts.countsByStatus)) {
      expect(count).toBeLessThanOrEqual(counts.total);
    }
  });

  it("never lets a narrower filter increase a count", async () => {
    const { organizationId } = await seedDisplayedStatusPopulation();

    const wide = await buildAgentSessionStatusCounts(
      scopedInput(organizationId)
    );
    // Narrower by exactly one seeded row: the Stale row's activity anchor sits
    // outside this window and every other row's sits inside it.
    const narrow = await buildAgentSessionStatusCounts({
      ...scopedInput(organizationId),
      filters: {
        quality: "all",
        startDate: new Date(Date.now() - 60 * MINUTE_MS).toISOString(),
      },
    });

    expect(narrow.total).toBeLessThan(wide.total);
    for (const status of AGENT_SESSION_COUNTED_STATUSES) {
      expect(
        narrow.countsByStatus[status],
        `narrowing must not grow the "${status}" bucket`
      ).toBeLessThanOrEqual(wide.countsByStatus[status]);
    }
    // Same shortfall as the wide read: the UNRECOGNIZED_STATUS row is inside
    // the window and inside `total`, and in no bucket.
    expect(sumBuckets(narrow)).toBe(narrow.total - 1);
  });

  it("counts no session belonging to another organization", async () => {
    const { organizationId } = await seedDisplayedStatusPopulation();
    const foreign = await seedOrgWithOwner();
    await createTestSessionDetail({
      organizationId: foreign.organizationId,
      userId: foreign.userId,
      label: "foreign-active",
      sessionTimestamp: new Date(),
    });

    const counts = await buildAgentSessionStatusCounts(
      scopedInput(organizationId)
    );
    // The counterfactual: the foreign row is real and IS counted — by its own
    // org. So an unchanged `total` above is the org predicate doing work, not
    // an empty second organization.
    const foreignCounts = await buildAgentSessionStatusCounts(
      scopedInput(foreign.organizationId)
    );

    expect(counts.total).toBe(8);
    expect(counts.countsByStatus[SESSION_STATUS.ACTIVE]).toBe(5);
    expect(foreignCounts.total).toBe(1);
    expect(foreignCounts.countsByStatus[SESSION_STATUS.ACTIVE]).toBe(1);
  });
});

/**
 * Sum of the buckets. ISS-10629 had to skip the `null` display-only buckets
 * rather than coerce them to 0; ISS-10364 retired those keys, so every bucket
 * is a real count and the sum is over all of them.
 */
function sumBuckets(counts: AgentSessionStatusCountsResponse): number {
  return Object.values(counts.countsByStatus).reduce(
    (total, count) => total + count,
    0
  );
}

/** The counts input every case shares: org-scoped and quality-neutral. */
function scopedInput(organizationId: string) {
  return {
    organizationId,
    filters: { quality: "all" as const },
  };
}

async function seedOrgWithOwner(): Promise<{
  organizationId: string;
  userId: string;
}> {
  const organizationId = await committedOrganizations.create();
  const owner = await createTestUser(organizationId);
  return { organizationId, userId: owner.id };
}

/**
 * One row per terminal status, plus a stored `active` beside an end nothing
 * followed — the shape that used to display a terminal value without storing
 * one, and that must now be counted under Active.
 *
 * ISS-10629 did not shrink this seed. The population is deliberately still the
 * full displayed spread, because what the cases now assert is that the counts
 * bucket it by the STORED column — a seed holding only stored-vocabulary rows
 * could not tell that apart from the projection it replaced.
 */
async function seedDisplayedStatusPopulation(): Promise<{
  organizationId: string;
  userId: string;
}> {
  const owner = await seedOrgWithOwner();
  const now = Date.now();
  const fresh = new Date(now - MINUTE_MS);
  const staleAnchor = new Date(
    now - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS + 1) * 60 * MINUTE_MS
  );
  const seed = (
    label: string,
    row: Parameters<typeof createTestSessionDetail>[0] extends infer T
      ? Omit<T, "organizationId" | "userId" | "label">
      : never
  ) => createTestSessionDetail({ ...owner, label, ...row });

  await seed("active", { sessionTimestamp: fresh });
  await seed("waiting", {
    sessionTimestamp: fresh,
    awaitingInputSince: new Date(now - 30 * MINUTE_MS),
  });
  await seed("stale", {
    sessionTimestamp: staleAnchor,
    lastActivityAt: staleAnchor,
  });
  await seed("inactive", {
    sessionTimestamp: fresh,
    status: SESSION_STATUS.INACTIVE,
  });
  await seed("error", {
    sessionTimestamp: fresh,
    status: SESSION_STATUS.ERROR,
  });
  // Stored `active`, ended, and never active again: displays the terminal state
  // the run reached, chosen by `endsWithError`.
  await seed("reconciled-inactive", {
    sessionTimestamp: new Date(now - 3 * MINUTE_MS),
    lastActivityAt: new Date(now - 3 * MINUTE_MS),
    sessionEndedAt: new Date(now - 2 * MINUTE_MS),
    endsWithError: false,
  });
  await seed("reconciled-error", {
    sessionTimestamp: new Date(now - 3 * MINUTE_MS),
    lastActivityAt: new Date(now - 3 * MINUTE_MS),
    sessionEndedAt: new Date(now - 2 * MINUTE_MS),
    endsWithError: true,
  });
  await seed("unknown", {
    sessionTimestamp: fresh,
    status: UNRECOGNIZED_STATUS,
  });
  return owner;
}

/**
 * ISS-12251 (PLN-2176 T-3.2) — the typed-SQL person split, EXECUTED.
 *
 * The Owner (`ownerUserIds`, $4 — the `userIds` facet intersected with the
 * singular `userId` deep link, per the operator ruling of 2026-10-13) matches
 * `artifacts.assignee_id`; the `viewerScope=self` scope (`creatorUserIds`, $25)
 * matches `artifacts.created_by_id`. The fixture keeps the three
 * people apart: each session's recording user (`compute_targets.user_id`) is a
 * third person, one session is owned by A and created by C, the other owned by
 * C and created by A. So swapping the two predicates, or keying either on the
 * recording user, changes every answer below. The three carry names
 * that sort A < recorder < C, so the Owner sort (assignee, AC-006) and the team
 * scope (Created by, AC-005) each answer differently on every wrong column.
 */

import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import {
  readSessionListPageByCompoundSort,
  readSessionListPageByDuration,
  readSessionListPageByUpdated,
  readSessionListPageByUser,
} from "@/app/agent-sessions/service/session-list-sql-reader";
import {
  EMPTY_USAGE_SQL_FACETS,
  readCostSplit,
  readFacetCounts,
  readLocCoverageCounts,
  readMergedPrLoc,
  readUsageTotals,
} from "@/app/agent-sessions/service/usage-sql-reader";
import type {
  AgentSessionListQuery,
  AgentSessionSortRule,
} from "@/app/agent-sessions/validators";
import {
  CREATED_BY_A_COST,
  OWNED_BY_A_COST,
  type OwnerCreatorFixture,
  seedOwnerCreatorSplit,
} from "./session-owner-creator.test-fixtures";
import { arm, wholeOrg } from "./usage-typed-sql-statements.test-helpers";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const organizations = createCommittedTestOrganizationTracker();

async function listPages(
  fixture: OwnerCreatorFixture,
  filters: AgentSessionListQuery,
  viewerId?: string
): Promise<string[][]> {
  const input = { organizationId: fixture.organizationId, viewerId, filters };
  const pages = await Promise.all([
    readSessionListPageByUpdated(input, "desc", 0, 10),
    readSessionListPageByUser(input, "desc", 0, 10),
    readSessionListPageByDuration(input, "desc", 0, 10),
  ]);
  return pages.map((page) => page.map((row) => row.id));
}

describeIfDb("typed SQL Owner and Created by scopes (ISS-12251)", () => {
  afterEach(async () => {
    await organizations.cleanup();
  });

  it("matches the Owner facet against the assignee in every summary statement", async () => {
    const fixture = await seedOwnerCreatorSplit(organizations);
    const window = wholeOrg(fixture.organizationId);
    const facets = {
      ...EMPTY_USAGE_SQL_FACETS,
      ownerUserIds: [fixture.personA],
    };

    const totals = await readUsageTotals(window, facets);
    expect(totals.sessionCount).toBe(1);
    expect(totals.estimatedCost).toBeCloseTo(OWNED_BY_A_COST, 6);

    const split = await readCostSplit(window, facets);
    expect(split.unclassifiedCost).toBeCloseTo(OWNED_BY_A_COST, 6);

    expect((await readMergedPrLoc(window, facets)).mergedPrCount).toBe(1);
    expect(
      (await readLocCoverageCounts(window, facets)).numeratorSessionCount
    ).toBe(1);

    const harness = arm(await readFacetCounts(window, facets), "harness");
    expect(harness.map((row) => row.sessionCount)).toEqual([1]);
  });

  it("matches the creator scope against Created by in every summary statement", async () => {
    const fixture = await seedOwnerCreatorSplit(organizations);
    const window = wholeOrg(fixture.organizationId);
    const facets = {
      ...EMPTY_USAGE_SQL_FACETS,
      creatorUserIds: [fixture.personA],
    };

    const totals = await readUsageTotals(window, facets);
    expect(totals.sessionCount).toBe(1);
    expect(totals.estimatedCost).toBeCloseTo(CREATED_BY_A_COST, 6);

    const split = await readCostSplit(window, facets);
    expect(split.unclassifiedCost).toBeCloseTo(CREATED_BY_A_COST, 6);

    expect((await readMergedPrLoc(window, facets)).mergedPrCount).toBe(0);
    expect(
      (await readLocCoverageCounts(window, facets)).numeratorSessionCount
    ).toBe(0);

    // A plain conjunct, so it narrows the Owner arm too: A's one session is
    // owned by C.
    const owner = arm(await readFacetCounts(window, facets), "owner");
    expect(owner.map((row) => [row.value, row.sessionCount])).toEqual([
      [fixture.personC, 1],
    ]);
  });

  it("scopes every list page: userIds and the userId deep link by Owner, self by Created by", async () => {
    const fixture = await seedOwnerCreatorSplit(organizations);

    expect(await listPages(fixture, { userIds: [fixture.personA] })).toEqual([
      [fixture.ownedByA],
      [fixture.ownedByA],
      [fixture.ownedByA],
    ]);
    expect(
      await listPages(
        fixture,
        { viewerScope: AgentSessionViewerScope.Self },
        fixture.personA
      )
    ).toEqual([
      [fixture.createdByA],
      [fixture.createdByA],
      [fixture.createdByA],
    ]);
    expect(await listPages(fixture, { userId: fixture.personA })).toEqual([
      [fixture.ownedByA],
      [fixture.ownedByA],
      [fixture.ownedByA],
    ]);
    expect(
      await listPages(fixture, {
        userId: fixture.personA,
        userIds: [fixture.personC],
      })
    ).toEqual([[], [], []]);
  });

  it("ANDs a self scope with the Owner facet instead of letting either widen the other", async () => {
    const fixture = await seedOwnerCreatorSplit(organizations);
    // A's own sessions (created by A) that C owns: exactly one.
    expect(
      await listPages(
        fixture,
        {
          viewerScope: AgentSessionViewerScope.Self,
          userIds: [fixture.personC],
        },
        fixture.personA
      )
    ).toEqual([
      [fixture.createdByA],
      [fixture.createdByA],
      [fixture.createdByA],
    ]);
    // A's own sessions that A owns: none.
    expect(
      await listPages(
        fixture,
        {
          viewerScope: AgentSessionViewerScope.Self,
          userIds: [fixture.personA],
        },
        fixture.personA
      )
    ).toEqual([[], [], []]);
  });

  it("orders the Owner sort by the assignee's name, single-rule and compound", async () => {
    const fixture = await seedOwnerCreatorSplit(organizations);
    const input = { organizationId: fixture.organizationId, filters: {} };
    const byOwner = (dir: "asc" | "desc"): AgentSessionSortRule[] => [
      { column: "user", dir },
      { column: "repo", dir: "asc" },
    ];
    const ids = (page: { id: string }[]) => page.map((row) => row.id);
    const assigneeAsc = [fixture.ownedByA, fixture.createdByA];
    const assigneeDesc = [fixture.createdByA, fixture.ownedByA];

    expect(ids(await readSessionListPageByUser(input, "asc", 0, 10))).toEqual(
      assigneeAsc
    );
    expect(ids(await readSessionListPageByUser(input, "desc", 0, 10))).toEqual(
      assigneeDesc
    );
    expect(
      ids(await readSessionListPageByCompoundSort(input, byOwner("asc"), 0, 10))
    ).toEqual(assigneeAsc);
    expect(
      ids(
        await readSessionListPageByCompoundSort(input, byOwner("desc"), 0, 10)
      )
    ).toEqual(assigneeDesc);
  });

  it("matches the team scope against Created by, on the list pages and the summary", async () => {
    const fixture = await seedOwnerCreatorSplit(organizations);
    const teamId = await withDb(async (db) => {
      const team = await db.team.create({
        data: {
          organizationId: fixture.organizationId,
          name: "ISS-12251 team",
          slug: "iss-12251-team",
          members: { create: { userId: fixture.personA } },
        },
        select: { id: true },
      });
      return team.id;
    });

    expect(await listPages(fixture, { teamId })).toEqual([
      [fixture.createdByA],
      [fixture.createdByA],
      [fixture.createdByA],
    ]);
    const totals = await readUsageTotals(wholeOrg(fixture.organizationId), {
      ...EMPTY_USAGE_SQL_FACETS,
      teamId,
    });
    expect(totals.sessionCount).toBe(1);
    expect(totals.estimatedCost).toBeCloseTo(CREATED_BY_A_COST, 6);
  });
});

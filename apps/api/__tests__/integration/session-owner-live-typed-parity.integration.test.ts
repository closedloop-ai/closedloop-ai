/**
 * ISS-12251 (PLN-2176 T-3.1) — the LIVE Prisma path against the typed-SQL
 * candidate its shadows compare it with, on the person split.
 *
 * Both person filters are the Owner, the assignee — the `userIds` facet and
 * the singular `userId` deep link, intersected (operator ruling, Kerensa Whitlock
 * 2026-10-13: "If the UI says owner, it should filter by owner. The owner is
 * the assignee."). This pins the live list and usage reads to the typed-SQL
 * answers on a fixture whose assignee, creator and recorder are three different
 * people, so a shadow comparison of an Owner-filtered or Owner-sorted request
 * finds no divergence and a filter on the wrong column changes the answer.
 *
 * PLN-2176 T-3.3: self and team scope are "whose session" scopes and match
 * Created by (`artifacts.created_by_id`, D-4) on both paths.
 */

import {
  type AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
} from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { readSessionListPageByUser } from "@/app/agent-sessions/service/session-list-sql-reader";
import { buildUsageSummaryFromSql } from "@/app/agent-sessions/service/usage-summary-sql";
import type {
  AgentSessionListQuery,
  AgentSessionUsageQuery,
} from "@/app/agent-sessions/validators";
import {
  CREATED_BY_A_COST,
  OWNED_BY_A_COST,
  type OwnerCreatorFixture,
  seedOwnerCreatorSplit,
} from "./session-owner-creator.test-fixtures";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const organizations = createCommittedTestOrganizationTracker();

async function liveIds(
  fixture: OwnerCreatorFixture,
  filters: AgentSessionListQuery,
  viewerId?: string
): Promise<string[]> {
  const page = await agentSessionsService.findSessions({
    organizationId: fixture.organizationId,
    filters,
    viewerId,
  });
  return page.items.map((item) => item.id);
}

async function typedIds(
  fixture: OwnerCreatorFixture,
  filters: AgentSessionListQuery,
  dir: "asc" | "desc",
  viewerId?: string
): Promise<string[]> {
  const page = await readSessionListPageByUser(
    { organizationId: fixture.organizationId, filters, viewerId },
    dir,
    0,
    10
  );
  return page.map((row) => row.id);
}

/** A team whose only member is `userId`. */
function createTeamOf(organizationId: string, userId: string): Promise<string> {
  return withDb(async (db) => {
    const team = await db.team.create({
      data: { organizationId, name: "Team A", slug: `team-a-${userId}` },
      select: { id: true },
    });
    await db.teamMember.create({
      data: { teamId: team.id, userId },
      select: { id: true },
    });
    return team.id;
  });
}

function ownerBreakdown(summary: AgentSessionUsageSummary) {
  return summary.byUser.map((row) => ({
    userId: row.userId,
    sessionCount: row.sessionCount,
    estimatedCost: row.estimatedCost,
  }));
}

describeIfDb(
  "live and typed Sessions reads agree on Owner and Created by (ISS-12251)",
  () => {
    afterEach(async () => {
      await organizations.cleanup();
    });

    it("filters the Owner facet by the assignee on both paths", async () => {
      const fixture = await seedOwnerCreatorSplit(organizations);
      const filters = { userIds: [fixture.personA] };

      expect(await liveIds(fixture, filters)).toEqual([fixture.ownedByA]);
      expect(await typedIds(fixture, filters, "desc")).toEqual([
        fixture.ownedByA,
      ]);
    });

    it("scopes the userId deep link by the assignee on both paths, intersected with the Owner facet", async () => {
      const fixture = await seedOwnerCreatorSplit(organizations);
      const deepLink = { userId: fixture.personA };
      expect(await liveIds(fixture, deepLink)).toEqual([fixture.ownedByA]);
      expect(await typedIds(fixture, deepLink, "desc")).toEqual([
        fixture.ownedByA,
      ]);

      // A in the facet: A's one session. A outside the facet: nothing.
      const withA = {
        userId: fixture.personA,
        userIds: [fixture.personA, fixture.personC],
      };
      expect(await liveIds(fixture, withA)).toEqual([fixture.ownedByA]);
      expect(await typedIds(fixture, withA, "desc")).toEqual([
        fixture.ownedByA,
      ]);
      const withoutA = { userId: fixture.personA, userIds: [fixture.personC] };
      expect(await liveIds(fixture, withoutA)).toEqual([]);
      expect(await typedIds(fixture, withoutA, "desc")).toEqual([]);
    });

    it("keeps the userId deep link on the per-owner breakdown on both paths, even when the Owner facet names someone else", async () => {
      const fixture = await seedOwnerCreatorSplit(organizations);
      const expected = [
        {
          userId: fixture.personA,
          sessionCount: 1,
          estimatedCost: OWNED_BY_A_COST,
        },
      ];
      for (const filters of [
        { userId: fixture.personA },
        { userId: fixture.personA, userIds: [fixture.personC] },
      ] satisfies AgentSessionUsageQuery[]) {
        const input = { organizationId: fixture.organizationId, filters };
        const live = await agentSessionsService.getUsageSummary(input);
        const typed = await buildUsageSummaryFromSql(input);
        expect(ownerBreakdown(live)).toEqual(expected);
        expect(ownerBreakdown(typed)).toEqual(ownerBreakdown(live));
      }
    });

    it.each([
      ["user", "asc"],
      ["user", "desc"],
      ["assignee", "asc"],
      ["assignee", "desc"],
    ] as const)(
      "orders sortBy=%s %s by the assignee's name on both paths",
      async (sortBy, sortDir) => {
        const fixture = await seedOwnerCreatorSplit(organizations);
        // Ada (A) owns one session and Cy (C) the other; both were recorded by Bo,
        // so ordering by the recorder would tie and fall to the id tiebreaker.
        const byAssignee =
          sortDir === "asc"
            ? [fixture.ownedByA, fixture.createdByA]
            : [fixture.createdByA, fixture.ownedByA];

        expect(await liveIds(fixture, { sortBy, sortDir })).toEqual(byAssignee);
        expect(
          await liveIds(fixture, { sorts: [{ column: sortBy, dir: sortDir }] })
        ).toEqual(byAssignee);
        expect(await typedIds(fixture, {}, sortDir)).toEqual(byAssignee);
      }
    );

    it("breaks per-owner usage down by the assignee on both paths", async () => {
      const fixture = await seedOwnerCreatorSplit(organizations);
      const input = {
        organizationId: fixture.organizationId,
        filters: {} satisfies AgentSessionUsageQuery,
      };
      const expected = [
        {
          userId: fixture.personA,
          sessionCount: 1,
          estimatedCost: OWNED_BY_A_COST,
        },
        {
          userId: fixture.personC,
          sessionCount: 1,
          estimatedCost: CREATED_BY_A_COST,
        },
      ].sort((left, right) => left.userId.localeCompare(right.userId));

      const live = await agentSessionsService.getUsageSummary(input);
      const typed = await buildUsageSummaryFromSql(input);
      expect(ownerBreakdown(live)).toEqual(expected);
      expect(ownerBreakdown(typed)).toEqual(ownerBreakdown(live));
    });

    it("scopes the per-owner breakdown to the filtered population, minus the Owner facet's own selection", async () => {
      const fixture = await seedOwnerCreatorSplit(organizations);
      // A second session A owns, outside the window: an Owner row summed over
      // the assignee's whole history instead of the filtered population counts it.
      await createTestSessionDetail({
        organizationId: fixture.organizationId,
        userId: fixture.personA,
        label: "owned-by-a-out-of-window",
        sessionTimestamp: new Date("2025-01-15T00:00:00Z"),
        cost: { estimatedCost: 300 },
      });
      const window = {
        startDate: "2026-05-01T00:00:00.000Z",
        endDate: "2026-05-31T23:59:59.999Z",
      };
      const expected = [
        {
          userId: fixture.personA,
          sessionCount: 1,
          estimatedCost: OWNED_BY_A_COST,
        },
        {
          userId: fixture.personC,
          sessionCount: 1,
          estimatedCost: CREATED_BY_A_COST,
        },
      ].sort((left, right) => left.userId.localeCompare(right.userId));

      // ISS-5283: the Owner facet does not filter its own list, so selecting A
      // still breaks the window down by both owners.
      for (const filters of [
        window,
        { ...window, userIds: [fixture.personA] },
      ] satisfies AgentSessionUsageQuery[]) {
        const input = { organizationId: fixture.organizationId, filters };
        const live = await agentSessionsService.getUsageSummary(input);
        const typed = await buildUsageSummaryFromSql(input);
        expect(ownerBreakdown(live)).toEqual(expected);
        expect(ownerBreakdown(typed)).toEqual(ownerBreakdown(live));
      }
    });

    it("pins viewerScope=self to Created by on both paths, ANDed with the Owner facet", async () => {
      const fixture = await seedOwnerCreatorSplit(organizations);
      const self = { viewerScope: AgentSessionViewerScope.Self };
      for (const [filters, expected] of [
        [self, [fixture.createdByA]],
        // A created the session C owns, so "mine that C owns" keeps it...
        [{ ...self, userIds: [fixture.personC] }, [fixture.createdByA]],
        // ...and "mine that I own" is empty: A owns a session C created.
        [{ ...self, userIds: [fixture.personA] }, []],
      ] satisfies [AgentSessionListQuery, string[]][]) {
        expect(await liveIds(fixture, filters, fixture.personA)).toEqual(
          expected
        );
        expect(
          await typedIds(fixture, filters, "desc", fixture.personA)
        ).toEqual(expected);
      }

      const input = {
        organizationId: fixture.organizationId,
        filters: self,
        viewerId: fixture.personA,
      };
      const live = await agentSessionsService.getUsageSummary(input);
      const typed = await buildUsageSummaryFromSql(input);
      expect(live.totalSessions).toBe(1);
      expect(live.totalEstimatedCost).toBeCloseTo(CREATED_BY_A_COST, 6);
      expect(typed.totalSessions).toBe(live.totalSessions);
      expect(typed.totalEstimatedCost).toBeCloseTo(live.totalEstimatedCost, 6);
    });

    it("scopes viewerScope=team to sessions a member created on both paths", async () => {
      const fixture = await seedOwnerCreatorSplit(organizations);
      const teamId = await createTeamOf(
        fixture.organizationId,
        fixture.personA
      );
      const filters = { viewerScope: AgentSessionViewerScope.Team, teamId };

      expect(await liveIds(fixture, filters)).toEqual([fixture.createdByA]);
      expect(await typedIds(fixture, filters, "desc")).toEqual([
        fixture.createdByA,
      ]);

      const input = { organizationId: fixture.organizationId, filters };
      const live = await agentSessionsService.getUsageSummary(input);
      const typed = await buildUsageSummaryFromSql(input);
      expect(live.totalSessions).toBe(1);
      expect(live.totalEstimatedCost).toBeCloseTo(CREATED_BY_A_COST, 6);
      expect(typed.totalSessions).toBe(live.totalSessions);
      expect(typed.totalEstimatedCost).toBeCloseTo(live.totalEstimatedCost, 6);
    });

    it("scopes the usage totals the same way on both paths", async () => {
      const fixture = await seedOwnerCreatorSplit(organizations);
      for (const filters of [
        { userIds: [fixture.personA] },
        { userId: fixture.personA },
      ] satisfies AgentSessionUsageQuery[]) {
        const input = { organizationId: fixture.organizationId, filters };
        const live = await agentSessionsService.getUsageSummary(input);
        const typed = await buildUsageSummaryFromSql(input);
        expect(live.totalSessions).toBe(1);
        expect(live.totalEstimatedCost).toBeCloseTo(OWNED_BY_A_COST, 6);
        expect(typed.totalSessions).toBe(live.totalSessions);
        expect(typed.totalEstimatedCost).toBeCloseTo(
          live.totalEstimatedCost,
          6
        );
      }
    });
  }
);

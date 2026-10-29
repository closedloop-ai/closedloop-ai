import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-7533 — two-org isolation for the two `teamsService` predicates this
 * change adds: `hasRole` and `existsInOrganization`. (`delete` is covered by
 * ISS-7535, which reduced it to one org-scoped statement on the FK cascade.)
 *
 * The five route suites under `__tests__/api/` all `vi.mock("@/app/teams/service")`,
 * so a case there that stubs a null team and asserts 404 proves only that the
 * route maps a value to a status — deleting `organizationId` from production
 * leaves every one of them green. That is the ISS-6748 shape
 * (`apps/api/AGENTS.md`), and it is why the org guarantees live here instead.
 *
 * The fake models Prisma's own semantics: **an absent `where` key constrains
 * nothing**. A fake that filtered on the caller's `organizationId` argument
 * rather than on what the service actually put in the `where` would reintroduce
 * the same false green one layer down. Note the relation-filter twist the scalar
 * precedents (`app/projects/__tests__/service-org-scoping.test.ts`) do not have:
 * these branches key on `where.team?.organizationId`, so dropping the whole
 * `team` clause is what reddens them.
 */

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

import { TeamRole } from "@repo/api/src/types/teams";
import { mockWithDbAll } from "@/__tests__/utils/db-helpers";
import { teamsService } from "../service";

const ORG_A = "org-a";
const ORG_B = "org-b";
const TEAM_IN_A = "team-in-a";
const USER = "user-1";

type TeamRow = { id: string; organizationId: string };
type MemberRow = { teamId: string; userId: string; role: TeamRole };

type TeamFilter = { organizationId?: string };
type ScalarWhere = {
  id?: string;
  organizationId?: string;
  teamId?: string;
  team?: TeamFilter;
  teamId_userId?: { teamId: string; userId: string };
};

let teams: TeamRow[];
let members: MemberRow[];

/** An absent `team` key constrains nothing — Prisma's rule, and the causal hinge. */
function teamClauseMatches(where: ScalarWhere, teamId: string): boolean {
  const wanted = where.team?.organizationId;
  if (wanted === undefined) {
    return true;
  }
  return teams.some((t) => t.id === teamId && t.organizationId === wanted);
}

function buildFakeDb() {
  return {
    team: {
      findFirst: ({ where }: { where: ScalarWhere }) => {
        const row = teams.find((t) => t.id === where.id);
        if (!row) {
          return Promise.resolve(null);
        }
        if (
          where.organizationId !== undefined &&
          where.organizationId !== row.organizationId
        ) {
          return Promise.resolve(null);
        }
        return Promise.resolve({ id: row.id });
      },
    },
    teamMember: {
      findUnique: ({ where }: { where: ScalarWhere }) => {
        const key = where.teamId_userId;
        const row = members.find(
          (m) => m.teamId === key?.teamId && m.userId === key?.userId
        );
        if (!(row && teamClauseMatches(where, row.teamId))) {
          return Promise.resolve(null);
        }
        return Promise.resolve({ role: row.role });
      },
    },
  };
}

describe("teamsService org scoping (ISS-7533)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    teams = [{ id: TEAM_IN_A, organizationId: ORG_A }];
    members = [{ teamId: TEAM_IN_A, userId: USER, role: TeamRole.Admin }];
    mockWithDbAll(buildFakeDb());
  });

  describe("hasRole", () => {
    it("grants an admin in the team's own organization", async () => {
      const allowed = await teamsService.hasRole({
        teamId: TEAM_IN_A,
        organizationId: ORG_A,
        userId: USER,
        requiredRole: TeamRole.Admin,
      });

      expect(allowed).toBe(true);
    });

    it("denies the same membership row when asked from another organization", async () => {
      const allowed = await teamsService.hasRole({
        teamId: TEAM_IN_A,
        organizationId: ORG_B,
        userId: USER,
        requiredRole: TeamRole.Admin,
      });

      expect(allowed).toBe(false);
    });

    it("still enforces the role floor inside the right organization", async () => {
      const allowed = await teamsService.hasRole({
        teamId: TEAM_IN_A,
        organizationId: ORG_A,
        userId: USER,
        requiredRole: TeamRole.Owner,
      });

      expect(allowed).toBe(false);
    });

    it("grants a lower floor to a higher role", async () => {
      const allowed = await teamsService.hasRole({
        teamId: TEAM_IN_A,
        organizationId: ORG_A,
        userId: USER,
        requiredRole: TeamRole.Member,
      });

      expect(allowed).toBe(true);
    });

    it("denies a user with no membership row", async () => {
      const allowed = await teamsService.hasRole({
        teamId: TEAM_IN_A,
        organizationId: ORG_A,
        userId: "stranger",
        requiredRole: TeamRole.Member,
      });

      expect(allowed).toBe(false);
    });
  });

  describe("existsInOrganization", () => {
    it("sees a team in its own organization", async () => {
      await expect(
        teamsService.existsInOrganization(TEAM_IN_A, ORG_A)
      ).resolves.toBe(true);
    });

    it("does not see that team from another organization", async () => {
      await expect(
        teamsService.existsInOrganization(TEAM_IN_A, ORG_B)
      ).resolves.toBe(false);
    });

    it("does not see a team id that does not exist", async () => {
      await expect(
        teamsService.existsInOrganization("no-such-team", ORG_A)
      ).resolves.toBe(false);
    });
  });
});

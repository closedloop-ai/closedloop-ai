import type { BasicUser, User } from "@repo/api/src/types/user";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCrossOrgProjectAssignees } from "@/app/cron/audit-data-invariants/cross-org-project-assignees";
import { projectsService } from "@/app/projects/service";
import { searchService } from "@/app/search/service";
import {
  PROJECT_ASSIGNEE_CROSS_ORG_EVENT,
  projectAssigneeCrossOrgThrottle,
} from "@/lib/user-org-membership";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

/**
 * ISS-10989 — a project read projects its assignee only when that user belongs
 * to the project's own organization.
 *
 * The cross-org row is inserted straight into the table, the way a row written
 * before ISS-9487 closed the service write would sit there. Two organizations
 * and a same-org sibling on purpose: a single-org fixture cannot tell a scoped
 * projection from an unscoped one, and a guard that nulled every assignee would
 * pass the cross-org half alone.
 */

const hasDatabase = !!keys().DATABASE_URL;

const SLUG_QUERY = "PROJ-";
const SAMPLE_LIMIT = 50;

type Fixture = {
  organizationId: string;
  teamId: string;
  sameOrgUser: User;
  foreignUser: User;
  crossOrgProjectId: string;
  sameOrgProjectId: string;
};

type ReadRow = { id: string; assignee?: BasicUser | null };

const READ_PATHS: [string, (f: Fixture) => Promise<ReadRow[]>][] = [
  [
    "projectsService.findByOrganization",
    (f) => projectsService.findByOrganization(f.organizationId),
  ],
  [
    "projectsService.findByTeam",
    (f) => projectsService.findByTeam(f.teamId, f.organizationId),
  ],
  [
    "projectsService.findById",
    (f) =>
      readEach(
        (id) => projectsService.findById(id, f.organizationId),
        [f.crossOrgProjectId, f.sameOrgProjectId]
      ),
  ],
  [
    "projectsService.findBySlug",
    (f) =>
      readEach(
        (slug) => projectsService.findBySlug(slug, f.organizationId),
        [`${SLUG_QUERY}CROSS`, `${SLUG_QUERY}SAME`]
      ),
  ],
  [
    "projectsService.findFavoritesByUser",
    (f) =>
      projectsService.findFavoritesByUser(f.sameOrgUser.id, f.organizationId),
  ],
  [
    "searchService.search",
    async (f) =>
      (await searchService.search(f.organizationId, SLUG_QUERY)).projects,
  ],
];

afterEach(() => {
  vi.restoreAllMocks();
  projectAssigneeCrossOrgThrottle.clear();
});

describe.skipIf(!hasDatabase)("project assignee organization scope", () => {
  it.each(READ_PATHS)(
    "%s renders a cross-org assignee as unassigned and keeps a same-org one",
    async (_path, read) => {
      await autoRollbackTransaction(async () => {
        const f = await seedTwoOrgProjects();
        const error = vi
          .spyOn(log, "error")
          .mockImplementation(() => undefined);

        const rows = await read(f);
        const cross = rows.find((r) => r.id === f.crossOrgProjectId);
        const same = rows.find((r) => r.id === f.sameOrgProjectId);

        expect(cross).toBeDefined();
        expect(cross?.assignee ?? null).toBeNull();
        // Covers `assigneeId` too: the foreign id alone names the other
        // tenant's user.
        expect(JSON.stringify(cross)).not.toContain(f.foreignUser.email);
        expect(JSON.stringify(cross)).not.toContain(f.foreignUser.id);

        expect(same?.assignee).toStrictEqual({
          id: f.sameOrgUser.id,
          email: f.sameOrgUser.email,
          firstName: f.sameOrgUser.firstName,
          lastName: f.sameOrgUser.lastName,
          avatarUrl: f.sameOrgUser.avatarUrl ?? null,
        });

        expect(error).toHaveBeenCalledWith(PROJECT_ASSIGNEE_CROSS_ORG_EVENT, {
          projectId: f.crossOrgProjectId,
          organizationId: f.organizationId,
          occurrences: 1,
        });
      });
    }
  );

  it("reports a repeated cross-org read once per project per window", async () => {
    await autoRollbackTransaction(async () => {
      const f = await seedTwoOrgProjects();
      const error = vi.spyOn(log, "error").mockImplementation(() => undefined);

      await projectsService.findByOrganization(f.organizationId);
      await projectsService.findByOrganization(f.organizationId);

      const reports = error.mock.calls.filter(
        ([event]) => event === PROJECT_ASSIGNEE_CROSS_ORG_EVENT
      );
      expect(reports).toHaveLength(1);
    });
  });

  it("names every corrupt project in an organization, not only the first one read", async () => {
    await autoRollbackTransaction(async () => {
      const f = await seedTwoOrgProjects();
      const secondCrossOrgProjectId = await createTestProject(
        f.organizationId,
        f.sameOrgUser.id,
        { slug: `${SLUG_QUERY}CROSS2`, assigneeId: f.foreignUser.id }
      );
      const error = vi.spyOn(log, "error").mockImplementation(() => undefined);

      await projectsService.findByOrganization(f.organizationId);
      await projectsService.findByOrganization(f.organizationId);

      const reports = error.mock.calls.filter(
        ([event]) => event === PROJECT_ASSIGNEE_CROSS_ORG_EVENT
      );
      expect(reports).toHaveLength(2);
      for (const projectId of [f.crossOrgProjectId, secondCrossOrgProjectId]) {
        expect(error).toHaveBeenCalledWith(PROJECT_ASSIGNEE_CROSS_ORG_EVENT, {
          projectId,
          organizationId: f.organizationId,
          occurrences: 1,
        });
      }
    });
  });

  it("counts the cross-org row in the daily invariant audit and leaves the same-org row out", async () => {
    await autoRollbackTransaction(async () => {
      const f = await seedTwoOrgProjects();

      const result = await checkCrossOrgProjectAssignees(SAMPLE_LIMIT);

      expect(result.sampleIds).toContain(f.crossOrgProjectId);
      expect(result.sampleIds).not.toContain(f.sameOrgProjectId);
      expect(result.count).toBeGreaterThanOrEqual(1);
    });
  });

  it("reports the whole population as the count when the sample is capped", async () => {
    await autoRollbackTransaction(async () => {
      const f = await seedTwoOrgProjects();
      await createTestProject(f.organizationId, f.sameOrgUser.id, {
        slug: `${SLUG_QUERY}CROSS2`,
        assigneeId: f.foreignUser.id,
      });
      const uncapped = await checkCrossOrgProjectAssignees(SAMPLE_LIMIT);

      const capped = await checkCrossOrgProjectAssignees(1);

      expect(capped.sampleIds).toHaveLength(1);
      expect(capped.count).toBe(uncapped.count);
      expect(capped.count).toBeGreaterThanOrEqual(2);
    });
  });

  it("keeps assigneeId on a same-org row and clears it on a cross-org row", async () => {
    await autoRollbackTransaction(async () => {
      const f = await seedTwoOrgProjects();
      vi.spyOn(log, "error").mockImplementation(() => undefined);

      const cross = await projectsService.findById(
        f.crossOrgProjectId,
        f.organizationId
      );
      const same = await projectsService.findById(
        f.sameOrgProjectId,
        f.organizationId
      );

      expect(cross?.assigneeId).toBeNull();
      expect(same?.assigneeId).toBe(f.sameOrgUser.id);
    });
  });
});

async function seedTwoOrgProjects(): Promise<Fixture> {
  const organizationId = await createTestOrganization();
  const otherOrganizationId = await createTestOrganization();
  const sameOrgUser = await createTestUser(organizationId);
  const foreignUser = await createTestUser(otherOrganizationId);

  const crossOrgProjectId = await createTestProject(
    organizationId,
    sameOrgUser.id,
    { slug: `${SLUG_QUERY}CROSS`, assigneeId: foreignUser.id }
  );
  const sameOrgProjectId = await createTestProject(
    organizationId,
    sameOrgUser.id,
    { slug: `${SLUG_QUERY}SAME`, assigneeId: sameOrgUser.id }
  );

  const teamId = await withDb(async (db) => {
    const team = await db.team.create({
      data: { organizationId, name: "Team", slug: "team" },
    });
    await db.projectTeam.createMany({
      data: [crossOrgProjectId, sameOrgProjectId].map((projectId) => ({
        projectId,
        teamId: team.id,
      })),
    });
    await db.favoriteProject.createMany({
      data: [crossOrgProjectId, sameOrgProjectId].map((projectId) => ({
        projectId,
        userId: sameOrgUser.id,
      })),
    });
    return team.id;
  });

  return {
    organizationId,
    teamId,
    sameOrgUser,
    foreignUser,
    crossOrgProjectId,
    sameOrgProjectId,
  };
}

async function readEach<T extends ReadRow>(
  read: (key: string) => Promise<T | null>,
  keysToRead: string[]
): Promise<ReadRow[]> {
  const rows: ReadRow[] = [];
  for (const key of keysToRead) {
    const row = await read(key);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

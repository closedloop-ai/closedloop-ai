/**
 * ISS-6748 — two-org isolation for `projectsService.findById`.
 *
 * `__tests__/api/project-tree-route.test.ts` claims "returns 404 for a project
 * outside the org", but it mocks `@/app/projects/service` and stubs `findById`
 * → `null`: the 404 is the test's own mock. The real predicate lives at
 * `app/projects/service.ts` (`db.project.findUnique({ where: { id,
 * organizationId } })`) and had NO executing coverage — the integration suite
 * covers `findBySlug`, a different method with a different `where`.
 *
 * This drives the real service against a DB fake that models per-org
 * visibility with Prisma's own semantics (an absent `where` key constrains
 * nothing), so deleting `organizationId` from the lookup reddens it.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: vi.fn().mockResolvedValue("PRO-1"),
}));

vi.mock("@/app/search/search-index-service", () => ({
  searchIndexService: {
    indexAfterCommit: vi.fn(),
    removeAfterCommit: vi.fn(),
  },
}));

import { withDb } from "@repo/database";
import { projectsService } from "../service";

const ORG_A = "org-a";
const ORG_B = "org-b";
const PROJECT_IN_B = "project-in-b";

type ProjectRow = { id: string; organizationId: string };

const PROJECTS: ProjectRow[] = [{ id: PROJECT_IN_B, organizationId: ORG_B }];

/**
 * Prisma semantics on purpose: a key ABSENT from the `where` constrains
 * nothing. That is what makes this causal — drop `organizationId` from the
 * service's lookup and the foreign project starts matching.
 */
function findUniqueImpl({
  where,
}: {
  where: { id?: string; organizationId?: string };
}) {
  const row = PROJECTS.find((p) => p.id === where.id);
  if (!row) {
    return Promise.resolve(null);
  }
  if (
    where.organizationId !== undefined &&
    where.organizationId !== row.organizationId
  ) {
    return Promise.resolve(null);
  }
  // Shape only needs the relations `toProjectWithDetails` reads through.
  return Promise.resolve({
    ...row,
    name: "Project B",
    slug: "PRO-1",
    settings: {},
    assignee: null,
    teams: [],
    artifacts: [],
    tagProjects: [],
  });
}

describe("projectsService.findById — two-org isolation (ISS-6748)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (withDb as unknown as Mock).mockImplementation(
      (cb: (db: unknown) => unknown) =>
        cb({ project: { findUnique: vi.fn(findUniqueImpl) } })
    );
  });

  it("returns the project to a caller in its own org", async () => {
    const project = await projectsService.findById(PROJECT_IN_B, ORG_B);

    expect(project).not.toBeNull();
    expect(project?.id).toBe(PROJECT_IN_B);
  });

  it("returns null for a caller in another org", async () => {
    const project = await projectsService.findById(PROJECT_IN_B, ORG_A);

    expect(project).toBeNull();
  });
});

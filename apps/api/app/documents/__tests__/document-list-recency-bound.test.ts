import {
  DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
  DocumentListRecency,
  type FindDocumentsOptions,
} from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import { ArtifactType } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FEA-1626 (epic FEA-908) headline acceptance criterion: a seeded ~12-month
 * power-user account must come back BOUNDED instead of as full history.
 *
 * These tests are not predicate-shape assertions — `document-list-query.test.ts`
 * owns those. Here a year of artifacts is seeded into an in-memory table and the
 * REAL `documentListService.countAll` runs the REAL `buildDocumentListWhere`
 * against it, so the number asserted is the number of rows the endpoint would
 * actually draw. Removing the server-side default makes the bounded assertions
 * fail with the full-history count, which is the whole point.
 */

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const ACTIVE_PROJECT_ID = "project-active";
const ARCHIVED_PROJECT_ID = "project-archived";
const FIXED_NOW = new Date("2026-08-05T12:00:00.000Z");
const DAY_MS = 86_400_000;
const SEEDED_DAYS = 365;

type SeededProject = { id: string; status: ProjectStatus };

type SeededArtifact = {
  id: string;
  organizationId: string;
  type: string;
  assigneeId: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const PROJECTS: readonly SeededProject[] = [
  { id: ACTIVE_PROJECT_ID, status: ProjectStatus.InProgress },
  { id: ARCHIVED_PROJECT_ID, status: ProjectStatus.Archived },
];

/**
 * Evaluate the subset of Prisma `where` operators `buildDocumentListWhere`
 * actually emits. Deliberately narrow: it understands scalar equality (including
 * an explicit `null`), a `gte` bound on `updatedAt`, and a top-level `OR` of the
 * archived-project alternatives — and nothing else, so it cannot quietly accept
 * an operator the predicate has not been proven to produce.
 */
function matchesWhere(
  artifact: SeededArtifact,
  where: Record<string, unknown>
): boolean {
  return Object.entries(where).every(([key, condition]) =>
    matchesClause(artifact, key, condition)
  );
}

function matchesClause(
  artifact: SeededArtifact,
  key: string,
  condition: unknown
): boolean {
  if (key === "OR") {
    const alternatives = condition as Record<string, unknown>[];
    return alternatives.some((alternative) =>
      matchesWhere(artifact, alternative)
    );
  }
  if (key === "project") {
    return matchesProjectClause(artifact, condition as Record<string, unknown>);
  }
  if (key === "updatedAt") {
    const { gte } = condition as { gte: Date };
    return artifact.updatedAt.getTime() >= gte.getTime();
  }
  return artifact[key as keyof SeededArtifact] === condition;
}

function matchesProjectClause(
  artifact: SeededArtifact,
  clause: Record<string, unknown>
): boolean {
  // A Prisma filter on a nullable to-one relation matches ONLY rows that have a
  // related row. Modelling that faithfully is what makes the project-less
  // fixture below a real regression test rather than a tautology.
  const project = PROJECTS.find(
    (candidate) => candidate.id === artifact.projectId
  );
  if (!project) {
    return false;
  }
  const status = clause.status as { not: ProjectStatus };
  return project.status !== status.not;
}

/**
 * One year of assigned artifacts for a power user, one per day, spread across an
 * active project, an archived project, and no project at all — plus decoys that
 * must never be counted (another user's row, a non-DOCUMENT artifact).
 */
function seedPowerUserYear(): SeededArtifact[] {
  const artifacts: SeededArtifact[] = [];
  for (let dayIndex = 0; dayIndex < SEEDED_DAYS; dayIndex++) {
    artifacts.push({
      id: `artifact-${dayIndex}`,
      organizationId: ORGANIZATION_ID,
      type: ArtifactType.DOCUMENT,
      assigneeId: USER_ID,
      projectId: projectForDay(dayIndex),
      createdAt: new Date(FIXED_NOW.getTime() - dayIndex * DAY_MS),
      updatedAt: new Date(FIXED_NOW.getTime() - dayIndex * DAY_MS),
    });
  }
  artifacts.push({
    id: "artifact-other-user",
    organizationId: ORGANIZATION_ID,
    type: ArtifactType.DOCUMENT,
    assigneeId: OTHER_USER_ID,
    projectId: ACTIVE_PROJECT_ID,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  });
  artifacts.push({
    id: "artifact-not-a-document",
    organizationId: ORGANIZATION_ID,
    type: ArtifactType.BRANCH,
    assigneeId: USER_ID,
    projectId: ACTIVE_PROJECT_ID,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  });
  return artifacts;
}

/** Every third day is project-less, every third-plus-one is archived. */
function projectForDay(dayIndex: number): string | null {
  if (dayIndex % 3 === 0) {
    return null;
  }
  if (dayIndex % 3 === 1) {
    return ARCHIVED_PROJECT_ID;
  }
  return ACTIVE_PROJECT_ID;
}

function countSeeded(
  artifacts: readonly SeededArtifact[],
  predicate: (artifact: SeededArtifact) => boolean
): number {
  return artifacts.filter(predicate).length;
}

const mockWithDb = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, withDb: Object.assign(mockWithDb, { tx: vi.fn() }) };
});

import { documentListService } from "../document-list-service";

let seeded: SeededArtifact[];

/**
 * The request the My Tasks board issues with `my-tasks-recency-window` ON: it
 * asks for the narrowing explicitly. The server imposes nothing of its own, so
 * the params have to be here or these bounds cannot hold.
 */
function listOptions(
  overrides: Partial<FindDocumentsOptions> = {}
): FindDocumentsOptions & { organizationId: string } {
  return {
    organizationId: ORGANIZATION_ID,
    assigneeId: USER_ID,
    limit: 50,
    recencyDays: DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
    includeArchivedProjects: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  seeded = seedPowerUserYear();
  mockWithDb.mockImplementation(
    async (
      callback: (db: {
        artifact: {
          count: (args: { where: Record<string, unknown> }) => Promise<number>;
        };
      }) => Promise<number>
    ) =>
      await callback({
        artifact: {
          count: ({ where }) =>
            Promise.resolve(
              countSeeded(seeded, (artifact) => matchesWhere(artifact, where))
            ),
        },
      })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("FEA-1626: a 12-month power-user account reads bounded, not whole", () => {
  it("returns only the recent, live slice of a full year of assigned work", async () => {
    const bounded = await documentListService.countAll(listOptions());

    const expected = countSeeded(
      seeded,
      (artifact) =>
        artifact.assigneeId === USER_ID &&
        artifact.type === ArtifactType.DOCUMENT &&
        artifact.updatedAt.getTime() >=
          FIXED_NOW.getTime() - DOCUMENT_LIST_DEFAULT_RECENCY_DAYS * DAY_MS &&
        artifact.projectId !== ARCHIVED_PROJECT_ID
    );
    expect(bounded).toBe(expected);
    // The bound is the assertion that matters: a year of history must not come
    // back whole, and the slice must be a real fraction of it, not a rounding
    // error away from either end.
    expect(bounded).toBeLessThan(SEEDED_DAYS / 2);
    expect(bounded).toBeGreaterThan(0);
  });

  it("returns the FULL year when the caller explicitly requests older data", async () => {
    const unbounded = await documentListService.countAll(
      listOptions({
        recencyDays: DocumentListRecency.All,
        includeArchivedProjects: true,
      })
    );

    expect(unbounded).toBe(SEEDED_DAYS);
  });

  it("returns the FULL year to a paged request that omits the new params", async () => {
    // The deploy-skew case (wongk): an already-deployed `apps/app`, and a new
    // build with the flag off, both send assigneeId + limit and nothing else.
    // If the server defaulted the window, this would come back bounded and the
    // closed-by-default flag would be controlling nothing.
    const legacyPaged = await documentListService.countAll({
      organizationId: ORGANIZATION_ID,
      assigneeId: USER_ID,
      limit: 50,
    });

    expect(legacyPaged).toBe(SEEDED_DAYS);
  });

  it("leaves the unbounded full-history arm reading the whole year", async () => {
    // No `limit` — the Documents index, plan/document pickers, the MCP
    // `list-documents` tool, and version-skewed API-key clients all read this
    // way, and FEA-1626 must not change a single row they receive.
    const legacy = await documentListService.countAll({
      organizationId: ORGANIZATION_ID,
      assigneeId: USER_ID,
    });

    expect(legacy).toBe(SEEDED_DAYS);
  });
});

describe("FEA-1626 lifecycle narrowing on the seeded account", () => {
  it("drops artifacts in an ARCHIVED project when the client asks it to", async () => {
    const bounded = await documentListService.countAll(listOptions());
    const archivedInWindow = countSeeded(
      seeded,
      (artifact) =>
        artifact.projectId === ARCHIVED_PROJECT_ID &&
        artifact.updatedAt.getTime() >=
          FIXED_NOW.getTime() - DOCUMENT_LIST_DEFAULT_RECENCY_DAYS * DAY_MS
    );

    expect(archivedInWindow).toBeGreaterThan(0);
    const withArchived = await documentListService.countAll(
      listOptions({ includeArchivedProjects: true })
    );
    expect(withArchived - bounded).toBe(archivedInWindow);
  });

  it("KEEPS project-less artifacts — a null project is not an archived one", async () => {
    const bounded = await documentListService.countAll(listOptions());
    const projectLessInWindow = countSeeded(
      seeded,
      (artifact) =>
        artifact.projectId === null &&
        artifact.updatedAt.getTime() >=
          FIXED_NOW.getTime() - DOCUMENT_LIST_DEFAULT_RECENCY_DAYS * DAY_MS
    );

    // The naive `project: { status: { not: ARCHIVED } }` predicate this OR
    // replaces would return zero of these org-level Documents and Templates.
    expect(projectLessInWindow).toBeGreaterThan(0);
    expect(bounded).toBeGreaterThanOrEqual(projectLessInWindow);
  });

  it("counts an old artifact that was worked on recently, because the window is on updatedAt", async () => {
    seeded.push({
      id: "artifact-old-but-active",
      organizationId: ORGANIZATION_ID,
      type: ArtifactType.DOCUMENT,
      assigneeId: USER_ID,
      projectId: ACTIVE_PROJECT_ID,
      // Created well outside the window; touched today. A `createdAt` window
      // would drop this row, and the matcher would fail to satisfy such a
      // clause at all — which is what makes this assertion meaningful.
      createdAt: new Date(FIXED_NOW.getTime() - SEEDED_DAYS * DAY_MS),
      updatedAt: FIXED_NOW,
    });
    const withOldButActive = await documentListService.countAll(listOptions());

    seeded = seeded.filter(
      (artifact) => artifact.id !== "artifact-old-but-active"
    );
    const without = await documentListService.countAll(listOptions());
    expect(withOldButActive - without).toBe(1);
  });
});

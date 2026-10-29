/**
 * Unit tests for projectsService favorite methods:
 * addFavorite, removeFavorite, findFavoritesByUser
 */
import { ProjectStatus } from "@repo/api/src/types/project";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// Mock modules before importing the service
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

// Import after mocking
import { withDb } from "@repo/database";
import { createHostileOrderedFindMany } from "@/__tests__/utils/hostile-order-planner.test-helpers";
import { projectsService } from "../service";

const mockWithDb = withDb as unknown as Mock;

const TEST_USER_ID = "user-111";
const TEST_PROJECT_ID = "project-222";
const TEST_ORG_ID = "org-333";

describe("projectsService.addFavorite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when project does not exist in the organization", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue(null);

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({
        project: { findUnique: mockFindUnique },
        favoriteProject: { upsert: vi.fn() },
      })
    );

    const result = await projectsService.addFavorite(
      TEST_PROJECT_ID,
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result).toBeNull();
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: TEST_PROJECT_ID, organizationId: TEST_ORG_ID },
      select: { id: true },
    });
  });

  it("upserts a favorite and returns { favorited: true } when project exists", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID });
    const mockUpsert = vi.fn().mockResolvedValue({});

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({
        project: { findUnique: mockFindUnique },
        favoriteProject: { upsert: mockUpsert },
      })
    );

    const result = await projectsService.addFavorite(
      TEST_PROJECT_ID,
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result).toEqual({ favorited: true });
    expect(mockUpsert).toHaveBeenCalledWith({
      where: {
        userId_projectId: {
          userId: TEST_USER_ID,
          projectId: TEST_PROJECT_ID,
        },
      },
      create: { userId: TEST_USER_ID, projectId: TEST_PROJECT_ID },
      update: {},
      select: { id: true },
    });
  });
});

describe("projectsService.removeFavorite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when project does not exist in the organization", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue(null);

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({
        project: { findUnique: mockFindUnique },
        favoriteProject: { deleteMany: vi.fn() },
      })
    );

    const result = await projectsService.removeFavorite(
      TEST_PROJECT_ID,
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result).toBeNull();
  });

  it("deletes the favorite and returns { favorited: false } when project exists", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID });
    const mockDeleteMany = vi.fn().mockResolvedValue({ count: 1 });

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({
        project: { findUnique: mockFindUnique },
        favoriteProject: { deleteMany: mockDeleteMany },
      })
    );

    const result = await projectsService.removeFavorite(
      TEST_PROJECT_ID,
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result).toEqual({ favorited: false });
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { userId: TEST_USER_ID, projectId: TEST_PROJECT_ID },
    });
  });
});

describe("projectsService.findFavoritesByUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries favorites by userId and project organizationId, ordered by createdAt", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([]);

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({
        favoriteProject: { findMany: mockFindMany },
      })
    );

    await projectsService.findFavoritesByUser(TEST_USER_ID, TEST_ORG_ID);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        userId: TEST_USER_ID,
        project: {
          organizationId: TEST_ORG_ID,
          status: { not: ProjectStatus.Archived },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      include: {
        project: {
          include: expect.any(Object),
        },
      },
    });
  });

  it("returns mapped project results from the database", async () => {
    const mockFavorites = [
      {
        project: {
          id: "project-1",
          name: "Favorited Project",
          organizationId: TEST_ORG_ID,
          settings: null,
          assignee: null,
          teams: [],
          artifacts: [],
        },
      },
    ];

    const mockFindMany = vi.fn().mockResolvedValue(mockFavorites);

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({
        favoriteProject: { findMany: mockFindMany },
      })
    );

    const result = await projectsService.findFavoritesByUser(
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("project-1");
  });

  // ISS-9780: the query-shape case above proves the service ASKS for a total
  // order; it cannot prove the order it SERVES, because its fake returns `[]`.
  // This one hands the read a population that is entirely tied on `createdAt` —
  // the favorites a user stars in one burst share it — through a fake that
  // applies the requested ordering and permutes tied rows between calls. Strip
  // the terminal key and the two identical reads hand the user two different
  // orders.
  it("serves the same favorite sequence twice when every row is tied on createdAt", async () => {
    const TIED_AT = new Date("2026-09-01T00:00:00.000Z");
    const favoriteRows = [
      ["fav-d", "project-d"],
      ["fav-b", "project-b"],
      ["fav-a", "project-a"],
      ["fav-c", "project-c"],
    ].map(([favoriteId, projectId]) => ({
      id: favoriteId,
      userId: TEST_USER_ID,
      createdAt: TIED_AT,
      project: {
        id: projectId,
        name: `Project ${projectId}`,
        organizationId: TEST_ORG_ID,
        settings: null,
        assignee: null,
        teams: [],
        artifacts: [],
      },
    }));

    const findMany = createHostileOrderedFindMany(favoriteRows);
    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({ favoriteProject: { findMany } })
    );

    const first = await projectsService.findFavoritesByUser(
      TEST_USER_ID,
      TEST_ORG_ID
    );
    const second = await projectsService.findFavoritesByUser(
      TEST_USER_ID,
      TEST_ORG_ID
    );

    // The terminal key is the favorite row's own `id`, ascending, so the served
    // sequence is not merely stable — it is this one.
    expect(first.map((project) => project.id)).toEqual([
      "project-a",
      "project-b",
      "project-c",
      "project-d",
    ]);
    expect(second.map((project) => project.id)).toEqual(
      first.map((project) => project.id)
    );
  });
});

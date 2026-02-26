/**
 * Unit tests for projectsService favorite methods:
 * addFavorite, removeFavorite, findFavoritesByUser
 */
import { type Mock, vi } from "vitest";

// Mock modules before importing the service
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

// Import after mocking
import { withDb } from "@repo/database";
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

    mockWithDb.mockImplementation((callback: any) =>
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

    mockWithDb.mockImplementation((callback: any) =>
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
    });
  });
});

describe("projectsService.removeFavorite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when project does not exist in the organization", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue(null);

    mockWithDb.mockImplementation((callback: any) =>
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

    mockWithDb.mockImplementation((callback: any) =>
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

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        favoriteProject: { findMany: mockFindMany },
      })
    );

    await projectsService.findFavoritesByUser(TEST_USER_ID, TEST_ORG_ID);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        userId: TEST_USER_ID,
        project: { organizationId: TEST_ORG_ID },
      },
      orderBy: { createdAt: "desc" },
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

    mockWithDb.mockImplementation((callback: any) =>
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
});

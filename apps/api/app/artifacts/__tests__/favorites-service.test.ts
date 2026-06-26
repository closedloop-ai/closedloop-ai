import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { artifactFavoritesService } from "../favorites-service";

const mockWithDb = withDb as unknown as Mock;

const TEST_USER_ID = "user-111";
const TEST_ARTIFACT_ID = "artifact-222";
const TEST_ORG_ID = "org-333";

describe("artifactFavoritesService.addFavorite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when artifact does not exist in the organization", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue(null);

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifact: { findUnique: mockFindUnique },
        favoriteArtifact: { upsert: vi.fn() },
      })
    );

    const result = await artifactFavoritesService.addFavorite(
      TEST_ARTIFACT_ID,
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result).toBeNull();
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: TEST_ARTIFACT_ID, organizationId: TEST_ORG_ID },
      select: { id: true },
    });
  });

  it("upserts a favorite and returns { favorited: true } when artifact exists", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue({ id: TEST_ARTIFACT_ID });
    const mockUpsert = vi.fn().mockResolvedValue({});

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifact: { findUnique: mockFindUnique },
        favoriteArtifact: { upsert: mockUpsert },
      })
    );

    const result = await artifactFavoritesService.addFavorite(
      TEST_ARTIFACT_ID,
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result).toEqual({ favorited: true });
    expect(mockUpsert).toHaveBeenCalledWith({
      where: {
        userId_artifactId: {
          userId: TEST_USER_ID,
          artifactId: TEST_ARTIFACT_ID,
        },
      },
      create: { userId: TEST_USER_ID, artifactId: TEST_ARTIFACT_ID },
      update: {},
    });
  });

  it("does not call upsert when artifact is not found", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue(null);
    const mockUpsert = vi.fn();

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifact: { findUnique: mockFindUnique },
        favoriteArtifact: { upsert: mockUpsert },
      })
    );

    await artifactFavoritesService.addFavorite(
      TEST_ARTIFACT_ID,
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("artifactFavoritesService.removeFavorite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when artifact does not exist in the organization", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue(null);

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifact: { findUnique: mockFindUnique },
        favoriteArtifact: { deleteMany: vi.fn() },
      })
    );

    const result = await artifactFavoritesService.removeFavorite(
      TEST_ARTIFACT_ID,
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result).toBeNull();
  });

  it("deletes the favorite and returns { favorited: false } when artifact exists", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue({ id: TEST_ARTIFACT_ID });
    const mockDeleteMany = vi.fn().mockResolvedValue({ count: 1 });

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifact: { findUnique: mockFindUnique },
        favoriteArtifact: { deleteMany: mockDeleteMany },
      })
    );

    const result = await artifactFavoritesService.removeFavorite(
      TEST_ARTIFACT_ID,
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result).toEqual({ favorited: false });
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { userId: TEST_USER_ID, artifactId: TEST_ARTIFACT_ID },
    });
  });

  it("does not call deleteMany when artifact is not found", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue(null);
    const mockDeleteMany = vi.fn();

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifact: { findUnique: mockFindUnique },
        favoriteArtifact: { deleteMany: mockDeleteMany },
      })
    );

    await artifactFavoritesService.removeFavorite(
      TEST_ARTIFACT_ID,
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});

describe("artifactFavoritesService.findFavoritesByUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries favorites by userId and artifact organizationId", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([]);

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        favoriteArtifact: { findMany: mockFindMany },
      })
    );

    await artifactFavoritesService.findFavoritesByUser(
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        userId: TEST_USER_ID,
        artifact: { organizationId: TEST_ORG_ID },
      },
      orderBy: { createdAt: "desc" },
      include: {
        artifact: {
          include: { assignee: expect.any(Object) },
        },
      },
    });
  });

  it("returns mapped artifact results", async () => {
    const mockArtifact = {
      id: "artifact-1",
      name: "Test Artifact",
      organizationId: TEST_ORG_ID,
    };
    const mockFindMany = vi
      .fn()
      .mockResolvedValue([{ artifact: mockArtifact }]);

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        favoriteArtifact: { findMany: mockFindMany },
      })
    );

    const result = await artifactFavoritesService.findFavoritesByUser(
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("artifact-1");
  });
});

/**
 * Unit tests for projectsService.findByTeam method.
 *
 * Tests the limit parameter functionality and multi-tenant security checks.
 */
import { ArtifactStatus } from "@repo/api/src/types/artifact";
import { ProjectStatus } from "@repo/api/src/types/project";
import { type Mock, vi } from "vitest";

// Mock modules before importing the service
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

// Import after mocking
import { withDb } from "@repo/database";
import { projectsService } from "../service";

// Type alias for mocked function
const mockWithDb = withDb as unknown as Mock;

describe("projectsService.findByTeam", () => {
  const TEST_TEAM_ID = "team-123";
  const TEST_ORG_ID = "org-456";

  // Mock project data
  const MOCK_PROJECT = {
    id: "project-1",
    name: "Test Project",
    organizationId: TEST_ORG_ID,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
    artifacts: [],
    teams: [
      {
        team: {
          id: TEST_TEAM_ID,
          name: "Test Team",
        },
      },
    ],
    owner: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls Prisma with take: 3 and sortOrder/updatedAt ordering when limit is provided", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        project: {
          findMany: mockFindMany,
        },
      };
      return callback(mockDb);
    });

    await projectsService.findByTeam(TEST_TEAM_ID, TEST_ORG_ID, { limit: 3 });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        teams: {
          some: { teamId: TEST_TEAM_ID },
        },
        organizationId: TEST_ORG_ID,
      },
      include: expect.any(Object),
      orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
      take: 3,
    });
  });

  it("calls Prisma without take and with sortOrder/updatedAt ordering when no limit provided", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        project: {
          findMany: mockFindMany,
        },
      };
      return callback(mockDb);
    });

    await projectsService.findByTeam(TEST_TEAM_ID, TEST_ORG_ID);

    const callArgs = mockFindMany.mock.calls[0][0];

    expect(callArgs).toEqual({
      where: {
        teams: {
          some: { teamId: TEST_TEAM_ID },
        },
        organizationId: TEST_ORG_ID,
      },
      include: expect.any(Object),
      orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
    });

    // Explicitly verify take is not present
    expect(callArgs).not.toHaveProperty("take");
  });

  it("always includes multi-tenant WHERE clause with organizationId and teamId regardless of limit", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        project: {
          findMany: mockFindMany,
        },
      };
      return callback(mockDb);
    });

    // Test with limit
    await projectsService.findByTeam(TEST_TEAM_ID, TEST_ORG_ID, { limit: 5 });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: TEST_ORG_ID,
          teams: { some: { teamId: TEST_TEAM_ID } },
        }),
      })
    );

    mockFindMany.mockClear();

    // Test without limit
    await projectsService.findByTeam(TEST_TEAM_ID, TEST_ORG_ID);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: TEST_ORG_ID,
          teams: { some: { teamId: TEST_TEAM_ID } },
        }),
      })
    );
  });

  it("applies status inclusion filters when provided", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        project: {
          findMany: mockFindMany,
        },
      };
      return callback(mockDb);
    });

    await projectsService.findByTeam(TEST_TEAM_ID, TEST_ORG_ID, {
      status: [ProjectStatus.Archived],
    });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [ProjectStatus.Archived] },
        }),
      })
    );
  });

  it("applies status exclusion filters when provided", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        project: {
          findMany: mockFindMany,
        },
      };
      return callback(mockDb);
    });

    await projectsService.findByTeam(TEST_TEAM_ID, TEST_ORG_ID, {
      excludeStatus: [ProjectStatus.Archived],
    });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { notIn: [ProjectStatus.Archived] },
        }),
      })
    );
  });
});

describe("projectsService.calculateStatus", () => {
  it("returns 0 for an empty array", () => {
    expect(projectsService.calculateStatus([])).toBe(0);
  });

  it("returns 0 when all artifacts have non-terminal statuses", () => {
    const artifacts = [
      { status: ArtifactStatus.Draft },
      { status: ArtifactStatus.InReview },
      { status: ArtifactStatus.Approved },
      { status: ArtifactStatus.ReadyForReview },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(0);
  });

  it("returns 100 when all artifacts are Executed", () => {
    const artifacts = [
      { status: ArtifactStatus.Executed },
      { status: ArtifactStatus.Executed },
      { status: ArtifactStatus.Executed },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(100);
  });

  it("returns 100 when all artifacts are Obsolete", () => {
    const artifacts = [
      { status: ArtifactStatus.Obsolete },
      { status: ArtifactStatus.Obsolete },
      { status: ArtifactStatus.Obsolete },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(100);
  });

  it("returns 50 for mixed Executed+Obsolete+Draft with 2-of-4 completed", () => {
    const artifacts = [
      { status: ArtifactStatus.Executed },
      { status: ArtifactStatus.Obsolete },
      { status: ArtifactStatus.Draft },
      { status: ArtifactStatus.Draft },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(50);
  });

  it("returns 25 for 1-of-4 Executed artifacts", () => {
    const artifacts = [
      { status: ArtifactStatus.Executed },
      { status: ArtifactStatus.Draft },
      { status: ArtifactStatus.InReview },
      { status: ArtifactStatus.Approved },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(25);
  });

  it("regression: 1-Approved-of-4 returns 0 while 1-Executed-of-4 returns 25, confirming Approved is not terminal", () => {
    const approvedArtifacts = [
      { status: ArtifactStatus.Approved },
      { status: ArtifactStatus.Draft },
      { status: ArtifactStatus.Draft },
      { status: ArtifactStatus.Draft },
    ];
    const executedArtifacts = [
      { status: ArtifactStatus.Executed },
      { status: ArtifactStatus.Draft },
      { status: ArtifactStatus.Draft },
      { status: ArtifactStatus.Draft },
    ];
    expect(projectsService.calculateStatus(approvedArtifacts)).toBe(0);
    expect(projectsService.calculateStatus(executedArtifacts)).toBe(25);
  });
});

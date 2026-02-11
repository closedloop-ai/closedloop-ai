/**
 * Unit tests for projectsService.findByTeam method.
 *
 * Tests the limit parameter functionality and multi-tenant security checks.
 */
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

  it("calls Prisma with take: 3 and orderBy: { updatedAt: 'desc' } when limit is provided", async () => {
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
      orderBy: { updatedAt: "desc" },
      take: 3,
    });
  });

  it("calls Prisma without take and with orderBy: { createdAt: 'desc' } when no limit provided", async () => {
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
      orderBy: { createdAt: "desc" },
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
});

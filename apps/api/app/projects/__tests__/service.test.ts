/**
 * Unit tests for projectsService.findByTeam method.
 *
 * Tests the limit parameter functionality and multi-tenant security checks.
 */
import {
  DocumentStatus,
  DocumentType,
  FeatureStatus,
} from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

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
        organizationId: TEST_ORG_ID,
        isTemplatesSentinel: false,
        teams: {
          some: { teamId: TEST_TEAM_ID },
        },
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
        organizationId: TEST_ORG_ID,
        isTemplatesSentinel: false,
        teams: {
          some: { teamId: TEST_TEAM_ID },
        },
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

  it("returns 0 when all document artifacts have non-terminal statuses", () => {
    const artifacts = [
      { status: DocumentStatus.Draft, subtype: DocumentType.Prd },
      { status: DocumentStatus.InReview, subtype: DocumentType.Prd },
      { status: DocumentStatus.ChangesRequested, subtype: DocumentType.Prd },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(0);
  });

  it("returns 100 when all documents are in a terminal status (Approved/Executed/Obsolete)", () => {
    const artifacts = [
      { status: DocumentStatus.Approved, subtype: DocumentType.Prd },
      {
        status: DocumentStatus.Executed,
        subtype: DocumentType.ImplementationPlan,
      },
      { status: DocumentStatus.Obsolete, subtype: DocumentType.Prd },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(100);
  });

  it("returns 100 when all features are terminal (Done/Canceled)", () => {
    const artifacts = [
      { status: FeatureStatus.Done, subtype: DocumentType.Feature },
      { status: FeatureStatus.Canceled, subtype: DocumentType.Feature },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(100);
  });

  it("returns 50 for a mix of 2-of-4 terminal across documents and features", () => {
    const artifacts = [
      { status: DocumentStatus.Approved, subtype: DocumentType.Prd },
      { status: FeatureStatus.Done, subtype: DocumentType.Feature },
      { status: DocumentStatus.Draft, subtype: DocumentType.Prd },
      { status: FeatureStatus.Backlog, subtype: DocumentType.Feature },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(50);
  });

  it("treats per-subtype terminal sets independently: a feature Approved-string is not terminal", () => {
    // APPROVED is terminal for documents but not part of the feature vocabulary,
    // so a feature carrying it counts as non-terminal.
    const artifacts = [
      { status: DocumentStatus.Approved, subtype: DocumentType.Feature },
      { status: FeatureStatus.Done, subtype: DocumentType.Feature },
      { status: FeatureStatus.Triage, subtype: DocumentType.Feature },
      { status: FeatureStatus.InProgress, subtype: DocumentType.Feature },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(25);
  });

  it("regression: document EXECUTED and APPROVED are both terminal post-PRD-495", () => {
    const artifacts = [
      {
        status: DocumentStatus.Executed,
        subtype: DocumentType.ImplementationPlan,
      },
      { status: DocumentStatus.Approved, subtype: DocumentType.Prd },
      { status: DocumentStatus.Draft, subtype: DocumentType.Prd },
      { status: DocumentStatus.InReview, subtype: DocumentType.Prd },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(50);
  });
});

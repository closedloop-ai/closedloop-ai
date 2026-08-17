/**
 * Unit tests for projectsService.findByTeam and projectsService.update.
 *
 * Tests the limit parameter functionality and multi-tenant security checks.
 */
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  PROJECT_COMPLETION_ARTIFACT_TYPE,
  ProjectStatus,
} from "@repo/api/src/types/project";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const indexAfterCommit = vi.hoisted(() => vi.fn());
const waitUntil = vi.hoisted(() => vi.fn());

// Mock modules before importing the service
vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@vercel/functions", () => ({ waitUntil }));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: vi.fn().mockResolvedValue("PRO-1"),
}));

vi.mock("@/app/search/search-index-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/search/search-index-service")
  >("@/app/search/search-index-service");
  return {
    ...actual,
    searchIndexService: { indexAfterCommit, removeAfterCommit: vi.fn() },
  };
});

// Import after mocking
import { withDb } from "@repo/database";
import {
  InvalidProjectTeamsError,
  MAX_PROJECT_TEAMS,
  projectsService,
} from "../service";

// Type alias for mocked function
const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = (withDb as unknown as { tx: Mock }).tx;

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

  // ISS-4636: the artifacts feeding `completionPercentage` are the completion
  // population — documents — not every artifact of the project. The UI copy
  // names this same population via PROJECT_COMPLETION_POPULATION_NOUN.
  it("selects only the completion population's artifacts for completionPercentage", async () => {
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

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          artifacts: expect.objectContaining({
            where: { type: PROJECT_COMPLETION_ARTIFACT_TYPE },
          }),
        }),
      })
    );
  });

  // ISS-4679 / version-skew: the wire field stays numeric for old clients; the
  // empty population is signalled by the additive optional flag, omitted when
  // the population is non-empty.
  it("serializes an empty population as completionPercentage 0 + completionPopulationEmpty true", async () => {
    const mockFindMany = vi
      .fn()
      .mockResolvedValue([{ ...MOCK_PROJECT, artifacts: [] }]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = { project: { findMany: mockFindMany } };
      return callback(mockDb);
    });

    const [project] = await projectsService.findByTeam(
      TEST_TEAM_ID,
      TEST_ORG_ID
    );

    expect(project.completionPercentage).toBe(0);
    expect(project.completionPopulationEmpty).toBe(true);
  });

  it("omits completionPopulationEmpty for a non-empty population", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([
      {
        ...MOCK_PROJECT,
        artifacts: [{ status: DocumentStatus.Draft, subtype: null }],
      },
    ]);

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = { project: { findMany: mockFindMany } };
      return callback(mockDb);
    });

    const [project] = await projectsService.findByTeam(
      TEST_TEAM_ID,
      TEST_ORG_ID
    );

    expect(typeof project.completionPercentage).toBe("number");
    // Additive optional field: absent (not `false`/`null`) so old clients that
    // ignore it degrade to the legacy 0% behavior.
    expect("completionPopulationEmpty" in project).toBe(false);
  });
});

describe("projectsService.calculateStatus", () => {
  it("returns null for an empty population (no documents/issues to complete)", () => {
    // ISS-4679: an empty population has no percentage; `null` distinguishes it
    // from a real 0-of-N so the ring can render an empty-state track.
    expect(projectsService.calculateStatus([])).toBeNull();
  });

  it("returns 0 (not null) when all document artifacts have non-terminal statuses", () => {
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
      { status: IssueStatus.Done, subtype: DocumentType.Feature },
      { status: IssueStatus.Canceled, subtype: DocumentType.Feature },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(100);
  });

  it("returns 50 for a mix of 2-of-4 terminal across documents and features", () => {
    const artifacts = [
      { status: DocumentStatus.Approved, subtype: DocumentType.Prd },
      { status: IssueStatus.Done, subtype: DocumentType.Feature },
      { status: DocumentStatus.Draft, subtype: DocumentType.Prd },
      { status: IssueStatus.Backlog, subtype: DocumentType.Feature },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(50);
  });

  it("treats per-subtype terminal sets independently: a feature Approved-string is not terminal", () => {
    // APPROVED is terminal for documents but not part of the feature vocabulary,
    // so a feature carrying it counts as non-terminal.
    const artifacts = [
      { status: DocumentStatus.Approved, subtype: DocumentType.Feature },
      { status: IssueStatus.Done, subtype: DocumentType.Feature },
      { status: IssueStatus.Triage, subtype: DocumentType.Feature },
      { status: IssueStatus.InProgress, subtype: DocumentType.Feature },
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

// ISS-6561: `teamIds` is the ProjectTeam relation, not a Project column. It
// must never reach `project.update`'s `data` — Prisma rejects the unknown
// argument and the whole PUT /projects/:id fails with a generic 500 before the
// team sync below it can run.
describe("projectsService.update", () => {
  const PROJECT_ID = "project-1";
  const ORG_ID = "org-456";
  const TEAM_A = "team-a";
  const TEAM_B = "team-b";
  // A real team, owned by a different organization than the caller's.
  const FOREIGN_TEAM = "team-in-another-org";

  const UPDATED_PROJECT = {
    id: PROJECT_ID,
    organizationId: ORG_ID,
    name: "Renamed",
    slug: "PRO-1",
    description: null,
    assigneeId: null,
    status: ProjectStatus.InProgress,
    priority: null,
    updatedAt: new Date("2026-08-14T00:00:00.000Z"),
  };

  let projectUpdate: Mock;
  let projectTeamDeleteMany: Mock;
  let projectTeamCreateMany: Mock;
  let teamFindMany: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    projectUpdate = vi.fn().mockResolvedValue(UPDATED_PROJECT);
    projectTeamDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    // Stands in for the (projectId, teamId) unique constraint: a payload that
    // repeats a pair is a write error, which is how a duplicated teamId used to
    // surface as a generic 500.
    projectTeamCreateMany = vi
      .fn()
      .mockImplementation(({ data }: { data: Array<{ teamId: string }> }) => {
        const pairs = new Set(data.map((row) => row.teamId));
        if (pairs.size !== data.length) {
          return Promise.reject(
            new Error(
              "Unique constraint failed on the fields: (`project_id`,`team_id`)"
            )
          );
        }
        return Promise.resolve({ count: data.length });
      });
    // Default: every requested team resolves inside the caller's own org.
    teamFindMany = vi
      .fn()
      .mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id })))
      );
    mockWithDbTx.mockImplementation((callback: any) =>
      callback({
        project: { update: projectUpdate },
        team: { findMany: teamFindMany },
        projectTeam: {
          deleteMany: projectTeamDeleteMany,
          createMany: projectTeamCreateMany,
        },
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps teamIds out of the Prisma update payload and syncs the team rows", async () => {
    await projectsService.update(PROJECT_ID, ORG_ID, {
      name: "Renamed",
      teamIds: [TEAM_A],
    });

    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: PROJECT_ID, organizationId: ORG_ID },
      data: { name: "Renamed" },
    });
    expect(projectTeamDeleteMany).toHaveBeenCalledWith({
      where: { projectId: PROJECT_ID },
    });
    expect(projectTeamCreateMany).toHaveBeenCalledWith({
      data: [{ projectId: PROJECT_ID, teamId: TEAM_A }],
      skipDuplicates: true,
    });
    expect(indexAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: PROJECT_ID, teamId: TEAM_A })
    );
  });

  it("leaves the team rows alone and re-reads the projected team when teamIds is absent", async () => {
    const findFirst = vi.fn().mockResolvedValue({ teamId: TEAM_B });
    mockWithDb.mockImplementation((callback: any) =>
      callback({ projectTeam: { findFirst } })
    );

    await projectsService.update(PROJECT_ID, ORG_ID, {
      status: ProjectStatus.Completed,
    });
    // The unresolved-team path defers the read to `waitUntil`.
    await waitUntil.mock.calls[0]?.[0];

    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: PROJECT_ID, organizationId: ORG_ID },
      data: { status: ProjectStatus.Completed },
    });
    expect(projectTeamDeleteMany).not.toHaveBeenCalled();
    expect(projectTeamCreateMany).not.toHaveBeenCalled();
    expect(indexAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: PROJECT_ID, teamId: TEAM_B })
    );
  });

  // ISS-6561 review (finding 1): the validator only proves the ids are UUIDs.
  // Without an org predicate on the resolve, an Org A caller can attach its
  // project to an Org B team, and the response plus the search projection then
  // carry that foreign team.
  it("rejects the whole update when a requested team belongs to another organization", async () => {
    // The foreign team exists, but not in this caller's organization, so the
    // org-scoped resolve returns only the in-org one.
    teamFindMany.mockResolvedValue([{ id: TEAM_A }]);

    await expect(
      projectsService.update(PROJECT_ID, ORG_ID, {
        teamIds: [TEAM_A, FOREIGN_TEAM],
      })
    ).rejects.toThrow(InvalidProjectTeamsError);

    // The resolve ran inside the transaction, scoped to the caller's org.
    expect(teamFindMany).toHaveBeenCalledWith({
      where: { id: { in: [TEAM_A, FOREIGN_TEAM] }, organizationId: ORG_ID },
      select: { id: true },
    });
    // ...and it ran BEFORE the current memberships were touched.
    expect(projectTeamDeleteMany).not.toHaveBeenCalled();
    expect(projectTeamCreateMany).not.toHaveBeenCalled();
    // The foreign team reaches neither the write nor the search projection.
    expect(indexAfterCommit).not.toHaveBeenCalled();
  });

  it("does not resolve or attach any team when every requested team is foreign", async () => {
    teamFindMany.mockResolvedValue([]);

    await expect(
      projectsService.update(PROJECT_ID, ORG_ID, { teamIds: [FOREIGN_TEAM] })
    ).rejects.toThrow(InvalidProjectTeamsError);

    expect(projectTeamCreateMany).not.toHaveBeenCalled();
    expect(indexAfterCommit).not.toHaveBeenCalled();
  });

  // ISS-6561 review (finding 2): the validator accepts [teamA, teamA]; the
  // unique (projectId, teamId) constraint then turned the PUT into a generic
  // 500. The array is deduped and bounded before the write instead.
  it("dedupes a repeated teamId into a single membership instead of failing the write", async () => {
    await expect(
      projectsService.update(PROJECT_ID, ORG_ID, {
        teamIds: [TEAM_A, TEAM_A],
      })
    ).resolves.toEqual(UPDATED_PROJECT);

    expect(projectTeamCreateMany).toHaveBeenCalledWith({
      data: [{ projectId: PROJECT_ID, teamId: TEAM_A }],
      skipDuplicates: true,
    });
    expect(indexAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: PROJECT_ID, teamId: TEAM_A })
    );
  });

  it("rejects a teamIds array over the cap before issuing any write", async () => {
    const overCap = Array.from(
      { length: MAX_PROJECT_TEAMS + 1 },
      (_, i) => `team-${i}`
    );

    await expect(
      projectsService.update(PROJECT_ID, ORG_ID, { teamIds: overCap })
    ).rejects.toThrow(InvalidProjectTeamsError);

    expect(teamFindMany).not.toHaveBeenCalled();
    expect(projectTeamDeleteMany).not.toHaveBeenCalled();
    expect(projectTeamCreateMany).not.toHaveBeenCalled();
  });

  // `create` takes the same caller-supplied `teamIds` and reaches the same
  // ProjectTeam write, so it is scoped by the same org-resolve rather than
  // leaving the identical cross-org attach open on POST /projects.
  it("rejects create when a requested team belongs to another organization", async () => {
    const projectCreate = vi.fn().mockResolvedValue(UPDATED_PROJECT);
    const createTeamFindMany = vi.fn().mockResolvedValue([]);
    const createTeamRows = vi.fn().mockResolvedValue({ count: 1 });
    mockWithDbTx.mockImplementation((callback: any) =>
      callback({
        project: { create: projectCreate },
        team: { findMany: createTeamFindMany },
        projectTeam: { createMany: createTeamRows },
      })
    );

    await expect(
      projectsService.create(ORG_ID, "user-1", {
        name: "New",
        teamIds: [FOREIGN_TEAM],
      })
    ).rejects.toThrow(InvalidProjectTeamsError);

    expect(createTeamFindMany).toHaveBeenCalledWith({
      where: { id: { in: [FOREIGN_TEAM] }, organizationId: ORG_ID },
      select: { id: true },
    });
    expect(createTeamRows).not.toHaveBeenCalled();
    expect(indexAfterCommit).not.toHaveBeenCalled();
  });

  it("clears every team row without a createMany for an empty teamIds", async () => {
    await projectsService.update(PROJECT_ID, ORG_ID, { teamIds: [] });

    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: PROJECT_ID, organizationId: ORG_ID },
      data: {},
    });
    expect(projectTeamDeleteMany).toHaveBeenCalledWith({
      where: { projectId: PROJECT_ID },
    });
    expect(projectTeamCreateMany).not.toHaveBeenCalled();
    expect(indexAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: PROJECT_ID, teamId: null })
    );
  });
});

/**
 * Unit tests for projectsService.findByTeam and projectsService.update.
 *
 * Tests the limit parameter functionality and multi-tenant security checks.
 */
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  PROJECT_COMPLETION_ARTIFACT_TYPE,
  ProjectStatus,
} from "@repo/api/src/types/project";
import { Result } from "@repo/api/src/types/result";
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
  generateSlug: vi.fn(async () => "PRO-1"),
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

import {
  MAX_PROJECT_TEAMS,
  PROJECT_TEAM_CAP_MESSAGE,
} from "@repo/api/src/types/project";
// Import after mocking
import { withDb } from "@repo/database";
import { createHostileOrderedFindMany } from "@/__tests__/utils/hostile-order-planner.test-helpers";
import {
  InvalidProjectTeamsError,
  InvalidProjectTeamsReason,
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

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) => {
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
      orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }, { id: "asc" }],
      take: 3,
    });
  });

  it("calls Prisma without take and with sortOrder/updatedAt ordering when no limit provided", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) => {
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
      orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }, { id: "asc" }],
    });

    // Explicitly verify take is not present
    expect(callArgs).not.toHaveProperty("take");
  });

  it("always includes multi-tenant WHERE clause with organizationId and teamId regardless of limit", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([MOCK_PROJECT]);

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) => {
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

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) => {
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

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) => {
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

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) => {
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

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) => {
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

    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) => {
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

// ISS-6561: `teamIds` is the ProjectTeam relation, not a Project column. It
// must never reach `project.update`'s `data` — Prisma rejects the unknown
// argument and the whole PUT /projects/:id fails with a generic 500 before the
// team sync below it can run.
describe("projectsService.update", () => {
  const PROJECT_ID = "project-1";
  const ORG_ID = "org-456";
  const TEAM_A = "team-a";
  const TEAM_B = "team-b";
  const TEAM_C = "team-c";
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

  /**
   * The row as it stood BEFORE the write. Deliberately different from
   * `UPDATED_PROJECT` on both audited fields: if the service ever returned the
   * post-write row as `previous`, every assertion below would still pass
   * against an identical pair.
   */
  const PREVIOUS_FIELDS = {
    status: ProjectStatus.NotStarted,
    priority: "LOW",
  };

  let projectUpdate: Mock;
  let projectTeamDeleteMany: Mock;
  let projectTeamCreateMany: Mock;
  let teamFindMany: Mock;
  /**
   * The project's ProjectTeam rows, seeded with the two it already belongs to.
   *
   * Asserting the createMany ARGUMENTS alone cannot see a wipe: the service
   * deletes every row and recreates the set, so "createMany was called with
   * three rows" stays true even if the delete runs after it and the project ends
   * up with none — which is exactly ISS-6559's bug. Two seeded teams are what
   * make the net effect readable; with one, a targeted update and a
   * wipe-and-replace produce the same membership.
   */
  let projectTeamRows: Set<string>;
  /** The `FOR UPDATE` before-image read the audit receipt is diffed from. */
  let lockedBeforeImage: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({
        projectTeam: {
          findFirst: vi.fn(async () => ({ teamId: TEAM_C })),
        },
      })
    );
    projectUpdate = vi.fn().mockResolvedValue(UPDATED_PROJECT);
    projectTeamRows = new Set([TEAM_A, TEAM_B]);
    projectTeamDeleteMany = vi.fn().mockImplementation(() => {
      const count = projectTeamRows.size;
      projectTeamRows.clear();
      return Promise.resolve({ count });
    });
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
        for (const row of data) {
          projectTeamRows.add(row.teamId);
        }
        return Promise.resolve({ count: data.length });
      });
    // Default: every requested team resolves inside the caller's own org.
    teamFindMany = vi
      .fn()
      .mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id })))
      );
    lockedBeforeImage = vi.fn().mockResolvedValue([PREVIOUS_FIELDS]);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({
        $queryRaw: lockedBeforeImage,
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

  // The update REPLACES memberships (deleteMany then createMany), so a caller
  // that names one team when the project has two silently drops the other. The
  // MCP tool therefore forwards the caller's whole set; this pins that every id
  // in that set reaches the write, and that the project is left holding all
  // three. Fails against a one-id shape, which can only ever deliver a single
  // row here, and against a delete that outlives the create.
  it("attaches a third team without dropping the two the project already had", async () => {
    teamFindMany.mockResolvedValue([
      { id: TEAM_A },
      { id: TEAM_B },
      { id: TEAM_C },
    ]);

    await projectsService.update(PROJECT_ID, ORG_ID, {
      teamIds: [TEAM_A, TEAM_B, TEAM_C],
    });

    expect(projectTeamCreateMany).toHaveBeenCalledWith({
      data: [
        { projectId: PROJECT_ID, teamId: TEAM_A },
        { projectId: PROJECT_ID, teamId: TEAM_B },
        { projectId: PROJECT_ID, teamId: TEAM_C },
      ],
      skipDuplicates: true,
    });
    expect([...projectTeamRows].sort()).toEqual([TEAM_A, TEAM_B, TEAM_C]);
  });

  // The positive case above is only evidence that the widening works if this one
  // proves the same assertion can still see a REFUSAL: taking an array must not
  // become a way to reach past the org boundary. Two organizations are what make
  // that distinguishable — against an unscoped resolve both cases would pass.
  it("refuses the whole three-team attach when one team belongs to another organization", async () => {
    // Org-scoped resolve returns only the caller's own two.
    teamFindMany.mockResolvedValue([{ id: TEAM_A }, { id: TEAM_B }]);

    const error = await settledValue(() =>
      projectsService.update(PROJECT_ID, ORG_ID, {
        teamIds: [TEAM_A, TEAM_B, FOREIGN_TEAM],
      })
    );

    expect(error).toBeInstanceOf(InvalidProjectTeamsError);
    expect(teamFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: [TEAM_A, TEAM_B, FOREIGN_TEAM] },
        organizationId: ORG_ID,
      },
      select: { id: true },
    });
    // Nothing partially applied: the two in-org teams are not written either,
    // and the memberships the project already had survive the refusal.
    expect(projectTeamDeleteMany).not.toHaveBeenCalled();
    expect(projectTeamCreateMany).not.toHaveBeenCalled();
    expect(indexAfterCommit).not.toHaveBeenCalled();
    expect([...projectTeamRows].sort()).toEqual([TEAM_A, TEAM_B]);
  });

  it("leaves the team rows alone and re-reads the projected team when teamIds is absent", async () => {
    const findFirst = vi.fn().mockResolvedValue({ teamId: TEAM_B });
    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) =>
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

    const error = await settledValue(() =>
      projectsService.update(PROJECT_ID, ORG_ID, {
        teamIds: [TEAM_A, FOREIGN_TEAM],
      })
    );
    expect(error).toBeInstanceOf(InvalidProjectTeamsError);
    expect((error as InvalidProjectTeamsError).reason).toBe(
      InvalidProjectTeamsReason.Unresolved
    );

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

    const error = await settledValue(() =>
      projectsService.update(PROJECT_ID, ORG_ID, { teamIds: [FOREIGN_TEAM] })
    );
    expect(error).toBeInstanceOf(InvalidProjectTeamsError);
    expect((error as InvalidProjectTeamsError).reason).toBe(
      InvalidProjectTeamsReason.Unresolved
    );

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
    ).resolves.toEqual(
      Result.ok({ project: UPDATED_PROJECT, previous: PREVIOUS_FIELDS })
    );

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

    const error = await settledValue(() =>
      projectsService.update(PROJECT_ID, ORG_ID, { teamIds: overCap })
    );
    expect(error).toBeInstanceOf(InvalidProjectTeamsError);
    expect((error as InvalidProjectTeamsError).reason).toBe(
      InvalidProjectTeamsReason.OverCap
    );

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
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({
        project: { create: projectCreate },
        team: { findMany: createTeamFindMany },
        projectTeam: { createMany: createTeamRows },
      })
    );

    const error = await settledValue(() =>
      projectsService.create(ORG_ID, "user-1", {
        name: "New",
        teamIds: [FOREIGN_TEAM],
      })
    );
    expect(error).toBeInstanceOf(InvalidProjectTeamsError);
    expect((error as InvalidProjectTeamsError).reason).toBe(
      InvalidProjectTeamsReason.Unresolved
    );

    expect(createTeamFindMany).toHaveBeenCalledWith({
      where: { id: { in: [FOREIGN_TEAM] }, organizationId: ORG_ID },
      select: { id: true },
    });
    expect(createTeamRows).not.toHaveBeenCalled();
    expect(indexAfterCommit).not.toHaveBeenCalled();
  });

  // The route decides whether to hand the caller a corrective team roster off
  // this `reason` alone, so both producing paths must pin which one they emit.
  // Asserting only the class leaves a swap of the two throw sites fully green.
  it("rejects create over the cap with the over-cap reason and no team lookup", async () => {
    const projectCreate = vi.fn().mockResolvedValue(UPDATED_PROJECT);
    const createTeamFindMany = vi.fn().mockResolvedValue([]);
    const createTeamRows = vi.fn().mockResolvedValue({ count: 1 });
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({
        project: { create: projectCreate },
        team: { findMany: createTeamFindMany },
        projectTeam: { createMany: createTeamRows },
      })
    );
    const overCap = Array.from(
      { length: MAX_PROJECT_TEAMS + 1 },
      (_, i) => `team-${i}`
    );

    const error = await settledValue(() =>
      projectsService.create(ORG_ID, "user-1", {
        name: "New",
        teamIds: overCap,
      })
    );

    expect(error).toBeInstanceOf(InvalidProjectTeamsError);
    expect((error as InvalidProjectTeamsError).reason).toBe(
      InvalidProjectTeamsReason.OverCap
    );
    expect((error as InvalidProjectTeamsError).message).toBe(
      PROJECT_TEAM_CAP_MESSAGE
    );
    expect(createTeamFindMany).not.toHaveBeenCalled();
    expect(createTeamRows).not.toHaveBeenCalled();
  });

  // ISS-9688 (#7225 review, whitlockk and codex). The audit ledger is hashed and
  // append-only, so a receipt built from a before-image another writer could
  // have moved is a permanent wrong row. The route cannot close that on its own
  // — it holds no lock — so the pair has to come from inside this transaction.
  it("returns a before-image read under FOR UPDATE in the same transaction as the write", async () => {
    const result = await projectsService.update(PROJECT_ID, ORG_ID, {
      status: ProjectStatus.InProgress,
    });

    // The pre-image is the LOCKED read's row, not a re-read of the written one.
    expect(result).toEqual(
      Result.ok({ project: UPDATED_PROJECT, previous: PREVIOUS_FIELDS })
    );

    // `FOR UPDATE` is the load-bearing token: an unlocked read still lets a
    // concurrent writer commit between it and the update under READ COMMITTED,
    // which is the lost-update this exists to serialize. Asserting only that
    // some read happened leaves dropping the lock fully green.
    expect(lockedBeforeImage).toHaveBeenCalledTimes(1);
    const sql = lockedBeforeImage.mock.calls[0][0].join("");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("projects");

    // ...and it ran BEFORE the write, or it is not a before-image at all.
    expect(lockedBeforeImage.mock.invocationCallOrder[0]).toBeLessThan(
      projectUpdate.mock.invocationCallOrder[0]
    );
  });

  it("reports no before-image when the locked row does not exist", async () => {
    // The route folds this into its 404: no row to lock is the same answer as
    // no project, and it must never be mistaken for "nothing changed".
    lockedBeforeImage.mockResolvedValue([]);

    const result = await projectsService.update(PROJECT_ID, ORG_ID, {
      status: ProjectStatus.InProgress,
    });

    expect(result).toMatchObject({ ok: true, value: { previous: null } });
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

/**
 * Return whatever the call settled with — the rejection reason, or the resolved
 * value if it did not reject. Assertions stay in the test body so a call that
 * unexpectedly resolves fails an assertion rather than skipping one.
 */
function settledValue(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    (value) => value,
    (caught: unknown) => caught
  );
}

// ---------------------------------------------------------------------------
// ISS-9780 — the project lists lead on `sortOrder`, which is the most tie-prone
// column in the schema: every project a user has never reordered shares one
// value. The recency column behind it is not unique either, so before the
// terminal key these reads had no defined answer for their tied rows — the
// board could reshuffle between two identical loads.
//
// The fake applies the requested ordering and permutes tied rows between calls,
// so this observes the ORDER SERVED. Drop `{ id: "asc" }` and the sequences
// diverge.
// ---------------------------------------------------------------------------
describe("projectsService list ordering is total (ISS-9780)", () => {
  const ORG_ID = "org-456";
  const TIED_AT = new Date("2026-09-01T00:00:00.000Z");

  function tiedProjects() {
    return ["project-d", "project-b", "project-a", "project-c"].map((id) => ({
      id,
      name: `Project ${id}`,
      organizationId: ORG_ID,
      // Every row tied on BOTH ordering columns the service names ahead of the
      // terminal key — the population the defect actually reaches.
      sortOrder: 0,
      createdAt: TIED_AT,
      updatedAt: TIED_AT,
      artifacts: [],
      teams: [],
      owner: null,
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves findByOrganization in the same order twice when every row is tied", async () => {
    const findMany = createHostileOrderedFindMany(tiedProjects());
    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({ project: { findMany } })
    );

    const first = await projectsService.findByOrganization(ORG_ID);
    const second = await projectsService.findByOrganization(ORG_ID);

    expect(first.map((project) => project.id)).toEqual(
      second.map((project) => project.id)
    );
    expect(first).toHaveLength(4);
  });

  it("serves findByTeam in the same order twice when every row is tied", async () => {
    const findMany = createHostileOrderedFindMany(tiedProjects());
    mockWithDb.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({ project: { findMany } })
    );

    const first = await projectsService.findByTeam("team-123", ORG_ID);
    const second = await projectsService.findByTeam("team-123", ORG_ID);

    expect(first.map((project) => project.id)).toEqual(
      second.map((project) => project.id)
    );
    expect(first).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// ISS-9441 — create with no priority
// ---------------------------------------------------------------------------

describe("projectsService.create priority", () => {
  const ORG_ID = "org-9441";
  const TEAM_ID = "team-9441";

  /**
   * Since the ISS-9441 migration dropped the column's DEFAULT, "no priority" is
   * expressed by the key being ABSENT from the write and the column resolving to
   * NULL — so the created row, and the projection built from it, both carry null.
   */
  const CREATED_PROJECT = {
    id: "project-9441",
    organizationId: ORG_ID,
    name: "Unprioritized",
    slug: "PRO-9441",
    description: null,
    assigneeId: null,
    status: ProjectStatus.NotStarted,
    priority: null,
    updatedAt: new Date("2026-09-17T00:00:00.000Z"),
  };

  it("writes no priority column and projects null when the caller omits one", async () => {
    const projectCreate = vi.fn().mockResolvedValue(CREATED_PROJECT);
    mockWithDbTx.mockImplementation((callback: (client: unknown) => unknown) =>
      callback({
        project: { create: projectCreate },
        team: { findMany: vi.fn().mockResolvedValue([{ id: TEAM_ID }]) },
        projectTeam: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      })
    );

    await projectsService.create(ORG_ID, "user-1", {
      name: "Unprioritized",
      teamIds: [TEAM_ID],
    });

    const { data } = projectCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // A `priority: undefined` in the payload would read identically at the
    // column but is a different write for Prisma to reason about, so the key's
    // absence is what is pinned.
    expect("priority" in data).toBe(false);
    // The projection mirrors the stored value, so an unprioritized project has
    // to reach `:priority=NONE` rather than the MEDIUM the old default supplied.
    expect(indexAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: CREATED_PROJECT.id, priority: null })
    );
  });
});

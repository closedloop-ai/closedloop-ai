import {
  MAX_PROJECT_TEAMS,
  PROJECT_TEAM_CAP_MESSAGE,
  ProjectErrorCode,
} from "@repo/api/src/types/project";
import type { ProjectTeamOption } from "@repo/api/src/types/teams";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TeamRequirementVerb,
  teamRequirementErrorResponse,
  unresolvedTeamErrorResponse,
} from "../team-requirement";
import { createProjectValidator, updateProjectValidator } from "../validators";

// Regex literals at module level (Ultracite useTopLevelRegex)
const FOREIGN_UUID_PATTERN = /f0e1d2c3-b4a5-6789-dead-beefdeadbeef/;

vi.mock("@/app/teams/service", () => ({
  teamsService: {
    listTeamOptions: vi.fn(),
  },
}));

// Import after mock so vi.mocked works
import { teamsService } from "@/app/teams/service";

const VALID_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const ORG_ID = "org-00000000-0000-0000-0000-000000000001";

function makeTeam(id: string, name: string): ProjectTeamOption {
  return { id, name };
}

const MOCK_TEAMS: ProjectTeamOption[] = [
  makeTeam("team-00000000-0000-0000-0000-000000000001", "Alpha"),
  makeTeam("team-00000000-0000-0000-0000-000000000002", "Beta"),
];

function issuesFrom(
  validator: typeof createProjectValidator | typeof updateProjectValidator,
  body: unknown
) {
  const result = validator.safeParse(body);
  if (result.success) {
    return [];
  }
  return result.error.issues;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(teamsService.listTeamOptions).mockResolvedValue(MOCK_TEAMS);
});

describe("teamRequirementErrorResponse", () => {
  it("returns a 400 with team list when create body has no teamIds", async () => {
    const issues = issuesFrom(createProjectValidator, { name: "P" });
    const response = await teamRequirementErrorResponse({
      issues,
      rawBody: { name: "P" },
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(response).not.toBeNull();
    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual(MOCK_TEAMS);
    expect(body.error).toContain(MOCK_TEAMS[0].name);
    expect(body.error).toContain(MOCK_TEAMS[1].name);
  });

  it("returns a 400 with team list when create body has teamIds: []", async () => {
    const rawBody = { name: "P", teamIds: [] };
    const issues = issuesFrom(createProjectValidator, rawBody);
    const response = await teamRequirementErrorResponse({
      issues,
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(response).not.toBeNull();
    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual(MOCK_TEAMS);
  });

  it("returns a 400 with team list when create body has teamIds: ['not-a-uuid']", async () => {
    const rawBody = { name: "P", teamIds: ["not-a-uuid"] };
    const issues = issuesFrom(createProjectValidator, rawBody);
    const response = await teamRequirementErrorResponse({
      issues,
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(response).not.toBeNull();
    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual(MOCK_TEAMS);
  });

  // teamIds: null — key is present but wrong type. isTeamRequirementIssue
  // returns false for invalid_type when the key exists, so this is a shape
  // error and falls through to null.
  it("returns null when create body has teamIds: null (present but wrong type)", async () => {
    const rawBody = { name: "P", teamIds: null };
    const issues = issuesFrom(createProjectValidator, rawBody);
    const response = await teamRequirementErrorResponse({
      issues,
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(response).toBeNull();
  });

  // teamIds: [123] — element-level invalid_type (not invalid_format).
  // isTeamRequirementIssue only returns true for element-level issues whose
  // code is "invalid_format". A numeric element produces "invalid_type" at
  // path ["teamIds", 0], which the implementation treats as a shape error
  // returning null.
  it("returns null when create body has teamIds: [123] (element type error — shape, not missing team)", async () => {
    const rawBody = { name: "P", teamIds: [123] };
    const issues = issuesFrom(createProjectValidator, rawBody);
    const response = await teamRequirementErrorResponse({
      issues,
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    // isTeamRequirementIssue gates on invalid_format for element-level issues;
    // a numeric element emits invalid_type at ["teamIds", 0] — not a team failure.
    expect(response).toBeNull();
  });

  it("returns null when the only failures are on non-teamIds fields", async () => {
    // name: "" fails min(1); teamIds is valid → no team requirement issue
    const rawBody = { name: "", teamIds: [VALID_UUID] };
    const issues = issuesFrom(createProjectValidator, rawBody);
    const response = await teamRequirementErrorResponse({
      issues,
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(response).toBeNull();
    expect(teamsService.listTeamOptions).not.toHaveBeenCalled();
  });

  it("returns null and skips listTeamOptions when issues is undefined", async () => {
    const response = await teamRequirementErrorResponse({
      issues: undefined,
      rawBody: {},
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(response).toBeNull();
    expect(teamsService.listTeamOptions).not.toHaveBeenCalled();
  });

  it("returns a 400 with team list when update body has teamIds: []", async () => {
    const rawBody = { teamIds: [] };
    const issues = issuesFrom(updateProjectValidator, rawBody);
    const response = await teamRequirementErrorResponse({
      issues,
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Update,
    });

    expect(response).not.toBeNull();
    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual(MOCK_TEAMS);
  });

  it("zero teams: message states no teams and API keys cannot create them", async () => {
    vi.mocked(teamsService.listTeamOptions).mockResolvedValue([]);
    const rawBody = { name: "P" };
    const issues = issuesFrom(createProjectValidator, rawBody);
    const response = await teamRequirementErrorResponse({
      issues,
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(response).not.toBeNull();
    const body = await response?.json();
    expect(body.details.teams).toEqual([]);
    expect(body.error).toContain("no teams");
    expect(body.error).toContain("API keys cannot create teams");
  });

  it("zero teams: create message mentions 'before a project can be created'", async () => {
    vi.mocked(teamsService.listTeamOptions).mockResolvedValue([]);
    const rawBody = { name: "P" };
    const issues = issuesFrom(createProjectValidator, rawBody);
    const response = await teamRequirementErrorResponse({
      issues,
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    const body = await response?.json();
    expect(body.error).toContain("before a project can be created");
  });

  it("zero teams: update message does NOT say 'before a project can be created'", async () => {
    vi.mocked(teamsService.listTeamOptions).mockResolvedValue([]);
    const rawBody = { teamIds: [] };
    const issues = issuesFrom(updateProjectValidator, rawBody);
    const response = await teamRequirementErrorResponse({
      issues,
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Update,
    });

    const body = await response?.json();
    expect(body.error).not.toContain("before a project can be created");
    expect(body.error).toContain("before a project's teams can be changed");
  });

  // The message is the ONLY roster an MCP agent can read (`details` is stripped
  // by the MCP sanitizer, FEA-2550, and there is no `list-teams` tool), so a
  // count cap on the prose was a cap on which teams the agent could choose at
  // all. Every team is named; the remaining bound is on characters, not options.
  it("names every team in the prose for an org well past the old 25-team cap", async () => {
    const thirtyTeams = makeTeams(30);
    vi.mocked(teamsService.listTeamOptions).mockResolvedValue(thirtyTeams);

    const rawBody = { name: "P" };
    const issues = issuesFrom(createProjectValidator, rawBody);
    const response = await teamRequirementErrorResponse({
      issues,
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(response).not.toBeNull();
    const body = await response?.json();
    expect(body.details.teams).toHaveLength(30);
    for (const team of thirtyTeams) {
      expect(body.error).toContain(team.id);
    }
    expect(body.error).not.toContain("omitted for length");
  });

  it("bounds the prose by characters and states how many teams it omitted", async () => {
    // Names sized so the roster cannot fit the character budget.
    const manyTeams: ProjectTeamOption[] = Array.from({ length: 400 }, (_, i) =>
      makeTeam(
        `team-0000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        `Team ${i} ${"x".repeat(40)}`
      )
    );
    vi.mocked(teamsService.listTeamOptions).mockResolvedValue(manyTeams);

    const rawBody = { name: "P" };
    const response = await teamRequirementErrorResponse({
      issues: issuesFrom(createProjectValidator, rawBody),
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    const body = await response?.json();
    // The complete set still reaches a caller that can read `details`.
    expect(body.details.teams).toHaveLength(400);
    expect(body.error).toContain("omitted for length");
    // ISS-6966: the recovery path an MCP caller can actually take. `details` is
    // stripped before it reaches an agent, so a pointer at `details.teams`
    // alone left every omitted team unselectable on that channel.
    expect(body.error).toContain("list-teams");
    expect(body.error).toContain("details.teams");
    // Bounded, but not empty: the first team is always named.
    expect(body.error).toContain(manyTeams[0].id);
    expect(body.error.length).toBeLessThan(6000);
  });

  it("calls listTeamOptions with the passed organizationId", async () => {
    const rawBody = { name: "P" };
    const issues = issuesFrom(createProjectValidator, rawBody);
    await teamRequirementErrorResponse({
      issues,
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(teamsService.listTeamOptions).toHaveBeenCalledWith(ORG_ID);
  });

  // Naming a different team cannot fix "too many teams", so this denial must not
  // carry a roster (`apps/api/AGENTS.md` L110) and must not pay for the lookup.
  it("over-cap: returns the cap message with no roster and no team lookup", async () => {
    const overCap = Array.from({ length: MAX_PROJECT_TEAMS + 1 }, () =>
      crypto.randomUUID()
    );
    const rawBody = { name: "P", teamIds: overCap };
    const response = await teamRequirementErrorResponse({
      issues: issuesFrom(createProjectValidator, rawBody),
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body.error).toContain(PROJECT_TEAM_CAP_MESSAGE);
    expect(body.details).toBeUndefined();
    expect(body.code).not.toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(teamsService.listTeamOptions).not.toHaveBeenCalled();
  });

  // The bypass: a malformed element is an `invalid_format` issue, which on its
  // own earns remediation. Paired with an over-cap array it used to drag the
  // roster along and defeat the no-roster-for-over-cap rule. Over-cap wins.
  it("over-cap outranks a malformed element and still returns no roster", async () => {
    const overCap = Array.from({ length: MAX_PROJECT_TEAMS + 1 }, () =>
      crypto.randomUUID()
    );
    overCap[0] = "not-a-uuid";
    const rawBody = { name: "P", teamIds: overCap };
    const response = await teamRequirementErrorResponse({
      issues: issuesFrom(createProjectValidator, rawBody),
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    const body = await response?.json();
    expect(body.error).toContain(PROJECT_TEAM_CAP_MESSAGE);
    expect(body.details).toBeUndefined();
    expect(teamsService.listTeamOptions).not.toHaveBeenCalled();
  });

  // `teamIds` is caller-supplied and Zod emits one issue per bad element, so an
  // unbounded render lets the caller dictate the response size.
  it("bounds the rendered issue list instead of one error per bad element", async () => {
    const malformed = Array.from({ length: 60 }, (_, i) => `not-a-uuid-${i}`);
    const rawBody = { name: "P", teamIds: malformed };
    const response = await teamRequirementErrorResponse({
      issues: issuesFrom(createProjectValidator, rawBody),
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    const body = await response?.json();
    expect(body.error).toContain("(and 50 more)");
    // 10 rendered, not 60: the per-element text cannot grow with the input.
    expect(countOccurrences(body.error, "teamIds")).toBe(10);
  });

  // The roster is remediation, not the denial. Losing it must not turn a client
  // error into a 500 — the caller falls back to the plain Zod 400.
  it("preserves the underlying 400 when the roster read fails", async () => {
    vi.mocked(teamsService.listTeamOptions).mockRejectedValue(
      new Error("db unavailable")
    );

    const rawBody = { name: "P" };
    const response = await teamRequirementErrorResponse({
      issues: issuesFrom(createProjectValidator, rawBody),
      rawBody,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    // null tells the route to forward its own 400 untouched.
    expect(response).toBeNull();
  });
});

describe("unresolvedTeamErrorResponse", () => {
  it("returns 400 with team list and project_team_required code", async () => {
    const response = await unresolvedTeamErrorResponse({
      message: "Team not found in this organization.",
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual(MOCK_TEAMS);
  });

  it("anti-enumeration: rejected team id does not appear in the response body", async () => {
    const FOREIGN_ID = "f0e1d2c3-b4a5-6789-dead-beefdeadbeef";
    // Message intentionally does not embed the id — service keeps it opaque
    const message = "The requested team could not be resolved.";

    const response = await unresolvedTeamErrorResponse({
      message,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Update,
    });

    const body = await response.json();
    const serialized = JSON.stringify(body);
    expect(FOREIGN_UUID_PATTERN.test(serialized)).toBe(false);
    // Service message passes through verbatim
    expect(body.error).toContain(message);
    // Sanity: the id we're checking for is not in the mocked teams either
    expect(serialized).not.toContain(FOREIGN_ID);
  });

  // This helper is awaited inside the route's `catch`, so a rejection here would
  // escape the handler entirely and surface as a 500 rather than the 400 the
  // invalid request earned.
  it("still returns the 400 when the roster read fails", async () => {
    vi.mocked(teamsService.listTeamOptions).mockRejectedValue(
      new Error("db unavailable")
    );
    const message = "One or more teams were not found in this organization.";

    const response = await unresolvedTeamErrorResponse({
      message,
      organizationId: ORG_ID,
      verb: TeamRequirementVerb.Create,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe(message);
    expect(body.details).toBeUndefined();
  });
});

function makeTeams(count: number): ProjectTeamOption[] {
  return Array.from({ length: count }, (_, i) =>
    makeTeam(
      `team-0000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      `Team ${i}`
    )
  );
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

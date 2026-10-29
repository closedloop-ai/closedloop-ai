import { ProjectErrorCode } from "@repo/api/src/types/project";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const VALID_TEAM_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
/** A syntactically valid assignee id that the service refuses (ISS-9487). */
const FOREIGN_USER_UUID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
/**
 * Deliberately NOT the shipped org-membership string, so the 400 case can only
 * pass if the route answers with the message the service result carries.
 */
const SERVICE_REFUSAL_MESSAGE = "refusal carried by the service result";
const ORG_TEAM_A = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Alpha Team",
};
const ORG_TEAM_B = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Beta Team",
};
const ORG_TEAMS = [ORG_TEAM_A, ORG_TEAM_B];

const mocks = vi.hoisted(() => ({
  findByOrganization: vi.fn(),
  findByTeam: vi.fn(),
  getValuesForEntity: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  listTeamOptions: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler({ user: { id: "user-1", organizationId: "org-1" } }, request),
}));

// importOriginal spreads the real module so that InvalidProjectTeamsError and
// InvalidProjectTeamsReason are the real class/const — route.ts's `instanceof`
// check would silently fail against `undefined` if they were absent.
vi.mock("./service", async (importOriginal) => {
  const real = await importOriginal<typeof import("./service")>();
  return {
    ...real,
    projectsService: {
      findByOrganization: mocks.findByOrganization,
      findByTeam: mocks.findByTeam,
      create: mocks.create,
      findById: mocks.findById,
    },
  };
});

// team-requirement.ts imports teamsService from this path alias.
vi.mock("@/app/teams/service", () => ({
  teamsService: {
    listTeamOptions: mocks.listTeamOptions,
  },
}));

vi.mock("../custom-fields/values-service", () => ({
  customFieldValuesService: {
    getValuesForEntity: mocks.getValuesForEntity,
  },
}));

import { GET, POST } from "./route";
import { InvalidProjectTeamsError, InvalidProjectTeamsReason } from "./service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routeContext() {
  return { params: Promise.resolve({}) };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost:3002/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// GET /projects — unchanged tests
// ---------------------------------------------------------------------------

describe("GET /projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByOrganization.mockResolvedValue([]);
    mocks.findByTeam.mockResolvedValue([]);
    mocks.getValuesForEntity.mockResolvedValue([]);
  });

  it("returns 200 for a valid request without query params", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/projects"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.findByOrganization).toHaveBeenCalledWith("org-1", {
      excludeStatus: ["ARCHIVED"],
    });
  });

  it("forwards valid query params to the service", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/projects?teamId=team-1&limit=25"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.findByTeam).toHaveBeenCalledWith("team-1", "org-1", {
      limit: 25,
      excludeStatus: ["ARCHIVED"],
    });
  });

  it("rejects unsupported query params instead of silently dropping them (ISS-4505)", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/projects?unknownFilter=value"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(mocks.findByOrganization).not.toHaveBeenCalled();
    expect(mocks.findByTeam).not.toHaveBeenCalled();
  });

  it("rejects unsupported query params even when mixed with valid ones", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost:3002/projects?teamId=team-1&bogus=should-fail"
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findByTeam).not.toHaveBeenCalled();
  });

  it("honors limit on the organization path, not only the team path (davetho)", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/projects?limit=25"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.findByOrganization).toHaveBeenCalledWith("org-1", {
      limit: 25,
      excludeStatus: ["ARCHIVED"],
    });
  });

  it("rejects __proto__ query param instead of silently swallowing it (davetho)", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/projects?__proto__=polluted"),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findByOrganization).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /projects — team-requirement cases (ISS-6966)
// ---------------------------------------------------------------------------

describe("POST /projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listTeamOptions.mockResolvedValue(ORG_TEAMS);
    mocks.create.mockResolvedValue(Result.ok({ id: PROJECT_ID }));
    mocks.findById.mockResolvedValue({
      id: PROJECT_ID,
      name: "Test Project",
      teams: [ORG_TEAM_A],
      customFields: [],
      tags: [],
    });
  });

  // Case 1: missing teamIds → team-required 400 with roster
  it("returns 400 with team list when teamIds is absent", async () => {
    const response = await POST(postRequest({ name: "Proj" }), routeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual(ORG_TEAMS);
    expect(body.error).toContain(ORG_TEAM_A.name);
    expect(body.error).toContain(ORG_TEAM_B.name);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // Case 2: empty teamIds → same team-required 400
  it("returns 400 with team list when teamIds is an empty array", async () => {
    const response = await POST(
      postRequest({ name: "Proj", teamIds: [] }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual(ORG_TEAMS);
    expect(body.error).toContain(ORG_TEAM_A.name);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // Case 3: valid teamIds → 200, create called with those ids
  it("creates the project and returns 200 when teamIds is valid", async () => {
    const response = await POST(
      postRequest({ name: "Proj", teamIds: [VALID_TEAM_UUID] }),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ teamIds: [VALID_TEAM_UUID] }),
      undefined
    );
  });

  // Case 4 (GATING): name invalid but teamIds valid → plain 400, no team roster
  it("returns plain validation 400 without team roster when teamIds is valid but name is empty", async () => {
    const response = await POST(
      postRequest({ name: "", teamIds: [VALID_TEAM_UUID] }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).not.toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details).toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // Case 5: teamIds present but wrong type (null) → plain 400, no team roster
  it("returns plain 400 when teamIds is null, not a team-required error", async () => {
    const response = await POST(
      postRequest({ name: "Proj", teamIds: null }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).not.toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details).toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // Case 6: teamIds contains an invalid UUID string → still team-required (invalid_format at element)
  it("returns 400 with team list when teamIds contains a malformed UUID string", async () => {
    const response = await POST(
      postRequest({ name: "Proj", teamIds: ["not-a-uuid"] }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual(ORG_TEAMS);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // Case 7: teamIds has a numeric element (invalid_type at element, not invalid_format)
  it("returns plain 400 when teamIds contains a numeric element, not team-required", async () => {
    const response = await POST(
      postRequest({ name: "Proj", teamIds: [123] }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).not.toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details).toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // Case 8: org isolation — listTeamOptions must be called with the user's org id
  it("fetches teams only for the authenticated organization", async () => {
    // Make the mock argument-sensitive: return teams only for org-1
    mocks.listTeamOptions.mockImplementation(async (orgId: string) =>
      orgId === "org-1" ? ORG_TEAMS : []
    );

    const response = await POST(postRequest({ name: "Proj" }), routeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.listTeamOptions).toHaveBeenCalledWith("org-1");
    // Teams from another org must not appear in the response
    expect(body.details.teams).toEqual(ORG_TEAMS);
    // The response must not include any teams that were NOT returned by listTeamOptions for org-1
    const teamIds = (body.details.teams as Array<{ id: string }>).map(
      (t) => t.id
    );
    for (const teamId of teamIds) {
      expect([ORG_TEAM_A.id, ORG_TEAM_B.id]).toContain(teamId);
    }
  });

  // Case 9: org has no teams → 400, empty roster, guidance names web app not API
  it("returns empty team list and web-app guidance when the org has no teams", async () => {
    mocks.listTeamOptions.mockResolvedValue([]);

    const response = await POST(postRequest({ name: "Proj" }), routeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual([]);
    expect(body.error).toContain("no teams");
    expect(body.error).toContain("API keys cannot create teams");
    // Must not direct the caller to an API endpoint
    expect(body.error).not.toContain("/api/");
    expect(body.error).not.toContain("POST /");
    expect(body.error).not.toContain("GET /");
  });

  // Case 10: both name and teamIds fail → ONE 400 that names both problems
  it("includes both the team problem and the name problem in a single 400", async () => {
    const response = await POST(
      postRequest({ name: "", teamIds: [] }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    // Team roster is present because the team problem earns it
    expect(body.details.teams).toEqual(ORG_TEAMS);
    // The name problem is also surfaced in the same message
    expect(body.error).toContain("Also invalid");
    expect(body.error).toContain("name");
  });

  // Case 11: service rejects with Unresolved → 400 + team list, rejected id absent
  it("returns team list when service rejects because the team id does not resolve, without echoing the rejected id", async () => {
    mocks.create.mockRejectedValueOnce(
      new InvalidProjectTeamsError(
        "One or more teams were not found in this organization.",
        InvalidProjectTeamsReason.Unresolved
      )
    );

    const response = await POST(
      postRequest({ name: "Proj", teamIds: [VALID_TEAM_UUID] }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual(ORG_TEAMS);
    // The rejected team id must not appear anywhere in the response (anti-enumeration)
    expect(JSON.stringify(body)).not.toContain(VALID_TEAM_UUID);
  });

  // Case 12: service rejects with OverCap → 400 with cap message, no team roster
  it("returns cap-exceeded 400 without team list when the team count limit is exceeded", async () => {
    mocks.create.mockRejectedValueOnce(
      new InvalidProjectTeamsError(
        "A project can be linked to at most 100 teams.",
        InvalidProjectTeamsReason.OverCap
      )
    );

    const response = await POST(
      postRequest({ name: "Proj", teamIds: [VALID_TEAM_UUID] }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).not.toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details).toBeUndefined();
    expect(body.error).toContain("at most");
  });

  // Case 13: malformed JSON → 400 "Invalid JSON body", no team roster
  it("returns Invalid JSON body for malformed request body without team remediation", async () => {
    const request = new NextRequest("http://localhost:3002/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json }",
    });

    const response = await POST(request, routeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
    expect(body.code).toBeUndefined();
    expect(body.details).toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // Case 15 (ISS-9487): the service's assignee refusal reaches the caller as a
  // 400 carrying the message the refusal itself carries.
  it("maps a refused create to 400 with the service's message", async () => {
    mocks.create.mockResolvedValueOnce(
      Result.err({
        status: Status.BadRequest,
        message: SERVICE_REFUSAL_MESSAGE,
      })
    );

    const response = await POST(
      postRequest({
        name: "Proj",
        teamIds: [VALID_TEAM_UUID],
        assigneeId: FOREIGN_USER_UUID,
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe(SERVICE_REFUSAL_MESSAGE);
    // No team roster: the remediation a team refusal earns cannot fix this one.
    expect(body.details).toBeUndefined();
  });
});

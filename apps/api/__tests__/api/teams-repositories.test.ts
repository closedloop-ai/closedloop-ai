import { TeamRole } from "@repo/api/src/types/teams";
import { v7 as uuidv7 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTeamRepository } from "@/__tests__/support/teams/team.test-fixtures";
import { GET, POST } from "@/app/teams/[teamId]/repositories/route";
import { AddRepositoryError, teamsService } from "@/app/teams/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/teams/service");

describe("GET /teams/:teamId/repositories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: {
        ...createTestAuthContext().user,
        id: "user-1",
        organizationId: "org-1",
      },
    });
    // `clearAllMocks` does not reset implementations, so this default must be
    // set per-block rather than inherited from a sibling describe.
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(true);
  });

  it("returns repositories for a team member", async () => {
    const repos = [buildTeamRepository({ isPrimary: true })];
    vi.mocked(teamsService.getRepositories).mockResolvedValue(repos);

    const request = createMockRequest({
      url: "http://localhost:3002/teams/team-1/repositories",
    });
    const response = await GET(
      request,
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(teamsService.getRepositories).toHaveBeenCalledWith("team-1");
  });

  // ISS-5095: the repo pool inherits the org-readable visibility of the team and
  // project that link to it. `isMember` is FALSE here and the read still
  // succeeds — this is the exact persona (org member, not on this team) whose
  // 403 blanked the workspace with a false "Your session expired".
  it("returns repositories for an org member who is NOT a team member", async () => {
    const repos = [buildTeamRepository({ isPrimary: true })];
    vi.mocked(teamsService.isMember).mockResolvedValue(false);
    vi.mocked(teamsService.getRepositories).mockResolvedValue(repos);

    const response = await GET(
      createMockRequest(),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(teamsService.getRepositories).toHaveBeenCalledWith("team-1");
  });

  // The membership check must be gone, not merely satisfied: a lingering call
  // would mean the gate is still wired and one refactor away from returning.
  it("does not consult team membership at all", async () => {
    vi.mocked(teamsService.getRepositories).mockResolvedValue([]);

    const response = await GET(
      createMockRequest(),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(200);
    expect(teamsService.isMember).not.toHaveBeenCalled();
  });

  it("maps a team the caller cannot see to 404", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

    const response = await GET(
      createMockRequest(),
      createMockRouteContext({ teamId: "missing" })
    );

    expect(response.status).toBe(404);
    expect(teamsService.getRepositories).not.toHaveBeenCalled();
  });

  // ISS-5095 widened this read from team-membership to org scope; the ORG
  // boundary is what remains, so it is pinned explicitly. A team that exists but
  // belongs to another organization is not found for this caller — the lookup is
  // scoped by the caller's own `organizationId`, never a client-supplied one —
  // and no repository row is read.
  it("maps an unseeable team to 404 and never reads its repos", async () => {
    // The probe is org-scoped, so an out-of-org team resolves to false. The
    // cross-org guarantee itself is proven in
    // `app/teams/__tests__/service-org-scoping.test.ts` — this asserts only the
    // route's mapping (`apps/api/AGENTS.md`).
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

    const response = await GET(
      createMockRequest(),
      createMockRouteContext({ teamId: "team-in-org-2" })
    );

    expect(response.status).toBe(404);
    expect(teamsService.existsInOrganization).toHaveBeenCalledWith(
      "team-in-org-2",
      "org-1"
    );
    expect(teamsService.getRepositories).not.toHaveBeenCalled();
  });

  it("returns 500 on service failure", async () => {
    vi.mocked(teamsService.getRepositories).mockRejectedValue(
      new Error("Database error")
    );

    const response = await GET(
      createMockRequest(),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(500);
  });
});

describe("POST /teams/:teamId/repositories", () => {
  const installationRepositoryId = uuidv7();

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: {
        ...createTestAuthContext().user,
        id: "user-1",
        organizationId: "org-1",
      },
    });
    // `clearAllMocks` does not reset implementations, so this default must be
    // set per-block rather than inherited from a sibling describe.
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(true);
  });

  it("adds a repository with valid data", async () => {
    const created = buildTeamRepository({ installationRepositoryId });
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.addRepository).mockResolvedValue({
      ok: true,
      value: created,
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId, isDefaultSelected: true },
      }),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(200);
    expect(teamsService.hasRole).toHaveBeenCalledWith({
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      requiredRole: TeamRole.Admin,
    });
    expect(teamsService.addRepository).toHaveBeenCalledWith("team-1", "org-1", {
      installationRepositoryId,
      isDefaultSelected: true,
    });
  });

  it("returns 403 when caller is not admin", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId },
      }),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(403);
    expect(teamsService.addRepository).not.toHaveBeenCalled();
  });

  it("maps a team the caller cannot see to 404", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId },
      }),
      createMockRouteContext({ teamId: "missing" })
    );

    expect(response.status).toBe(404);
    expect(teamsService.addRepository).not.toHaveBeenCalled();
  });

  it("returns 400 on validation error", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId: "not-a-uuid" },
      }),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(400);
    expect(teamsService.addRepository).not.toHaveBeenCalled();
  });

  it("returns 400 when repo is not in org installations", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.addRepository).mockResolvedValue({
      ok: false,
      error: AddRepositoryError.RepoNotAvailable,
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId },
      }),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe(
      "Repository is not available for this organization"
    );
  });

  it("returns 409 when repo is already added", async () => {
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);
    vi.mocked(teamsService.addRepository).mockResolvedValue({
      ok: false,
      error: AddRepositoryError.AlreadyAdded,
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: { installationRepositoryId },
      }),
      createMockRouteContext({ teamId: "team-1" })
    );

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toBe("Repository is already added to this team");
  });
});

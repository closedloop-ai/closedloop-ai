import { TeamRole } from "@repo/api/src/types/teams";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { teamsService } from "@/app/teams/service";
import { requireTeamRole } from "./require-team-role";

/**
 * ISS-7533 — the guard's contract, including the ORDERING the ticket is about.
 *
 * The org-predicate guarantees themselves are proven against the real service in
 * `__tests__/service-org-scoping.test.ts`; this suite mocks the service because
 * what it pins is the guard's own decision sequence, which no service-level test
 * can see.
 */

vi.mock("@/app/teams/service", () => ({
  teamsService: {
    existsInOrganization: vi.fn(),
    hasRole: vi.fn(),
  },
}));

const USER = { id: "user-1", organizationId: "org-1" };

describe("requireTeamRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears a caller who meets the role floor", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(true);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);

    const result = await requireTeamRole("team-1", USER, TeamRole.Admin);

    expect(result).toBeNull();
    expect(teamsService.existsInOrganization).toHaveBeenCalledWith(
      "team-1",
      "org-1"
    );
    expect(teamsService.hasRole).toHaveBeenCalledWith({
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      requiredRole: TeamRole.Admin,
    });
    // The cleared path stays at two round-trips; the deny-path re-probe below
    // must not leak onto it.
    expect(teamsService.existsInOrganization).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for a team the caller cannot see, WITHOUT consulting the role", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(false);

    const response = await requireTeamRole("team-1", USER, TeamRole.Admin);

    expect(response?.status).toBe(404);
    const json = await response?.json();
    expect(json.error).toBe("Team not found");
    // The whole point of the guard: the org check runs FIRST. Wire a call site
    // role-gate-first and this assertion is the one that fails.
    expect(teamsService.hasRole).not.toHaveBeenCalled();
  });

  it("answers 403 for a visible team when the role floor is unmet", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(true);
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const response = await requireTeamRole("team-1", USER, TeamRole.Owner);

    expect(response?.status).toBe(403);
    const json = await response?.json();
    expect(json.error).toBe("Forbidden");
    // 403 is only correct once the team is confirmed still there — the deny
    // path re-reads before it accuses the caller of a role failure.
    expect(teamsService.existsInOrganization).toHaveBeenCalledTimes(2);
  });

  it("answers 404 when the team vanishes between the probe and the role gate", async () => {
    vi.mocked(teamsService.existsInOrganization)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.mocked(teamsService.hasRole).mockResolvedValue(false);

    const response = await requireTeamRole("team-1", USER, TeamRole.Owner);

    // `hasRole` returns a bare false for two different reasons. Here it means
    // "no membership row because the team is gone", not "role floor unmet", and
    // 403 would contradict the 404 this guard promises for a team the caller
    // cannot see. Drop the re-probe and this case is the one that reddens.
    expect(response?.status).toBe(404);
    const json = await response?.json();
    expect(json.error).toBe("Team not found");
  });

  it("passes the requested role through rather than a fixed floor", async () => {
    vi.mocked(teamsService.existsInOrganization).mockResolvedValue(true);
    vi.mocked(teamsService.hasRole).mockResolvedValue(true);

    await requireTeamRole("team-9", USER, TeamRole.Owner);

    expect(teamsService.hasRole).toHaveBeenCalledWith(
      expect.objectContaining({ requiredRole: TeamRole.Owner })
    );
  });
});

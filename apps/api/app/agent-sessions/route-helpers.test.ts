import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  isMember: vi.fn(),
  isOrgAdmin: vi.fn(),
}));

vi.mock("@/app/teams/service", () => ({
  teamsService: {
    findById: mocks.findById,
    isMember: mocks.isMember,
  },
}));

vi.mock("@/lib/auth/org-admin", () => ({
  isOrgAdmin: mocks.isOrgAdmin,
}));

vi.mock("@/lib/agent-session-sync-feature", () => ({
  isAgentMonitoringEnabledForUser: vi.fn(),
}));

import { isAgentMonitoringEnabledForUser } from "@/lib/agent-session-sync-feature";
import { authorizeAgentSessionTeamScope } from "./route-helpers";

const AUTH_INPUT = {
  organizationId: "019f0fcb-8336-7c4d-9f64-528fb9520c30",
  userId: "019f0fcb-8336-7c4d-9f64-528fb9520c31",
  clerkOrgId: "org_clerk_1",
  clerkUserId: "user_clerk_1",
} as const;

describe("authorizeAgentSessionTeamScope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAgentMonitoringEnabledForUser).mockResolvedValue(true);
  });

  it("allows non-team requests without team lookup", async () => {
    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: {},
      })
    ).resolves.toBe(true);

    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it("denies explicit team scope without a team id before lookup", async () => {
    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { viewerScope: AgentSessionViewerScope.Team },
      })
    ).resolves.toBe(false);

    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it("allows a team member for explicit team scope", async () => {
    mocks.findById.mockResolvedValueOnce({ id: "team-1" });
    mocks.isMember.mockResolvedValueOnce(true);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: {
          viewerScope: AgentSessionViewerScope.Team,
          teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32",
        },
      })
    ).resolves.toBe(true);

    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
  });

  it("applies the same policy to legacy bare teamId requests", async () => {
    mocks.findById.mockResolvedValueOnce({ id: "team-1" });
    mocks.isMember.mockResolvedValueOnce(true);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32" },
      })
    ).resolves.toBe(true);
  });

  it("denies team requests when monitoring is disabled before team lookup", async () => {
    vi.mocked(isAgentMonitoringEnabledForUser).mockResolvedValueOnce(false);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32" },
      })
    ).resolves.toBe(false);

    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it("allows org admins when they are not team members", async () => {
    mocks.findById.mockResolvedValueOnce({ id: "team-1" });
    mocks.isMember.mockResolvedValueOnce(false);
    mocks.isOrgAdmin.mockResolvedValueOnce(true);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32" },
      })
    ).resolves.toBe(true);
  });

  it("fails closed for foreign teams and non-members", async () => {
    mocks.findById.mockResolvedValueOnce(null);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32" },
      })
    ).resolves.toBe(false);

    mocks.findById.mockResolvedValueOnce({ id: "team-1" });
    mocks.isMember.mockResolvedValueOnce(false);
    mocks.isOrgAdmin.mockResolvedValueOnce(false);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32" },
      })
    ).resolves.toBe(false);
  });
});

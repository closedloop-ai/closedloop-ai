import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsInOrganization: vi.fn(),
  isMember: vi.fn(),
  getOrgAdminStatus: vi.fn(),
}));

vi.mock("@/app/teams/service", () => ({
  teamsService: {
    existsInOrganization: mocks.existsInOrganization,
    isMember: mocks.isMember,
  },
}));

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));

import {
  ORG_ADMIN_STATUS_ADMIN,
  ORG_ADMIN_STATUS_NOT_ADMIN,
} from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import { TeamScopeAuthorization } from "@/lib/team-scope-policy";
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
  });

  it("allows non-team requests without team lookup", async () => {
    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: {},
      })
    ).resolves.toBe(TeamScopeAuthorization.Allowed);

    expect(mocks.existsInOrganization).not.toHaveBeenCalled();
  });

  it("denies explicit team scope without a team id before lookup", async () => {
    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { viewerScope: AgentSessionViewerScope.Team },
      })
    ).resolves.toBe(TeamScopeAuthorization.Denied);

    expect(mocks.existsInOrganization).not.toHaveBeenCalled();
  });

  it("allows a team member for explicit team scope", async () => {
    mocks.existsInOrganization.mockResolvedValueOnce(true);
    mocks.isMember.mockResolvedValueOnce(true);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: {
          viewerScope: AgentSessionViewerScope.Team,
          teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32",
        },
      })
    ).resolves.toBe(TeamScopeAuthorization.Allowed);

    expect(mocks.getOrgAdminStatus).not.toHaveBeenCalled();
  });

  it("applies the same policy to legacy bare teamId requests", async () => {
    mocks.existsInOrganization.mockResolvedValueOnce(true);
    mocks.isMember.mockResolvedValueOnce(true);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32" },
      })
    ).resolves.toBe(TeamScopeAuthorization.Allowed);
  });

  // FEA-4155 (whitlockk review #3789): team-scope authorization no longer consults
  // the winding-down `DESKTOP_AGENT_SESSION_SYNC` monitoring flag, so an in-team
  // request goes straight to team membership + org-admin RBAC. It must not fail
  // closed on that flag as it winds down.
  it("authorizes an in-team request on membership alone, no monitoring gate (FEA-4155)", async () => {
    mocks.existsInOrganization.mockResolvedValueOnce(true);
    mocks.isMember.mockResolvedValueOnce(true);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32" },
      })
    ).resolves.toBe(TeamScopeAuthorization.Allowed);

    expect(mocks.existsInOrganization).toHaveBeenCalledWith(
      "019f0fcb-8336-7c4d-9f64-528fb9520c32",
      AUTH_INPUT.organizationId
    );
  });

  it("allows org admins when they are not team members", async () => {
    mocks.existsInOrganization.mockResolvedValueOnce(true);
    mocks.isMember.mockResolvedValueOnce(false);
    mocks.getOrgAdminStatus.mockResolvedValueOnce(ORG_ADMIN_STATUS_ADMIN);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32" },
      })
    ).resolves.toBe(TeamScopeAuthorization.Allowed);
  });

  it("fails closed for foreign teams and non-members", async () => {
    mocks.existsInOrganization.mockResolvedValueOnce(false);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32" },
      })
    ).resolves.toBe(TeamScopeAuthorization.Denied);

    mocks.existsInOrganization.mockResolvedValueOnce(true);
    mocks.isMember.mockResolvedValueOnce(false);
    mocks.getOrgAdminStatus.mockResolvedValueOnce(ORG_ADMIN_STATUS_NOT_ADMIN);

    await expect(
      authorizeAgentSessionTeamScope({
        ...AUTH_INPUT,
        filters: { teamId: "019f0fcb-8336-7c4d-9f64-528fb9520c32" },
      })
    ).resolves.toBe(TeamScopeAuthorization.Denied);
  });
});

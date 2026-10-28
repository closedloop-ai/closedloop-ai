/**
 * ISS-8661 — a team-scoped read whose org-admin FALLBACK could not be READ
 * answers 503, not 403.
 *
 * `authorizeTeamScopeRead`'s own unit test pins the VERDICT enum
 * (`lib/__tests__/team-scope-policy.test.ts`); this pins what that verdict
 * becomes on the wire. Neither substitutes for the other: reverting
 * `TEAM_SCOPE_REFUSALS[Unresolved]` to `forbiddenResponse()` leaves the verdict
 * test green and restores the defect for every team-scoped read.
 *
 * The paired `not_admin` case is what keeps the two statuses from drifting into
 * each other's meaning — without it, a mapping that answered 503 for every
 * refusal would pass.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  existsInOrganization: vi.fn(),
  isMember: vi.fn(),
  getOrgAdminStatus: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params ?? Promise.resolve({})),
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

vi.mock("./service", () => ({
  agentSessionsService: {
    findExportRows: vi.fn(),
    findSessions: vi.fn(),
    getAnalytics: vi.fn(),
    getUsageSummary: vi.fn(),
  },
}));

import {
  ORG_ADMIN_STATUS_NOT_ADMIN,
  ORG_ADMIN_STATUS_PROVIDER_ERROR,
} from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import { OrgAdminGateErrorCode } from "@/lib/auth/org-admin-denial";
import { GET as getList } from "./route";
import { agentSessionsService } from "./service";

const TEAM_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c32";

function invoke() {
  return getList(
    createMockRequest({
      url: `https://api.example.test/agent-sessions?viewerScope=team&teamId=${TEAM_ID}`,
    }),
    createMockRouteContext({})
  );
}

describe("team-scoped read — unresolved org-admin fallback is not a denial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mocks.existsInOrganization.mockResolvedValue(true);
    // Forces the request through the org-admin fallback rather than the
    // membership short-circuit, which never reaches the role lookup.
    mocks.isMember.mockResolvedValue(false);
  });

  it("answers 503 role_unresolved when the role could not be read", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_PROVIDER_ERROR);

    const response = await invoke();

    expect(response.status).toBe(503);
    expect(response.status).not.toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: OrgAdminGateErrorCode.RoleUnresolved,
    });
    // Still fails CLOSED: no session data is read on an unresolved role.
    expect(agentSessionsService.findSessions).not.toHaveBeenCalled();
  });

  it("keeps 403 when the role resolved and denied", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);

    const response = await invoke();

    expect(response.status).toBe(403);
    expect(agentSessionsService.findSessions).not.toHaveBeenCalled();
  });
});

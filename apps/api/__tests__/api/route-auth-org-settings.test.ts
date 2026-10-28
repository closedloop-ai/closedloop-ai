/**
 * ISS-11409: the organization, team, user and settings reads Daveth moved from
 * `withAuth` to `withAnyAuth`.
 *
 * Runs the REAL auth wrappers; only the identity primitives underneath them
 * are replaced (see `route-auth-callers.test-helpers`). Each handler's first
 * org-scoped dependency is spied on, so a case proves the handler ran on
 * behalf of the caller the wrapper resolved, not merely that it answered.
 */
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { beforeEach, describe, vi } from "vitest";
import {
  API_KEY_IDENTITY,
  type CallerIdentity,
  DESKTOP_IDENTITY,
  installCallerIdentities,
  itAuthenticatesMovedHandler,
  probe,
  type RouteHandler,
  registerLookupUser,
  SESSION_IDENTITY,
  userFor,
} from "@/__tests__/support/auth/route-auth-callers.test-helpers";

vi.mock("@repo/auth/server", async () =>
  (
    await import("@/__tests__/support/auth/route-auth-primitives.test-mocks")
  ).routeAuthModuleMocks.clerkServer()
);
vi.mock("@/lib/auth/find-or-create-user", async () =>
  (
    await import("@/__tests__/support/auth/route-auth-primitives.test-mocks")
  ).routeAuthModuleMocks.findOrCreateUser()
);
vi.mock("@/lib/auth/desktop-session-auth", async () =>
  (
    await import("@/__tests__/support/auth/route-auth-primitives.test-mocks")
  ).routeAuthModuleMocks.desktopSessionAuth()
);
vi.mock("@/lib/auth/desktop-managed-pop", async (importOriginal) =>
  (
    await import("@/__tests__/support/auth/route-auth-primitives.test-mocks")
  ).routeAuthModuleMocks.desktopManagedPop(importOriginal)
);
vi.mock("@vercel/functions", async (importOriginal) =>
  (
    await import("@/__tests__/support/auth/route-auth-primitives.test-mocks")
  ).routeAuthModuleMocks.vercelFunctions(importOriginal)
);

import { GET as getOrganization } from "@/app/organizations/[id]/route";
import { GET as getOrganizations } from "@/app/organizations/route";
import { organizationsService } from "@/app/organizations/service";
import { GET as getPenseroInfo } from "@/app/settings/pensero/route";
import { penseroIntegrationService } from "@/app/settings/pensero-integration-service";
import { GET as getTeamMembers } from "@/app/teams/[teamId]/members/route";
import { GET as getTeamRepositories } from "@/app/teams/[teamId]/repositories/route";
import { GET as getTeam } from "@/app/teams/[teamId]/route";
import { teamsService } from "@/app/teams/service";
import { GET as getUser } from "@/app/users/[id]/route";
import { usersService } from "@/app/users/service";
import { notFoundResponse, successResponse } from "@/lib/route-utils";

const TEAM_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_USER_ID = "user-lookup-target";
const UNSET_PENSERO_INFO = {
  isSet: false,
  lastFour: null,
  baseUrl: null,
  teamIdentifiers: [],
  setAt: null,
};

function organizationDetail(organizationId: string) {
  return {
    id: organizationId,
    clerkId: `clerk_${organizationId}`,
    name: `Org ${organizationId}`,
  };
}

/** The user `GET /users/[id]` looks up, in the caller's own organization. */
function lookupTarget(organizationId: string): CallerIdentity {
  return {
    userId: TARGET_USER_ID,
    organizationId,
    clerkUserId: `clerk_${TARGET_USER_ID}`,
    clerkOrgId: `clerk_${organizationId}`,
  };
}

function asHandler(handler: unknown): RouteHandler {
  return handler as RouteHandler;
}

describe("ISS-11409 org, team, user and settings reads moved to withAnyAuth", () => {
  beforeEach(() => {
    installCallerIdentities();
    vi.spyOn(organizationsService, "findDetailById").mockImplementation(
      (id: string) => Promise.resolve(organizationDetail(id) as never)
    );
    vi.spyOn(teamsService, "findById").mockResolvedValue(null as never);
    vi.spyOn(teamsService, "existsInOrganization").mockResolvedValue(false);
    vi.spyOn(
      penseroIntegrationService,
      "getOrgCredentialInfo"
    ).mockResolvedValue(UNSET_PENSERO_INFO as never);
  });

  itAuthenticatesMovedHandler({
    name: "GET /organizations",
    handler: asHandler(getOrganizations),
    request: { method: "GET", path: "/organizations" },
    requiredScopes: [ApiKeyScope.Read],
    reachedResponse: (identity) =>
      successResponse([organizationDetail(identity.organizationId)]),
    ranAs: (identity) => [
      probe(organizationsService.findDetailById, identity.organizationId),
    ],
  });

  itAuthenticatesMovedHandler({
    name: "GET /organizations/[id]",
    handler: asHandler(getOrganization),
    request: { method: "GET", path: "/organizations/own" },
    params: (identity) => ({ id: identity.organizationId }),
    requiredScopes: [ApiKeyScope.Read],
    reachedResponse: (identity) =>
      successResponse(organizationDetail(identity.organizationId)),
    ranAs: (identity) => [
      probe(organizationsService.findDetailById, identity.organizationId),
    ],
  });

  itAuthenticatesMovedHandler({
    name: "GET /users/[id]",
    handler: asHandler(getUser),
    request: { method: "GET", path: `/users/${TARGET_USER_ID}` },
    params: () => ({ id: TARGET_USER_ID }),
    arrange: () => {
      for (const caller of [
        SESSION_IDENTITY,
        API_KEY_IDENTITY,
        DESKTOP_IDENTITY,
      ]) {
        registerLookupUser(lookupTarget(caller.organizationId));
      }
    },
    requiredScopes: [ApiKeyScope.Read],
    reachedResponse: (identity) =>
      successResponse(userFor(lookupTarget(identity.organizationId))),
    ranAs: (identity) => [
      probe(usersService.findById, TARGET_USER_ID, identity.organizationId),
    ],
  });

  itAuthenticatesMovedHandler({
    name: "GET /teams/[teamId]",
    handler: asHandler(getTeam),
    request: { method: "GET", path: `/teams/${TEAM_ID}` },
    params: () => ({ teamId: TEAM_ID }),
    requiredScopes: [ApiKeyScope.Read],
    reachedResponse: () => notFoundResponse("Team"),
    ranAs: (identity) => [
      probe(teamsService.findById, TEAM_ID, identity.organizationId),
    ],
  });

  itAuthenticatesMovedHandler({
    name: "GET /teams/[teamId]/members",
    handler: asHandler(getTeamMembers),
    request: { method: "GET", path: `/teams/${TEAM_ID}/members` },
    params: () => ({ teamId: TEAM_ID }),
    requiredScopes: [ApiKeyScope.Read],
    reachedResponse: () => notFoundResponse("Team"),
    ranAs: (identity) => [
      probe(
        teamsService.existsInOrganization,
        TEAM_ID,
        identity.organizationId
      ),
    ],
  });

  itAuthenticatesMovedHandler({
    name: "GET /teams/[teamId]/repositories",
    handler: asHandler(getTeamRepositories),
    request: { method: "GET", path: `/teams/${TEAM_ID}/repositories` },
    params: () => ({ teamId: TEAM_ID }),
    requiredScopes: [ApiKeyScope.Read],
    reachedResponse: () => notFoundResponse("Team"),
    ranAs: (identity) => [
      probe(
        teamsService.existsInOrganization,
        TEAM_ID,
        identity.organizationId
      ),
    ],
  });

  itAuthenticatesMovedHandler({
    name: "GET /settings/pensero",
    handler: asHandler(getPenseroInfo),
    request: { method: "GET", path: "/settings/pensero" },
    requiredScopes: [ApiKeyScope.Read],
    reachedResponse: () => successResponse(UNSET_PENSERO_INFO),
    ranAs: (identity) => [
      probe(
        penseroIntegrationService.getOrgCredentialInfo,
        identity.organizationId
      ),
    ],
  });
});

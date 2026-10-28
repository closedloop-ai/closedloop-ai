/**
 * ISS-11409: the handlers Daveth ruled session-only. Neither an `sk_live_` API
 * key nor a Desktop session token may reach them; each answers 401 before its
 * body runs, and the API-key verifier and Desktop token resolver are never
 * consulted.
 *
 * ISS-11795 adds `POST /documents/merge` and `POST /integrations/linear/export`:
 * each makes a paid server-side Anthropic call on ClosedLoop's own key, so a
 * key or Desktop token must be refused before that call can start, while a
 * signed-in session is still served.
 *
 * Runs the REAL auth wrappers (see `route-auth-callers.test-helpers`). The
 * rule's `SESSION_ONLY_HANDLERS` declares the same set; moving one of these to
 * `withAnyAuth` without a new ruling fails here.
 */
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CallerCredential,
  CallerKind,
  installCallerIdentities,
  itRefusesNonSessionCallers,
  type RouteHandler,
  type RouteRequest,
  requestAs,
  SESSION_IDENTITY,
  snapshot,
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

import { DELETE as deleteApiKey } from "@/app/api-keys/[id]/route";
import { POST as createApiKey, GET as listApiKeys } from "@/app/api-keys/route";
import { POST as postMerge } from "@/app/documents/merge/route";
import { documentMergeService } from "@/app/documents/merge-service";
import { POST as postConfirmGithubReset } from "@/app/integrations/github/connect/confirm-reset/route";
import { POST as postGithubConnect } from "@/app/integrations/github/connect/route";
import { POST as postGoogleConnect } from "@/app/integrations/google/connect/route";
import { POST as postLinearConnect } from "@/app/integrations/linear/connect/route";
import { POST as postLinearExport } from "@/app/integrations/linear/export/route";
import { linearService } from "@/app/integrations/linear/service";
import { PUT as putOrganization } from "@/app/organizations/[id]/route";
import {
  DELETE as deletePublicKey,
  POST as registerPublicKey,
} from "@/app/public-keys/route";
import {
  DELETE as deleteOrgClaudeKey,
  PUT as putOrgClaudeKey,
} from "@/app/settings/api-keys/org/route";
import {
  DELETE as deleteUserClaudeKey,
  PUT as putUserClaudeKey,
} from "@/app/settings/api-keys/user/route";
import { PUT as putComputeMode } from "@/app/settings/compute-mode/route";
import { PUT as putFrustration } from "@/app/settings/frustration/route";
import {
  DELETE as deletePensero,
  PUT as putPensero,
} from "@/app/settings/pensero/route";
import {
  DELETE as deleteTeamMember,
  PUT as putTeamMember,
} from "@/app/teams/[teamId]/members/[userId]/route";
import { POST as addTeamMember } from "@/app/teams/[teamId]/members/route";
import {
  DELETE as deleteTeamRepository,
  PUT as putTeamRepository,
} from "@/app/teams/[teamId]/repositories/[teamRepositoryId]/route";
import { POST as addTeamRepository } from "@/app/teams/[teamId]/repositories/route";
import {
  DELETE as deleteTeam,
  PUT as putTeam,
} from "@/app/teams/[teamId]/route";
import { POST as createTeam } from "@/app/teams/route";
import { PUT as putUser } from "@/app/users/[id]/route";
import {
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

const ID = "12121212-1212-4121-8121-121212121212";
const OTHER_ID = "34343434-3434-4343-8343-343434343434";
const LINEAR_TEAM_ID = "linear-team-1";
const MERGED_DOCUMENT = { id: ID, title: "Merged" };

const MERGE_REQUEST: RouteRequest = {
  method: "POST",
  path: "/documents/merge",
  body: { primaryDocumentId: ID, secondaryDocumentId: OTHER_ID },
};
const LINEAR_EXPORT_REQUEST: RouteRequest = {
  method: "POST",
  path: "/integrations/linear/export",
  body: { documentId: ID, teamId: LINEAR_TEAM_ID },
};

function asHandler(handler: unknown): RouteHandler {
  return handler as RouteHandler;
}

describe("ISS-11409 and ISS-11795 session-only handlers refuse API keys and Desktop tokens", () => {
  beforeEach(() => {
    installCallerIdentities();
  });

  const cases: {
    name: string;
    handler: unknown;
    method: string;
    path: string;
    params?: Record<string, string>;
  }[] = [
    {
      name: "GET /api-keys",
      handler: listApiKeys,
      method: "GET",
      path: "/api-keys",
    },
    {
      name: "POST /api-keys",
      handler: createApiKey,
      method: "POST",
      path: "/api-keys",
    },
    {
      name: "DELETE /api-keys/[id]",
      handler: deleteApiKey,
      method: "DELETE",
      path: `/api-keys/${ID}`,
      params: { id: ID },
    },
    {
      name: "POST /public-keys",
      handler: registerPublicKey,
      method: "POST",
      path: "/public-keys",
    },
    {
      name: "DELETE /public-keys",
      handler: deletePublicKey,
      method: "DELETE",
      path: "/public-keys?fingerprint=abc",
    },
    {
      name: "PUT /settings/api-keys/org",
      handler: putOrgClaudeKey,
      method: "PUT",
      path: "/settings/api-keys/org",
    },
    {
      name: "DELETE /settings/api-keys/org",
      handler: deleteOrgClaudeKey,
      method: "DELETE",
      path: "/settings/api-keys/org",
    },
    {
      name: "PUT /settings/api-keys/user",
      handler: putUserClaudeKey,
      method: "PUT",
      path: "/settings/api-keys/user",
    },
    {
      name: "DELETE /settings/api-keys/user",
      handler: deleteUserClaudeKey,
      method: "DELETE",
      path: "/settings/api-keys/user",
    },
    {
      name: "PUT /settings/pensero",
      handler: putPensero,
      method: "PUT",
      path: "/settings/pensero",
    },
    {
      name: "DELETE /settings/pensero",
      handler: deletePensero,
      method: "DELETE",
      path: "/settings/pensero",
    },
    {
      name: "POST /integrations/github/connect",
      handler: postGithubConnect,
      method: "POST",
      path: "/integrations/github/connect",
    },
    {
      name: "POST /integrations/github/connect/confirm-reset",
      handler: postConfirmGithubReset,
      method: "POST",
      path: "/integrations/github/connect/confirm-reset",
    },
    {
      name: "POST /integrations/google/connect",
      handler: postGoogleConnect,
      method: "POST",
      path: "/integrations/google/connect",
    },
    {
      name: "POST /integrations/linear/connect",
      handler: postLinearConnect,
      method: "POST",
      path: "/integrations/linear/connect",
    },
    {
      name: "PUT /settings/frustration",
      handler: putFrustration,
      method: "PUT",
      path: "/settings/frustration",
    },
    {
      name: "POST /teams",
      handler: createTeam,
      method: "POST",
      path: "/teams",
    },
    {
      name: "PUT /teams/[teamId]",
      handler: putTeam,
      method: "PUT",
      path: `/teams/${ID}`,
      params: { teamId: ID },
    },
    {
      name: "DELETE /teams/[teamId]",
      handler: deleteTeam,
      method: "DELETE",
      path: `/teams/${ID}`,
      params: { teamId: ID },
    },
    {
      name: "POST /teams/[teamId]/members",
      handler: addTeamMember,
      method: "POST",
      path: `/teams/${ID}/members`,
      params: { teamId: ID },
    },
    {
      name: "PUT /teams/[teamId]/members/[userId]",
      handler: putTeamMember,
      method: "PUT",
      path: `/teams/${ID}/members/${OTHER_ID}`,
      params: { teamId: ID, userId: OTHER_ID },
    },
    {
      name: "DELETE /teams/[teamId]/members/[userId]",
      handler: deleteTeamMember,
      method: "DELETE",
      path: `/teams/${ID}/members/${OTHER_ID}`,
      params: { teamId: ID, userId: OTHER_ID },
    },
    {
      name: "POST /teams/[teamId]/repositories",
      handler: addTeamRepository,
      method: "POST",
      path: `/teams/${ID}/repositories`,
      params: { teamId: ID },
    },
    {
      name: "PUT /teams/[teamId]/repositories/[teamRepositoryId]",
      handler: putTeamRepository,
      method: "PUT",
      path: `/teams/${ID}/repositories/${OTHER_ID}`,
      params: { teamId: ID, teamRepositoryId: OTHER_ID },
    },
    {
      name: "DELETE /teams/[teamId]/repositories/[teamRepositoryId]",
      handler: deleteTeamRepository,
      method: "DELETE",
      path: `/teams/${ID}/repositories/${OTHER_ID}`,
      params: { teamId: ID, teamRepositoryId: OTHER_ID },
    },
    {
      name: "PUT /organizations/[id]",
      handler: putOrganization,
      method: "PUT",
      path: `/organizations/${ID}`,
      params: { id: ID },
    },
    {
      name: "PUT /users/[id]",
      handler: putUser,
      method: "PUT",
      path: `/users/${ID}`,
      params: { id: ID },
    },
    {
      name: "PUT /settings/compute-mode",
      handler: putComputeMode,
      method: "PUT",
      path: "/settings/compute-mode",
    },
    {
      name: "POST /documents/merge",
      handler: postMerge,
      method: MERGE_REQUEST.method,
      path: MERGE_REQUEST.path,
    },
    {
      name: "POST /integrations/linear/export",
      handler: postLinearExport,
      method: LINEAR_EXPORT_REQUEST.method,
      path: LINEAR_EXPORT_REQUEST.path,
    },
  ];

  for (const testCase of cases) {
    itRefusesNonSessionCallers({
      name: testCase.name,
      handler: asHandler(testCase.handler),
      request: { method: testCase.method, path: testCase.path },
      params: testCase.params,
    });
  }
});

describe("ISS-11795 paid-AI handlers serve only a signed-in session", () => {
  beforeEach(() => {
    installCallerIdentities();
    vi.spyOn(documentMergeService, "merge").mockResolvedValue(
      Result.ok(MERGED_DOCUMENT) as never
    );
    vi.spyOn(linearService, "exportImplementationPlan").mockResolvedValue({
      success: false,
      status: 404,
      error: "Implementation plan not found",
    } as never);
  });

  const paidCases = [
    {
      name: "POST /documents/merge",
      handler: asHandler(postMerge),
      request: MERGE_REQUEST,
      service: () => documentMergeService.merge,
      sessionResponse: () => successResponse(MERGED_DOCUMENT),
      sessionArgs: [
        ID,
        OTHER_ID,
        SESSION_IDENTITY.organizationId,
        SESSION_IDENTITY.userId,
      ],
    },
    {
      name: "POST /integrations/linear/export",
      handler: asHandler(postLinearExport),
      request: LINEAR_EXPORT_REQUEST,
      service: () => linearService.exportImplementationPlan,
      sessionResponse: () => notFoundResponse("Artifact"),
      sessionArgs: [
        ID,
        LINEAR_TEAM_ID,
        SESSION_IDENTITY.organizationId,
        SESSION_IDENTITY.userId,
      ],
    },
  ];

  const refused: { label: string; credential: CallerCredential }[] = [
    { label: "a full-access API key", credential: { kind: CallerKind.ApiKey } },
    {
      label: "a Desktop session token",
      credential: { kind: CallerKind.DesktopSession },
    },
  ];

  for (const testCase of paidCases) {
    for (const { label, credential } of refused) {
      it(`${testCase.name} answers ${label} as an unauthenticated caller and never starts the paid call`, async () => {
        const response = await testCase.handler(
          requestAs(credential, testCase.request),
          { params: Promise.resolve({}) }
        );

        expect(await snapshot(response)).toEqual(
          await snapshot(unauthorizedResponse())
        );
        expect(testCase.service()).not.toHaveBeenCalled();
      });
    }

    it(`${testCase.name} still serves a Clerk session as the session's organization`, async () => {
      const response = await testCase.handler(
        requestAs({ kind: CallerKind.ClerkSession }, testCase.request),
        { params: Promise.resolve({}) }
      );

      expect(await snapshot(response)).toEqual(
        await snapshot(testCase.sessionResponse())
      );
      expect(testCase.service()).toHaveBeenCalledWith(...testCase.sessionArgs);
    });
  }
});

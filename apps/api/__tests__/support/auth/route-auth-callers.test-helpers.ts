import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { AuthErrorCode } from "@repo/api/src/types/auth-error";
import { ORG_IDENTITY_HEADER } from "@repo/api/src/types/headers";
import type { User } from "@repo/api/src/types/user";
import { DESKTOP_SESSION_JWT_TYP } from "@repo/auth/desktop-session-jwt";
import { ApiKeySource } from "@repo/database";
import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";
import { routeAuthPrimitives } from "@/__tests__/support/auth/route-auth-primitives.test-mocks";
import { ClerkOrgRoleFixture } from "@/__tests__/utils/auth-helpers";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { clerkService } from "@/lib/auth/clerk-service";
import { forbiddenResponse, unauthorizedResponse } from "@/lib/route-utils";

/**
 * Caller identities for route auth suites that run the REAL `withAnyAuth`,
 * `withAuth`, `withApiKeyAuth` and `withDesktopSessionAuth` (ISS-11409).
 *
 * Only the identity primitives underneath those wrappers are replaced: Clerk's
 * `auth()`, `findOrCreateUser`, the Desktop token resolver and the managed-key
 * proof-of-possession check are module mocks the suite declares with
 * `route-auth-primitives.test-mocks`; the API-key, user, organization and Clerk
 * membership services are spied on here. The Desktop token is classified by
 * the real `isDesktopSessionToken`, and a session naming another organization
 * is refused by the real `resolveOrgHeader`.
 */

export const CallerKind = {
  ClerkSession: "clerk-session",
  WrongOrgSession: "wrong-org-session",
  ApiKey: "api-key",
  DesktopSession: "desktop-session",
  Anonymous: "anonymous",
} as const;
export type CallerKind = (typeof CallerKind)[keyof typeof CallerKind];

export type CallerIdentity = {
  userId: string;
  organizationId: string;
  clerkUserId: string;
  clerkOrgId: string;
};

export const SESSION_IDENTITY: CallerIdentity = {
  userId: "user-session",
  organizationId: "org-session",
  clerkUserId: "clerk_user_session",
  clerkOrgId: "clerk_org_session",
};

export const API_KEY_IDENTITY: CallerIdentity = {
  userId: "user-api-key",
  organizationId: "org-api-key",
  clerkUserId: "clerk_user_api_key",
  clerkOrgId: "clerk_org_api_key",
};

export const DESKTOP_IDENTITY: CallerIdentity = {
  userId: "user-desktop",
  organizationId: "org-desktop",
  clerkUserId: "clerk_user_desktop",
  clerkOrgId: "clerk_org_desktop",
};

/** A Clerk organization no caller is a member of. */
export const FOREIGN_CLERK_ORG_ID = "clerk_org_foreign";

const FULL_ACCESS_TOKEN = "sk_live_route_auth_full_access";
const SCOPED_TOKEN_PREFIX = "sk_live_route_auth_scopes_";
const MEMBER_OWNED_TOKEN = "sk_live_route_auth_member_owned";

const FULL_ACCESS_SCOPES: ApiKeyScope[] = [
  ApiKeyScope.Read,
  ApiKeyScope.Write,
  ApiKeyScope.Delete,
];

/** An `sk_live_` token whose key carries exactly `scopes`. */
export function apiKeyTokenWithScopes(scopes: ApiKeyScope[]): string {
  return `${SCOPED_TOKEN_PREFIX}${scopes.join("_")}`;
}

/** Every issuable scope except `missing`, so a check for any of them fails. */
export function scopesWithout(missing: ApiKeyScope[]): ApiKeyScope[] {
  return FULL_ACCESS_SCOPES.filter((scope) => !missing.includes(scope));
}

function scopesForToken(token: string): ApiKeyScope[] | null {
  if (token === FULL_ACCESS_TOKEN || token === MEMBER_OWNED_TOKEN) {
    return FULL_ACCESS_SCOPES;
  }
  if (!token.startsWith(SCOPED_TOKEN_PREFIX)) {
    return null;
  }
  const encoded = token.slice(SCOPED_TOKEN_PREFIX.length);
  return FULL_ACCESS_SCOPES.filter((scope) =>
    encoded.split("_").includes(scope)
  );
}

function base64Url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** The Desktop session token of {@link DESKTOP_IDENTITY}, an org admin. */
export const DESKTOP_SESSION_TOKEN = desktopSessionTokenFor(DESKTOP_IDENTITY);

/** The `User` row the fixtures resolve for `identity`. */
export function userFor(identity: CallerIdentity): User {
  return {
    id: identity.userId,
    organizationId: identity.organizationId,
    clerkId: identity.clerkUserId,
    email: `${identity.userId}@example.com`,
    firstName: "Route",
    lastName: "Caller",
    role: "ENGINEER",
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    avatarUrl: null,
    phoneNumber: null,
    linearId: null,
    slackId: null,
    githubUsername: null,
  };
}

/** The member-owned key's owner: same org as the API key, member role. */
const MEMBER_KEY_OWNER: CallerIdentity = {
  ...API_KEY_IDENTITY,
  userId: "user-api-key-member",
  clerkUserId: "clerk_user_api_key_member",
};

/** A Desktop user in the Desktop org whose Clerk role is member. */
const MEMBER_DESKTOP_IDENTITY: CallerIdentity = {
  ...DESKTOP_IDENTITY,
  userId: "user-desktop-member",
  clerkUserId: "clerk_user_desktop_member",
};

/** A Desktop session token whose user is an org member, not an admin. */
export const MEMBER_DESKTOP_SESSION_TOKEN = desktopSessionTokenFor(
  MEMBER_DESKTOP_IDENTITY
);

const DESKTOP_IDENTITY_BY_TOKEN = new Map<string, CallerIdentity>([
  [DESKTOP_SESSION_TOKEN, DESKTOP_IDENTITY],
  [MEMBER_DESKTOP_SESSION_TOKEN, MEMBER_DESKTOP_IDENTITY],
]);

const NON_ADMIN_CLERK_USER_IDS = new Set([
  MEMBER_KEY_OWNER.clerkUserId,
  MEMBER_DESKTOP_IDENTITY.clerkUserId,
]);

const IDENTITY_USERS = [
  SESSION_IDENTITY,
  API_KEY_IDENTITY,
  DESKTOP_IDENTITY,
  MEMBER_KEY_OWNER,
  MEMBER_DESKTOP_IDENTITY,
];

let currentCaller: CallerKind = CallerKind.Anonymous;

/**
 * Users the handler under test looks up through `usersService.findById`,
 * beyond the caller identities `withApiKeyAuth` resolves.
 */
const extraUsers = new Map<string, User>();

function userKey(userId: string, organizationId: string): string {
  return `${userId}@${organizationId}`;
}

export function registerLookupUser(identity: CallerIdentity): void {
  extraUsers.set(
    userKey(identity.userId, identity.organizationId),
    userFor(identity)
  );
}

/**
 * Point every identity primitive at the fixed identities above. Call in
 * `beforeEach`: the lane's `mockReset` clears implementations between tests.
 */
export function installCallerIdentities(): void {
  currentCaller = CallerKind.Anonymous;
  extraUsers.clear();

  routeAuthPrimitives.clerkAuth.mockImplementation(() => {
    const signedIn =
      currentCaller === CallerKind.ClerkSession ||
      currentCaller === CallerKind.WrongOrgSession;
    return Promise.resolve(
      signedIn
        ? {
            userId: SESSION_IDENTITY.clerkUserId,
            orgId: SESSION_IDENTITY.clerkOrgId,
            orgRole: ClerkOrgRoleFixture.Admin,
            sessionId: "sess_route_auth",
          }
        : { userId: null, orgId: null, orgRole: null, sessionId: null }
    );
  });
  routeAuthPrimitives.findOrCreateUser.mockImplementation(
    (clerkUserId: string, clerkOrgId: string) =>
      Promise.resolve(
        clerkUserId === SESSION_IDENTITY.clerkUserId &&
          clerkOrgId === SESSION_IDENTITY.clerkOrgId
          ? userFor(SESSION_IDENTITY)
          : null
      )
  );
  routeAuthPrimitives.resolveDesktopSessionContext.mockImplementation(
    (token: string) => {
      const identity = DESKTOP_IDENTITY_BY_TOKEN.get(token);
      return Promise.resolve(
        identity
          ? {
              user: userFor(identity),
              organizationId: identity.organizationId,
              clerkOrgId: identity.clerkOrgId,
            }
          : null
      );
    }
  );
  routeAuthPrimitives.getDesktopManagedPopRequestFailure.mockResolvedValue(
    null
  );
  routeAuthPrimitives.waitUntil.mockImplementation(() => undefined);

  vi.spyOn(apiKeysService, "verifyKeyWithMetadata").mockImplementation(
    (token: string) => {
      const scopes = scopesForToken(token);
      if (!scopes) {
        return Promise.resolve(null);
      }
      const owner =
        token === MEMBER_OWNED_TOKEN ? MEMBER_KEY_OWNER : API_KEY_IDENTITY;
      return Promise.resolve({
        apiKeyId: `key-${owner.userId}`,
        userId: owner.userId,
        organizationId: owner.organizationId,
        scopes,
        source: ApiKeySource.USER_CREATED,
        gatewayId: null,
        boundPublicKey: null,
      });
    }
  );
  vi.spyOn(apiKeysService, "touchLastUsedAt").mockResolvedValue(undefined);
  vi.spyOn(usersService, "findById").mockImplementation(
    (id: string, organizationId: string) => {
      const identity = IDENTITY_USERS.find(
        (candidate) =>
          candidate.userId === id && candidate.organizationId === organizationId
      );
      if (identity) {
        return Promise.resolve(userFor(identity));
      }
      return Promise.resolve(
        extraUsers.get(userKey(id, organizationId)) ?? null
      );
    }
  );
  vi.spyOn(organizationsService, "findById").mockImplementation(
    (id: string) => {
      const identity = IDENTITY_USERS.find(
        (candidate) => candidate.organizationId === id
      );
      return Promise.resolve(
        identity
          ? ({
              id: identity.organizationId,
              clerkId: identity.clerkOrgId,
              name: "Route Auth Org",
            } as Awaited<ReturnType<typeof organizationsService.findById>>)
          : null
      );
    }
  );
  vi.spyOn(clerkService, "getOrganizationMembershipRole").mockImplementation(
    (clerkOrgId: string, clerkUserId: string) => {
      if (clerkOrgId === FOREIGN_CLERK_ORG_ID) {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        NON_ADMIN_CLERK_USER_IDS.has(clerkUserId)
          ? ClerkOrgRoleFixture.Member
          : ClerkOrgRoleFixture.Admin
      );
    }
  );
}

export function identityFor(caller: CallerKind): CallerIdentity {
  switch (caller) {
    case CallerKind.ApiKey:
      return API_KEY_IDENTITY;
    case CallerKind.DesktopSession:
      return DESKTOP_IDENTITY;
    default:
      return SESSION_IDENTITY;
  }
}

export type RouteRequest = {
  method: string;
  path: string;
  body?: unknown;
};

export type CallerCredential =
  | { kind: typeof CallerKind.ClerkSession }
  | { kind: typeof CallerKind.WrongOrgSession }
  | { kind: typeof CallerKind.Anonymous }
  | { kind: typeof CallerKind.DesktopSession; token?: string }
  | { kind: typeof CallerKind.ApiKey; token?: string };

/** Build the request `caller` would send, and make it the current caller. */
export function requestAs(
  credential: CallerCredential,
  route: RouteRequest
): NextRequest {
  currentCaller = credential.kind;
  const headers = new Headers();
  if (credential.kind === CallerKind.ApiKey) {
    headers.set(
      "authorization",
      `Bearer ${credential.token ?? FULL_ACCESS_TOKEN}`
    );
  }
  if (credential.kind === CallerKind.DesktopSession) {
    headers.set(
      "authorization",
      `Bearer ${credential.token ?? DESKTOP_SESSION_TOKEN}`
    );
  }
  // A key or Desktop token naming a foreign organization still runs as its own
  // organization; only the session path reads this header, and a session
  // naming one is refused.
  if (
    credential.kind === CallerKind.WrongOrgSession ||
    credential.kind === CallerKind.ApiKey ||
    credential.kind === CallerKind.DesktopSession
  ) {
    headers.set(ORG_IDENTITY_HEADER, FOREIGN_CLERK_ORG_ID);
  }
  if (route.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new NextRequest(`http://localhost:3002${route.path}`, {
    method: route.method,
    headers,
    body: route.body === undefined ? undefined : JSON.stringify(route.body),
  });
}

/** The token of a full-access key whose owner is an org member, not an admin. */
export const MEMBER_OWNED_API_KEY_TOKEN = MEMBER_OWNED_TOKEN;

export type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> }
) => Promise<Response>;

export type MovedHandlerCase = {
  /** `"GET /documents/[id]/rating"` */
  name: string;
  handler: RouteHandler;
  request: RouteRequest;
  params?: (identity: CallerIdentity) => Record<string, string>;
  /** The API-key scopes the handler requires. */
  requiredScopes: ApiKeyScope[];
  /**
   * The response the handler answers once it runs with the arranged mocks,
   * built with the same route-utils helper the handler uses.
   */
  reachedResponse: (identity: CallerIdentity) => Response;
  /** Arrange the handler's own dependencies before each request. */
  arrange?: () => void;
  /**
   * The calls that show the handler ran on behalf of `identity`: its first
   * org-scoped dependency, called with that caller's organization or user.
   */
  ranAs: (identity: CallerIdentity) => CallProbe[];
  /** Org-admin gated: a member-owned key must still be refused. */
  adminGated?: boolean;
};

function call(
  testCase: MovedHandlerCase,
  credential: CallerCredential
): Promise<Response> {
  const identity = identityFor(credential.kind);
  testCase.arrange?.();
  return testCase.handler(requestAs(credential, testCase.request), {
    params: Promise.resolve(testCase.params?.(identity) ?? {}),
  });
}

/**
 * The admitted and rejected callers of a handler moved to `withAnyAuth`
 * (ISS-11409). Call inside a `describe` whose `beforeEach` runs
 * {@link installCallerIdentities}.
 */
export function itAuthenticatesMovedHandler(testCase: MovedHandlerCase): void {
  const itRunsAs = (
    title: string,
    credential: CallerCredential,
    identity: CallerIdentity
  ) =>
    it(title, async () => {
      const response = await call(testCase, credential);

      expect(await snapshot(response)).toEqual(
        await snapshot(testCase.reachedResponse(identity))
      );
      for (const { spy, args } of testCase.ranAs(identity)) {
        expect(spy).toHaveBeenCalledWith(...args);
      }
    });

  itRunsAs(
    `${testCase.name} serves a Clerk session as the session's organization`,
    { kind: CallerKind.ClerkSession },
    SESSION_IDENTITY
  );

  it(`${testCase.name} refuses a session naming an organization the caller is not in, as withAuth does`, async () => {
    const response = await call(testCase, {
      kind: CallerKind.WrongOrgSession,
    });

    expect(await snapshot(response)).toEqual(
      await snapshot(forbiddenResponse({ code: AuthErrorCode.OrgForbidden }))
    );
  });

  itRunsAs(
    `${testCase.name} admits an API key holding ${testCase.requiredScopes.join(" and ")} and runs as its owner`,
    {
      kind: CallerKind.ApiKey,
      token: apiKeyTokenWithScopes(testCase.requiredScopes),
    },
    API_KEY_IDENTITY
  );

  it(`${testCase.name} refuses an API key missing ${testCase.requiredScopes.join(" or ")}`, async () => {
    const response = await call(testCase, {
      kind: CallerKind.ApiKey,
      token: apiKeyTokenWithScopes(scopesWithout(testCase.requiredScopes)),
    });

    expect(response.status).toBe(403);
  });

  if (testCase.requiredScopes.length > 1) {
    for (const missing of testCase.requiredScopes) {
      it(`${testCase.name} refuses an API key missing only ${missing}`, async () => {
        const response = await call(testCase, {
          kind: CallerKind.ApiKey,
          token: apiKeyTokenWithScopes(scopesWithout([missing])),
        });

        expect(response.status).toBe(403);
        for (const { spy } of testCase.ranAs(API_KEY_IDENTITY)) {
          expect(spy).not.toHaveBeenCalled();
        }
      });
    }
  }

  itRunsAs(
    `${testCase.name} admits a Desktop session token and runs as its user`,
    { kind: CallerKind.DesktopSession },
    DESKTOP_IDENTITY
  );

  it(`${testCase.name} answers a caller with no credential as withAuth does`, async () => {
    const response = await call(testCase, { kind: CallerKind.Anonymous });

    expect(await snapshot(response)).toEqual(
      await snapshot(unauthorizedResponse())
    );
  });

  if (testCase.adminGated) {
    it(`${testCase.name} refuses an API key whose owner is not an org admin`, async () => {
      const response = await call(testCase, {
        kind: CallerKind.ApiKey,
        token: MEMBER_OWNED_API_KEY_TOKEN,
      });

      expect(response.status).toBe(403);
    });

    it(`${testCase.name} refuses a Desktop session whose user is not an org admin`, async () => {
      const response = await call(testCase, {
        kind: CallerKind.DesktopSession,
        token: MEMBER_DESKTOP_SESSION_TOKEN,
      });

      expect(response.status).toBe(403);
      for (const { spy } of testCase.ranAs(DESKTOP_IDENTITY)) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  }
}

/** A spied dependency and the arguments the handler must have passed it. */
export type CallProbe = { spy: unknown; args: unknown[] };

export function probe(spy: unknown, ...args: unknown[]): CallProbe {
  return { spy, args };
}

type ResponseSnapshot = {
  status: number;
  headers: [string, string][];
  body: unknown;
};

/** Status, every header and the JSON body. */
export async function snapshot(response: Response): Promise<ResponseSnapshot> {
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    ),
    body: await response.json(),
  };
}

export type SessionOnlyHandlerCase = {
  name: string;
  handler: RouteHandler;
  request: RouteRequest;
  params?: Record<string, string>;
};

/**
 * A handler Daveth ruled session-only (ISS-11409): neither an API key nor a
 * Desktop session token reaches it.
 */
export function itRefusesNonSessionCallers(
  testCase: SessionOnlyHandlerCase
): void {
  const context = () => ({ params: Promise.resolve(testCase.params ?? {}) });

  it(`${testCase.name} answers 401 to a full-access API key`, async () => {
    const response = await testCase.handler(
      requestAs({ kind: CallerKind.ApiKey }, testCase.request),
      context()
    );

    expect(response.status).toBe(401);
    expect(apiKeysService.verifyKeyWithMetadata).not.toHaveBeenCalled();
  });

  it(`${testCase.name} answers 401 to a Desktop session token`, async () => {
    const response = await testCase.handler(
      requestAs({ kind: CallerKind.DesktopSession }, testCase.request),
      context()
    );

    expect(response.status).toBe(401);
    expect(
      routeAuthPrimitives.resolveDesktopSessionContext
    ).not.toHaveBeenCalled();
  });
}

/**
 * A token the real `isDesktopSessionToken` classifies as a Desktop access
 * token for `identity`. Its signature is never checked here:
 * `resolveDesktopSessionContext` is the mocked verifier.
 */
function desktopSessionTokenFor(identity: CallerIdentity): string {
  return [
    base64Url({ alg: "EdDSA", typ: DESKTOP_SESSION_JWT_TYP }),
    base64Url({ sub: identity.userId }),
    "signature",
  ].join(".");
}

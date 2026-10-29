"use client";

import {
  useAuth as useClerkAuth,
  useClerk as useClerkInstance,
  useOrganization as useClerkOrganization,
  useOrganizationList as useClerkOrganizationList,
  useReverification as useClerkReverification,
  useSession as useClerkSession,
  useUser as useClerkUser,
} from "@clerk/nextjs";
import { LOCAL_TRUSTED_CLIENT_TOKEN } from "@repo/api/src/types/local-trusted-auth";
import {
  LOCAL_TRUSTED_ORG_ROLE,
  LOCAL_TRUSTED_SESSION_ID,
  type LocalTrustedIdentity,
} from "./auth-mode";
import {
  buildLocalTrustedSessionClaims,
  hasLocalTrustedRole,
} from "./local-trusted-claims";
import {
  resolveLocalTrustedUser,
  useLocalTrustedIdentity,
} from "./local-trusted-client";

/**
 * ISS-12054: the Clerk hooks `@repo/auth/client` hands the app, made safe to call
 * with no `ClerkProvider` mounted.
 *
 * Under `AUTH_MODE=local_trusted` the root layout mounts the server-resolved
 * identity (`LocalTrustedIdentityProvider`) INSTEAD of `ClerkProvider`, so a
 * local stack needs no Clerk credentials and the browser never loads Clerk.
 * Clerk's own hooks throw outside their provider, so each export below answers
 * from the identity when one is mounted and calls Clerk's hook only when none
 * is, which is every real deployment, where the identity is `null` by
 * construction and the result is Clerk's, untouched.
 *
 * Which implementation a component gets is fixed for the life of the tree: the
 * server decides the mode before the document is sent and the provider never
 * changes it, so a component calls the same hooks on every render.
 *
 * The answers split by what the hook describes:
 *   - `useAuth` and `useUser` describe WHO is signed in, and answer with the
 *     synthetic session the server's `auth()` and `currentUser()` report.
 *   - `useOrganization`, `useOrganizationList`, `useSession` and `useClerk`
 *     hand out Clerk RESOURCES. A local session has none, so they answer the
 *     way Clerk does for a browser holding no Clerk session, which is the shape
 *     every consumer already handled on the Clerk-free e2e lane.
 */

type ClerkAuthHooks = {
  useAuth: typeof useClerkAuth;
  useClerk: typeof useClerkInstance;
  useOrganization: typeof useClerkOrganization;
  useOrganizationList: typeof useClerkOrganizationList;
  useSession: typeof useClerkSession;
  useUser: typeof useClerkUser;
};

type ClerkAuthResult = ReturnType<typeof useClerkAuth>;
type ClerkInstance = ReturnType<typeof useClerkInstance>;
type ClerkSessionResult = ReturnType<typeof useClerkSession>;

/**
 * One table per identity object, so every value the local hooks return keeps
 * its reference across renders (consumers key effects on `getToken`).
 */
const localTrustedHooksByIdentity = new WeakMap<
  LocalTrustedIdentity,
  ClerkAuthHooks
>();

// Each export picks its implementation and then calls it. Clerk's hook is read
// only when no identity is mounted, so a suite that mocks `@clerk/nextjs` down
// to the one hook it exercises keeps working.
export const useAuth: typeof useClerkAuth = (...args) =>
  (localTrustedHooks(useLocalTrustedIdentity())?.useAuth ?? useClerkAuth)(
    ...args
  );

export const useUser: typeof useClerkUser = () =>
  (localTrustedHooks(useLocalTrustedIdentity())?.useUser ?? useClerkUser)();

export const useOrganization: typeof useClerkOrganization = (...args) =>
  (
    localTrustedHooks(useLocalTrustedIdentity())?.useOrganization ??
    useClerkOrganization
  )(...args);

export const useOrganizationList: typeof useClerkOrganizationList = (...args) =>
  (
    localTrustedHooks(useLocalTrustedIdentity())?.useOrganizationList ??
    useClerkOrganizationList
  )(...args);

export const useSession: typeof useClerkSession = () =>
  (
    localTrustedHooks(useLocalTrustedIdentity())?.useSession ?? useClerkSession
  )();

export const useClerk: typeof useClerkInstance = () =>
  (
    localTrustedHooks(useLocalTrustedIdentity())?.useClerk ?? useClerkInstance
  )();

/**
 * Clerk's `useReverification`, which re-verifies a stale Clerk session before
 * a sensitive call. A local session has no Clerk session to re-verify, so the
 * call runs as given and its own result or rejection reaches the caller, as on
 * the `/connect/github/link` route, which reaches its existing failure state
 * rather than throwing during render.
 */
export const useReverification: typeof useClerkReverification = (
  fetcher,
  options
) =>
  (useLocalTrustedIdentity()
    ? callWithoutReverification
    : useClerkReverification)(fetcher, options);

const callWithoutReverification: typeof useClerkReverification =
  (fetcher) =>
  (...args) =>
    Promise.resolve(fetcher(...args));

function localTrustedHooks(
  identity: LocalTrustedIdentity | null
): ClerkAuthHooks | null {
  if (!identity) {
    return null;
  }
  let hooks = localTrustedHooksByIdentity.get(identity);
  if (!hooks) {
    hooks = buildLocalTrustedHooks(identity);
    localTrustedHooksByIdentity.set(identity, hooks);
  }
  return hooks;
}

function buildLocalTrustedHooks(
  identity: LocalTrustedIdentity
): ClerkAuthHooks {
  const auth = localTrustedAuthResult(identity);
  const user = resolveLocalTrustedUser(
    { isLoaded: false, isSignedIn: undefined, user: undefined },
    identity
  );
  const clerk = localTrustedClerk();
  const organization = noClerkOrganization();
  const organizationList = noClerkOrganizationList();
  const session: ClerkSessionResult = {
    isLoaded: true,
    isSignedIn: false,
    session: null,
  };
  return {
    useAuth: () => auth,
    useClerk: () => clerk,
    useOrganization: () => organization,
    useOrganizationList: () => organizationList,
    useSession: () => session,
    useUser: () => user,
  };
}

function localTrustedAuthResult(
  identity: LocalTrustedIdentity
): ClerkAuthResult {
  return {
    actor: null,
    getToken: () => Promise.resolve(LOCAL_TRUSTED_CLIENT_TOKEN),
    has: hasLocalTrustedRole,
    isLoaded: true,
    isSignedIn: true,
    orgId: identity.orgId,
    orgRole: LOCAL_TRUSTED_ORG_ROLE,
    orgSlug: identity.orgSlug,
    sessionClaims: buildLocalTrustedSessionClaims(identity),
    sessionId: LOCAL_TRUSTED_SESSION_ID,
    signOut: () => Promise.resolve(),
    userId: identity.userId,
  };
}

/**
 * The Clerk instance for a session that has none. `signOut` and `setActive`
 * resolve without effect because there is no Clerk session to end or switch:
 * the synthetic session is decided per request by the server, and `useClerk`
 * consumers only await these. `openUserProfile` opens nothing for the same
 * reason. Clerk's instance is a class whose constructor is not a public export,
 * so the members consumers read are built here and narrowed in ONE assertion,
 * the same constraint `local-trusted-client.tsx` documents for the user.
 */
function localTrustedClerk(): ClerkInstance {
  const fields: Partial<ClerkInstance> = {
    client: undefined,
    loaded: true,
    openUserProfile: () => undefined,
    setActive: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    status: "ready",
  };
  return fields as ClerkInstance;
}

/** What Clerk's `useOrganization` answers once loaded with no active organization. */
function noClerkOrganization() {
  return {
    domains: null,
    invitations: null,
    isLoaded: true,
    membership: null,
    membershipRequests: null,
    memberships: null,
    organization: null,
  } as const;
}

/** Clerk reports the list as not loaded until it has a USER, which a local session never gives it. */
function noClerkOrganizationList() {
  return {
    createOrganization: undefined,
    isLoaded: false,
    setActive: undefined,
    userInvitations: emptyPage(),
    userMemberships: emptyPage(),
    userSuggestions: emptyPage(),
  } as const;
}

/**
 * Clerk's `PaginatedResourcesWithDefault` (`undefinedPaginatedResource` in
 * `@clerk/shared`): what a paginated read answers before it may fetch.
 */
function emptyPage() {
  return {
    count: undefined,
    data: undefined,
    error: undefined,
    fetchNext: undefined,
    fetchPage: undefined,
    fetchPrevious: undefined,
    hasNextPage: false,
    hasPreviousPage: false,
    isError: false,
    isFetching: false,
    isLoading: false,
    page: undefined,
    pageCount: undefined,
    revalidate: undefined,
    setData: undefined,
  } as const;
}

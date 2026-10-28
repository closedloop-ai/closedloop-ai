import "server-only";

import type { BrowserSession } from "@repo/api/src/types/browser-session";
import {
  hasLocalTrustedDisplayOverrides,
  LOCAL_TRUSTED_EXTERNAL_ACCOUNT_PROVIDERS,
  LOCAL_TRUSTED_ORG_NAME,
  LOCAL_TRUSTED_ORG_ROLE,
  LOCAL_TRUSTED_SESSION_ID,
  LOCAL_TRUSTED_USERNAME,
  resolveLocalTrustedIdentity,
  resolveLocalTrustedUserProfile,
} from "@repo/auth/auth-mode";
import type {
  ClerkOrganization,
  ClerkOrganizationInvitation,
  ClerkOrganizationMembership,
  ClerkPage,
  ClerkUser,
  ClerkUserOrganizationMembership,
} from "./clerk-service";
import { browserActivityFromUserAgent } from "./local-trusted-browser-activity";
import { listSeededRoster } from "./seeded-roster";

/**
 * ISS-11468: the Clerk boundary's answers under `AUTH_MODE=local_trusted`.
 *
 * `clerk-service.ts` routes every method here once `isLocalTrustedAuthActive()`
 * has said yes, which is the same guard that throws under production, stage and
 * preview (`packages/auth/auth-mode.ts`). Nothing in this module re-checks the
 * environment, so it must never be imported from anywhere but that boundary.
 *
 * The harness has exactly one user, one organization and one session, all
 * synthetic, so the rules are:
 *   - A read about that identity answers with the synthetic data.
 *   - A read about anything else answers the way Clerk would for a stranger:
 *     `null` where the method has a not-found answer, otherwise a 404-shaped
 *     error that `isClerkNotFound` recognises.
 *   - A write throws {@link LocalTrustedClerkUnsupportedError}. There is no
 *     provider to change, and pretending a write succeeded would let the
 *     database and a (nonexistent) provider disagree without anyone noticing.
 */

/** A Clerk write attempted under `local_trusted`, where there is no Clerk. */
export class LocalTrustedClerkUnsupportedError extends Error {
  constructor(method: string) {
    super(
      `clerkService.${method} is not supported under AUTH_MODE=local_trusted: ` +
        "there is no Clerk instance to change."
    );
    this.name = "LocalTrustedClerkUnsupportedError";
  }
}

/** Clerk's not-found, for an id the synthetic harness does not have. */
class LocalTrustedClerkNotFoundError extends Error {
  readonly status = 404;

  constructor(kind: string, id: string) {
    super(`${kind} ${id} does not exist under AUTH_MODE=local_trusted`);
    this.name = "LocalTrustedClerkNotFoundError";
  }
}

/** Fixed epoch-millisecond stamp for synthetic provider rows. */
const SYNTHETIC_TIMESTAMP_MS = 0;
/** The synthetic session never expires within any run. */
const SYNTHETIC_SESSION_EXPIRY_MS = 4_102_444_800_000;

function syntheticUser(): ClerkUser {
  const identity = resolveLocalTrustedIdentity();
  const profile = resolveLocalTrustedUserProfile(identity);
  return {
    id: identity.userId,
    email: profile.email,
    firstName: profile.firstName,
    lastName: profile.lastName,
    imageUrl: null,
    phoneNumber: null,
  };
}

function syntheticMembership(): ClerkOrganizationMembership {
  const identity = resolveLocalTrustedIdentity();
  const profile = resolveLocalTrustedUserProfile(identity);
  return {
    id: `orgmem_${LOCAL_TRUSTED_USERNAME}`,
    userId: identity.userId,
    role: LOCAL_TRUSTED_ORG_ROLE,
    identifier: profile.email,
    firstName: profile.firstName,
    lastName: profile.lastName,
    imageUrl: null,
    createdAt: SYNTHETIC_TIMESTAMP_MS,
    updatedAt: SYNTHETIC_TIMESTAMP_MS,
  };
}

function isSyntheticUser(userId: string): boolean {
  return userId === resolveLocalTrustedIdentity().userId;
}

function isSyntheticOrganization(organizationId: string): boolean {
  return organizationId === resolveLocalTrustedIdentity().orgId;
}

function emptyPage<T>(): ClerkPage<T> {
  return { data: [], totalCount: 0 };
}

export const localTrustedClerkService = {
  updateOrganizationLogo(): Promise<void> {
    return Promise.reject(
      new LocalTrustedClerkUnsupportedError("updateOrganizationLogo")
    );
  },
  getOrganization(organizationId: string): Promise<ClerkOrganization> {
    if (!isSyntheticOrganization(organizationId)) {
      return Promise.reject(
        new LocalTrustedClerkNotFoundError("Organization", organizationId)
      );
    }
    return Promise.resolve({
      id: organizationId,
      name: syntheticOrganizationName(),
      slug: resolveLocalTrustedIdentity().orgSlug,
      imageUrl: null,
    });
  },

  updateOrganization(): Promise<ClerkOrganization> {
    return Promise.reject(
      new LocalTrustedClerkUnsupportedError("updateOrganization")
    );
  },

  createOrganization(): Promise<ClerkOrganization> {
    return Promise.reject(
      new LocalTrustedClerkUnsupportedError("createOrganization")
    );
  },

  userHasOrganization(): Promise<boolean> {
    return Promise.resolve(true);
  },

  findUserOrganizationBySlug(): Promise<ClerkOrganization | null> {
    return Promise.resolve(null);
  },

  getUser(userId: string): Promise<ClerkUser> {
    if (!isSyntheticUser(userId)) {
      return Promise.reject(new LocalTrustedClerkNotFoundError("User", userId));
    }
    return Promise.resolve(syntheticUser());
  },

  createOrganizationInvitation(): Promise<{ id: string }> {
    return Promise.reject(
      new LocalTrustedClerkUnsupportedError("createOrganizationInvitation")
    );
  },

  getUserExternalAccountProviders(userId: string): Promise<string[]> {
    if (!isSyntheticUser(userId)) {
      return Promise.reject(new LocalTrustedClerkNotFoundError("User", userId));
    }
    return Promise.resolve([...LOCAL_TRUSTED_EXTERNAL_ACCOUNT_PROVIDERS]);
  },

  getOrganizationMembershipRole(
    organizationId: string,
    userId: string
  ): Promise<string | null> {
    return Promise.resolve(
      isSyntheticOrganization(organizationId) && isSyntheticUser(userId)
        ? LOCAL_TRUSTED_ORG_ROLE
        : null
    );
  },

  async listOrganizationMemberships(params: {
    organizationId: string;
    limit: number;
    offset: number;
  }): Promise<ClerkPage<ClerkOrganizationMembership>> {
    if (!isSyntheticOrganization(params.organizationId)) {
      return emptyPage();
    }
    // ISS-12135: a stack that names its person (`pnpm vibe up`) reports the
    // seeded people; every other lane keeps the one synthetic member.
    const identity = resolveLocalTrustedIdentity();
    const all = hasLocalTrustedDisplayOverrides(identity)
      ? await listSeededRoster({
          clerkOrgId: params.organizationId,
          signedIn: {
            clerkUserId: identity.userId,
            role: LOCAL_TRUSTED_ORG_ROLE,
          },
        })
      : [syntheticMembership()];
    return {
      data: all.slice(params.offset, params.offset + params.limit),
      totalCount: all.length,
    };
  },

  listOrganizationInvitations(): Promise<
    ClerkPage<ClerkOrganizationInvitation>
  > {
    return Promise.resolve(emptyPage());
  },

  /** ISS-12056: the synthetic user is the only one, found by its own email. */
  findUserIdsByEmail(email: string): Promise<string[]> {
    const identity = resolveLocalTrustedIdentity();
    return Promise.resolve(
      email === resolveLocalTrustedUserProfile(identity).email
        ? [identity.userId]
        : []
    );
  },

  /** ISS-12056: the synthetic user belongs to the synthetic org only. */
  listUserOrganizationMemberships(
    userId: string
  ): Promise<ClerkUserOrganizationMembership[]> {
    if (!isSyntheticUser(userId)) {
      return Promise.resolve([]);
    }
    return Promise.resolve([
      {
        organizationId: resolveLocalTrustedIdentity().orgId,
        organizationName: syntheticOrganizationName(),
        role: LOCAL_TRUSTED_ORG_ROLE,
      },
    ]);
  },

  /** ISS-12135: the synthetic session's org is the synthetic org. */
  getLastActiveOrganizationId(userId: string): Promise<string | undefined> {
    return Promise.resolve(
      isSyntheticUser(userId) ? resolveLocalTrustedIdentity().orgId : undefined
    );
  },

  getOrganizationInvitation(params: {
    organizationId: string;
    invitationId: string;
  }): Promise<ClerkOrganizationInvitation> {
    return Promise.reject(
      new LocalTrustedClerkNotFoundError("Invitation", params.invitationId)
    );
  },

  revokeOrganizationInvitation(): Promise<ClerkOrganizationInvitation> {
    return Promise.reject(
      new LocalTrustedClerkUnsupportedError("revokeOrganizationInvitation")
    );
  },

  updateOrganizationMembership(): Promise<ClerkOrganizationMembership> {
    return Promise.reject(
      new LocalTrustedClerkUnsupportedError("updateOrganizationMembership")
    );
  },

  deleteOrganizationMembership(): Promise<ClerkOrganizationMembership> {
    return Promise.reject(
      new LocalTrustedClerkUnsupportedError("deleteOrganizationMembership")
    );
  },

  listUserBrowserSessions(params: {
    userId: string;
    limit: number;
    offset: number;
    userAgent?: string;
  }): Promise<{
    sessions: Omit<BrowserSession, "isCurrentSession">[];
    totalCount: number;
  }> {
    const all: Omit<BrowserSession, "isCurrentSession">[] = isSyntheticUser(
      params.userId
    )
      ? [syntheticBrowserSession(params.userAgent)]
      : [];
    return Promise.resolve({
      sessions: all.slice(params.offset, params.offset + params.limit),
      totalCount: all.length,
    });
  },

  getBrowserSessionOwner(
    sessionId: string
  ): Promise<{ userId: string } | null> {
    return Promise.resolve(
      sessionId === LOCAL_TRUSTED_SESSION_ID
        ? { userId: resolveLocalTrustedIdentity().userId }
        : null
    );
  },

  revokeBrowserSession(): Promise<void> {
    return Promise.reject(
      new LocalTrustedClerkUnsupportedError("revokeBrowserSession")
    );
  },
};

/** ISS-12135: the vibe stack's seeded org name when set, else the fixed one. */
function syntheticOrganizationName(): string {
  return resolveLocalTrustedIdentity().orgName ?? LOCAL_TRUSTED_ORG_NAME;
}

/**
 * The synthetic browser session. ISS-12135: a stack that names its person
 * (`pnpm vibe up`) reports it as the live session it is, active now on the
 * requesting browser; every other lane keeps the fixed fixture.
 */
function syntheticBrowserSession(
  userAgent: string | undefined
): Omit<BrowserSession, "isCurrentSession"> {
  const live = hasLocalTrustedDisplayOverrides(resolveLocalTrustedIdentity());
  return {
    id: LOCAL_TRUSTED_SESSION_ID,
    lastActiveAt: new Date(
      live ? Date.now() : SYNTHETIC_TIMESTAMP_MS
    ).toISOString(),
    expireAt: new Date(SYNTHETIC_SESSION_EXPIRY_MS).toISOString(),
    activity: live ? browserActivityFromUserAgent(userAgent) : null,
  };
}

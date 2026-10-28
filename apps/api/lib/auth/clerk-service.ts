import "server-only";

import type {
  BrowserSession,
  BrowserSessionActivity,
} from "@repo/api/src/types/browser-session";
import { isLocalTrustedAuthActive } from "@repo/auth/auth-mode";
import { clerkClient } from "@repo/auth/server";
import { BoundedMap } from "@repo/lib/bounded-map";
import { localTrustedClerkService } from "./local-trusted-clerk-service";

/**
 * Clerk organization data returned from the API
 */
export type ClerkOrganization = {
  id: string;
  name: string;
  slug: string | null;
  /**
   * ISS-11465 — the organization's logo, which Clerk serves from
   * `https://img.clerk.com`. Clerk returns a GENERATED fallback avatar for an
   * org that has uploaded nothing, so this is `string | null` only because the
   * provider types it that way; callers must still treat it as optional.
   */
  imageUrl: string | null;
};

/**
 * Clerk user data returned from the API
 */
export type ClerkUser = {
  id: string;
  /** Clerk timestamp in milliseconds; absent in local trusted mode. */
  createdAt?: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  phoneNumber: string | null;
};

/**
 * The states a Clerk organization invitation can be in.
 *
 * Clerk's own set, spelled here because `@clerk/backend` is a transitive
 * dependency of `@clerk/nextjs` rather than a direct one, so importing its
 * `OrganizationInvitationStatus` from this app would be a phantom import. The
 * literals are identical, so a value from this const is assignable to the SDK's
 * parameter and typecheck still catches a typo.
 */
export const ClerkInvitationStatus = {
  Pending: "pending",
  Accepted: "accepted",
  Revoked: "revoked",
  Expired: "expired",
} as const;

export type ClerkInvitationStatus =
  (typeof ClerkInvitationStatus)[keyof typeof ClerkInvitationStatus];

/**
 * One Clerk organization membership, flattened to plain data.
 *
 * `userId` is nullable because Clerk carries it on `publicUserData`, which the
 * SDK types `| null | undefined`, and a membership has no other field holding
 * it. A placeholder id would be worse than none: it would address a mutation at
 * a user who does not exist.
 *
 * Timestamps stay in Clerk's units (epoch milliseconds). This module is the
 * provider boundary, not a domain owner, so the domain service converts them.
 */
export type ClerkOrganizationMembership = {
  id: string;
  userId: string | null;
  /** Clerk's role string, verbatim. Open set — an instance can carry custom roles. */
  role: string;
  identifier: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  createdAt: number;
  updatedAt: number;
};

/** One Clerk organization invitation, flattened to plain data. */
export type ClerkOrganizationInvitation = {
  id: string;
  emailAddress: string;
  /** Clerk's role string, verbatim. Open set. */
  role: string;
  /** Optional on the provider's resource; absent stays absent, never defaulted. */
  status?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

/** One of a user's organization memberships, seen from the user (ISS-12056). */
export type ClerkUserOrganizationMembership = {
  organizationId: string;
  organizationName: string;
  role: string;
};

/**
 * A bounded page of provider rows, plus the provider's count of the WHOLE
 * population — not of this page. The two differ on every page but the last.
 */
export type ClerkPage<T> = {
  data: T[];
  totalCount: number;
};

/**
 * Clerk service - handles interactions with the Clerk SDK
 */
export const clerkService = {
  async createOrganization(params: {
    name: string;
    slug: string;
    createdBy: string;
  }): Promise<ClerkOrganization> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.createOrganization();
    }
    const client = await clerkClient();
    const org = await client.organizations.createOrganization(params);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      imageUrl: org.imageUrl ?? null,
    };
  },

  async userHasOrganization(userId: string): Promise<boolean> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.userHasOrganization();
    }
    const client = await clerkClient();
    const memberships = await client.users.getOrganizationMembershipList({
      userId,
      limit: 1,
    });
    return memberships.totalCount > 0;
  },

  /**
   * Recover the organization created by a bootstrap request after Clerk
   * committed it but the API failed before local persistence completed.
   */
  async findUserOrganizationBySlug(
    userId: string,
    slug: string
  ): Promise<ClerkOrganization | null> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.findUserOrganizationBySlug();
    }
    const client = await clerkClient();
    const memberships = await client.users.getOrganizationMembershipList({
      userId,
      limit: 100,
    });
    const organization = memberships.data
      .map((membership) => membership.organization)
      .find((candidate) => candidate.slug === slug);
    return organization
      ? {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          imageUrl: organization.imageUrl ?? null,
        }
      : null;
  },

  /**
   * Fetch an organization from Clerk by ID
   */
  async getOrganization(organizationId: string): Promise<ClerkOrganization> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.getOrganization(organizationId);
    }
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({
      organizationId,
    });

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      imageUrl: org.imageUrl ?? null,
    };
  },

  async updateOrganization(
    organizationId: string,
    data: { slug?: string; name?: string }
  ): Promise<ClerkOrganization> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.updateOrganization();
    }
    const client = await clerkClient();
    const org = await client.organizations.updateOrganization(organizationId, {
      ...(data.slug !== undefined && { slug: data.slug }),
      ...(data.name !== undefined && { name: data.name }),
    });

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      imageUrl: org.imageUrl ?? null,
    };
  },

  /**
   * Fetch a user from Clerk by ID
   */
  async getUser(userId: string): Promise<ClerkUser> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.getUser(userId);
    }
    const client = await clerkClient();
    const user = await client.users.getUser(userId);

    // Get primary email
    const primaryEmail = user.emailAddresses.find(
      (email: { id: string; emailAddress: string }) =>
        email.id === user.primaryEmailAddressId
    );

    if (!primaryEmail) {
      throw new Error("User has no primary email address");
    }

    // Get primary phone number
    const primaryPhone = user.phoneNumbers.find(
      (phone: { id: string; phoneNumber: string }) =>
        phone.id === user.primaryPhoneNumberId
    );

    return {
      id: user.id,
      email: primaryEmail.emailAddress,
      createdAt: user.createdAt,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
      phoneNumber: primaryPhone?.phoneNumber ?? null,
    };
  },

  /**
   * Mint a real Clerk organization invitation for a single email (PRD-532
   * §5.4). On acceptance, Clerk fires `organizationMembership.created`, which
   * the auth webhook syncs into a durable MEMBER of the existing org — the
   * invitee joins the caller's org rather than creating a new org-of-one.
   *
   * `inviterUserId` is the inviter's Clerk user id so Clerk attributes the
   * invitation. Returns the Clerk invitation id.
   */
  async createOrganizationInvitation(params: {
    organizationId: string;
    emailAddress: string;
    role: string;
    inviterUserId: string;
  }): Promise<{ id: string }> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.createOrganizationInvitation();
    }
    const client = await clerkClient();
    const invitation = await client.organizations.createOrganizationInvitation({
      organizationId: params.organizationId,
      emailAddress: params.emailAddress,
      role: params.role,
      inviterUserId: params.inviterUserId,
    });

    return { id: invitation.id };
  },

  /**
   * The OAuth providers linked to a Clerk user, spelled the way Clerk spells
   * them (`oauth_github`, `oauth_google`, …).
   *
   * Raw on purpose: this module is the Clerk boundary, not a domain owner, so
   * mapping a provider onto a product vocabulary belongs to the caller that has
   * one. Throws on a Clerk failure rather than returning an empty list — "no
   * linked provider" and "we could not ask" are different answers, and a caller
   * that conflated them would report an unmeasured fact. The memo behind this
   * preserves that: it never stores a rejection.
   *
   * Memoized per user for {@link EXTERNAL_ACCOUNT_PROVIDERS_TTL_MS} — see
   * {@link memoizedExternalAccountProviders}.
   */
  async getUserExternalAccountProviders(userId: string): Promise<string[]> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.getUserExternalAccountProviders(
        userId
      );
    }
    return await memoizedExternalAccountProviders(userId);
  },

  /**
   * ISS-12056: the ids of the users whose email address is `email`; at most
   * two, which is enough for a caller to tell "one" from "ambiguous".
   */
  async findUserIdsByEmail(email: string): Promise<string[]> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.findUserIdsByEmail(email);
    }
    const client = await clerkClient();
    const page = await client.users.getUserList({
      emailAddress: [email],
      limit: 2,
    });
    return page.data.map((user) => user.id);
  },

  /** Every organization `userId` belongs to, with its name and their role. */
  async listUserOrganizationMemberships(
    userId: string
  ): Promise<ClerkUserOrganizationMembership[]> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.listUserOrganizationMemberships(
        userId
      );
    }
    const client = await clerkClient();
    const memberships: ClerkUserOrganizationMembership[] = [];
    let offset = 0;
    while (true) {
      const page = await client.users.getOrganizationMembershipList({
        userId,
        limit: USER_ORGANIZATION_MEMBERSHIP_LIMIT,
        offset,
      });
      memberships.push(
        ...page.data.map((membership) => ({
          organizationId: membership.organization.id,
          organizationName: membership.organization.name,
          role: membership.role,
        }))
      );
      if (memberships.length >= page.totalCount) {
        return memberships;
      }
      if (page.data.length === 0) {
        throw new Error(
          "Clerk returned an incomplete organization membership page"
        );
      }
      offset += page.data.length;
    }
  },

  /**
   * ISS-12135: the org the user's Clerk session last had active, read from
   * the most recently active of their sessions that carries one, ended
   * sessions included. `undefined` when none does. Throws on a provider
   * failure, so "no org" and "could not ask" stay apart.
   */
  async getLastActiveOrganizationId(
    userId: string
  ): Promise<string | undefined> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.getLastActiveOrganizationId(userId);
    }
    const client = await clerkClient();
    let latest: { orgId: string; lastActiveAt: number } | undefined;
    let offset = 0;
    let seen = 0;
    while (true) {
      const page = await client.sessions.getSessionList({
        userId,
        limit: USER_SESSION_PAGE_LIMIT,
        offset,
      });
      for (const session of page.data) {
        const orgId = session.lastActiveOrganizationId;
        if (orgId && (!latest || session.lastActiveAt > latest.lastActiveAt)) {
          latest = { orgId, lastActiveAt: session.lastActiveAt };
        }
      }
      seen += page.data.length;
      if (seen >= page.totalCount) {
        return latest?.orgId;
      }
      if (page.data.length === 0) {
        throw new Error("Clerk returned an incomplete session page");
      }
      offset += page.data.length;
    }
  },

  /**
   * Fetch a user's organization membership role from Clerk.
   */
  async getOrganizationMembershipRole(
    organizationId: string,
    userId: string
  ): Promise<string | null> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.getOrganizationMembershipRole(
        organizationId,
        userId
      );
    }
    const client = await clerkClient();
    const memberships =
      await client.organizations.getOrganizationMembershipList({
        organizationId,
        userId: [userId],
        limit: 1,
      });

    const membership = memberships.data[0];

    if (!membership) {
      return null;
    }

    return membership.role;
  },

  /**
   * A bounded page of an organization's memberships (ISS-9083).
   *
   * `organizationId` is always the authenticated context's Clerk org id and
   * never a request value. That is what forecloses reading another
   * organization's roster — structurally, rather than by a check that could be
   * forgotten on the next route.
   *
   * `limit` and `offset` are trusted here and clamped by the caller, matching
   * `listUserBrowserSessions` below and for the same reason: the provider
   * answers an out-of-range limit with its own default rather than an error, so
   * an unclamped caller silently gets a short page.
   *
   * Throws on a provider failure rather than returning an empty page: "this org
   * has no members" and "we could not ask" are different answers, and a caller
   * that conflated them would report an empty roster as a measured fact.
   */
  async listOrganizationMemberships(params: {
    organizationId: string;
    limit: number;
    offset: number;
  }): Promise<ClerkPage<ClerkOrganizationMembership>> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.listOrganizationMemberships(params);
    }
    const client = await clerkClient();
    const page = await client.organizations.getOrganizationMembershipList({
      organizationId: params.organizationId,
      limit: params.limit,
      offset: params.offset,
    });

    return {
      data: page.data.map(toClerkOrganizationMembership),
      totalCount: page.totalCount,
    };
  },

  /**
   * A bounded page of an organization's invitations, narrowed to the given
   * statuses when any are supplied. Same org-scoping, clamping, and
   * throw-on-failure contract as {@link listOrganizationMemberships}.
   */
  async listOrganizationInvitations(params: {
    organizationId: string;
    limit: number;
    offset: number;
    status?: ClerkInvitationStatus[];
  }): Promise<ClerkPage<ClerkOrganizationInvitation>> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.listOrganizationInvitations();
    }
    const client = await clerkClient();
    const page = await client.organizations.getOrganizationInvitationList({
      organizationId: params.organizationId,
      limit: params.limit,
      offset: params.offset,
      ...(params.status !== undefined && { status: params.status }),
    });

    return {
      data: page.data.map(toClerkOrganizationInvitation),
      totalCount: page.totalCount,
    };
  },

  /** One invitation by id, scoped to the organization that owns it. */
  async getOrganizationInvitation(params: {
    organizationId: string;
    invitationId: string;
  }): Promise<ClerkOrganizationInvitation> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.getOrganizationInvitation(params);
    }
    const client = await clerkClient();
    const invitation = await client.organizations.getOrganizationInvitation({
      organizationId: params.organizationId,
      invitationId: params.invitationId,
    });

    return toClerkOrganizationInvitation(invitation);
  },

  /**
   * Revoke a pending invitation. `requestingUserId` is the caller's Clerk user
   * id, so Clerk attributes the revocation to the admin who asked for it.
   */
  async revokeOrganizationInvitation(params: {
    organizationId: string;
    invitationId: string;
    requestingUserId: string;
  }): Promise<ClerkOrganizationInvitation> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.revokeOrganizationInvitation();
    }
    const client = await clerkClient();
    const invitation = await client.organizations.revokeOrganizationInvitation({
      organizationId: params.organizationId,
      invitationId: params.invitationId,
      requestingUserId: params.requestingUserId,
    });

    return toClerkOrganizationInvitation(invitation);
  },

  /**
   * Change a member's role. Clerk keys membership mutations on the Clerk USER
   * id — there is no membership-id route on the provider.
   */
  async updateOrganizationMembership(params: {
    organizationId: string;
    userId: string;
    role: string;
  }): Promise<ClerkOrganizationMembership> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.updateOrganizationMembership();
    }
    const client = await clerkClient();
    const membership = await client.organizations.updateOrganizationMembership({
      organizationId: params.organizationId,
      userId: params.userId,
      role: params.role,
    });

    return toClerkOrganizationMembership(membership);
  },

  /** Remove a member. Keyed on the Clerk USER id, as the update above is. */
  async deleteOrganizationMembership(params: {
    organizationId: string;
    userId: string;
  }): Promise<ClerkOrganizationMembership> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.deleteOrganizationMembership();
    }
    const client = await clerkClient();
    const membership = await client.organizations.deleteOrganizationMembership({
      organizationId: params.organizationId,
      userId: params.userId,
    });

    return toClerkOrganizationMembership(membership);
  },

  /**
   * A page of the user's ACTIVE browser sessions.
   *
   * Order is the provider's documented default (descending by creation date)
   * and is NOT re-sorted here, because sorting a single page cannot impose an
   * order across pages. A consumer that depends on ordering should sort what it
   * renders rather than read a guarantee into this method.
   *
   * The only path that carries device and location metadata: the provider
   * returns `latestActivity` on the list read and omits it entirely from the
   * single-session read, so populating a row from `getBrowserSessionOwner`
   * below would render a confident "unavailable" for a session whose data
   * exists.
   *
   * `limit` and `offset` are trusted here and clamped by the caller. That is
   * deliberate but sharp-edged: the provider answers an out-of-range limit with
   * 200 and its own 10-row default rather than an error, so an unclamped caller
   * silently gets a short page. The route owns the clamp.
   *
   * Throws on a provider failure rather than returning an empty page, for the
   * same reason `getUserExternalAccountProviders` does: "no other sessions" and
   * "we could not ask" are different answers.
   */
  async listUserBrowserSessions(params: {
    userId: string;
    limit: number;
    offset: number;
    /** The requesting browser's header; only the local-trusted answer reads it (ISS-12135). */
    userAgent?: string;
  }): Promise<{
    sessions: Omit<BrowserSession, "isCurrentSession">[];
    totalCount: number;
  }> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.listUserBrowserSessions(params);
    }
    const client = await clerkClient();
    const page = await client.sessions.getSessionList({
      userId: params.userId,
      status: "active",
      limit: params.limit,
      offset: params.offset,
    });

    return {
      sessions: page.data.map(toBrowserSessionRow),
      totalCount: page.totalCount,
    };
  },

  /**
   * Who owns a session, for the revoke ownership check.
   *
   * `null` for a session the provider does not know, and a throw for every
   * other failure, so the caller can keep not-found distinct from unavailable.
   * Carries no activity metadata by design — see the note above.
   */
  async getBrowserSessionOwner(
    sessionId: string
  ): Promise<{ userId: string } | null> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.getBrowserSessionOwner(sessionId);
    }
    const client = await clerkClient();
    try {
      const session = await client.sessions.getSession(sessionId);
      return { userId: session.userId };
    } catch (error) {
      if (isClerkNotFound(error)) {
        return null;
      }
      throw error;
    }
  },

  /**
   * Revoke one session by id. Ownership is the caller's to establish first.
   *
   * A session the provider has already revoked resolves rather than throwing:
   * the caller asked for it to be gone and it is gone, so a repeat DELETE is
   * not an error.
   */
  async revokeBrowserSession(sessionId: string): Promise<void> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.revokeBrowserSession();
    }
    const client = await clerkClient();
    try {
      await client.sessions.revokeSession(sessionId);
    } catch (error) {
      if (isClerkNotFound(error)) {
        return;
      }
      throw error;
    }
  },

  async updateOrganizationLogo(params: {
    organizationId: string;
    uploaderUserId: string;
    file: File;
  }): Promise<void> {
    if (isLocalTrustedAuthActive()) {
      return await localTrustedClerkService.updateOrganizationLogo();
    }
    const client = await clerkClient();
    await client.organizations.updateOrganizationLogo(params.organizationId, {
      file: params.file,
      uploaderUserId: params.uploaderUserId,
    });
  },
};

/**
 * Clerk's HTTP status, when it reports one. Its errors carry `status`; anything
 * else (a transport failure, a thrown non-error) is deliberately NOT a 404 and
 * propagates, so an outage cannot be read as "this session is gone".
 *
 * Exported so the Members surface's error mapper decides not-found from the
 * same predicate this module already uses, rather than a second copy of it.
 */
export function isClerkNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404
  );
}

/**
 * Drop a Clerk activity field that the provider left blank.
 *
 * Omission, never `null`: an already-installed Desktop build parses a missing
 * key, and the repo's cross-repo rule reserves `null` for contracts that
 * declare it.
 *
 * A blank string counts as blank. GeoIP answers `city: ""` when it cannot place
 * an address, and `??` alone would pass that through for the panel to render as
 * an empty location beside a real country. `false` and `0` are real values and
 * survive — only a string that is empty or all whitespace is dropped.
 */
function activityField<T>(value: T | null | undefined): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
}

/**
 * Map one Clerk session onto the shared contract, minus `isCurrentSession` —
 * only the route knows which session is making the request.
 *
 * Shared by the list path and its tests so the two cannot drift.
 */
function toBrowserSessionRow(session: {
  id: string;
  lastActiveAt: number;
  expireAt: number;
  latestActivity?: {
    browserName?: string;
    browserVersion?: string;
    deviceType?: string;
    isMobile?: boolean;
    city?: string;
    country?: string;
  } | null;
}): Omit<BrowserSession, "isCurrentSession"> {
  const raw = session.latestActivity;
  let activity: BrowserSessionActivity | null = null;

  if (raw) {
    activity = {
      ...(activityField(raw.browserName) !== undefined && {
        browserName: raw.browserName,
      }),
      ...(activityField(raw.browserVersion) !== undefined && {
        browserVersion: raw.browserVersion,
      }),
      ...(activityField(raw.deviceType) !== undefined && {
        deviceType: raw.deviceType,
      }),
      ...(activityField(raw.isMobile) !== undefined && {
        isMobile: raw.isMobile,
      }),
      ...(activityField(raw.city) !== undefined && { city: raw.city }),
      ...(activityField(raw.country) !== undefined && { country: raw.country }),
    };
  }

  return {
    id: session.id,
    lastActiveAt: new Date(session.lastActiveAt).toISOString(),
    expireAt: new Date(session.expireAt).toISOString(),
    activity,
  };
}

/**
 * Flatten a Clerk membership resource, keeping every absent field absent.
 *
 * `publicUserData` carries the whole identity half of a membership, so when the
 * provider withholds it every identity field is null — including the user id,
 * which has nowhere else to come from. The row is still produced: a membership
 * with no public user data is still a member, and dropping it would under-report
 * the organization.
 */
function toClerkOrganizationMembership(membership: {
  id: string;
  role: string;
  createdAt: number;
  updatedAt: number;
  publicUserData?: {
    userId: string;
    identifier: string;
    firstName: string | null;
    lastName: string | null;
    imageUrl: string;
  } | null;
}): ClerkOrganizationMembership {
  const publicUserData = membership.publicUserData ?? null;

  return {
    id: membership.id,
    userId: publicUserData?.userId ?? null,
    role: membership.role,
    identifier: publicUserData?.identifier ?? null,
    firstName: publicUserData?.firstName ?? null,
    lastName: publicUserData?.lastName ?? null,
    imageUrl: publicUserData?.imageUrl ?? null,
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt,
  };
}

/**
 * Flatten a Clerk invitation resource.
 *
 * `status` is spread conditionally rather than assigned, so an invitation the
 * provider reported no status for comes back with no `status` key at all. An
 * explicit `undefined` would serialize away anyway, but the omission is what the
 * type promises and what a version-skewed consumer parses.
 */
function toClerkOrganizationInvitation(invitation: {
  id: string;
  emailAddress: string;
  role: string;
  status?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}): ClerkOrganizationInvitation {
  return {
    id: invitation.id,
    emailAddress: invitation.emailAddress,
    role: invitation.role,
    ...(invitation.status !== undefined && { status: invitation.status }),
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
    expiresAt: invitation.expiresAt,
  };
}

/**
 * How long a memoized provider list stays servable.
 *
 * The list changes only when the user links or unlinks an OAuth account, so
 * this is a staleness budget, not a correctness boundary — and it is the REAL
 * bound, because `apps/api` runs on serverless instances that hold separate
 * copies of this map and the invalidation below can only reach the one it runs
 * on.
 */
const EXTERNAL_ACCOUNT_PROVIDERS_TTL_MS = 60_000;

/** Entries are per Clerk user, so the cap bounds concurrent signed-in users. */
const EXTERNAL_ACCOUNT_PROVIDERS_MAX_USERS = 1000;

type ExternalAccountProvidersEntry = {
  /** The in-flight or settled fetch, so concurrent misses share one Clerk call. */
  providers: Promise<string[]>;
  expiresAt: number;
};

/**
 * ISS-10335: the guided-onboarding snapshot the sidebar fetches on EVERY
 * authenticated page load calls `getUserExternalAccountProviders`, which is a
 * Clerk Backend API user read. Clerk's development instance allows 100 requests
 * per 10 seconds shared by every CI run, and four Playwright workers turned
 * that into 429 storms.
 */
const externalAccountProvidersMemo = new BoundedMap<
  string,
  ExternalAccountProvidersEntry
>(EXTERNAL_ACCOUNT_PROVIDERS_MAX_USERS);

/**
 * Drop a user's memoized provider list, so the next read asks Clerk again.
 *
 * Best-effort by construction: it clears the instance it runs on and nothing
 * else, which is why the TTL above is what actually bounds staleness.
 */
export function invalidateUserExternalAccountProviders(userId: string): void {
  externalAccountProvidersMemo.delete(userId);
}

/**
 * The user's provider list, from the memo when it is live and from Clerk
 * otherwise.
 *
 * The PROMISE is memoized rather than its value, which is what makes concurrent
 * misses for one user share a single Clerk call. A rejection is evicted instead
 * of served, so "we could not ask" keeps propagating to the caller rather than
 * settling into the memo as "no linked provider".
 */
async function memoizedExternalAccountProviders(
  userId: string
): Promise<string[]> {
  const live = externalAccountProvidersMemo.get(userId);
  if (live && live.expiresAt > Date.now()) {
    return await live.providers;
  }

  const providers = fetchExternalAccountProviders(userId);
  const entry: ExternalAccountProvidersEntry = {
    providers,
    expiresAt: Date.now() + EXTERNAL_ACCOUNT_PROVIDERS_TTL_MS,
  };
  externalAccountProvidersMemo.set(userId, entry);
  providers.catch(() => {
    // Identity-checked so a failing call cannot evict the newer entry a retry
    // has already installed.
    if (externalAccountProvidersMemo.get(userId) === entry) {
      externalAccountProvidersMemo.delete(userId);
    }
  });

  return await providers;
}

/** The uncached Clerk read behind {@link memoizedExternalAccountProviders}. */
async function fetchExternalAccountProviders(
  userId: string
): Promise<string[]> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  return user.externalAccounts.map((account) => account.provider);
}

const USER_ORGANIZATION_MEMBERSHIP_LIMIT = 100;
const USER_SESSION_PAGE_LIMIT = 100;

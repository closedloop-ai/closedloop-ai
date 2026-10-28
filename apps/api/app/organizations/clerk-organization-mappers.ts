import "server-only";

import type {
  OrganizationMemberSummary,
  PendingInvitationSummary,
} from "@repo/api/src/types/organization-members";
import type {
  ClerkOrganizationInvitation,
  ClerkOrganizationMembership,
} from "@/lib/auth/clerk-service";

/**
 * @file clerk-organization-mappers.ts
 * @description Provider row → wire summary, for both Members reads (ISS-9083).
 *
 * One module rather than one per service, for the same reason the error mapping
 * is shared: the roster read and the invitation read both convert Clerk's epoch
 * timestamps, and the mutations in M4 return the SAME two summary shapes their
 * reads do. Two copies would let a read and the write that follows it report
 * the same membership differently.
 *
 * Every mapper keeps an absent provider field absent. Nothing here defaults,
 * substitutes, or invents — a member with no public user data comes back with
 * nulls, an invitation with no status comes back with no status key, and a
 * timestamp with no representable instant behind it comes back null.
 *
 * Nothing here throws, either. A mapper that did would take the whole page down
 * with it: both callers map inside one try/catch — see {@link clerkEpochToIso}.
 */

/**
 * Clerk's epoch milliseconds as an ISO 8601 string, or `null` when the value is
 * not a representable instant.
 *
 * NULL RATHER THAN A THROW, because a throw here took the whole page with it:
 * both list services map inside one try/catch that classifies anything thrown
 * as `provider_unavailable`, so ONE unreadable timestamp answered 503 and
 * discarded every other row — the entire roster for any organization under the
 * default page size. The realistic trigger is a field the provider omitted
 * arriving as `undefined`, and one missing timestamp is not evidence that
 * Clerk is unreachable.
 *
 * `null` is the answer this contract already gives for a withheld `userId`: the
 * row keeps everything the provider did say, and the one field nobody
 * established reads as unknown rather than as `"Invalid Date"`, an epoch-zero
 * timestamp from 1970, or a silently dropped member. The services log the gap,
 * once per page.
 */
export function clerkEpochToIso(epochMilliseconds: number): string | null {
  // `Number.isFinite` does not coerce, which is the point: `new Date(null)` is
  // epoch zero, so an omitted field arriving as `null` would otherwise be
  // reported as a real membership created in 1970.
  if (!Number.isFinite(epochMilliseconds)) {
    return null;
  }

  const date = new Date(epochMilliseconds);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

/** One Clerk membership as the roster reports it. */
export function toOrganizationMemberSummary(
  membership: ClerkOrganizationMembership
): OrganizationMemberSummary {
  return {
    userId: membership.userId,
    identifier: membership.identifier,
    firstName: membership.firstName,
    lastName: membership.lastName,
    imageUrl: membership.imageUrl,
    role: membership.role,
    createdAt: clerkEpochToIso(membership.createdAt),
  };
}

/**
 * One Clerk invitation as the invitation list reports it.
 *
 * `status` is spread conditionally, so an invitation the provider reported no
 * status for carries no `status` key. The list is filtered to pending, and that
 * filter is NOT licence to stamp the field: a fabricated `"pending"` is
 * indistinguishable from a measured one.
 */
export function toPendingInvitationSummary(
  invitation: ClerkOrganizationInvitation
): PendingInvitationSummary {
  return {
    invitationId: invitation.id,
    emailAddress: invitation.emailAddress,
    role: invitation.role,
    ...(invitation.status !== undefined && { status: invitation.status }),
    createdAt: clerkEpochToIso(invitation.createdAt),
    updatedAt: clerkEpochToIso(invitation.updatedAt),
    expiresAt: clerkEpochToIso(invitation.expiresAt),
  };
}

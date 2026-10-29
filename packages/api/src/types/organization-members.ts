import { OrganizationRole } from "./organization-role.ts";

/**
 * @file organization-members.ts
 * @description The wire contract of the Settings Members panel (ISS-9083):
 * organization memberships and pending invitations as this API reports them,
 * plus the codes it answers a failed one with.
 *
 * Members-specific by decision, not by omission. ISS-8378 handed the question
 * of a generic `SettingsDomainState<TData>` forward, and one consumer is not
 * enough to shape a generic envelope — the second Settings panel is what will
 * decide whether these shapes generalise or fork.
 *
 * FOUR PROVIDER FACTS THESE SHAPES DELIBERATELY DO NOT PAPER OVER. Each one
 * is a place where a tidier type would report something Clerk never said:
 *
 * 1. `role` is an OPEN string. `OrganizationMembershipRole` is
 *    `OrganizationCustomRoleKey`, so an instance can carry roles this product
 *    has never heard of. A read passes the value through verbatim and keeps the
 *    row; {@link isOrganizationRole} is how a consumer asks whether it is one of
 *    ours. Coercing an unknown role to Member would report a permission level
 *    the provider did not grant, and dropping the row would hide a member.
 * 2. `status` is OPTIONAL on the provider's invitation, so it is optional here.
 *    A list filtered to pending is not licence to stamp the field — a fabricated
 *    `"pending"` is indistinguishable from a measured one.
 * 3. `userId` and the identity fields are NULLABLE, because the provider's
 *    `publicUserData` is. See {@link OrganizationMemberSummary.userId}.
 * 4. TIMESTAMPS are NULLABLE. Clerk emits epoch milliseconds and the mappers
 *    convert at the boundary, so no consumer has to know the provider's units —
 *    but a value that is not a representable instant has no ISO spelling, and
 *    the row reports `null` there rather than a 1970 timestamp. See
 *    {@link OrganizationMemberSummary.createdAt}.
 */

/**
 * One organization member, as the roster reports them.
 */
export type OrganizationMemberSummary = {
  /**
   * The member's Clerk USER id — the key every membership mutation is addressed
   * by, and `null` when the provider withheld it.
   *
   * Nullable because Clerk carries the user id on `publicUserData`, which the
   * SDK types `| null | undefined`, and there is no other field on a membership
   * that holds it. A membership with no public user data therefore has no user
   * id at all. The row is still returned — a member exists — but nothing can be
   * done to it until the provider answers with the id.
   */
  userId: string | null;
  /** Email or username Clerk identifies the member by. Null when withheld. */
  identifier: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  /** Clerk's role string, verbatim. Not narrowed — see the file header. */
  role: string;
  /**
   * When the membership was created, ISO 8601, and `null` when the provider's
   * timestamp was not a representable instant.
   *
   * Nullable for the same reason {@link OrganizationMemberSummary.userId} is: a
   * value the provider did not give us readably is reported absent, never
   * invented. The row is still returned — a member exists — because failing the
   * whole page on one bad timestamp discards every other member with it.
   */
  createdAt: string | null;
};

/**
 * A bounded page of the roster. `total` is the provider's count of the whole
 * population, not of this page, so `members.length` and `total` differ on every
 * page but the last of a short list.
 */
export type OrganizationMembersPage = {
  members: OrganizationMemberSummary[];
  total: number;
  hasMore: boolean;
  /**
   * ISS-12135. Optional and additive: an API from before it omits the field,
   * and a consumer reads that as the Clerk roster it has always been.
   */
  source?: OrganizationMembersSource;
};

/**
 * One pending invitation, as the invitation list reports it.
 */
export type PendingInvitationSummary = {
  invitationId: string;
  emailAddress: string;
  /** Clerk's role string, verbatim. Not narrowed — see the file header. */
  role: string;
  /**
   * Clerk's invitation status (`pending`, `accepted`, `revoked`, `expired`).
   * ABSENT when the provider did not report one — never defaulted.
   */
  status?: string;
  /**
   * The invitation's lifecycle instants, ISO 8601, each `null` when the
   * provider's value was not representable — see
   * {@link OrganizationMemberSummary.createdAt}.
   */
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
};

/** A bounded page of pending invitations. `total` counts the population. */
export type PendingInvitationsPage = {
  invitations: PendingInvitationSummary[];
  total: number;
  hasMore: boolean;
};

/**
 * A completed resend. Clerk has no resend primitive, so a resend is a revoke
 * plus a re-create and mints a NEW invitation id: the id the caller held is
 * dead once this returns, and `revokedInvitationId` names it so a consumer can
 * replace the row it was showing rather than end up with both.
 *
 * NO PRODUCER YET, deliberately: `POST /organizations/invitations/[id]/resend`
 * lands with PLN-1911 M4. Declared here so the Members wire contract ships as
 * one reviewable unit rather than arriving in two halves — unlike
 * {@link OrganizationMembersErrorCode}, whose members are what the wire
 * PROMISES and so are restricted to what a producer can already return.
 */
export type ResendInvitationResponse = {
  invitation: PendingInvitationSummary;
  revokedInvitationId: string;
};

/**
 * A completed role change, carrying the membership as it now stands.
 *
 * No producer yet — `PATCH /organizations/members/[userId]` lands with
 * PLN-1911 M4. See {@link ResendInvitationResponse} for why it ships early.
 */
export type ChangeMemberRoleResponse = {
  member: OrganizationMemberSummary;
};

/**
 * A completed removal. `removed` is a literal so the shape cannot report a
 * no-op as a removal.
 *
 * No producer yet — `DELETE /organizations/members/[userId]` lands with
 * PLN-1911 M4. See {@link ResendInvitationResponse} for why it ships early.
 */
export type RemoveMemberResponse = {
  removed: true;
  userId: string;
};

/**
 * How a Members request failed, as the WIRE reports it.
 *
 * Every member of this const is a `code` a client can actually receive. That is
 * the whole entry condition, and it is why there is only one today: an absent
 * resource is answered by the shared 404 helper, which emits no `code` at all,
 * so a `NotFound` member here would have been a contract promise nothing keeps.
 * The server-side discriminant for that outcome lives with the code that
 * branches on it — `ClerkFailureKind` in `apps/api/app/organizations` — because
 * it is backend metadata, not transport.
 *
 * The mutation-specific codes (already-settled invitations, the last-owner
 * rule, an unconfigured role) arrive with the mutations that emit them, under
 * the same rule.
 *
 * {@link OrganizationMembersErrorCode.ProviderUnavailable} is on the wire as the
 * `code` on a 503 — it is what keeps "Clerk did not answer" distinguishable
 * from an empty list, which is the distinction ISS-9083 names.
 */
export const OrganizationMembersErrorCode = {
  /** Clerk was unreachable, or failed for a reason this contract cannot name. */
  ProviderUnavailable: "provider_unavailable",
} as const;

export type OrganizationMembersErrorCode =
  (typeof OrganizationMembersErrorCode)[keyof typeof OrganizationMembersErrorCode];

/** Rows per page when the caller does not ask. */
export const ORGANIZATION_MEMBERS_PAGE_LIMIT_DEFAULT = 50;

/**
 * Hard ceiling on rows per page.
 *
 * Load-bearing rather than decorative: Clerk answers an out-of-range limit with
 * HTTP 200 and its own default page rather than an error, so an unclamped bound
 * returns a short page that reads as a complete roster.
 */
export const ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX = 100;

/**
 * Hard ceiling on the page offset. Past it the Members reads answer 400.
 *
 * Bounded because Clerk rejects an absurd offset by throwing, which this API
 * could only report as a 503 `provider_unavailable` plus an error-level log — a
 * caller mistake rendered as a provider outage, and a log line any
 * authenticated caller could drive on demand.
 *
 * REJECTED rather than clamped, unlike the page-size ceiling above. A clamped
 * offset aliases every page past the ceiling onto the ceiling's own page, and
 * because `hasMore` is derived from the offset the service was handed, that
 * page reports another one after it while the response echoes no offset the
 * client could check. A paging client loops on it. There is no such page, and
 * 400 is the only answer that says so.
 */
export const ORGANIZATION_MEMBERS_OFFSET_MAX = 10_000;

const ORGANIZATION_ROLES: ReadonlySet<string> = new Set<string>(
  Object.values(OrganizationRole)
);

/**
 * Whether a role string Clerk returned is one this product knows how to write.
 *
 * For a consumer deciding whether it can render a role control for a row, not
 * for filtering the roster: a row whose role is unrecognised is still a member,
 * and hiding it would under-report the organization.
 */
export function isOrganizationRole(value: string): value is OrganizationRole {
  return ORGANIZATION_ROLES.has(value);
}

/**
 * ISS-12135: where a roster page came from, decided by the API.
 * `seeded`: a vibe preview the vibe workflow seeded, whose roster is its seeded
 * rows and is read-only. `clerk`: the Clerk organization, everywhere else.
 */
export const OrganizationMembersSource = {
  Clerk: "clerk",
  Seeded: "seeded",
} as const;

export type OrganizationMembersSource =
  (typeof OrganizationMembersSource)[keyof typeof OrganizationMembersSource];

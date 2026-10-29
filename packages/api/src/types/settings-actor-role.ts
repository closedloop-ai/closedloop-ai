/**
 * @file settings-actor-role.ts
 * @description The Settings actor's organization role, and the three-way
 * outcome of trying to READ it (ISS-8378).
 *
 * `isOrgAdminRole` answers one boolean; v2 needs member/admin/owner apart,
 * because `SettingsPanelCapability` carries an `owner` rung. This widens the
 * same Clerk role string WITHOUT forking the admin set — {@link OrgAdminRole}
 * stays the authority and the map below is exhaustive over it.
 *
 * The three-way status exists because `getOrgAdminStatus` answers
 * `{ isAdmin: false }` to both "not an admin" and "Clerk did not answer".
 * Correct for a write gate, wrong for a projection: it would tell a real admin
 * during an outage that they are not allowed in.
 */
import { OrgAdminRole } from "./org-admin-role.ts";

/**
 * The actor's authority over an organization, least privileged first.
 *
 * `Owner` is separated from `Admin` even though no `apps/api` gate
 * distinguishes them today, because `SettingsPanelCapability.Owner` already
 * exists and a service asked to deny an owner-only operation cannot express
 * that against a boolean. Collapsing them here would mean re-deriving the role
 * at every future owner-only call site.
 */
export const SettingsActorRole = {
  Member: "member",
  Admin: "admin",
  Owner: "owner",
} as const;

export type SettingsActorRole =
  (typeof SettingsActorRole)[keyof typeof SettingsActorRole];

export const SETTINGS_ACTOR_ROLES: readonly SettingsActorRole[] = [
  SettingsActorRole.Member,
  SettingsActorRole.Admin,
  SettingsActorRole.Owner,
];

/**
 * Whether the actor's role was READ, not what it turned out to be.
 *
 * `NotAMember` is an ANSWER — the membership lookup succeeded and found
 * nothing, which is what a removed member or a cross-org request looks like.
 * `Unresolved` is the absence of an answer. A projection that treats the second
 * as the first tells a real admin, during a Clerk outage, that they have been
 * removed from their organization.
 */
export const SettingsActorRoleStatus = {
  Resolved: "resolved",
  NotAMember: "not-a-member",
  Unresolved: "unresolved",
} as const;

export type SettingsActorRoleStatus =
  (typeof SettingsActorRoleStatus)[keyof typeof SettingsActorRoleStatus];

/**
 * Why a role could not be read. A closed set; consumers treat an unrecognized
 * value as "unreadable" rather than switching on it, so a newer server adding a
 * reason degrades on an older client instead of failing.
 *
 * There is deliberately no "this caller has no membership context" reason. The
 * live membership lookup is keyed on `clerkOrgId`/`clerkUserId`, which every
 * auth path populates — including `sk_live_` API keys and desktop sessions,
 * which carry no `orgRole` session claim. That is exactly why this service
 * reads Clerk rather than the claim: a projection built on the claim alone
 * reports every desktop caller as a plain member regardless of their authority.
 */
export const SettingsActorRoleUnresolvedReason = {
  /** The membership provider threw or was unreachable. */
  ProviderError: "provider_error",
  /**
   * The provider returned a membership whose role value is not a usable string
   * — blank, whitespace-only, or not a string at all. The membership EXISTS, so
   * this is corrupt provider data rather than the settled "no membership"
   * answer, and folding it into `NotAMember` would tell a real member they had
   * been removed from their organization.
   */
  MalformedRole: "malformed_role",
} as const;

export type SettingsActorRoleUnresolvedReason =
  (typeof SettingsActorRoleUnresolvedReason)[keyof typeof SettingsActorRoleUnresolvedReason];

export type SettingsActorRoleResolution =
  | { status: typeof SettingsActorRoleStatus.Resolved; role: SettingsActorRole }
  | { status: typeof SettingsActorRoleStatus.NotAMember }
  | {
      status: typeof SettingsActorRoleStatus.Unresolved;
      reason: SettingsActorRoleUnresolvedReason;
    };

/**
 * Exhaustive over {@link OrgAdminRole}, so a new Clerk role admitted to the
 * admin set fails `tsc` here until this axis decides whether it is an admin or
 * an owner. A partial map would silently demote it to `Member` by the
 * unrecognized-role fallback below — a privileged role reported as unprivileged.
 */
const SETTINGS_ROLE_BY_ORG_ADMIN_ROLE: Record<OrgAdminRole, SettingsActorRole> =
  {
    [OrgAdminRole.Admin]: SettingsActorRole.Admin,
    [OrgAdminRole.Owner]: SettingsActorRole.Owner,
  };

/**
 * Null-prototype because the key is an untrusted provider string: `"constructor"`
 * off a plain object literal is a truthy non-role value.
 */
const SETTINGS_ROLE_LOOKUP: Record<string, SettingsActorRole> = Object.assign(
  Object.create(null),
  SETTINGS_ROLE_BY_ORG_ADMIN_ROLE
);

/**
 * Widen a raw Clerk membership role into the Settings axis.
 *
 * THREE OUTCOMES FROM THREE KINDS OF INPUT, and the middle one is the point.
 *
 * An ABSENT role (`null`/`undefined`) is `NotAMember`. That is the only value
 * `getOrganizationMembershipRole` yields when no membership record exists, so
 * it is the settled answer: removed member, or cross-org request.
 *
 * A PRESENT but UNUSABLE role — blank, whitespace-only, or not a string —
 * is `Unresolved`. The membership row exists and its role could not be read, so
 * nothing about this actor's authority is known. Reporting it as `NotAMember`
 * would turn corrupt provider data into a confident removal decision, answering
 * a 200 with every domain forbidden where the retryable 503 belongs.
 *
 * A PRESENT but unrecognized role resolves to `Member`, matching the existing
 * authority rather than departing from it: `isOrgAdminRole` already answers
 * `false` outside the admin set, so an unheard-of Clerk role is treated as
 * non-admin today. Erroring instead would break Settings for that cohort the
 * day Clerk adds a role; admitting it as admin would widen an authorization
 * boundary on an unknown string. Unlike a blank value, it is a role the
 * provider genuinely holds — just not one this build ranks.
 */
export function resolveSettingsActorRole(
  clerkRole: string | null | undefined
): SettingsActorRoleResolution {
  if (clerkRole === null || clerkRole === undefined) {
    return { status: SettingsActorRoleStatus.NotAMember };
  }
  // `typeof` as well as the emptiness test because this is a provider trust
  // boundary: the declared `string` does not constrain what Clerk returns.
  if (typeof clerkRole !== "string" || clerkRole.trim().length === 0) {
    return {
      status: SettingsActorRoleStatus.Unresolved,
      reason: SettingsActorRoleUnresolvedReason.MalformedRole,
    };
  }
  return {
    status: SettingsActorRoleStatus.Resolved,
    role: SETTINGS_ROLE_LOOKUP[clerkRole] ?? SettingsActorRole.Member,
  };
}

/**
 * Clerk organization roles that carry admin-level authority — the single
 * source of truth for the server-side admin gate (`getOrgAdminStatus` in
 * `apps/api/lib/auth/org-admin.ts`) and for the client-side `isAdminRole`
 * check that decides which admin affordances render.
 *
 * WHY ITS OWN LEAF MODULE
 * -----------------------
 * `packages/app` cannot import from `apps/api`, so the one value both sides
 * read has to live in a package both depend on. It is kept dependency-free —
 * no Zod, no parsers — because the client consumer (`role-utils.ts`) is
 * imported by broad `"use client"` surfaces such as the app sidebar, which
 * must be able to pull in the role set without dragging a validator into the
 * browser bundle.
 *
 * It is NOT in `packages/auth` — that package owns Clerk plumbing and one fixed
 * synthetic e2e identity (`LOCAL_TRUSTED_ORG_ROLE`), whereas this is an
 * authorization policy read by both apps, which is what `packages/api/src/types`
 * is for.
 *
 * Not to be confused with `OrgInviteRole` in `./onboarding.ts`: that one is the
 * set of roles an invitee can be ASSIGNED (admin/member), this one is the set
 * that GRANTS admin authority (admin/owner). They deliberately differ.
 *
 * The set is an authorization boundary: dropping a member here silently
 * revokes every admin-gated route and every admin affordance for that role.
 */
export const OrgAdminRole = {
  Admin: "org:admin",
  Owner: "org:owner",
} as const;
export type OrgAdminRole = (typeof OrgAdminRole)[keyof typeof OrgAdminRole];

const ORG_ADMIN_ROLES: ReadonlySet<string> = new Set<string>(
  Object.values(OrgAdminRole)
);

/**
 * Whether a resolved Clerk membership role grants admin-level access. Callers
 * that can hold an absent role must guard for it first — an absent membership
 * is "not a member", which is a different fact from "a member without the
 * role".
 */
export function isOrgAdminRole(role: string): role is OrgAdminRole {
  return ORG_ADMIN_ROLES.has(role);
}

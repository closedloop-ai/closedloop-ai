/**
 * Pack-admin capability boundary (FEA-4084).
 *
 * Makes the member-vs-admin pack-management boundary legible: which pack
 * capabilities an org role holds. This is NOT a new permissions system — it
 * reads the SAME role model the rest of the app already uses (`isAdminRole`,
 * mirroring the backend `ADMIN_ROLES`), so the boundary the UI shows is exactly
 * the boundary the API enforces. Pack admin capability is derived from the org
 * role, not stored or edited independently.
 *
 * The three capabilities mirror the real pack surfaces:
 *  - author the catalog (create / upload / edit / archive catalog items),
 *  - distribute (require or offer packs across the org),
 *  - install to own machines (self-service install on a member's own devices).
 *
 * Every org member can install packs to their own machines; only an org
 * admin/owner can author the catalog or distribute. That mapping is the single
 * source of truth here, so the admin boundary row and any capability gate read
 * the same words for the same state.
 */

/**
 * A distinct pack-management capability the boundary describes. A const object
 * (never a TS `enum`) so surfaces compare against the member, not a bare string.
 */
export const PackAdminCapability = {
  /** Create / upload / edit / archive catalog items. Admin/owner only. */
  AuthorCatalog: "author_catalog",
  /** Require or offer packs across the org (create distributions). Admin/owner only. */
  Distribute: "distribute",
  /** Install packs to one's own machines. Every member has this. */
  InstallToOwnMachines: "install_to_own_machines",
} as const;
export type PackAdminCapability =
  (typeof PackAdminCapability)[keyof typeof PackAdminCapability];

/** Render order for the boundary row — the two admin-gated capabilities first. */
export const PACK_ADMIN_CAPABILITY_ORDER: readonly PackAdminCapability[] = [
  PackAdminCapability.AuthorCatalog,
  PackAdminCapability.Distribute,
  PackAdminCapability.InstallToOwnMachines,
];

/**
 * Who holds a capability — the honest audience for it. `Admins` = org
 * admins/owners; `Everyone` = every org member. Kept as a labelled value (not a
 * boolean) so the row can render a truthful audience word, never color alone.
 */
export const CapabilityHolder = {
  Admins: "admins",
  Everyone: "everyone",
} as const;
export type CapabilityHolder =
  (typeof CapabilityHolder)[keyof typeof CapabilityHolder];

export type PackAdminCapabilityMeta = {
  /** Short capability label. */
  label: string;
  /** One-line plain gloss of what the capability lets a holder do. */
  description: string;
  /** Who holds this capability in the org's role model. */
  holder: CapabilityHolder;
};

/**
 * The single source of truth for each capability's label, gloss, and who holds
 * it. Exhaustive over {@link PackAdminCapability} so a newly added capability
 * fails typecheck here until it is intentionally described.
 */
export const PACK_ADMIN_CAPABILITY_META: Record<
  PackAdminCapability,
  PackAdminCapabilityMeta
> = {
  [PackAdminCapability.AuthorCatalog]: {
    label: "Author the catalog",
    description: "Create, upload, edit, and archive packs in the org catalog.",
    holder: CapabilityHolder.Admins,
  },
  [PackAdminCapability.Distribute]: {
    label: "Distribute packs",
    description: "Require or offer packs to members across the org.",
    holder: CapabilityHolder.Admins,
  },
  [PackAdminCapability.InstallToOwnMachines]: {
    label: "Install to own machines",
    description: "Install packs on their own devices.",
    holder: CapabilityHolder.Everyone,
  },
};

/** Human audience label for a capability holder. */
export const CAPABILITY_HOLDER_LABEL: Record<CapabilityHolder, string> = {
  [CapabilityHolder.Admins]: "Admins & owners",
  [CapabilityHolder.Everyone]: "Everyone",
};

/**
 * Whether a given role holds a capability, under the app's existing role model.
 * The two admin-gated capabilities require an admin/owner role; installing to
 * one's own machines is available to every member. Reused by a capability gate
 * so the enforced boundary and the shown boundary can't drift.
 */
export function roleHasPackCapability(
  capability: PackAdminCapability,
  isAdmin: boolean
): boolean {
  if (
    PACK_ADMIN_CAPABILITY_META[capability].holder === CapabilityHolder.Everyone
  ) {
    return true;
  }
  return isAdmin;
}

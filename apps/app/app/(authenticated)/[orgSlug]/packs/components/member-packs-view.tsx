"use client";

import { MemberView } from "@repo/app/packs/components/member-view";
import { useAdminPackViews } from "@repo/app/packs/hooks/use-admin-pack-views";
import { useAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import { CatalogDashboard } from "../../admin/catalog/components/catalog-dashboard";

/**
 * Web-member Packs treatment (FEA-4089), wired to the web data layer. Folds the
 * org catalog + distributions into `PackView`s (`GET /distributions` is
 * org-visible — no admin gate) and hands them to the shared, by-source
 * `MemberView`: a primary "Your packs" table grouped into Required / Installed
 * with honest per-row provenance, and a secondary "Available" catalog region.
 *
 * This replaces the FEA-4087 Slice-1 placeholder that landed members on the
 * admin `CatalogDashboard` (read-only) until the by-source treatment shipped.
 *
 * Two things this adapter threads through the shared view:
 *  - `memberUserId` (from the auth snapshot) scopes `specific`-targeting
 *    distributions to the targeted cohort, so an `auto_install specific` pack
 *    that names other members doesn't read as Required for this one.
 *  - `availableSlot` supplies the member-capable `CatalogDashboard`
 *    (`isAdmin={false}`) as the "Available" region body. That workspace still
 *    exposes the creator-only edit path for a member's own `OrgCustom` packs
 *    (`PATCH /catalog/{id}` permits creators to edit their own items) — so the
 *    by-source treatment no longer drops the member-owned edit capability the
 *    former slot carried (FEA-4085 parity).
 *
 * Honest scope note: `GET /distributions` (list) carries no per-member
 * `targetStatuses` and `catalogItemToPackView` sets `installedByMe=false`, so
 * the accepted-opt-in / self-installed / failed-install strands still can't be
 * derived on this surface. A member-scoped projection (per-member assignment +
 * install state) is a follow-up; until it lands the grouping degrades honestly
 * rather than fabricating those states.
 */
export function MemberPacksView() {
  const { userId } = useAuthSnapshot();
  const { packViews, isLoading, error } = useAdminPackViews({
    includeDistributions: true,
  });

  return (
    <MemberView
      availableSlot={<CatalogDashboard isAdmin={false} />}
      error={error}
      isLoading={isLoading}
      memberUserId={userId}
      packs={packViews}
    />
  );
}

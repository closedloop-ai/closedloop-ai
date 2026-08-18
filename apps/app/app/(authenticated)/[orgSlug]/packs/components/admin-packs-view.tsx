"use client";

import { AdminView } from "@repo/app/packs/components/admin-view";
import { PackAdminBoundary } from "@repo/app/packs/components/pack-admin-boundary";
import { useAdminPackViews } from "@repo/app/packs/hooks/use-admin-pack-views";
import { CatalogDashboard } from "../../admin/catalog/components/catalog-dashboard";

/**
 * Web-admin Packs treatment (FEA-4088 Slice 2). Wires the shared, manage-first
 * `AdminView` to the web data layer: the org catalog + distributions folded
 * into `PackView`s by `useAdminPackViews` drive the primary "Packs you
 * distribute" table, and the existing `CatalogDashboard` (the marketplace
 * discovery workspace plus its create / upload / distribute / archive dialogs)
 * is demoted into the secondary "Add packs" region.
 *
 * The hook is called here and again inside `CatalogDashboard`; TanStack Query
 * dedupes the catalog + distributions reads by key, so this is one network
 * fetch, not two. Keeping the marketplace as `CatalogDashboard` preserves every
 * dialog and edit path an admin had at the former `/admin/catalog` page.
 *
 * The `PackAdminBoundary` receives the same `isLoading`/`error` as the primary
 * table so its loading skeleton and honest failure state are real, not dead
 * scaffolding: the permission boundary depends on the same catalog +
 * distributions read the rest of the surface does, so when that read is in
 * flight the boundary shows a skeleton, and when it fails the boundary shows an
 * honest "couldn't load pack permissions" alert rather than a confident-looking
 * static list an admin could misread as loaded. `canManageRoles` stays off
 * (the boundary is read-only — this surface owns no role-management control).
 */
export function AdminPacksView() {
  const { distributedRows, isLoading, error } = useAdminPackViews({
    includeDistributions: true,
  });

  return (
    <AdminView
      boundarySlot={<PackAdminBoundary error={error} isLoading={isLoading} />}
      error={error}
      isLoading={isLoading}
      marketplaceSlot={<CatalogDashboard isAdmin />}
      rows={distributedRows}
    />
  );
}

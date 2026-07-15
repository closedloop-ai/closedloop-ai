"use client";

import type { DistributionDto } from "@repo/api/src/types/distribution";
import { useMemo } from "react";
import { useCatalogItems } from "../../agents/hooks/use-catalog";
import { useDistributions } from "../../agents/hooks/use-distributions";
import { catalogItemToPackView } from "../lib/catalog-item-to-pack-view";
import type { PackView } from "../lib/pack-view";

export type AdminPackViews = {
  packViews: PackView[];
  /** First distribution per catalog item, keyed by catalog item id. */
  distributionByCatalogId: Map<string, DistributionDto>;
  isLoading: boolean;
  error: Error | null;
};

type UseAdminPackViewsOptions = {
  /** Admin-only distribution summaries are skipped for member-visible catalog access. */
  includeDistributions?: boolean;
};

/**
 * Composes the org catalog + distributions into `PackView`s for the web-admin
 * Packs surface. A catalog item's admin distribution state (auto-install /
 * opt-in, per-target status) is merged in from the matching distribution.
 */
export function useAdminPackViews(
  options: UseAdminPackViewsOptions = {}
): AdminPackViews {
  const includeDistributions = options.includeDistributions ?? true;
  const catalog = useCatalogItems();
  const distributions = useDistributions({ enabled: includeDistributions });

  const distributionByCatalogId = useMemo(() => {
    const map = new Map<string, DistributionDto>();
    const distributionRows = includeDistributions
      ? (distributions.data ?? [])
      : [];
    for (const dist of distributionRows) {
      // Keep the first distribution per catalog item for the summary card.
      if (!map.has(dist.catalogItemId)) {
        map.set(dist.catalogItemId, dist);
      }
    }
    return map;
  }, [distributions.data, includeDistributions]);

  const packViews = useMemo(
    () =>
      (catalog.data ?? []).map((item) =>
        catalogItemToPackView(item, distributionByCatalogId.get(item.id))
      ),
    [catalog.data, distributionByCatalogId]
  );

  return {
    packViews,
    distributionByCatalogId,
    isLoading:
      catalog.isLoading || (includeDistributions && distributions.isLoading),
    error: (catalog.error ??
      (includeDistributions ? distributions.error : null)) as Error | null,
  };
}

"use client";

import type {
  CatalogItemDto,
  DistributionDto,
} from "@repo/api/src/types/distribution";
import { useMemo } from "react";
import { useCatalogItems } from "../../agents/hooks/use-catalog";
import { useDistributions } from "../../agents/hooks/use-distributions";
import { catalogItemToPackView } from "../lib/catalog-item-to-pack-view";
import {
  type DistributedPackRow,
  toDistributedPackRowsFromDistributions,
} from "../lib/distributed-pack-row";
import type { PackView } from "../lib/pack-view";

export type AdminPackViews = {
  packViews: PackView[];
  /** First distribution per catalog item, keyed by catalog item id. */
  distributionByCatalogId: Map<string, DistributionDto>;
  /**
   * One row per active distribution (NOT folded per catalog item), for the
   * manage-first distribute table — a catalog item can carry more than one
   * distribution, so folding would drop rows.
   */
  distributedRows: DistributedPackRow[];
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

  // ALL distributions per catalog item (not folded), for the member projection.
  // A catalog item can carry several active distributions at once; the member
  // grouping must consider every one so a required `all` distribution isn't
  // dropped when a newer `specific` distribution targets someone else — the
  // summary fold above (first-only) is not enough for member correctness.
  const distributionsByCatalogId = useMemo(() => {
    const map = new Map<string, DistributionDto[]>();
    const distributionRows = includeDistributions
      ? (distributions.data ?? [])
      : [];
    for (const dist of distributionRows) {
      const existing = map.get(dist.catalogItemId);
      if (existing) {
        existing.push(dist);
      } else {
        map.set(dist.catalogItemId, [dist]);
      }
    }
    return map;
  }, [distributions.data, includeDistributions]);

  const packViews = useMemo(
    () =>
      (catalog.data ?? []).map((item) =>
        catalogItemToPackView(
          item,
          distributionByCatalogId.get(item.id),
          null,
          distributionsByCatalogId.get(item.id)
        )
      ),
    [catalog.data, distributionByCatalogId, distributionsByCatalogId]
  );

  const catalogById = useMemo(() => {
    const map = new Map<string, CatalogItemDto>();
    for (const item of catalog.data ?? []) {
      map.set(item.id, item);
    }
    return map;
  }, [catalog.data]);

  // One row per distribution, built from the FULL distributions list so a
  // catalog item with multiple active distributions surfaces every one — the
  // per-catalog fold above is only for the summary card, not the table.
  const distributedRows = useMemo(() => {
    const distributionRows = includeDistributions
      ? (distributions.data ?? [])
      : [];
    return toDistributedPackRowsFromDistributions(
      distributionRows,
      catalogById
    );
  }, [distributions.data, includeDistributions, catalogById]);

  return {
    packViews,
    distributionByCatalogId,
    distributedRows,
    isLoading:
      catalog.isLoading || (includeDistributions && distributions.isLoading),
    error: (catalog.error ??
      (includeDistributions ? distributions.error : null)) as Error | null,
  };
}

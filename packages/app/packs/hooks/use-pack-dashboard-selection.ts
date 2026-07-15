"use client";

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import type {
  CatalogItemDto,
  DistributionDto,
} from "@repo/api/src/types/distribution";
import { useMemo } from "react";
import { useCatalogItem } from "../../agents/hooks/use-catalog";
import { agentComponentToPackAnalytics } from "../lib/agent-component-to-analytics";
import { catalogItemToPackView } from "../lib/catalog-item-to-pack-view";
import type { PackView } from "../lib/pack-view";
import { usePackAnalytics } from "./use-pack-analytics";

type UsePackDashboardSelectionOptions = {
  /**
   * The list of catalog items the discovery grid renders. Selection resolves
   * `selectedItem` from this list (list snapshot) merged with the per-item
   * detail read below.
   */
  items: CatalogItemDto[] | undefined;
  /**
   * The currently-selected catalog item id. Selection state is owned by the
   * caller so surface-specific derivations (e.g. the admin distribution read,
   * which itself calls a hook) can key off the same id.
   */
  selectedId: string | null;
  /**
   * Optional admin distribution state to fold into the detail `PackView`
   * (installed/pending targets). Member surfaces pass nothing.
   */
  distribution?: DistributionDto | null;
  /**
   * Whether to fetch the canonical org-wide analytics overlay for the selected
   * pack. Admin surfaces gate this on `isAdmin`; the member surface always
   * enables it. Defaults to `true`.
   */
  analyticsEnabled?: boolean;
};

type UsePackDashboardSelection = {
  /**
   * The selected catalog item, preferring the hydrated detail read (child
   * components + latest bodies) over the list snapshot.
   */
  selectedItem: CatalogItemDto | null;
  /**
   * The selected pack mapped to a `PackView`, with the analytics overlay
   * (Team-usage / Performance) layered on when available. `null` when nothing
   * is selected.
   */
  detailPack: PackView | null;
};

/**
 * Shared selection/detail/analytics composition for the Packs dashboards.
 *
 * Both the admin catalog dashboard (`admin/catalog/.../catalog-dashboard.tsx`)
 * and the member Plugins dashboard (`agents/.../member-packs-dashboard.tsx`)
 * render the same `PacksWorkspace` and drove an identical
 * `selectedId → listItem → packDetail → selectedItem → componentSlug →
 * analytics → detailPack` pipeline. This hook is that single, shared pipeline;
 * the surface-specific bits (admin distribution folding, analytics gating) are
 * supplied via options so behavior stays identical on both surfaces. Selection
 * state itself stays with the caller, since the admin surface resolves its
 * distribution (via `useDistribution`) off the same `selectedId`.
 */
export function usePackDashboardSelection({
  items,
  selectedId,
  distribution = null,
  analyticsEnabled = true,
}: UsePackDashboardSelectionOptions): UsePackDashboardSelection {
  const listItem = useMemo(
    () => items?.find((item) => item.id === selectedId) ?? null,
    [items, selectedId]
  );

  // Detail read hydrates the selected Pack's child components (→ Contents tab).
  const packDetail = useCatalogItem(selectedId ?? "");
  const selectedItem = packDetail.data ?? listItem;

  // Canonical org-wide analytics (see the identity-slug note): agentSlug is the
  // harness filename slug; component identity is `subagent::${agentSlug}`.
  const componentSlug = selectedItem?.agentSlug
    ? encodeComponentSlug(AgentComponentKind.Subagent, selectedItem.agentSlug)
    : null;
  const analytics = usePackAnalytics(analyticsEnabled ? componentSlug : null);

  const detailPack = useMemo<PackView | null>(() => {
    if (!selectedItem) {
      return null;
    }
    const base = catalogItemToPackView(selectedItem, distribution);
    if (!analytics.data) {
      return base;
    }
    const { teamUsage, performance } = agentComponentToPackAnalytics(
      analytics.data
    );
    return { ...base, teamUsage, performance };
  }, [selectedItem, distribution, analytics.data]);

  return { selectedItem, detailPack };
}

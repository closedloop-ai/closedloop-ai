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
import {
  type MemberComputeTarget,
  memberInstallMatrix,
} from "../lib/member-targets";
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
  /**
   * The member's own registered compute targets (FEA-4077). When supplied (the
   * web member surface), the selected pack's per-machine `installMatrix` is
   * built from these nodes so the member per-machine block reflects a READ of
   * the member's registered nodes. Omitted (admin / desktop) → no member matrix
   * is layered here (admin folds distribution; desktop uses local state).
   */
  memberTargets?: readonly MemberComputeTarget[];
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
  /**
   * The per-item detail read is in flight for the current selection (ISS-6925).
   *
   * Only a routed selection can observe this: a card click always has the list
   * snapshot in hand, but a direct load of `/packs/{id}` may name a pack the
   * list does not carry, and the surface must say "loading" rather than "not
   * found" until this read settles.
   */
  detailPending: boolean;
  /**
   * The per-item detail read FAILED (ISS-6925 review).
   *
   * Distinct from {@link detailPending} and from a pack that is genuinely
   * absent: `useCatalogItem` is a plain query, so a 5xx, a timeout, or an
   * offline client settles `isLoading` to false with no data. Collapsing that
   * into the not-found treatment would tell the reader their org's catalog does
   * not carry a pack, on the evidence of a transport failure.
   */
  detailFailed: boolean;
};

/**
 * Shared selection/detail/analytics composition for the Packs dashboards.
 *
 * The admin catalog dashboard (`admin/catalog/.../catalog-dashboard.tsx`) is the
 * consumer, and the member Packs surface (`packs/.../member-packs-view.tsx`)
 * reaches the same pipeline by embedding that dashboard as its "Available"
 * region with `isAdmin={false}`. Both therefore render the same
 * `PacksWorkspace` and drove an identical
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
  memberTargets,
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
    // Member per-machine block (FEA-4077): on the member surface (which passes a
    // `memberTargets` array — even empty) always build the per-machine matrix
    // from a READ of the member's registered nodes and any distribution status
    // rows keyed on them. A member with zero nodes yields an empty matrix (the
    // block's honest "no machines" state), distinct from `undefined` (admin /
    // desktop), which preserves the admin matrix built by `catalogItemToPackView`.
    const withMatrix = memberTargets
      ? {
          ...base,
          installMatrix: memberInstallMatrix(
            selectedItem,
            memberTargets,
            distribution?.targetStatuses ?? []
          ),
        }
      : base;
    if (!analytics.data) {
      return withMatrix;
    }
    const { teamUsage, performance } = agentComponentToPackAnalytics(
      analytics.data
    );
    return { ...withMatrix, teamUsage, performance };
  }, [selectedItem, distribution, analytics.data, memberTargets]);

  // Guarded on the selection rather than trusting the disabled query's own
  // flag: with nothing selected the detail query is keyed on "" and must never
  // report pending.
  const detailPending = selectedId !== null && packDetail.isLoading;
  const detailFailed = selectedId !== null && packDetail.isError;

  return { selectedItem, detailPack, detailPending, detailFailed };
}

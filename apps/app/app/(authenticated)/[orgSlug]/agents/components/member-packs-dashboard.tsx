"use client";

import { useCatalogItems } from "@repo/app/agents/hooks/use-catalog";
import { PacksWorkspace } from "@repo/app/packs/components/packs-workspace";
import { usePackDashboardSelection } from "@repo/app/packs/hooks/use-pack-dashboard-selection";
import { catalogItemToPackView } from "@repo/app/packs/lib/catalog-item-to-pack-view";
import type { PackView } from "@repo/app/packs/lib/pack-view";
import {
  createPacksContext,
  PacksMode,
} from "@repo/app/packs/lib/packs-context";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PACK_EXTENDED_CONTENT_KINDS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useMemo, useState } from "react";

/**
 * Member-facing Packs workspace for the web Agents → Plugins tab.
 *
 * Renders the same shared, prototype-styled `PacksWorkspace` as the admin
 * catalog dashboard (`admin/catalog/components/catalog-dashboard.tsx`), but in
 * the read-only `WebMember` context: a regular org member browses the org
 * catalog (`GET /catalog` is member-readable, org-scoped — only writes are
 * admin-gated) and sees the canonical usage/performance overlay, without the
 * admin authoring / distribution / archive affordances.
 *
 * Self-service install to a member's own Electron nodes from the web is a
 * follow-up: it needs a member-scoped distribution/dispatch path (cloud →
 * relay → node), which does not exist yet. Until then this surfaces discovery
 * + detail parity with the admin page and the prototype.
 */
export function MemberPacksDashboard() {
  const { data: items, isLoading, error } = useCatalogItems();

  const showExtended = useFeatureFlagEnabled(
    PACK_EXTENDED_CONTENT_KINDS_FEATURE_FLAG_KEY
  );
  const context = useMemo(
    () =>
      createPacksContext(PacksMode.WebMember, {
        showExtendedContentKinds: showExtended,
      }),
    [showExtended]
  );

  const packViews = useMemo<PackView[]>(
    () => (items ?? []).map((item) => catalogItemToPackView(item)),
    [items]
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Shared selection/detail/analytics pipeline (identical to the admin
  // dashboard); the member surface has no distribution folding and always
  // enables the canonical org-wide analytics overlay.
  const { detailPack } = usePackDashboardSelection({ items, selectedId });

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading Packs…</p>;
  }

  if (error) {
    return (
      <p className="text-destructive text-sm">
        Failed to load Packs: {error.message}
      </p>
    );
  }

  return (
    <PacksWorkspace
      context={context}
      detailPack={detailPack}
      onSelectPack={setSelectedId}
      packs={packViews}
      toolbarSlot={
        <div>
          <h2 className="font-semibold text-lg">Plugins</h2>
          <p className="text-muted-foreground text-sm">
            Browse the Packs available to your organization.
          </p>
        </div>
      }
    />
  );
}

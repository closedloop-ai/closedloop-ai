"use client";

import {
  type CatalogItemDto,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
import {
  catalogKeys,
  useArchiveCatalogItem,
  useCatalogItems,
} from "@repo/app/agents/hooks/use-catalog";
import { useDistribution } from "@repo/app/agents/hooks/use-distributions";
import { PacksWorkspace } from "@repo/app/packs/components/packs-workspace";
import { useAdminPackViews } from "@repo/app/packs/hooks/use-admin-pack-views";
import { usePackDashboardSelection } from "@repo/app/packs/hooks/use-pack-dashboard-selection";
import {
  createPacksContext,
  PacksMode,
} from "@repo/app/packs/lib/packs-context";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PACK_EXTENDED_CONTENT_KINDS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { Button } from "@repo/design-system/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { PencilIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ComponentEditorDialog } from "./component-editor-dialog";
import { CreateDistributionModal } from "./create-distribution-modal";
import { CreatePackDialog } from "./create-pack-dialog";
import { PackComponentsPanel } from "./pack-components-panel";

/**
 * Admin Packs dashboard (unified Packs UX). Renders the shared, prototype-styled
 * `PacksWorkspace` in the web-admin context — discovery grid + detail with an
 * editable Components manager (kind-aware authoring), Distribution, and the
 * canonical Team-usage / Performance tabs — preserving create / upload /
 * distribute / archive.
 */
type CatalogDashboardProps = {
  isAdmin: boolean;
};

export function CatalogDashboard({ isAdmin }: CatalogDashboardProps) {
  const queryClient = useQueryClient();
  const { packViews, distributionByCatalogId, isLoading, error } =
    useAdminPackViews({ includeDistributions: isAdmin });
  const { data: items } = useCatalogItems();
  const { data: currentUser } = useCurrentUser({ enabled: !isAdmin });
  const archiveItem = useArchiveCatalogItem();

  const showExtended = useFeatureFlagEnabled(
    PACK_EXTENDED_CONTENT_KINDS_FEATURE_FLAG_KEY
  );
  const context = useMemo(
    () =>
      createPacksContext(PacksMode.WebAdmin, {
        showTeamUsage: isAdmin,
        showActivity: false,
        showPerformance: isAdmin,
        showExtendedContentKinds: showExtended,
        manageCatalog: isAdmin,
        manageDistribution: isAdmin,
      }),
    [isAdmin, showExtended]
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [componentOpen, setComponentOpen] = useState(false);
  const [editingComponent, setEditingComponent] =
    useState<CatalogItemDto | null>(null);
  const [distributeItem, setDistributeItem] = useState<CatalogItemDto | null>(
    null
  );

  // Admin surface folds the selected Pack's distribution into the detail view.
  const selectedDist = selectedId
    ? distributionByCatalogId.get(selectedId)
    : undefined;
  const distDetail = useDistribution(selectedDist?.id ?? "");

  // Shared selection/detail/analytics pipeline (identical to the member
  // dashboard): the admin surface folds distribution into the detail view and
  // gates the analytics overlay on `isAdmin`.
  const { selectedItem, detailPack } = usePackDashboardSelection({
    items,
    selectedId,
    distribution: distDetail.data ?? selectedDist ?? null,
    analyticsEnabled: isAdmin,
  });

  const handleManageDistribution = useCallback(
    (packId: string) => {
      if (!isAdmin) {
        return;
      }
      const item = items?.find((candidate) => candidate.id === packId);
      if (item) {
        setDistributeItem(item);
      }
    },
    [isAdmin, items]
  );

  const handleArchive = useCallback(
    async (id: string) => {
      try {
        await archiveItem.mutateAsync(id);
        setSelectedId(null);
      } catch {
        // Error surfaced by the mutation.
      }
    },
    [archiveItem]
  );

  const handleComponentSaved = useCallback(() => {
    if (selectedId) {
      queryClient.invalidateQueries({
        queryKey: catalogKeys.detail(selectedId),
      });
    }
  }, [queryClient, selectedId]);

  const canEditCatalogItem = useCallback(
    (item: CatalogItemDto | null | undefined): item is CatalogItemDto => {
      if (
        !item ||
        item.source !== CatalogItemSource.OrgCustom ||
        item.archived
      ) {
        return false;
      }
      if (isAdmin) {
        return true;
      }
      return Boolean(item.createdById && item.createdById === currentUser?.id);
    },
    [currentUser?.id, isAdmin]
  );

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

  const selectedEditable = Boolean(
    selectedItem &&
      selectedItem.source === CatalogItemSource.OrgCustom &&
      !selectedItem.archived
  );
  const canEditSelected = canEditCatalogItem(selectedItem);
  const canArchiveSelected = Boolean(isAdmin && selectedEditable);

  // Component authoring targets Pack containers only. Legacy standalone
  // agent/plugin items (parentPackId: null) must not accept child components —
  // POSTing a child with a standalone item as parentPackId would produce an
  // inconsistent hierarchy.
  const selectedIsPack =
    selectedEditable && selectedItem?.targetKind === "pack";

  const canEditSelectedComponent = (component: CatalogItemDto) =>
    Boolean(selectedIsPack && canEditCatalogItem(component));

  const detailHeaderActions = selectedItem ? (
    <CatalogDetailActions
      archivePending={archiveItem.isPending}
      canArchiveSelected={canArchiveSelected}
      canEditSelected={canEditSelected}
      onArchive={handleArchive}
      onEdit={() => {
        setEditingComponent(selectedItem);
        setComponentOpen(true);
      }}
      selectedItem={selectedItem}
    />
  ) : null;

  const detailContentsSlot = selectedItem ? (
    <PackComponentsPanel
      canCreateComponents={Boolean(isAdmin && selectedIsPack)}
      canEditComponent={canEditSelectedComponent}
      components={selectedItem.components}
      onAdd={() => {
        setEditingComponent(null);
        setComponentOpen(true);
      }}
      onEdit={(component) => {
        setEditingComponent(component);
        setComponentOpen(true);
      }}
      onImported={handleComponentSaved}
      packId={selectedItem.id}
    />
  ) : null;

  return (
    <>
      <PacksWorkspace
        context={context}
        detailContentsSlot={detailContentsSlot}
        detailHeaderActions={detailHeaderActions}
        detailPack={detailPack}
        onManageDistribution={isAdmin ? handleManageDistribution : undefined}
        onSelectPack={setSelectedId}
        packs={packViews}
        toolbarSlot={
          <CatalogToolbar
            isAdmin={isAdmin}
            onCreate={() => setCreateOpen(true)}
          />
        }
      />

      <CreatePackDialog
        onCreated={(pack) => setSelectedId(pack.id)}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />

      {selectedId ? (
        <ComponentEditorDialog
          existing={editingComponent}
          onOpenChange={setComponentOpen}
          onSaved={handleComponentSaved}
          open={componentOpen}
          parentPackId={selectedId}
        />
      ) : null}

      {distributeItem ? (
        <CreateDistributionModal
          catalogItem={distributeItem}
          onOpenChange={(next) => {
            if (!next) {
              setDistributeItem(null);
            }
          }}
          onSuccess={() => setDistributeItem(null)}
          open={Boolean(distributeItem)}
        />
      ) : null}
    </>
  );
}

type CatalogToolbarProps = {
  isAdmin: boolean;
  onCreate: () => void;
};

function CatalogToolbar({ isAdmin, onCreate }: CatalogToolbarProps) {
  return (
    <>
      <div>
        <h2 className="font-semibold text-lg">Packs</h2>
        <p className="text-muted-foreground text-sm">
          Org-custom and curated Packs available to distribute.
        </p>
      </div>
      {isAdmin ? (
        <Button onClick={onCreate}>
          <PlusIcon className="mr-1 size-4" />
          New Pack
        </Button>
      ) : null}
    </>
  );
}

type CatalogDetailActionsProps = {
  archivePending: boolean;
  canArchiveSelected: boolean;
  canEditSelected: boolean;
  onArchive: (id: string) => void;
  onEdit: () => void;
  selectedItem: CatalogItemDto;
};

function CatalogDetailActions({
  archivePending,
  canArchiveSelected,
  canEditSelected,
  onArchive,
  onEdit,
  selectedItem,
}: CatalogDetailActionsProps) {
  if (!(canEditSelected || canArchiveSelected)) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      {canEditSelected ? (
        <Button className="gap-1.5" onClick={onEdit} size="sm" variant="ghost">
          <PencilIcon className="size-3.5" />
          Edit
        </Button>
      ) : null}
      {canArchiveSelected ? (
        <Button
          disabled={archivePending}
          onClick={() => onArchive(selectedItem.id)}
          size="sm"
          variant="ghost"
        >
          Archive
        </Button>
      ) : null}
    </div>
  );
}

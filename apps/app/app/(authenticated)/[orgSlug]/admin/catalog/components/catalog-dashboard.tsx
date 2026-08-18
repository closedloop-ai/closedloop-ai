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
import {
  distributionKeys,
  useDistribution,
} from "@repo/app/agents/hooks/use-distributions";
import { PacksLoadFailed } from "@repo/app/packs/components/packs-load-failed";
import { PacksWorkspace } from "@repo/app/packs/components/packs-workspace";
import { PacksWorkspaceSkeleton } from "@repo/app/packs/components/packs-workspace-skeleton";
import { useAdminPackViews } from "@repo/app/packs/hooks/use-admin-pack-views";
import { useMemberTargetsInstall } from "@repo/app/packs/hooks/use-member-targets-install";
import { usePackDashboardSelection } from "@repo/app/packs/hooks/use-pack-dashboard-selection";
import { usePackDistributionWithdrawal } from "@repo/app/packs/hooks/use-pack-distribution-withdrawal";
import {
  createPacksContext,
  PacksMode,
} from "@repo/app/packs/lib/packs-context";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY,
  PACK_UNDISTRIBUTE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { PencilIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useMemberPackTargets } from "@/hooks/queries/use-member-pack-targets";
import { ComponentEditorDialog } from "./component-editor-dialog";
import { CreateDistributionModal } from "./create-distribution-modal";
import { CreatePackDialog } from "./create-pack-dialog";
import { PackComponentsPanel } from "./pack-components-panel";
import { WithdrawDistributionDialog } from "./withdraw-distribution-dialog";

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
  const archiveItem = useArchiveCatalogItem();

  const context = useMemo(
    () =>
      createPacksContext(PacksMode.WebAdmin, {
        showTeamUsage: isAdmin,
        showActivity: false,
        showPerformance: isAdmin,
        manageCatalog: isAdmin,
        manageDistribution: isAdmin,
        // Member surface: show the per-machine block (FEA-4077), a READ of the
        // member's registered nodes. Admins manage roll-out through the
        // Distribution tab, so their per-machine block stays off.
        showMemberTargets: !isAdmin,
      }),
    [isAdmin]
  );

  // The member per-machine block reflects the member's OWN registered nodes
  // (FEA-4077) — scoped to this member so it never shows another member's
  // machines, and left `undefined` for an admin so the selection hook keeps the
  // admin distribution matrix instead of overwriting it with an empty member
  // matrix. The composition of those two reads lives in its own hook.
  const memberPackTargets = useMemberPackTargets(isAdmin);

  // ISS-5125: the member per-machine block's ACT half. Enabled only on the
  // MEMBER surface (an admin manages roll-out through Distribution, and their
  // block is not rendered at all) and only behind the closed-by-default
  // `member-self-service-install` flag. Off, `useMemberTargetsInstall` returns
  // null and the block stays the FEA-4077 read-only status list.
  //
  // No client-side permission check rides here: the org role model already
  // grants every member `InstallToOwnMachines`, and the API authorizes node
  // ownership itself (`findOwnedById`, owner-only and org-scoped). Adding a
  // second, weaker gate in the browser would only be able to disagree with it.
  const memberInstallEnabled = useFeatureFlagEnabled(
    MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY
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
    memberTargets: memberPackTargets.targets,
  });

  const memberTargetsInstall = useMemberTargetsInstall({
    packId: selectedItem?.id ?? null,
    enabled: !isAdmin && memberInstallEnabled,
  });

  // ISS-5123 (ISS-4779 closed-by-default): the admin "stop distributing" flow.
  // Web-only by construction — the Distribution tab that hosts the control
  // renders only under `PacksMode.WebAdmin`, so there is no desktop surface for
  // a Labs toggle to keep in parity. The hook owns the confirmation state and
  // the mutation; off, `requestWithdraw` is null and no control is rendered.
  const undistributeEnabled = useFeatureFlagEnabled(
    PACK_UNDISTRIBUTE_FEATURE_FLAG_KEY
  );
  const withdrawal = usePackDistributionWithdrawal({
    flagEnabled: undistributeEnabled,
    isAdmin,
    packName: selectedItem?.name,
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

  // ISS-5002: give the failure state a real way forward. Refetching both
  // families is what the failed view was waiting on (`useAdminPackViews` reads
  // the catalog list and, for admins, the distributions list).
  const handleRetryPacks = useCallback(() => {
    queryClient.refetchQueries({ queryKey: catalogKeys.all });
    queryClient.refetchQueries({ queryKey: distributionKeys.all });
  }, [queryClient]);

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
      return Boolean(
        item.createdById && item.createdById === memberPackTargets.currentUserId
      );
    },
    [memberPackTargets.currentUserId, isAdmin]
  );

  // ISS-5002: the purpose-built skeleton, not a bare unstyled paragraph. It
  // reserves the loaded workspace's real geometry (filter bar, card grid, and
  // the admin surface's 20rem team rail) so nothing reflows when the catalog
  // lands, and it carries the accessible loading status the paragraph never had.
  if (isLoading) {
    return (
      <PacksWorkspaceSkeleton
        header={<CatalogHeading />}
        showTeamLayout={isAdmin}
      />
    );
  }

  if (error) {
    // Keep the page's identity above the failure. The skeleton branch above
    // already proves the heading does not depend on the fetch, so dropping it
    // here would swap the whole page for one centered card immediately after
    // showing a headed skeleton.
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
        <CatalogHeading />
        <PacksLoadFailed error={error} onRetry={handleRetryPacks} />
      </div>
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
        memberTargetsDescription="Where this pack stands on the machines registered to your account."
        memberTargetsError={memberPackTargets.hasErrored}
        memberTargetsInstall={memberTargetsInstall}
        memberTargetsLoading={memberPackTargets.isLoading}
        onManageDistribution={isAdmin ? handleManageDistribution : undefined}
        onSelectPack={setSelectedId}
        onWithdrawDistribution={withdrawal.requestWithdraw}
        packs={packViews}
        toolbarSlot={
          <CatalogToolbar
            isAdmin={isAdmin}
            onCreate={() => setCreateOpen(true)}
          />
        }
        withdrawDistributionPending={withdrawal.isPending}
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

      {/*
        The withdraw confirmation. The control lives inside the selected pack's
        detail, so `selectedItem` is the pack being withdrawn.
      */}
      <WithdrawDistributionDialog pack={selectedItem} withdrawal={withdrawal} />
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
      <CatalogHeading />
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

/**
 * The surface's known-ahead-of-fetch heading. Split out of {@link CatalogToolbar}
 * so the loading skeleton can render the real heading (which never depends on
 * the fetch) in the same slot the loaded workspace puts it, without also
 * rendering the "New Pack" action whose dialog is not mounted yet (ISS-5002).
 */
function CatalogHeading() {
  return (
    <div>
      <h2 className="font-semibold text-lg">Packs</h2>
      <p className="text-muted-foreground text-sm">
        Org-custom and curated Packs available to distribute.
      </p>
    </div>
  );
}

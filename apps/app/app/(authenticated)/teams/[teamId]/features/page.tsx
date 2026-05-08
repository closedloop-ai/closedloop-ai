"use client";

import type { Priority } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { BoxIcon, Loader2Icon, PlusIcon, SearchIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { CreateFeatureModal } from "@/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/create-feature-modal";
import { ActiveFiltersBar } from "@/components/document-table/active-filters-bar";
import { DeleteRowActions } from "@/components/document-table/delete-row-actions";
import type {
  DocumentRowItem,
  RowEditHandlers,
} from "@/components/document-table/document-row";
import { FilterPopover } from "@/components/document-table/filter-popover";
import { FlatDocumentTable } from "@/components/document-table/flat-document-table";
import { TableViewMenu } from "@/components/document-table/table-view-menu";
import {
  useDeleteDocument,
  useDocumentsByTeam,
  useUpdateDocument,
} from "@/hooks/queries/use-documents";
import { useTeam } from "@/hooks/queries/use-teams";
import { useCurrentUser } from "@/hooks/queries/use-users";
import {
  FEATURE_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@/hooks/use-column-visibility";
import { useFilterCurrentUser } from "@/hooks/use-filter-current-user";
import { useGroupBy } from "@/hooks/use-group-by";
import { useItemsParentTitles } from "@/hooks/use-items-parent-titles";
import { useOrgUsersAsPopoverUsers } from "@/hooks/use-org-users-as-popover-users";
import { useTableFilters } from "@/hooks/use-table-filters";
import { useTeamMembers } from "@/hooks/use-team-members";

const COLUMN_VISIBILITY_KEY = "table:columns:team-features";

export default function TeamFeaturesPage() {
  const params = useParams();
  const teamId = params.teamId as string;
  const [createFeatureOpen, setCreateFeatureOpen] = useState(false);
  const [filterText, setFilterText] = useState("");

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility({
    storageKey: COLUMN_VISIBILITY_KEY,
  });
  const visibleColumns = useMemo(
    () => FEATURE_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  const { groupBy, setGroupBy } = useGroupBy(
    "table:groupByStatus:team-features"
  );

  const { data: team, isLoading: loadingTeam } = useTeam(teamId);
  const { data: features = [], isLoading: loadingFeatures } =
    useDocumentsByTeam(teamId, DocumentType.Feature);
  const orgUsers = useOrgUsersAsPopoverUsers();
  const { data: currentUser } = useCurrentUser();

  const {
    members: teamMembers,
    isLoading: teamMembersLoading,
    error: teamMembersError,
  } = useTeamMembers({ teamIds: team ? [team.id] : [] });

  const deleteFeatureMutation = useDeleteDocument();
  const updateFeatureMutation = useUpdateDocument();

  const allItems: DocumentRowItem[] = useMemo(
    () => features.map((f) => ({ kind: "feature" as const, data: f })),
    [features]
  );

  const filtersReturn = useTableFilters({
    items: allItems,
    currentUserId: currentUser?.id,
  });

  const displayItems = useMemo(() => {
    let filtered = features;
    if (filterText.trim()) {
      const q = filterText.toLowerCase().trim();
      filtered = features.filter(
        (f) =>
          f.title.toLowerCase().includes(q) || f.slug.toLowerCase().includes(q)
      );
    }
    let items: DocumentRowItem[] = filtered.map((f) => ({
      kind: "feature" as const,
      data: f,
    }));
    if (filtersReturn.isAnyFilterActive) {
      items = filtersReturn.applyFilters(items);
    }
    return items;
  }, [
    features,
    filterText,
    filtersReturn.isAnyFilterActive,
    filtersReturn.applyFilters,
  ]);

  const parentTitleMap = useItemsParentTitles(allItems);

  const filterCurrentUser = useFilterCurrentUser(currentUser);

  const editHandlers: RowEditHandlers = useMemo(
    () => ({
      teamMembers: orgUsers,
      onUpdateAssignee: (id, assigneeId) =>
        updateFeatureMutation.mutate({ id, assigneeId }),
      onUpdatePriority: (id, priority: Priority) =>
        updateFeatureMutation.mutate({ id, priority }),
      onUpdateStatus: (id, status) =>
        updateFeatureMutation.mutate({ id, status }),
    }),
    [orgUsers, updateFeatureMutation.mutate]
  );

  const handleDelete = async (item: DocumentRowItem): Promise<boolean> => {
    const result = await deleteFeatureMutation.mutateAsync(item.data.id);
    return result.deleted ?? false;
  };

  const loading = loadingTeam || loadingFeatures;
  const hasAnyFeatures = features.length > 0;
  const hasActiveRefinements =
    filterText.trim().length > 0 || filtersReturn.isAnyFilterActive;
  const emptyTitle =
    hasAnyFeatures && hasActiveRefinements
      ? "No matching features"
      : "No features yet";
  const emptyDescription =
    hasAnyFeatures && hasActiveRefinements
      ? "Try adjusting your search or filters."
      : "Features will appear here once they are created in a project.";

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!team) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Team not found</p>
      </div>
    );
  }

  return (
    <>
      <Header
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: team.name, href: `/teams/${teamId}/projects` },
          { label: "Features" },
        ]}
      >
        <Button onClick={() => setCreateFeatureOpen(true)}>
          <PlusIcon className="h-4 w-4" />
          Create Feature
        </Button>
      </Header>
      <CreateFeatureModal
        onOpenChange={setCreateFeatureOpen}
        open={createFeatureOpen}
        teamId={teamId}
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b">
          <div className="flex min-w-fit items-center justify-between gap-3 px-4 py-3">
            <h1 className="font-semibold text-xl">Features</h1>
            <div className="flex items-center gap-2">
              <div className="relative min-w-[200px] max-w-[350px]">
                <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
                  <SearchIcon className="h-4 w-4 text-muted-foreground" />
                </div>
                <Input
                  aria-label="Filter items"
                  className="h-8 pl-9 shadow-none"
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="Filter items..."
                  value={filterText}
                />
              </div>
              <FilterPopover
                currentUser={filterCurrentUser}
                filtersReturn={filtersReturn}
                teamMembers={teamMembers}
                teamMembersError={teamMembersError}
                teamMembersLoading={teamMembersLoading}
              />
              <TableViewMenu
                columns={FEATURE_DEFAULT_COLUMNS}
                groupBy={groupBy}
                onChangeGroupBy={setGroupBy}
                onToggle={toggleColumn}
                visibility={visibility}
              />
            </div>
          </div>
          {filtersReturn.isAnyFilterActive && (
            <ActiveFiltersBar
              currentUser={filterCurrentUser}
              filtersReturn={filtersReturn}
              teamMembers={teamMembers}
              teamMembersError={teamMembersError}
              teamMembersLoading={teamMembersLoading}
            />
          )}
        </div>
        <div className="flex-1 overflow-auto">
          <FlatDocumentTable
            editHandlers={editHandlers}
            emptyDescription={emptyDescription}
            emptyIcon={BoxIcon}
            emptyTitle={emptyTitle}
            groupBy={groupBy}
            groupExpansionKey="table:expand:team-features-status"
            items={displayItems}
            moreMenuContent={(_item, onRequestDelete) => (
              <DeleteRowActions onDelete={onRequestDelete} />
            )}
            onDelete={handleDelete}
            parentTitleMap={parentTitleMap}
            visibleColumns={visibleColumns}
          />
        </div>
      </main>
    </>
  );
}

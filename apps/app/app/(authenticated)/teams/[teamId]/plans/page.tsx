"use client";

import {
  type Artifact,
  type ArtifactStatus,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { FileCodeIcon, Loader2Icon, PlusIcon, SearchIcon } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { CreateArtifactModal } from "@/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/create-artifact-modal";
import { ActiveFiltersBar } from "@/components/artifact-table/active-filters-bar";
import type {
  ArtifactRowItem,
  RowEditHandlers,
} from "@/components/artifact-table/artifact-row";
import { DeleteRowActions } from "@/components/artifact-table/delete-row-actions";
import { FilterPopover } from "@/components/artifact-table/filter-popover";
import { FlatArtifactTable } from "@/components/artifact-table/flat-artifact-table";
import { TableViewMenu } from "@/components/artifact-table/table-view-menu";
import {
  useArtifactsByTeam,
  useDeleteArtifact,
  useUpdateArtifact,
} from "@/hooks/queries/use-artifacts";
import { useTeam } from "@/hooks/queries/use-teams";
import { useCurrentUser } from "@/hooks/queries/use-users";
import {
  PLAN_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@/hooks/use-column-visibility";
import { useGroupByStatus } from "@/hooks/use-group-by-status";
import { useItemsParentTitles } from "@/hooks/use-items-parent-titles";
import { useOrgUsersAsPopoverUsers } from "@/hooks/use-org-users-as-popover-users";
import { useTableFilters } from "@/hooks/use-table-filters";
import { useTeamMembers } from "@/hooks/use-team-members";
import { matchesFilter } from "@/lib/artifact-filter";

const COLUMN_VISIBILITY_KEY = "table:columns:team-plans";

export default function TeamPlansPage() {
  const params = useParams();
  const router = useRouter();
  const teamId = params.teamId as string;
  const [createPlanOpen, setCreatePlanOpen] = useState(false);
  const [filterText, setFilterText] = useState("");

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility({
    storageKey: COLUMN_VISIBILITY_KEY,
  });
  const visibleColumns = useMemo(
    () => PLAN_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  const { groupByStatus, toggleGroupByStatus } = useGroupByStatus(
    "table:groupByStatus:team-plans"
  );

  const { data: team, isLoading: loadingTeam } = useTeam(teamId);
  const { data: artifacts, isLoading: loadingArtifacts } = useArtifactsByTeam(
    teamId,
    ArtifactType.ImplementationPlan
  );
  const orgUsers = useOrgUsersAsPopoverUsers();
  const { data: currentUser } = useCurrentUser();

  const {
    members: teamMembers,
    isLoading: teamMembersLoading,
    error: teamMembersError,
  } = useTeamMembers({ teamIds: team ? [team.id] : [] });

  const deleteArtifactMutation = useDeleteArtifact();
  const updateArtifactMutation = useUpdateArtifact();

  const allItems: ArtifactRowItem[] = useMemo(
    () =>
      (artifacts ?? []).map((a) => ({ kind: "artifact" as const, data: a })),
    [artifacts]
  );

  const filtersReturn = useTableFilters({
    items: allItems,
    currentUserId: currentUser?.id,
  });

  const displayItems = useMemo(() => {
    const textFiltered = (artifacts ?? []).filter((a) =>
      matchesFilter(a, filterText)
    );
    let items: ArtifactRowItem[] = textFiltered.map((a) => ({
      kind: "artifact" as const,
      data: a,
    }));
    if (filtersReturn.isAnyFilterActive) {
      items = filtersReturn.applyFilters(items);
    }
    return items;
  }, [artifacts, filterText, filtersReturn]);

  const parentTitleMap = useItemsParentTitles(allItems);

  const filterCurrentUser = useMemo(
    () =>
      currentUser
        ? {
            id: currentUser.id,
            name:
              [currentUser.firstName, currentUser.lastName]
                .filter(Boolean)
                .join(" ") || currentUser.email,
            avatarUrl: currentUser.avatarUrl ?? undefined,
          }
        : null,
    [currentUser]
  );

  const editHandlers: RowEditHandlers = useMemo(
    () => ({
      teamMembers: orgUsers,
      onUpdateAssignee: (id, assigneeId) =>
        updateArtifactMutation.mutate({ id, assigneeId }),
      onUpdatePriority: (id, priority) =>
        updateArtifactMutation.mutate({ id, priority }),
      onUpdateStatus: (id, status) =>
        updateArtifactMutation.mutate({ id, status: status as ArtifactStatus }),
    }),
    [orgUsers, updateArtifactMutation]
  );

  const handleDelete = async (item: ArtifactRowItem): Promise<boolean> => {
    const result = await deleteArtifactMutation.mutateAsync(item.data.id);
    return result.deleted ?? false;
  };

  const loading = loadingTeam || loadingArtifacts;
  const hasAnyPlans = (artifacts ?? []).length > 0;
  const hasActiveRefinements =
    filterText.trim().length > 0 || filtersReturn.isAnyFilterActive;
  const emptyTitle =
    hasAnyPlans && hasActiveRefinements ? "No matching plans" : "No plans yet";
  const emptyDescription =
    hasAnyPlans && hasActiveRefinements
      ? "Try adjusting your search or filters."
      : "Plans will appear here once they are created in a project.";

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
          { label: "Plans" },
        ]}
      >
        <Button onClick={() => setCreatePlanOpen(true)}>
          <PlusIcon className="h-4 w-4" />
          Create Plan
        </Button>
      </Header>
      <CreateArtifactModal
        artifactType={ArtifactType.ImplementationPlan}
        onOpenChange={setCreatePlanOpen}
        onSuccess={(artifact: Artifact) =>
          router.push(`/implementation-plans/${artifact.slug}`)
        }
        open={createPlanOpen}
        teamId={teamId}
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b">
          <div className="flex min-w-fit items-center justify-between gap-3 px-4 py-3">
            <h1 className="font-semibold text-xl">Plans</h1>
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
                columns={PLAN_DEFAULT_COLUMNS}
                groupByStatus={groupByStatus}
                onToggle={toggleColumn}
                onToggleGroupByStatus={toggleGroupByStatus}
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
          <FlatArtifactTable
            editHandlers={editHandlers}
            emptyDescription={emptyDescription}
            emptyIcon={FileCodeIcon}
            emptyTitle={emptyTitle}
            groupByStatus={groupByStatus}
            items={displayItems}
            moreMenuContent={(_item, onRequestDelete) => (
              <DeleteRowActions onDelete={onRequestDelete} />
            )}
            onDelete={handleDelete}
            parentTitleMap={parentTitleMap}
            statusExpansionKey="table:expand:team-plans-status"
            visibleColumns={visibleColumns}
          />
        </div>
      </main>
    </>
  );
}

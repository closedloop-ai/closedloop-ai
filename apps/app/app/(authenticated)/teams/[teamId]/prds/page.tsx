"use client";

import {
  type Document,
  type DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { FileIcon, Loader2Icon, PlusIcon, SearchIcon } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { CreateDocumentModal } from "@/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/create-document-modal";
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
  PRD_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@/hooks/use-column-visibility";
import { useGroupBy } from "@/hooks/use-group-by";
import { useOrgUsersAsPopoverUsers } from "@/hooks/use-org-users-as-popover-users";
import { useTableFilters } from "@/hooks/use-table-filters";
import { useTeamMembers } from "@/hooks/use-team-members";
import { matchesFilter } from "@/lib/document-filter";

const COLUMN_VISIBILITY_KEY = "table:columns:team-prds";

export default function TeamPrdsPage() {
  const params = useParams();
  const router = useRouter();
  const teamId = params.teamId as string;
  const [createPrdOpen, setCreatePrdOpen] = useState(false);
  const [filterText, setFilterText] = useState("");

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility({
    storageKey: COLUMN_VISIBILITY_KEY,
  });
  const visibleColumns = useMemo(
    () => PRD_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  const { groupBy, setGroupBy } = useGroupBy("table:groupByStatus:team-prds");

  const { data: team, isLoading: loadingTeam } = useTeam(teamId);
  const { data: artifacts, isLoading: loadingDocuments } = useDocumentsByTeam(
    teamId,
    DocumentType.Prd
  );
  const orgUsers = useOrgUsersAsPopoverUsers();
  const { data: currentUser } = useCurrentUser();

  const {
    members: teamMembers,
    isLoading: teamMembersLoading,
    error: teamMembersError,
  } = useTeamMembers({ teamIds: team ? [team.id] : [] });

  const deleteDocumentMutation = useDeleteDocument();
  const updateDocumentMutation = useUpdateDocument();

  const allItems: DocumentRowItem[] = useMemo(
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
    let items: DocumentRowItem[] = textFiltered.map((a) => ({
      kind: "artifact" as const,
      data: a,
    }));
    if (filtersReturn.isAnyFilterActive) {
      items = filtersReturn.applyFilters(items);
    }
    return items;
  }, [artifacts, filterText, filtersReturn]);

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
        updateDocumentMutation.mutate({ id, assigneeId }),
      onUpdatePriority: (id, priority) =>
        updateDocumentMutation.mutate({ id, priority }),
      onUpdateStatus: (id, status) =>
        updateDocumentMutation.mutate({ id, status: status as DocumentStatus }),
    }),
    [orgUsers, updateDocumentMutation]
  );

  const handleDelete = async (item: DocumentRowItem): Promise<boolean> => {
    const result = await deleteDocumentMutation.mutateAsync(item.data.id);
    return result.deleted ?? false;
  };

  const loading = loadingTeam || loadingDocuments;
  const hasAnyPrds = (artifacts ?? []).length > 0;
  const hasActiveRefinements =
    filterText.trim().length > 0 || filtersReturn.isAnyFilterActive;
  const emptyTitle =
    hasAnyPrds && hasActiveRefinements ? "No matching PRDs" : "No PRDs yet";
  const emptyDescription =
    hasAnyPrds && hasActiveRefinements
      ? "Try adjusting your search or filters."
      : "PRDs will appear here once they are created in a project.";

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
          { label: "PRDs" },
        ]}
      >
        <Button onClick={() => setCreatePrdOpen(true)}>
          <PlusIcon className="h-4 w-4" />
          Create PRD
        </Button>
      </Header>
      <CreateDocumentModal
        documentType={DocumentType.Prd}
        onOpenChange={setCreatePrdOpen}
        onSuccess={(doc: Document) => router.push(`/prds/${doc.slug}`)}
        open={createPrdOpen}
        teamId={teamId}
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b">
          <div className="flex min-w-fit items-center justify-between gap-3 px-4 py-3">
            <h1 className="font-semibold text-xl">PRDs</h1>
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
                columns={PRD_DEFAULT_COLUMNS}
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
            emptyIcon={FileIcon}
            emptyTitle={emptyTitle}
            groupBy={groupBy}
            groupExpansionKey="table:expand:team-prds-status"
            items={displayItems}
            moreMenuContent={(_item, onRequestDelete) => (
              <DeleteRowActions onDelete={onRequestDelete} />
            )}
            onDelete={handleDelete}
            visibleColumns={visibleColumns}
          />
        </div>
      </main>
    </>
  );
}

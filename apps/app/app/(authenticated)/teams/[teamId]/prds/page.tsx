"use client";

import {
  type ArtifactStatus,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import type { User as PopoverUser } from "@repo/design-system/components/ui/user-select-popover";
import { FileIcon, Loader2Icon } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import type {
  ArtifactRowItem,
  RowEditHandlers,
} from "@/components/artifact-table/artifact-row";
import { ColumnVisibilityPanel } from "@/components/artifact-table/column-visibility-panel";
import { FlatArtifactTable } from "@/components/artifact-table/flat-artifact-table";
import {
  useArtifactsByTeam,
  useDeleteArtifact,
  useUpdateArtifact,
} from "@/hooks/queries/use-artifacts";
import { useTeam } from "@/hooks/queries/use-teams";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import {
  PRD_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@/hooks/use-column-visibility";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";
import { PrdRowActions } from "./components/prd-row-actions";

export default function TeamPrdsPage() {
  const params = useParams();
  const teamId = params.teamId as string;

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility();
  const visibleColumns = useMemo(
    () => PRD_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  const { data: team, isLoading: loadingTeam } = useTeam(teamId);
  const { data: artifacts = [], isLoading: loadingArtifacts } =
    useArtifactsByTeam(teamId, ArtifactType.Prd);
  const { data: usersResult } = useOrganizationUsers();

  const deleteArtifactMutation = useDeleteArtifact();
  const updateArtifactMutation = useUpdateArtifact();

  const items: ArtifactRowItem[] = useMemo(
    () => artifacts.map((a) => ({ kind: "artifact" as const, data: a })),
    [artifacts]
  );

  const orgUsers: PopoverUser[] = useMemo(() => {
    if (!usersResult) {
      return [];
    }
    return usersResult.map((user) => ({
      id: user.id,
      name: getUserDisplayName(user),
      email: user.email,
      avatarUrl: user.avatarUrl ?? undefined,
      initials: getUserInitials(user.firstName, user.lastName),
    }));
  }, [usersResult]);

  const editHandlers: RowEditHandlers = useMemo(
    () => ({
      teamMembers: orgUsers,
      onUpdateAssignee: (id, assigneeId) =>
        updateArtifactMutation.mutate({ id, assigneeId }),
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
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex min-w-fit items-center justify-between border-b px-4 pt-4 pb-2">
          <h1 className="font-semibold text-xl">PRDs</h1>
          <ColumnVisibilityPanel
            columns={PRD_DEFAULT_COLUMNS}
            onToggle={toggleColumn}
            visibility={visibility}
          />
        </div>
        <div className="flex-1 overflow-auto">
          <FlatArtifactTable
            editHandlers={editHandlers}
            emptyDescription="PRDs will appear here once they are created in a project."
            emptyIcon={FileIcon}
            emptyTitle="No PRDs yet"
            items={items}
            moreMenuContent={(_item, onRequestDelete) => (
              <PrdRowActions onDelete={onRequestDelete} />
            )}
            onDelete={handleDelete}
            visibleColumns={visibleColumns}
          />
        </div>
      </main>
    </>
  );
}

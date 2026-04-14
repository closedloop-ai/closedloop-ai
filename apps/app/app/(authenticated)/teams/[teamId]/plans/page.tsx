"use client";

import {
  type Artifact,
  type ArtifactStatus,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import { FileCodeIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { CreateArtifactModal } from "@/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/create-artifact-modal";
import type {
  ArtifactRowItem,
  RowEditHandlers,
} from "@/components/artifact-table/artifact-row";
import { DeleteRowActions } from "@/components/artifact-table/delete-row-actions";
import { FlatArtifactTable } from "@/components/artifact-table/flat-artifact-table";
import { TableViewMenu } from "@/components/artifact-table/table-view-menu";
import {
  useArtifactsByTeam,
  useDeleteArtifact,
  useUpdateArtifact,
} from "@/hooks/queries/use-artifacts";
import { useTeam } from "@/hooks/queries/use-teams";
import {
  PLAN_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@/hooks/use-column-visibility";
import { useItemsParentTitles } from "@/hooks/use-items-parent-titles";
import { useOrgUsersAsPopoverUsers } from "@/hooks/use-org-users-as-popover-users";

const COLUMN_VISIBILITY_KEY = "table:columns:team-plans";

export default function TeamPlansPage() {
  const params = useParams();
  const router = useRouter();
  const teamId = params.teamId as string;
  const [createPlanOpen, setCreatePlanOpen] = useState(false);

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility({
    storageKey: COLUMN_VISIBILITY_KEY,
  });
  const visibleColumns = useMemo(
    () => PLAN_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  const { data: team, isLoading: loadingTeam } = useTeam(teamId);
  const { data: artifacts, isLoading: loadingArtifacts } = useArtifactsByTeam(
    teamId,
    ArtifactType.ImplementationPlan
  );
  const orgUsers = useOrgUsersAsPopoverUsers();

  const deleteArtifactMutation = useDeleteArtifact();
  const updateArtifactMutation = useUpdateArtifact();

  const items: ArtifactRowItem[] = useMemo(
    () =>
      (artifacts ?? []).map((a) => ({ kind: "artifact" as const, data: a })),
    [artifacts]
  );

  const parentTitleMap = useItemsParentTitles(items);

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
        <div className="flex min-w-fit items-center justify-between border-b px-4 pt-4 pb-2">
          <h1 className="font-semibold text-xl">Plans</h1>
          <TableViewMenu
            columns={PLAN_DEFAULT_COLUMNS}
            onToggle={toggleColumn}
            visibility={visibility}
          />
        </div>
        <div className="flex-1 overflow-auto">
          <FlatArtifactTable
            editHandlers={editHandlers}
            emptyDescription="Plans will appear here once they are created in a project."
            emptyIcon={FileCodeIcon}
            emptyTitle="No plans yet"
            items={items}
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

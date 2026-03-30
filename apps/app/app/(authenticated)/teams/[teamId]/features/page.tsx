"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { FeatureStatus } from "@repo/api/src/types/feature";
import type { User as PopoverUser } from "@repo/design-system/components/ui/user-select-popover";
import { BoxIcon, Loader2Icon } from "lucide-react";
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
  useDeleteFeature,
  useFeaturesByTeam,
  useUpdateFeature,
} from "@/hooks/queries/use-features";
import { useTeam } from "@/hooks/queries/use-teams";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import {
  FEATURE_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@/hooks/use-column-visibility";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";
import { FeatureRowActions } from "./components/feature-row-actions";

export default function TeamFeaturesPage() {
  const params = useParams();
  const teamId = params.teamId as string;

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility();
  const visibleColumns = useMemo(
    () => FEATURE_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  const { data: team, isLoading: loadingTeam } = useTeam(teamId);
  const { data: features = [], isLoading: loadingFeatures } =
    useFeaturesByTeam(teamId);
  const { data: usersResult } = useOrganizationUsers();

  const deleteFeatureMutation = useDeleteFeature();
  const updateFeatureMutation = useUpdateFeature();

  const items: ArtifactRowItem[] = useMemo(
    () => features.map((f) => ({ kind: "feature" as const, data: f })),
    [features]
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
        updateFeatureMutation.mutate({ id, assigneeId }),
      onUpdatePriority: (id, priority: Priority) =>
        updateFeatureMutation.mutate({ id, priority }),
      onUpdateStatus: (id, status) =>
        updateFeatureMutation.mutate({ id, status: status as FeatureStatus }),
    }),
    [orgUsers, updateFeatureMutation]
  );

  const handleDelete = async (item: ArtifactRowItem): Promise<boolean> => {
    const result = await deleteFeatureMutation.mutateAsync(item.data.id);
    return result.deleted ?? false;
  };

  const loading = loadingTeam || loadingFeatures;

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
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex min-w-fit items-center justify-between border-b px-4 pt-4 pb-2">
          <h1 className="font-semibold text-xl">Features</h1>
          <ColumnVisibilityPanel
            columns={FEATURE_DEFAULT_COLUMNS}
            onToggle={toggleColumn}
            visibility={visibility}
          />
        </div>
        <div className="flex-1 overflow-auto">
          <FlatArtifactTable
            editHandlers={editHandlers}
            emptyDescription="Features will appear here once they are created in a project."
            emptyIcon={BoxIcon}
            emptyTitle="No features yet"
            items={items}
            moreMenuContent={(_item, onRequestDelete) => (
              <FeatureRowActions onDelete={onRequestDelete} />
            )}
            onDelete={handleDelete}
            visibleColumns={visibleColumns}
          />
        </div>
      </main>
    </>
  );
}

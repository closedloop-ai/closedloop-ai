"use client";

import {
  ArtifactBulkAction,
  ArtifactBulkKind,
} from "@repo/api/src/types/artifact-bulk-action";
import {
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import {
  type ProjectStatus,
  ProjectStatus as ProjectStatusValue,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import {
  useFavoriteProject,
  useFavoriteProjects,
  useUnfavoriteProject,
  useUpdateProjectAssignee,
  useUpdateProjectStatus,
} from "@repo/app/projects/hooks/use-projects";
import { PROJECT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import {
  registeredArtifactDescriptors,
  settleRegisteredArtifactAction,
} from "@repo/app/shared/bulk-actions/registered-artifact-actions";
import type {
  ArtifactBulkActionEntry,
  ArtifactBulkExecution,
  ArtifactBulkExecutor,
} from "@repo/app/shared/bulk-actions/registry";
import { useArtifactBulkActions } from "@repo/app/shared/bulk-actions/use-artifact-bulk-actions";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import type { TableBulkActionDescriptor } from "@repo/design-system/components/ui/table-bulk-actions";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { ArrowRightLeftIcon } from "lucide-react";

export type ProjectIndexBulkSelection = {
  actions: readonly TableBulkActionDescriptor[];
  enabled: boolean;
  onChange: (selectedIds: ReadonlySet<string>) => void;
  selectedIds: ReadonlySet<string>;
};

/** Registry-backed bulk actions for selected Project rows on the team index. */
export function useProjectIndexBulkActions(input: {
  projects: readonly ProjectWithDetails[];
  selectedIds: ReadonlySet<string>;
}): Pick<ProjectIndexBulkSelection, "actions" | "enabled"> {
  const enabled = useFeatureFlagEnabledOptional(
    ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY
  );
  const favorites = useFavoriteProjects();
  const favorite = useFavoriteProject();
  const unfavorite = useUnfavoriteProject();
  const updateOwner = useUpdateProjectAssignee();
  const updateStatus = useUpdateProjectStatus();
  const { data: organizationUsers } = useOrganizationUsers();
  const selectedProjects = input.projects.filter((project) =>
    input.selectedIds.has(project.id)
  );
  const rows = selectedProjects.map((project) => ({
    id: project.id,
    kind: ArtifactBulkKind.Project,
    label: project.name,
  }));
  const favoriteIds = new Set(
    favorites.data?.map((project) => project.id) ?? []
  );
  const users: User[] = (organizationUsers ?? []).map((user) => ({
    avatarUrl: user.avatarUrl ?? undefined,
    email: user.email,
    id: user.id,
    initials: getUserInitials(user.firstName, user.lastName),
    name: getUserDisplayName(user),
  }));
  const executors: Partial<Record<ArtifactBulkAction, ArtifactBulkExecutor>> = {
    [ArtifactBulkAction.ChangeFavorite]: (_rows, value) => {
      if (typeof value !== "boolean") {
        throw new TypeError(
          "Favorite bulk action requires a boolean target state"
        );
      }
      return executeProjectItems(selectedProjects, async (project) => {
        const isFavorite = favoriteIds.has(project.id);
        if (isFavorite === value) {
          return;
        }
        if (value) {
          await favorite.mutateAsync(project.id);
          return;
        }
        await unfavorite.mutateAsync(project.id);
      });
    },
    [ArtifactBulkAction.ChangeOwner]: (_rows, value) => {
      if (value !== null && typeof value !== "string") {
        throw new TypeError("Owner bulk action requires a user ID or null");
      }
      return executeProjectItems(selectedProjects, (project) =>
        updateOwner.mutateAsync({ projectId: project.id, assigneeId: value })
      );
    },
    [ArtifactBulkAction.ChangeStatus]: (_rows, value) => {
      if (!isProjectStatus(value)) {
        throw new TypeError("Status bulk action requires a Project status");
      }
      return executeProjectItems(selectedProjects, (project) =>
        updateStatus.mutateAsync({ projectId: project.id, status: value })
      );
    },
  };
  const entries = useArtifactBulkActions({
    rows,
    host: {
      executors,
      canPerform: (action) =>
        action !== ArtifactBulkAction.ChangeFavorite ||
        favorites.data !== undefined,
    },
  });
  const statusEntry = entries.find(
    (entry) => entry.id === ArtifactBulkAction.ChangeStatus
  );
  const presentations: Partial<
    Record<ArtifactBulkAction, TableBulkActionDescriptor>
  > = {
    [ArtifactBulkAction.ChangeStatus]: statusEntry
      ? projectStatusDescriptor(statusEntry)
      : undefined,
  };
  return {
    enabled,
    actions: registeredArtifactDescriptors({
      entries,
      presentations,
      favoriteIds,
      users,
      onCommitted: () => undefined,
    }),
  };
}

/** Preserve an outcome for every Project even when sibling writes reject. */
export async function executeProjectItems(
  projects: readonly Pick<ProjectWithDetails, "id">[],
  execute: (
    project: Pick<ProjectWithDetails, "id">
  ) => Promise<unknown> | undefined
): Promise<ArtifactBulkExecution> {
  const settlements = await Promise.allSettled(projects.map(execute));
  return {
    results: projects.map((project, index) =>
      settlements[index]?.status === "fulfilled"
        ? batchItemApplied(project.id)
        : batchItemFailed(project.id, BatchItemFailureCode.OutcomeUnknown)
    ),
    transactionIds: [],
  };
}

function projectStatusDescriptor(
  entry: ArtifactBulkActionEntry
): TableBulkActionDescriptor {
  return {
    emptyLabel: "No statuses available",
    icon: <ArrowRightLeftIcon />,
    id: ArtifactBulkAction.ChangeStatus,
    kind: "picker",
    label: "Change Status",
    onSelect: (_ids, option, selection) =>
      settleRegisteredArtifactAction(
        entry,
        option.id,
        selection,
        () => undefined
      ),
    options: Object.values(ProjectStatusValue).map((status) => ({
      id: status,
      label: PROJECT_STATUS_LABELS[status],
    })),
    undo: TableBulkActionUndo.NotImplemented,
  };
}

function isProjectStatus(value: unknown): value is ProjectStatus {
  return (
    typeof value === "string" &&
    Object.values(ProjectStatusValue).some((status) => status === value)
  );
}

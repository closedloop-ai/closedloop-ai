"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { AgentSessionBulkAssignField } from "@repo/api/src/types/agent-session-bulk-assign";
import {
  ArtifactBulkAction,
  ArtifactBulkKind,
} from "@repo/api/src/types/artifact-bulk-action";
import type { BatchMutationResponse } from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { User } from "@repo/api/src/types/user";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import {
  bulkReceiptFromCommittedIds,
  invalidateForBulkArtifactMutation,
} from "@repo/app/documents/hooks/bulk-artifact-invalidation";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import { useApiClientOptional } from "@repo/app/shared/api/use-api-client-optional";
import { batchMutationSelectionOutcome } from "@repo/app/shared/bulk-actions/batch-mutation-selection";
import { useMixedBulkActionConfirmation } from "@repo/app/shared/bulk-actions/mixed-action-confirmation";
import {
  descriptorBulkExecutor,
  registeredArtifactDescriptors,
} from "@repo/app/shared/bulk-actions/registered-artifact-actions";
import {
  type ArtifactBulkActionEntry,
  type ArtifactBulkRow,
  createArtifactBulkActionRegistry,
  executeSharedArtifactBulkAction,
} from "@repo/app/shared/bulk-actions/registry";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { getUserNamePart } from "@repo/app/shared/lib/user-utils";
import {
  BULK_REMOVE_TAG_ACTION_ID,
  BULK_TAG_ACTION_ID,
} from "@repo/app/tags/lib/bulk-tag-labels";
import { userKeys } from "@repo/app/users/hooks/use-users";
import type { TableBulkActionDescriptor } from "@repo/design-system/components/ui/table-bulk-actions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderInputIcon } from "lucide-react";
import type { ReactNode } from "react";
import { sessionsFavoriteBulkActions } from "./sessions-bulk-favorite-action";
import { sessionsBulkPickerAction } from "./sessions-bulk-picker-action";
import type { SessionsFavoriteController } from "./sessions-list-interactions";

/** Host context for the registry; the page never declares a supported-action list. */
export function useSessionsRegisteredBulkActions(input: {
  favorites?: SessionsFavoriteController;
  items: readonly AgentSessionListItem[];
  readOnly?: boolean;
  tagActions: readonly TableBulkActionDescriptor[];
}): {
  actions:
    | readonly TableBulkActionDescriptor[]
    | ((
        rows: readonly SessionTableRow[]
      ) => readonly TableBulkActionDescriptor[]);
  confirmationDialog: ReactNode;
} {
  const enabled = useFeatureFlagEnabledOptional(
    ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY
  );
  const apiClient = useApiClientOptional();
  const queryClient = useQueryClient();
  const { requestConfirmation, confirmationDialog } =
    useMixedBulkActionConfirmation();
  const writable = enabled && !input.readOnly && apiClient !== null;
  const projects = useQuery({
    queryKey: projectKeys.list({ teamId: undefined }),
    queryFn: () => {
      if (!apiClient) {
        throw new Error("Sessions project catalog requires the API");
      }
      return apiClient.get<ProjectWithDetails[]>("/projects");
    },
    enabled: writable,
  });
  const users = useQuery({
    queryKey: userKeys.organizationUsers(),
    queryFn: () => {
      if (!apiClient) {
        throw new Error("Sessions owner catalog requires the API");
      }
      return apiClient.get<User[]>("/users");
    },
    enabled: writable,
  });

  if (!writable) {
    return { actions: input.tagActions, confirmationDialog };
  }

  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const post = (route: string, body: unknown) =>
    apiClient.post<BatchMutationResponse>(route, body);
  const invalidate = (ids: readonly string[]) =>
    invalidateForBulkArtifactMutation(
      queryClient,
      bulkReceiptFromCommittedIds(ids)
    );

  const actions = (selectedRows: readonly SessionTableRow[]) => {
    const selectedById = new Map(selectedRows.map((row) => [row.id, row]));
    const rows: ArtifactBulkRow[] = selectedRows.map((row) => ({
      id: row.id,
      kind: ArtifactBulkKind.Session,
      label: row.name || row.id,
    }));
    const ids = rows.map((row) => row.id);
    const addTag = input.tagActions.find(
      (action) => action.id === BULK_TAG_ACTION_ID
    );
    const removeTag = input.tagActions.find(
      (action) => action.id === BULK_REMOVE_TAG_ACTION_ID
    );
    const selection = {
      clear: () => undefined,
      retain: () => undefined,
    };
    const entries = createArtifactBulkActionRegistry({
      rows,
      host: {
        post,
        canPerform: (action) => {
          if (action === ArtifactBulkAction.ChangeFavorite) {
            return (
              Boolean(input.favorites?.onBulkChange) &&
              !input.favorites?.isUnavailable
            );
          }
          if (action === ArtifactBulkAction.ChangeOwner) {
            return users.data !== undefined;
          }
          if (action === ArtifactBulkAction.ChangeProject) {
            return (
              projects.data !== undefined && ids.every((id) => itemById.has(id))
            );
          }
          if (
            action === ArtifactBulkAction.AddTag ||
            action === ArtifactBulkAction.RemoveTag
          ) {
            return input.tagActions.length > 0;
          }
          return true;
        },
        canApply: (action, row) => {
          if (
            action !== ArtifactBulkAction.AddTag &&
            action !== ArtifactBulkAction.RemoveTag
          ) {
            return true;
          }
          return selectedById.get(row.id)?.tagPermissions?.canApply === true;
        },
        executors: {
          ...(addTag
            ? {
                [ArtifactBulkAction.AddTag]: descriptorBulkExecutor(
                  addTag,
                  selection
                ),
              }
            : {}),
          ...(removeTag
            ? {
                [ArtifactBulkAction.RemoveTag]: descriptorBulkExecutor(
                  removeTag,
                  selection
                ),
              }
            : {}),
        },
      },
    });
    const favorite = entries.find(
      (entry) => entry.id === ArtifactBulkAction.ChangeFavorite
    );
    const move = entries.find(
      (entry) => entry.id === ArtifactBulkAction.ChangeProject
    );
    const presentations = {
      [ArtifactBulkAction.ChangeFavorite]:
        favorite && input.favorites
          ? sessionsFavoriteBulkActions({
              favorites: {
                ...input.favorites,
                onBulkChange: async (changedRows, target) => {
                  const execution = await executeSharedArtifactBulkAction(
                    { post },
                    ArtifactBulkAction.ChangeFavorite,
                    changedRows.map((row) => ({
                      id: row.id,
                      kind: ArtifactBulkKind.Session,
                    })),
                    target
                  );
                  const outcome = batchMutationSelectionOutcome(
                    execution.results,
                    changedRows.map((row) => row.id)
                  );
                  invalidate(outcome.appliedIds);
                  return {
                    succeededIds: outcome.appliedIds,
                    failedIds: outcome.failedIds,
                  };
                },
              },
              rows: selectedRows,
            })[0]
          : undefined,
      [ArtifactBulkAction.ChangeProject]: move
        ? sessionMoveDescriptor(
            move,
            projects.data ?? [],
            itemById,
            post,
            invalidate
          )
        : undefined,
      [ArtifactBulkAction.AddTag]: addTag,
      [ArtifactBulkAction.RemoveTag]: removeTag,
    };
    return registeredArtifactDescriptors({
      entries,
      presentations,
      favoriteIds: input.favorites?.favoriteIds ?? new Set(),
      users: (users.data ?? []).map((user) => ({
        id: user.id,
        name: getUserNamePart(user).trim() || user.email,
      })),
      onCommitted: (committedIds) => invalidate(committedIds),
      onMixedSelection: requestConfirmation,
    });
  };
  return { actions, confirmationDialog };
}

function sessionMoveDescriptor(
  entry: ArtifactBulkActionEntry,
  projects: readonly { id: string; name: string }[],
  itemById: ReadonlyMap<string, AgentSessionListItem>,
  post: (route: string, body: unknown) => Promise<BatchMutationResponse>,
  invalidate: (ids: readonly string[]) => void
): TableBulkActionDescriptor {
  return sessionsBulkPickerAction({
    command: {
      options: projects.map((project) => ({
        id: project.id,
        label: project.name,
      })),
      onApply: async (rowIds, option) => {
        const execution = await entry.execute(option.id);
        const outcome = batchMutationSelectionOutcome(
          execution.results,
          rowIds
        );
        invalidate(outcome.appliedIds);
        const previousProjects = new Map<string | null, string[]>();
        for (const id of outcome.appliedIds) {
          const previous = itemById.get(id)?.project?.id ?? null;
          previousProjects.set(previous, [
            ...(previousProjects.get(previous) ?? []),
            id,
          ]);
        }
        return {
          succeededIds: outcome.appliedIds,
          failedIds: outcome.failedIds,
          undo: async () => {
            for (const [projectId, sessionIds] of previousProjects) {
              const response = await post(
                `${BatchMutationRoute.AgentSessionsAssign}/v2`,
                {
                  sessionIds,
                  field: AgentSessionBulkAssignField.Project,
                  value: projectId,
                }
              );
              const restored = batchMutationSelectionOutcome(
                response.results,
                sessionIds
              );
              invalidate(restored.appliedIds);
              if (restored.failedIds.length > 0) {
                throw new Error("Session project restore was refused");
              }
            }
          },
        };
      },
    },
    icon: <FolderInputIcon />,
    id: ArtifactBulkAction.ChangeProject,
    label: "Move to project",
  });
}

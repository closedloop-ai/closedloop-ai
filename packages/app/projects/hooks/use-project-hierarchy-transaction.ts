"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  ProjectArtifactPlacementPosition,
  type ProjectArtifactPlacementRootUpdates,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectHierarchyOperation,
  ProjectHierarchyPlacement,
  type ProjectHierarchyRevision,
  ProjectHierarchySource,
  projectHierarchyTransactionResponseSchema,
} from "@repo/api/src/types/project-hierarchy-transaction";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { artifactFavoriteKeys } from "../../documents/hooks/artifact-favorite-keys";
import { documentKeys } from "../../documents/hooks/document-keys";
import { useApiClientOptional } from "../../shared/api/use-api-client-optional";
import { formatArtifactHierarchyMoveMessage } from "../../shared/components/generic-artifact-surface/preview/components/artifact-hierarchy";
import {
  ARTIFACT_PLACEMENT_FAILED_MESSAGE,
  ARTIFACT_PLACEMENT_UNDO_LABEL,
} from "../lib/artifact-placement-copy";
import type { ProjectArtifactMove } from "../lib/project-artifact-list-helpers";
import { projectKeys } from "./project-keys";
import { projectTreeKeys } from "./project-tree-keys";

export type ProjectHierarchyMoveIntent = ProjectArtifactMove & {
  sourceRevision: string;
  rootUpdates?: ProjectArtifactPlacementRootUpdates;
  surface?: typeof ArtifactStatusEditSurface.Board;
};

/** Submit a flag-off selected set through one server-owned hierarchy transaction. */
export function useProjectHierarchyTransaction(projectId: string) {
  const api = useApiClientOptional();
  const client = useQueryClient();
  const undoMutation = useMutation({
    mutationFn: async (
      response: ReturnType<
        typeof projectHierarchyTransactionResponseSchema.parse
      >
    ) => {
      if (!api) {
        throw new Error("Project hierarchy requires an API adapter");
      }
      return projectHierarchyTransactionResponseSchema.parse(
        await api.post<unknown>(
          `/projects/${projectId}/artifacts/hierarchy-transactions`,
          {
            operation: ProjectHierarchyOperation.Undo,
            transactionId: response.inverse.transactionId,
            expectedRevisions: response.projectRevisions,
            idempotencyKey: globalThis.crypto.randomUUID(),
            source: ProjectHierarchySource.Menu,
          }
        )
      );
    },
    onSuccess: (result) => invalidateHierarchyViews(client, result),
    onError: () => toast.error(ARTIFACT_PLACEMENT_FAILED_MESSAGE),
  });
  return useMutation({
    mutationFn: async (intent: ProjectHierarchyMoveIntent) => {
      if (!api) {
        throw new Error("Project hierarchy requires an API adapter");
      }
      const expectedRevisions: ProjectHierarchyRevision[] = [
        { projectId, revision: intent.sourceRevision },
      ];
      if (intent.targetProjectId && intent.targetProjectId !== projectId) {
        const destination = await api.get<ProjectHierarchyRevision>(
          `/projects/${intent.targetProjectId}/artifacts/hierarchy-transactions`
        );
        if (destination.projectId !== intent.targetProjectId) {
          throw new Error(
            "Project hierarchy revision does not match its project"
          );
        }
        expectedRevisions.push(destination);
      }
      return projectHierarchyTransactionResponseSchema.parse(
        await api.post<unknown>(
          `/projects/${projectId}/artifacts/hierarchy-transactions`,
          {
            artifactIds: intent.artifactIds,
            ...(intent.targetProjectId
              ? { targetProjectId: intent.targetProjectId }
              : {}),
            placement: hierarchyPlacement(intent.placement),
            ...(intent.targetArtifactId
              ? { targetArtifactId: intent.targetArtifactId }
              : {}),
            ...(intent.rootUpdates ? { rootUpdates: intent.rootUpdates } : {}),
            ...(intent.surface ? { surface: intent.surface } : {}),
            source: hierarchySource(intent.source),
            operation: ProjectHierarchyOperation.Move,
            expectedRevisions,
            idempotencyKey: globalThis.crypto.randomUUID(),
          }
        )
      );
    },
    onSuccess: (result) => {
      invalidateHierarchyViews(client, result);
      if (result.changedArtifactIds.length > 0 && !result.replayed) {
        toast.success(
          formatArtifactHierarchyMoveMessage(result.descendantCount),
          {
            action: {
              label: ARTIFACT_PLACEMENT_UNDO_LABEL,
              onClick: () => undoMutation.mutate(result),
            },
          }
        );
      }
    },
    onError: () => {
      client.invalidateQueries({ queryKey: projectTreeKeys.detail(projectId) });
    },
  });
}

function invalidateHierarchyViews(
  client: ReturnType<typeof useQueryClient>,
  result: ReturnType<typeof projectHierarchyTransactionResponseSchema.parse>
) {
  for (const revision of result.projectRevisions) {
    client.invalidateQueries({
      queryKey: projectTreeKeys.detail(revision.projectId),
    });
    client.invalidateQueries({
      queryKey: projectKeys.detail(revision.projectId),
    });
  }
  client.invalidateQueries({ queryKey: projectKeys.lists() });
  client.invalidateQueries({ queryKey: documentKeys.lists() });
  client.invalidateQueries({ queryKey: documentKeys.summaries() });
  client.invalidateQueries({ queryKey: artifactFavoriteKeys.list() });
  for (const id of result.changedArtifactIds) {
    client.invalidateQueries({ queryKey: documentKeys.detail(id) });
  }
}

function hierarchyPlacement(
  placement: ProjectArtifactMove["placement"]
): ProjectHierarchyPlacement {
  return placement === ProjectArtifactPlacementPosition.Root
    ? ProjectHierarchyPlacement.End
    : placement;
}

function hierarchySource(
  source: ProjectArtifactMove["source"]
): ProjectHierarchySource {
  if (source === ProjectArtifactPlacementSource.Pointer) {
    return ProjectHierarchySource.Drag;
  }
  if (source === ProjectArtifactPlacementSource.Keyboard) {
    return ProjectHierarchySource.Keyboard;
  }
  return ProjectHierarchySource.Api;
}

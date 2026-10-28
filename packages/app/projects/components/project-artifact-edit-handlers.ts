import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { useProjectArtifactGroupUpdates } from "../hooks/use-project-artifact-group-updates";

type ProjectArtifactUpdate = ReturnType<
  typeof useProjectArtifactGroupUpdates
>["update"];

/** The inline-edit writers Project Detail hands its cells, over one mutation. */
export function projectArtifactEditHandlers<TMember>(
  teamMembers: TMember,
  update: ProjectArtifactUpdate
) {
  return {
    teamMembers,
    onUpdateAssignee: (id: string, assigneeId: string | null) =>
      update.mutate({ id, assigneeId }),
    onUpdatePriority: (
      id: string,
      priority: Parameters<typeof update.mutate>[0]["priority"]
    ) => update.mutate({ id, priority }),
    onUpdateStatus: (
      id: string,
      status: Parameters<typeof update.mutate>[0]["status"],
      surface: ArtifactStatusEditSurface = ArtifactStatusEditSurface.InlineCell
    ) =>
      update.mutate({
        id,
        status,
        surface,
      }),
    onUpdateTitle: (id: string, title: string, _expectedTitle: string) =>
      update.mutateAsync({ id, title }),
  };
}

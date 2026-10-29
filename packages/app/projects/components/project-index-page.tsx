"use client";

import { ProjectStatus } from "@repo/api/src/types/project";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { useViewStateKey } from "../../shared/hooks/use-view-state-key";
import { useTeam } from "../../teams/hooks/use-teams";
import {
  useCreateProject,
  useDeleteProject,
  useProjectStatusHandler,
  useProjectsByTeam,
  useUpdateProjectAssignee,
  useUpdateProjectPriority,
  useUpdateProjectTargetDate,
} from "../hooks/use-projects";
import { ARCHIVED_PROJECTS_EMPTY_COPY } from "../lib/project-archived-copy";
import { CreateProjectModal } from "./create-project-modal";
import { useProjectIndexBulkActions } from "./project-index-bulk-actions";
import { ProjectsPortableSurface } from "./projects-portable-surface";

/** Native and web hosts share every project action and the portable list. */
export function ProjectIndexPage({
  teamId,
  archived = false,
}: {
  teamId: string;
  archived?: boolean;
}) {
  const orgPath = useOrgPath();
  const navigation = useNavigation();
  const team = useTeam(teamId);
  const projects = useProjectsByTeam(
    teamId,
    undefined,
    archived
      ? { status: [ProjectStatus.Archived] }
      : { excludeStatus: [ProjectStatus.Archived] }
  );
  const create = useCreateProject();
  const remove = useDeleteProject();
  const owner = useUpdateProjectAssignee();
  const priority = useUpdateProjectPriority();
  const dueDate = useUpdateProjectTargetDate();
  // The archived list unarchives from here, so it offers the same Undo the
  // archived page always did (ISS-13035).
  const status = useProjectStatusHandler({ showUndoOnUnarchive: archived });
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const bulkActions = useProjectIndexBulkActions({
    projects: projects.data ?? [],
    selectedIds: selectedProjectIds,
  });
  const bulkSelection = {
    ...bulkActions,
    onChange: setSelectedProjectIds,
    selectedIds: selectedProjectIds,
  };
  const viewStateKey = useViewStateKey(
    `table:view:team-projects-portable:${teamId}:${archived ? "archived" : "active"}`
  );
  if (team.isLoading || projects.isLoading) {
    return (
      <div className="flex h-full items-center justify-center" role="status">
        <Loader2Icon className="size-6 animate-spin" />
        <span className="sr-only">Loading project</span>
      </div>
    );
  }
  if (team.error || projects.error || !team.data) {
    return (
      <div className="p-4" role="alert">
        {team.error?.message ?? projects.error?.message ?? "Team not found"}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectsPortableSurface
        bulkSelection={bulkSelection}
        emptyStateCopy={archived ? ARCHIVED_PROJECTS_EMPTY_COPY : undefined}
        getProjectHref={(id) => orgPath(`/teams/${teamId}/projects/${id}`)}
        headingActions={
          <CreateProjectModal
            onCreateProject={async (input) => {
              const project = await create.mutateAsync(input);
              navigation.navigate(
                orgPath(`/teams/${teamId}/projects/${project.id}`)
              );
            }}
            onOpenChange={setCreateOpen}
            open={createOpen}
            teamId={teamId}
            teamName={team.data.name}
          />
        }
        onCreateProject={() => setCreateOpen(true)}
        onDelete={async (id) => Boolean((await remove.mutateAsync(id)).deleted)}
        onUpdateAssignee={(projectId, assigneeId) =>
          owner.mutate({ projectId, assigneeId })
        }
        onUpdatePriority={(projectId, value) =>
          priority.mutate({ projectId, priority: value })
        }
        onUpdateStatus={(projectId, next, previous) =>
          status.handleUpdateStatus(projectId, next, previous)
        }
        onUpdateTargetDate={(projectId, targetDate) =>
          dueDate.mutateAsync({ projectId, targetDate })
        }
        projects={projects.data ?? []}
        teamId={teamId}
        viewStateKey={viewStateKey}
      />
    </div>
  );
}

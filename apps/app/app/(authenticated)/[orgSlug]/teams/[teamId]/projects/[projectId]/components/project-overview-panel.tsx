"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { TagEntityType } from "@repo/api/src/types/tag";
import { EditableProjectDescription } from "@repo/app/projects/components/editable-project-description";
import { EditableProjectTitle } from "@repo/app/projects/components/editable-project-title";
import { FeatureFlagged } from "@repo/app/shared/feature-flags/feature-flagged";
import { ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { TagPicker } from "@repo/app/tags/components/tag-picker";
import { OverviewProperties } from "./overview-properties";

export function ProjectOverviewPanel({
  project,
  onUpdateAssignee,
  onUpdatePriority,
  onUpdateTargetDate,
}: {
  project: ProjectWithDetails;
  onUpdateAssignee: (assigneeId: string | null) => void;
  onUpdatePriority: (priority: Priority | null) => void;
  onUpdateTargetDate: (date: Date | null) => void;
}) {
  return (
    <div className="mx-auto mt-0 flex max-w-[950px] flex-col gap-10 p-6">
      <div className="flex flex-col gap-2">
        <EditableProjectTitle
          initialTitle={project.name}
          projectId={project.id}
        />
        <EditableProjectDescription
          initialDescription={project.description ?? ""}
          projectId={project.id}
        />
      </div>
      <FeatureFlagged flag={ARTIFACT_TAGS_FEATURE_FLAG_KEY}>
        <TagPicker
          appliedTags={project.tags ?? []}
          entityId={project.id}
          entityType={TagEntityType.Project}
        />
      </FeatureFlagged>
      <OverviewProperties
        onUpdateAssignee={onUpdateAssignee}
        onUpdatePriority={onUpdatePriority}
        onUpdateTargetDate={onUpdateTargetDate}
        project={project}
      />
    </div>
  );
}

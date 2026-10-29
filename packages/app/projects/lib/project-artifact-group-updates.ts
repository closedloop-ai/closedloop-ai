import type { ArtifactType } from "@repo/api/src/types/artifact";
import type { Priority } from "@repo/api/src/types/common";
import type { ArtifactStatus } from "@repo/api/src/types/document";
import { projectArtifactTypeSupportsGroupField } from "@repo/api/src/types/project-artifact-group-authority";
import { ProjectArtifactPlacementGroupField } from "@repo/api/src/types/project-artifact-placement";
import { isPriorityValue } from "@repo/design-system/lib/priority-order";
import {
  GenericArtifactKind,
  genericArtifactStatusCapability,
  genericArtifactStatusDefaultForRoot,
  genericArtifactStatusRaw,
} from "../../shared/components/generic-artifact-surface/generic-artifact-status";
import { ARTIFACT_GROUP_NO_VALUE } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-grouping";
import type { ArtifactListShellController } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import type { GenericArtifact } from "../../shared/components/generic-artifact-surface/preview/fixtures";
export type ProjectArtifactGroupUpdates = {
  assigneeId?: string | null;
  priority?: Priority | null;
  status?: ArtifactStatus;
  tagIds?: string[];
};

export type ProjectArtifactGroupController = Pick<
  ArtifactListShellController,
  "groupBy" | "secondaryGroupBy" | "groupedArtifacts"
>;

export function projectGroupUpdates(
  row: Pick<GenericArtifact, "kind">,
  entries: string[][],
  rows: readonly GenericArtifact[]
): ProjectArtifactGroupUpdates | null {
  const result: ProjectArtifactGroupUpdates = {};
  for (const [field, value] of entries) {
    const patch = projectGroupFieldUpdate(
      row,
      field ?? "none",
      value ?? "",
      rows
    );
    if (patch === null) {
      return null;
    }
    Object.assign(result, patch);
  }
  return result;
}

function projectGroupFieldUpdate(
  row: Pick<GenericArtifact, "kind">,
  field: string,
  value: string,
  rows: readonly GenericArtifact[]
): ProjectArtifactGroupUpdates | null {
  switch (field) {
    case "none":
      return {};
    case "status":
      return projectStatusGroupUpdate(row, value);
    case "owner": {
      if (
        row.kind === GenericArtifactKind.Branch ||
        row.kind === GenericArtifactKind.Deployment
      ) {
        return null;
      }
      if (value === ARTIFACT_GROUP_NO_VALUE) {
        return { assigneeId: null };
      }
      const assigneeId = rows.find(
        (item) => (item.ownerId ?? item.owner) === value
      )?.ownerId;
      return assigneeId ? { assigneeId } : null;
    }
    case "priority": {
      if (row.kind === GenericArtifactKind.Deployment) {
        return null;
      }
      if (value === ARTIFACT_GROUP_NO_VALUE) {
        return { priority: null };
      }
      return isPriorityValue(value) ? { priority: value } : null;
    }
    case "tags":
      return projectTagGroupUpdate(value, rows);
    default:
      return null;
  }
}
function projectStatusGroupUpdate(
  row: Pick<GenericArtifact, "kind">,
  value: string
): ProjectArtifactGroupUpdates | null {
  const status = genericArtifactStatusDefaultForRoot(row.kind, value);
  if (!status) {
    return null;
  }
  const raw = genericArtifactStatusRaw({
    ...row,
    status,
    statusRaw: undefined,
  });
  if (
    !(
      raw &&
      genericArtifactStatusCapability({ ...row, status, statusRaw: raw })
        .editable
    )
  ) {
    return null;
  }
  return { status: raw as ArtifactStatus };
}
function projectTagGroupUpdate(
  value: string,
  rows: readonly GenericArtifact[]
): ProjectArtifactGroupUpdates | null {
  if (value === ARTIFACT_GROUP_NO_VALUE) {
    return { tagIds: [] };
  }
  const source = rows.find((item) => item.tags.includes(value));
  const index = source?.tags.indexOf(value) ?? -1;
  const tagId = source?.tagIds?.[index];
  return tagId ? { tagIds: [tagId] } : null;
}

export function hierarchyTargetGroupUpdates(
  sourceId: string,
  targetId: string,
  controller: ProjectArtifactGroupController,
  rows: readonly GenericArtifact[]
) {
  const source = rows.find((row) => row.id === sourceId);
  const sourceGroup = controller.groupedArtifacts?.find((group) =>
    group.items.some((row) => row.id === sourceId)
  );
  const targetGroup = controller.groupedArtifacts?.find((group) =>
    group.items.some((row) => row.id === targetId)
  );
  if (!(source && targetGroup)) {
    return undefined;
  }
  const entries: string[][] = [];
  if (sourceGroup?.key !== targetGroup.key) {
    entries.push([controller.groupBy, targetGroup.key]);
  }
  const sourceSubgroup = sourceGroup?.subgroups?.find((group) =>
    group.items.some((row) => row.id === sourceId)
  );
  const targetSubgroup = targetGroup.subgroups?.find((group) =>
    group.items.some((row) => row.id === targetId)
  );
  if (targetSubgroup && sourceSubgroup?.key !== targetSubgroup.key) {
    entries.push([controller.secondaryGroupBy, targetSubgroup.key]);
  }
  if (entries.length === 0) {
    return undefined;
  }
  return projectGroupUpdates(source, entries, rows);
}
export function projectGroupAuthority(
  type: ArtifactType | undefined,
  field: string,
  secondary?: string
) {
  return [field, secondary].every((value) => {
    if (value === "owner") {
      return projectArtifactTypeSupportsGroupField(
        type,
        ProjectArtifactPlacementGroupField.AssigneeId
      );
    }
    if (value === "priority") {
      return projectArtifactTypeSupportsGroupField(
        type,
        ProjectArtifactPlacementGroupField.Priority
      );
    }
    if (value === "status") {
      return projectArtifactTypeSupportsGroupField(
        type,
        ProjectArtifactPlacementGroupField.Status
      );
    }
    return true;
  });
}

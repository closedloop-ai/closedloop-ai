"use client";

import {
  ProjectArtifactBoard,
  ProjectArtifactBoardField,
} from "@repo/app/projects/components/project-artifact-board"; // Cross-slice: project pages render the shipped project list (ISS-12938).
import {
  type ArtifactBoardItem,
  type ArtifactBoardMove,
  type ArtifactBoardMoveTarget,
  ArtifactBoardMutationState,
  ArtifactBoardSelectionIntent,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import type { GenericArtifact } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import {
  TableChoiceCell,
  TableDateCell,
  TablePersonCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import { FileTextIcon } from "lucide-react";
import { useMemo, useState } from "react";

/** Preserved Project prototype adapter for the mastered shared board. */
export function ProjectArtifactBoardPreview({
  artifacts,
  onOpenArtifact,
}: Readonly<{
  artifacts: readonly GenericArtifact[];
  onOpenArtifact: (artifact: GenericArtifact) => void;
}>) {
  const [statusById, setStatusById] = useState<ReadonlyMap<string, string>>(
    new Map()
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const itemByArtifactId = useMemo(
    () => new Map(artifacts.map((artifact) => [artifact.id, artifact])),
    [artifacts]
  );
  const items = useMemo(
    () =>
      artifacts.map((artifact) =>
        artifactBoardItem(artifact, artifacts, statusById)
      ),
    [artifacts, statusById]
  );
  const lanes = useMemo(() => artifactBoardLanes(items), [items]);

  const handleMove = (move: ArtifactBoardMove) => {
    setStatusById((current) => {
      const next = new Map(current);
      for (const rootId of move.rootIds) {
        next.set(rootId, move.target.laneId);
      }
      return next;
    });
  };

  return (
    <ProjectArtifactBoard
      feedback={{ state: ArtifactBoardMutationState.Idle }}
      getDropTargetLabel={dropTargetLabel}
      groupBy={ProjectArtifactBoardField.Status}
      items={items}
      lanes={lanes}
      onMove={handleMove}
      onOpen={(item) => {
        const artifact = itemByArtifactId.get(item.id);
        if (artifact) {
          onOpenArtifact(artifact);
        }
      }}
      onSelectionChange={(itemId, intent) =>
        setSelectedIds((current) => previewSelection(current, itemId, intent))
      }
      renderField={renderPreviewField}
      renderTypeIcon={() => <FileTextIcon className="size-4" />}
      selectedIds={selectedIds}
      visibleFieldIds={[
        ProjectArtifactBoardField.Priority,
        ProjectArtifactBoardField.Owner,
        ProjectArtifactBoardField.Tags,
        ProjectArtifactBoardField.Comments,
        ProjectArtifactBoardField.Updated,
      ]}
    />
  );
}

function artifactBoardItem(
  artifact: GenericArtifact,
  artifacts: readonly GenericArtifact[],
  statusById: ReadonlyMap<string, string>
): ArtifactBoardItem {
  const rootId = rootArtifactId(artifact, artifacts);
  return {
    fieldValues: {
      comments: artifact.commentCount ?? 0,
      owner: artifact.owner,
      priority: artifact.creationValues?.priority ?? null,
      status: statusById.get(rootId) ?? artifact.status,
      tags: artifact.tags,
      updated: artifact.updated,
    },
    id: artifact.id,
    laneId: statusById.get(rootId) ?? artifact.status,
    parentId: artifact.parentArtifactId ?? null,
    rootId,
    slug: artifact.slug,
    title: artifact.title,
    typeLabel: artifact.kind,
  };
}

function rootArtifactId(
  artifact: GenericArtifact,
  artifacts: readonly GenericArtifact[]
): string {
  const byId = new Map(artifacts.map((candidate) => [candidate.id, candidate]));
  let current = artifact;
  const visited = new Set<string>();
  while (current.parentArtifactId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = byId.get(current.parentArtifactId);
    if (!parent) {
      break;
    }
    current = parent;
  }
  return current.id;
}

function artifactBoardLanes(items: readonly ArtifactBoardItem[]) {
  const roots = items.filter((item) => item.id === item.rootId);
  return [...new Set(roots.map((item) => item.laneId))].map((laneId) => ({
    id: laneId,
    label: laneId,
    rootIds: roots
      .filter((item) => item.laneId === laneId)
      .map((item) => item.id),
  }));
}

function renderPreviewField(item: ArtifactBoardItem, field: { id: string }) {
  const value = item.fieldValues[field.id];
  switch (field.id) {
    case ProjectArtifactBoardField.Status:
      return <TableChoiceCell label={String(value)} />;
    case ProjectArtifactBoardField.Priority:
      return <TableChoiceCell label={String(value ?? "—")} />;
    case ProjectArtifactBoardField.Owner:
      return <TablePersonCell person={{ name: String(value) }} />;
    case ProjectArtifactBoardField.Tags:
      return <span>{(Array.isArray(value) ? value : []).join(" · ")}</span>;
    case ProjectArtifactBoardField.Comments:
      return <span>{String(value)}</span>;
    case ProjectArtifactBoardField.Updated:
      return <TableDateCell value={String(value)} />;
    default:
      return null;
  }
}

function previewSelection(
  current: readonly string[],
  itemId: string,
  intent: ArtifactBoardSelectionIntent
) {
  if (intent === ArtifactBoardSelectionIntent.Toggle) {
    return current.includes(itemId)
      ? current.filter((id) => id !== itemId)
      : [...current, itemId];
  }
  return [itemId];
}

function dropTargetLabel(target: ArtifactBoardMoveTarget) {
  return `${target.position} ${target.referenceRootId ?? target.laneId}`;
}

import { ArtifactType } from "@repo/api/src/types/artifact";
import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import { ARTIFACT_STATUS_DISPLAY_LABELS } from "@repo/api/src/types/artifact-status-display";
import { artifactStatusRootRank } from "@repo/api/src/types/artifact-status-rank";
import { BranchStatus } from "@repo/api/src/types/branch";
import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { DocumentStatusMutationOperation } from "@repo/api/src/types/document-status-mutation";
import {
  PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID,
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID,
  ProjectArtifactBoardDropPosition,
  projectArtifactBoardMoveIntent,
} from "@repo/api/src/types/project-artifact-board-move";
import {
  evaluateProjectArtifactLanePolicy,
  type ProjectArtifactLanePolicy,
  type ProjectArtifactLanePolicyResult,
} from "@repo/api/src/types/project-artifact-lane-policy";
import {
  ProjectArtifactPlacementSource as PlacementSource,
  ProjectArtifactPlacementGroupField,
  type ProjectArtifactPlacementIntent,
  ProjectArtifactPlacementPosition,
  type ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import type {
  DetailedArtifact,
  ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import {
  LEGACY_WAITING_WIRE_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { documentTypeFromSubtype } from "@repo/app/documents/lib/artifact-row-adapter";
import { documentArtifactStatusCapability } from "@repo/app/documents/lib/artifact-status-capability";
import {
  GroupByMode,
  type GroupByMode as GroupByModeValue,
} from "@repo/app/documents/lib/group-by";
import {
  ARTIFACT_STATUS_LABELS,
  DOCUMENT_TYPE_BADGE_LABELS,
} from "@repo/app/projects/lib/project-constants";
import type {
  ArtifactBoardItem,
  ArtifactBoardLane,
  ArtifactBoardMove,
  ArtifactBoardMoveTarget,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import {
  ArtifactBoardDropPosition,
  type ArtifactBoardSelectionIntent,
  artifactBoardSelectionFromIntent,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import {
  GenericArtifactKind,
  genericArtifactStatusDefaultForRoot,
  genericArtifactStatusRaw,
} from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import {
  DocumentColumn,
  type DocumentColumn as DocumentColumnValue,
} from "@repo/app/shared/hooks/use-column-visibility";
import {
  artifactStatusFacet,
  branchPullRequestStatusFacet,
  documentStatusFacet,
  sessionStatusFacet,
} from "@repo/app/shared/lib/artifact-status-adapter";
import { formatRelativeTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import {
  getUserDisplayName,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "@repo/app/shared/lib/user-utils";
import { priorityLabel } from "@repo/design-system/lib/priority-order";
import {
  PROJECT_ARTIFACT_BOARD_FIELDS,
  ProjectArtifactBoardField,
  type ProjectArtifactBoardField as ProjectArtifactBoardFieldValue,
} from "./project-artifact-board";

export function projectBoardVisibleFields(
  visibleColumns: readonly DocumentColumnValue[]
) {
  const fields: ProjectArtifactBoardFieldValue[] = [
    ProjectArtifactBoardField.Status,
  ];
  const columnFields: Partial<
    Record<DocumentColumnValue, ProjectArtifactBoardFieldValue>
  > = {
    [DocumentColumn.Assignee]: ProjectArtifactBoardField.Owner,
    [DocumentColumn.Priority]: ProjectArtifactBoardField.Priority,
    [DocumentColumn.Tags]: ProjectArtifactBoardField.Tags,
    [DocumentColumn.Type]: ProjectArtifactBoardField.Type,
    [DocumentColumn.Updated]: ProjectArtifactBoardField.Updated,
  };
  for (const column of visibleColumns) {
    const field = columnFields[column];
    if (field) {
      fields.push(field);
    }
  }
  return [...new Set(fields)];
}

/**
 * The portable project page's Options columns as card fields (ISS-12929,
 * 724-F4): every column the project list shares with the card catalog,
 * including the PRD-595 baseline Collaborators, Related Sessions, Comments and
 * Current version, in catalog order. Status always leads, as in
 * {@link projectBoardVisibleFields}.
 */
export function projectBoardFieldsFromListColumns(
  visibleColumnIds: ReadonlySet<string>
): ProjectArtifactBoardFieldValue[] {
  const fields: ProjectArtifactBoardFieldValue[] = [
    ProjectArtifactBoardField.Status,
  ];
  for (const field of PROJECT_ARTIFACT_BOARD_FIELDS) {
    const columnId = PROJECT_LIST_COLUMN_BY_BOARD_FIELD[field.id];
    if (columnId && visibleColumnIds.has(columnId)) {
      fields.push(field.id);
    }
  }
  return [...new Set(fields)];
}

export function projectBoardItems(
  treeData: ProjectTreeDetailsResponse,
  groupBy: GroupByModeValue
): ArtifactBoardItem[] {
  const items: ArtifactBoardItem[] = [];
  for (const node of treeData.nodes) {
    items.push(projectBoardItem(node.root, node.root.id, null, groupBy));
    for (const child of node.children) {
      items.push(
        projectBoardItem(child, node.root.id, child.parentId, groupBy)
      );
    }
  }
  return items;
}

export function projectBoardLanes(
  items: readonly ArtifactBoardItem[],
  groupBy: GroupByModeValue
) {
  const roots = items.filter((item) => item.id === item.rootId);
  const laneIds = projectBoardLaneIds(roots, groupBy);
  return laneIds.map((laneId) => ({
    id: laneId,
    label: laneLabel(laneId, roots, groupBy),
    rootIds: roots
      .filter((item) => item.laneId === laneId)
      .map((item) => item.id),
  }));
}

/** Status-root presentation for the project board; persisted status remains raw. */
export function projectBoardSharedStatusItems(
  treeData: ProjectTreeDetailsResponse
): ArtifactBoardItem[] {
  const items: ArtifactBoardItem[] = [];
  for (const node of treeData.nodes) {
    items.push({
      ...projectBoardItem(node.root, node.root.id, null, GroupByMode.Status),
      laneId: projectBoardSharedStatusRoot(node.root),
    });
    for (const child of node.children) {
      items.push({
        ...projectBoardItem(
          child,
          node.root.id,
          child.parentId,
          GroupByMode.Status
        ),
        laneId: projectBoardSharedStatusRoot(child),
      });
    }
  }
  return items;
}

/** Five shared root lanes in the same semantic order as status list grouping. */
export function projectBoardSharedStatusLanes(
  items: readonly ArtifactBoardItem[],
  orderedRootIds: readonly string[]
) {
  const roots = items.filter((item) => item.id === item.rootId);
  const responseRank = new Map(orderedRootIds.map((id, index) => [id, index]));
  return Object.values(ARTIFACT_STATUS_ROOT)
    .sort(
      (left, right) =>
        artifactStatusRootRank(left) - artifactStatusRootRank(right)
    )
    .map((id) => ({
      id,
      label: ARTIFACT_STATUS_DISPLAY_LABELS[id],
      rootIds: roots
        .filter((item) => item.laneId === id)
        .sort(
          (left, right) =>
            (responseRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
            (responseRank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        )
        .map((item) => item.id),
    }));
}

/** Resolve a shared lane to one allowed raw status per selected root. */
export function projectBoardSharedStatusTargets(
  treeData: ProjectTreeDetailsResponse,
  rootIds: readonly string[],
  targetRoot: string
): Record<string, string> | null {
  const targets: Record<string, string> = Object.create(null);
  for (const rootId of rootIds) {
    const artifact = treeData.nodes.find(
      (node) => node.root.id === rootId
    )?.root;
    if (!(artifact?.type === ArtifactType.Document && artifact.subtype)) {
      return null;
    }
    const documentType = documentTypeFromSubtype(artifact.subtype);
    const kind =
      documentType === DocumentType.Feature
        ? GenericArtifactKind.Issue
        : GenericArtifactKind.Document;
    const currentRoot = documentStatusFacet(documentType, artifact.status)
      .normalized.root;
    const alias = genericArtifactStatusDefaultForRoot(kind, targetRoot);
    let raw: string | null = null;
    if (currentRoot === targetRoot) {
      raw = artifact.status;
    } else if (alias) {
      raw = genericArtifactStatusRaw({ kind, status: alias });
    }
    const capability = documentArtifactStatusCapability({
      documentType,
      operation: DocumentStatusMutationOperation.Single,
      rawStatus: artifact.status,
      statusMutation: artifact.statusMutation,
    });
    if (
      !raw ||
      documentStatusFacet(documentType, raw).normalized.root !== targetRoot ||
      !capability.editable ||
      !capability.allowedTargets.some((status) => status === raw)
    ) {
      return null;
    }
    targets[rootId] = raw;
  }
  return rootIds.length > 0 ? targets : null;
}

/** Fold a raw server lane for whole-population count aggregation. */
export function projectBoardSharedStatusRootFromRaw(raw: string): string {
  if (Object.values(DocumentStatus).some((status) => status === raw)) {
    return artifactStatusFacet(ArtifactStatusVocabulary.Document, raw)
      .normalized.root;
  }
  if (Object.values(IssueStatus).some((status) => status === raw)) {
    return artifactStatusFacet(ArtifactStatusVocabulary.Issue, raw).normalized
      .root;
  }
  if (
    raw === LEGACY_WAITING_WIRE_STATUS ||
    Object.values(SESSION_STATUS).some((status) => status === raw)
  ) {
    return sessionStatusFacet(raw).normalized.root;
  }
  if (Object.values(BranchStatus).some((status) => status === raw)) {
    return artifactStatusFacet(ArtifactStatusVocabulary.Branch, raw).normalized
      .root;
  }
  return branchPullRequestStatusFacet(raw).normalized.root;
}

function projectBoardSharedStatusRoot(artifact: DetailedArtifact): string {
  if (artifact.type === ArtifactType.Document && artifact.subtype) {
    return documentStatusFacet(
      documentTypeFromSubtype(artifact.subtype),
      artifact.status
    ).normalized.root;
  }
  if (artifact.type === ArtifactType.Session) {
    return sessionStatusFacet(artifact.status).normalized.root;
  }
  return projectBoardSharedStatusRootFromRaw(artifact.status);
}

/** Apply a persisted lane preference without dropping lanes unknown to it. */
export function orderProjectBoardLanes<T extends { id: string }>(
  lanes: readonly T[],
  laneOrder: readonly string[]
): T[] {
  const rankById = new Map(laneOrder.map((id, index) => [id, index]));
  return lanes
    .map((lane, index) => ({ index, lane }))
    .sort((left, right) => {
      const leftRank = rankById.get(left.lane.id);
      const rightRank = rankById.get(right.lane.id);
      if (leftRank !== undefined && rightRank !== undefined) {
        return leftRank - rightRank;
      }
      if (leftRank !== undefined) {
        return -1;
      }
      if (rightRank !== undefined) {
        return 1;
      }
      return left.index - right.index;
    })
    .map(({ lane }) => lane);
}

/** Cross-lane grouping changes remain available when manual in-lane order is off. */
export function projectBoardManualOrderAllowsTarget(
  item: Pick<ArtifactBoardItem, "laneId">,
  target: ArtifactBoardMoveTarget,
  manualOrder: boolean
): boolean {
  return manualOrder || item.laneId !== target.laneId;
}

export function projectBoardGroupField(groupBy: GroupByModeValue) {
  switch (groupBy) {
    case GroupByMode.Status:
      return ProjectArtifactBoardField.Status;
    case GroupByMode.Priority:
      return ProjectArtifactBoardField.Priority;
    case GroupByMode.Assignee:
      return ProjectArtifactBoardField.Owner;
    case GroupByMode.None:
      return null;
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

export function boardMoveRequest(input: {
  groupBy: GroupByModeValue;
  move: ArtifactBoardMove;
  projectId: string;
  source: Exclude<ProjectArtifactPlacementSource, typeof PlacementSource.Undo>;
  lanePolicy?: ProjectArtifactLanePolicy;
  targetLaneRootIds: readonly string[];
}): ProjectArtifactPlacementIntent {
  return projectArtifactBoardMoveIntent({
    destinationProjectId: input.projectId,
    expectedPolicyRevision: input.lanePolicy?.revision,
    laneField: boardLaneField(input.groupBy),
    laneId: input.move.target.laneId,
    position: BOARD_DROP_POSITION[input.move.target.position],
    referenceRootId: input.move.target.referenceRootId,
    rootIds: input.move.rootIds,
    source: input.source,
    targetLaneRootIds: input.targetLaneRootIds,
  });
}

/** The placement fence for a move made from the rendered board page. */
export function boardRenderedProjectVersions(
  projectId: string,
  projectVersion: string | undefined
): Record<string, string> | undefined {
  return projectVersion ? { [projectId]: projectVersion } : undefined;
}

/** Resolve the canonical optional transition/capacity result for every UI path. */
export function projectBoardLanePolicyResult(input: {
  expectedPolicyRevision?: string;
  items: readonly ArtifactBoardItem[];
  policy: ProjectArtifactLanePolicy | null | undefined;
  rootIds: readonly string[];
  targetLaneId: string;
  targetLaneIdsByRootId?: Readonly<Record<string, string>>;
}): ProjectArtifactLanePolicyResult {
  const laneRootIds: Record<string, string[]> = Object.create(null);
  for (const item of input.items) {
    if (item.id !== item.rootId) {
      continue;
    }
    const roots = laneRootIds[item.laneId];
    if (roots) {
      roots.push(item.id);
    } else {
      laneRootIds[item.laneId] = [item.id];
    }
  }
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const moves = input.rootIds.flatMap((rootId) => {
    const item = itemById.get(rootId);
    return item
      ? [
          {
            destinationLaneId:
              input.targetLaneIdsByRootId?.[rootId] ?? input.targetLaneId,
            rootId,
            sourceLaneId: item.laneId,
          },
        ]
      : [];
  });
  return evaluateProjectArtifactLanePolicy({
    expectedPolicyRevision: input.expectedPolicyRevision,
    laneRootIds,
    moves,
    policy: input.policy,
  });
}

export function crossProjectBoardMoveRequest(input: {
  destinationProjectId: string;
  selectedRootIds: readonly string[];
}): ProjectArtifactPlacementIntent {
  return {
    destinationProjectId: input.destinationProjectId,
    position: ProjectArtifactPlacementPosition.Root,
    source: PlacementSource.Keyboard,
    sourceArtifactIds: [...input.selectedRootIds],
  };
}

export function projectBoardSelection(
  current: readonly string[],
  rootIds: readonly string[],
  itemId: string,
  intent: ArtifactBoardSelectionIntent,
  anchorRef: { current: string | null }
) {
  return artifactBoardSelectionFromIntent(
    current,
    rootIds,
    itemId,
    intent,
    anchorRef
  );
}

/**
 * ISS-12905: names a drop target by its lane label or reference card title,
 * never by id, because the board announces it to screen readers.
 */
export function projectBoardDropTargetLabeler(
  items: readonly ArtifactBoardItem[],
  lanes: readonly ArtifactBoardLane[]
): (target: ArtifactBoardMoveTarget) => string {
  const titleById = new Map(items.map((item) => [item.id, item.title]));
  const laneLabelById = new Map(lanes.map((lane) => [lane.id, lane.label]));
  return (target) => {
    if (target.position === ArtifactBoardDropPosition.End) {
      const laneLabel = laneLabelById.get(target.laneId);
      return laneLabel ? `End of ${laneLabel}` : target.position;
    }
    const title =
      target.referenceRootId === undefined
        ? undefined
        : titleById.get(target.referenceRootId);
    return title ? `${target.position} ${title}` : target.position;
  };
}

function projectBoardItem(
  artifact: DetailedArtifact,
  rootId: string,
  parentId: string | null,
  groupBy: GroupByModeValue
): ArtifactBoardItem {
  const owner = artifact.assignee
    ? getUserDisplayName(artifact.assignee)
    : UNASSIGNED_ASSIGNEE_LABEL;
  return {
    fieldValues: {
      owner,
      priority: artifact.priority,
      status: ARTIFACT_STATUS_LABELS[artifact.status] ?? artifact.status,
      tags: artifact.tags?.map((tag) => tag.name) ?? [],
      type: projectBoardTypeLabel(artifact),
      updated: formatRelativeTimeOrFallback(artifact.updatedAt),
    },
    id: artifact.id,
    laneId: projectBoardLaneId(groupBy, artifact),
    parentId,
    rootId,
    slug: artifact.slug ?? "",
    title: artifact.name,
    typeLabel: projectBoardTypeLabel(artifact),
  };
}

function laneLabel(
  laneId: string,
  roots: readonly ArtifactBoardItem[],
  groupBy: GroupByModeValue
) {
  if (groupBy === GroupByMode.Status) {
    return ARTIFACT_STATUS_LABELS[laneId] ?? laneId;
  }
  if (groupBy === GroupByMode.Priority) {
    return priorityLabel(
      laneId === PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID ? null : laneId
    );
  }
  if (groupBy === GroupByMode.None) {
    return "All Artifacts";
  }
  return (
    roots
      .find((item) => item.laneId === laneId)
      ?.fieldValues.owner?.toString() ?? UNASSIGNED_ASSIGNEE_LABEL
  );
}

function projectBoardLaneIds(
  roots: readonly ArtifactBoardItem[],
  groupBy: GroupByModeValue
) {
  const populated = roots.map((item) => item.laneId);
  switch (groupBy) {
    case GroupByMode.Status:
      return [
        ...new Set([
          ...Object.values(DocumentStatus),
          ...Object.values(IssueStatus),
          ...populated,
        ]),
      ];
    case GroupByMode.Priority:
      return [
        ...Object.values(Priority),
        PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID,
      ];
    case GroupByMode.Assignee:
      return [
        ...new Set([...populated, PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID]),
      ];
    case GroupByMode.None:
      return ["all"];
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

function projectBoardLaneId(
  groupBy: GroupByModeValue,
  artifact: DetailedArtifact
) {
  switch (groupBy) {
    case GroupByMode.Status:
      return artifact.status;
    case GroupByMode.Priority:
      return artifact.priority ?? PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID;
    case GroupByMode.Assignee:
      return artifact.assigneeId ?? PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID;
    case GroupByMode.None:
      return "all";
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

/**
 * ISS-12929 (724-F9): exhaustive, so a Deployment root no longer falls through
 * to the Pull Request label. Each arm reuses the label its kind already ships
 * with: the documents table badges for documents, branches and sessions, and
 * the generic board's kind label for deployments.
 */
export function projectBoardTypeLabel(artifact: DetailedArtifact): string {
  switch (artifact.type) {
    case ArtifactType.Document:
      return artifact.subtype
        ? DOCUMENT_TYPE_BADGE_LABELS[documentTypeFromSubtype(artifact.subtype)]
        : GenericArtifactKind.Document;
    case ArtifactType.Session:
      return "Session";
    case ArtifactType.Branch:
      return "Pull Request";
    case ArtifactType.Deployment:
      return GenericArtifactKind.Deployment;
    default: {
      const exhaustive: never = artifact.type;
      return exhaustive;
    }
  }
}

function boardLaneField(
  groupBy: GroupByModeValue
): ProjectArtifactPlacementGroupField | null {
  switch (groupBy) {
    case GroupByMode.Status:
      return ProjectArtifactPlacementGroupField.Status;
    case GroupByMode.Priority:
      return ProjectArtifactPlacementGroupField.Priority;
    case GroupByMode.Assignee:
      return ProjectArtifactPlacementGroupField.AssigneeId;
    case GroupByMode.None:
      return null;
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

const BOARD_DROP_POSITION: Record<
  ArtifactBoardDropPosition,
  ProjectArtifactBoardDropPosition
> = {
  [ArtifactBoardDropPosition.After]: ProjectArtifactBoardDropPosition.After,
  [ArtifactBoardDropPosition.Before]: ProjectArtifactBoardDropPosition.Before,
  [ArtifactBoardDropPosition.End]: ProjectArtifactBoardDropPosition.End,
};

/**
 * Project list column id per card field. Type has no list column; the card
 * shows its kind through the type icon instead.
 */
const PROJECT_LIST_COLUMN_BY_BOARD_FIELD: Record<
  ProjectArtifactBoardFieldValue,
  string | null
> = {
  [ProjectArtifactBoardField.Collaborators]: "collaborators",
  [ProjectArtifactBoardField.Comments]: "comments",
  [ProjectArtifactBoardField.CurrentVersion]: "currentVersion",
  [ProjectArtifactBoardField.Owner]: "owner",
  [ProjectArtifactBoardField.Priority]: "priority",
  [ProjectArtifactBoardField.RelatedSessions]: "relatedSessions",
  [ProjectArtifactBoardField.Status]: "status",
  [ProjectArtifactBoardField.Tags]: "tags",
  [ProjectArtifactBoardField.Type]: null,
  [ProjectArtifactBoardField.Updated]: "updated",
};

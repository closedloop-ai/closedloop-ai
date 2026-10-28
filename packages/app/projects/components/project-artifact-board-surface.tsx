"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  type ProjectArtifactBoardFilters,
  ProjectArtifactBoardGroup,
} from "@repo/api/src/types/project-artifact-board-page";
import type { ProjectArtifactBoardView } from "@repo/api/src/types/project-artifact-board-view";
import {
  ProjectArtifactLanePolicyReason,
  type ProjectArtifactLanePolicyResult,
  projectArtifactLanePolicyReasonLabel,
} from "@repo/api/src/types/project-artifact-lane-policy";
import type { ProjectArtifactPlacementSource as ProjectArtifactPlacementSourceValue } from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import type {
  DetailedArtifact,
  ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import type { TableFilters } from "@repo/app/documents/hooks/use-table-filters";
import {
  type DocumentRowData,
  documentRowFromArtifact,
} from "@repo/app/documents/lib/artifact-row-adapter";
import {
  GroupByMode,
  type GroupByMode as GroupByModeValue,
} from "@repo/app/documents/lib/group-by";
import {
  resolveBoardPlacementVersions,
  useArtifactPlacement,
} from "@repo/app/projects/hooks/use-artifact-placement";
import { useProjectArtifactBoardAnalytics } from "@repo/app/projects/hooks/use-project-artifact-board-analytics";
import {
  type ProjectArtifactBoardPageSort,
  useProjectArtifactBoardPage,
} from "@repo/app/projects/hooks/use-project-artifact-board-page";
import { useProjectArtifactMetadata } from "@repo/app/projects/hooks/use-project-artifact-list-metadata";
import { useProjects } from "@repo/app/projects/hooks/use-projects";
import { useProjectBoardFilters } from "@repo/app/projects/lib/project-artifact-board-filters";
import { projectArtifactHref } from "@repo/app/projects/lib/project-artifact-list-helpers";
import { useApiClientOptional } from "@repo/app/shared/api/use-api-client-optional";
import type { ArtifactBoardFeedback } from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board";
import type {
  ArtifactBoardItem,
  ArtifactBoardMove,
  ArtifactBoardMoveTarget,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import {
  ArtifactBoardDropPosition,
  ArtifactBoardMutationState,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import { ArtifactSelectionAnnouncer } from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import {
  GenericArtifactKind,
  genericArtifactStatusDefaultForRoot,
  genericArtifactStatusRaw,
} from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { InlineNameCell } from "@repo/design-system/components/ui/inline-name-cell";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  ProjectArtifactBoard,
  ProjectArtifactBoardField,
  projectArtifactBoardPolicyFeedback,
} from "./project-artifact-board";
import {
  findProjectBoardArtifact,
  projectBoardCanMove,
  projectBoardCanMoveToLane,
  projectBoardRoute,
  projectBoardTypeIcon,
  renderProjectBoardField,
} from "./project-artifact-board-fields";
import {
  boardMoveRequest,
  boardRenderedProjectVersions,
  crossProjectBoardMoveRequest,
  orderProjectBoardLanes,
  projectBoardDropTargetLabeler,
  projectBoardGroupField,
  projectBoardItems,
  projectBoardLanePolicyResult,
  projectBoardLanes,
  projectBoardManualOrderAllowsTarget,
  projectBoardSelection,
  projectBoardSharedStatusItems,
  projectBoardSharedStatusLanes,
  projectBoardSharedStatusRootFromRaw,
  projectBoardSharedStatusTargets,
} from "./project-artifact-board-model";
import { ProjectArtifactBoardSelectionActions } from "./project-artifact-board-selection-actions";
import { openProjectArtifactTarget } from "./project-artifact-list-actions";

export type ProjectArtifactBoardSurfaceProps = {
  boardView: ProjectArtifactBoardView;
  editHandlers: RowEditHandlers;
  filterText: string;
  /** The project table's filters; the board route applies them (724-F5). */
  filters?: TableFilters;
  /**
   * The portable project list's resolved toolbar filters (ISS-12929), used
   * in place of the table's filters when given.
   */
  listFilters?: ProjectArtifactBoardFilters;
  groupBy: GroupByModeValue;
  onAddIssue?: (status: IssueStatus) => void;
  project: DocumentRowData["project"];
  projectId: string;
  /**
   * The project table's column sort (724-F5). A derived order turns off
   * in-lane manual reordering, as the table hides its rank handle.
   */
  sort?: ProjectArtifactBoardPageSort;
  teamId: string;
};

/** Production Projects adapter for the shared root-only Artifact Board. */
export function ProjectArtifactBoardSurface({
  boardView,
  editHandlers,
  filterText,
  filters,
  groupBy,
  listFilters,
  onAddIssue,
  project,
  projectId,
  sort,
  teamId,
}: Readonly<ProjectArtifactBoardSurfaceProps>) {
  const sharedStatusEnabled = useSharedStatusBoardEnabled(groupBy);
  const apiClient = useApiClientOptional();
  const navigation = useNavigation();
  const buildOrgPath = useOrgPath();
  const tableFilters = useProjectBoardFilters(filters, filterText);
  const boardFilters = listFilters ?? tableFilters;
  const boardQuery = useProjectArtifactBoardPage(
    projectId,
    projectBoardQueryGroup(groupBy),
    { filters: boardFilters, sort }
  );
  const manualOrder = boardView.arrangement.manualOrder && !sort;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [policyRejection, setPolicyRejection] =
    useState<ProjectArtifactLanePolicyReason | null>(null);
  const projects = useProjects(teamId, { enabled: selectedIds.length > 0 });
  const selectionAnchorRef = useRef<string | null>(null);
  const treeData = useMemo<ProjectTreeDetailsResponse>(
    () => ({
      externalParents: [],
      nodes:
        boardQuery.data?.lanes.flatMap((lane) =>
          lane.cards.map((card) => ({ children: [], root: card.artifact }))
        ) ?? [],
    }),
    [boardQuery.data]
  );
  const documents = useMemo(
    () =>
      treeData.nodes.flatMap((node) => {
        const document = documentRowFromArtifact(node.root, project);
        return document ? [document] : [];
      }),
    [project, treeData]
  );
  const documentById = useMemo(
    () => new Map(documents.map((document) => [document.id, document])),
    [documents]
  );
  const rawItems = useMemo(
    () => projectBoardItems(treeData, groupBy),
    [groupBy, treeData]
  );
  const items = useMemo(() => {
    if (!sharedStatusEnabled) {
      return rawItems;
    }
    const rootById = new Map(
      projectBoardSharedStatusItems(treeData).map((item) => [
        item.id,
        item.laneId,
      ])
    );
    return rawItems.map((item) => ({
      ...item,
      laneId: rootById.get(item.id) ?? item.laneId,
    }));
  }, [rawItems, sharedStatusEnabled, treeData]);
  const visibleFieldIds = useMemo(
    () =>
      sharedStatusEnabled
        ? [
            ProjectArtifactBoardField.Status,
            ...boardView.arrangement.cardFieldIds,
          ]
        : boardView.arrangement.cardFieldIds,
    [boardView.arrangement.cardFieldIds, sharedStatusEnabled]
  );
  const cardArtifacts = useMemo(
    () => treeData.nodes.map((node) => node.root),
    [treeData]
  );
  const metadata = useProjectArtifactMetadata({
    artifacts: cardArtifacts,
    includePeople: visibleFieldIds.some(
      (field) =>
        field === ProjectArtifactBoardField.Collaborators ||
        field === ProjectArtifactBoardField.Comments
    ),
    includeRelatedSessions: visibleFieldIds.includes(
      ProjectArtifactBoardField.RelatedSessions
    ),
  });
  const lanePolicy = boardQuery.data?.lanePolicy;
  const mutation = useArtifactPlacement(projectId, true, {
    board: { items: rawItems, policy: lanePolicy },
  });
  const lanes = useMemo(() => {
    const counts = new Map(
      boardQuery.data?.lanes.map((lane) => [lane.id, lane.count]) ?? []
    );
    const sharedCounts = projectBoardSharedStatusLaneCounts(
      boardQuery.data?.lanes ?? []
    );
    const derivedLanes = sharedStatusEnabled
      ? projectBoardSharedStatusLanes(items, boardQuery.data?.rootIds ?? [])
      : orderProjectBoardLanes(
          projectBoardLanes(items, groupBy),
          boardView.arrangement.laneOrder
        );
    return derivedLanes.map((lane) => ({
      ...lane,
      collapsed: boardView.arrangement.collapsedLaneIds.includes(lane.id),
      count:
        counts.get(lane.id) ?? sharedCounts.get(lane.id) ?? lane.rootIds.length,
    }));
  }, [
    boardQuery.data,
    boardView.arrangement,
    groupBy,
    items,
    sharedStatusEnabled,
  ]);
  const renderedLanes = useMemo(
    () =>
      lanes.map((lane) => {
        const status = issueStatusFromLane(lane.id);
        if (!(onAddIssue && status)) {
          return lane;
        }
        return {
          ...lane,
          header: (
            <Button
              aria-label="Add issue"
              onClick={() => onAddIssue(status)}
              size="icon-sm"
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          ),
        };
      }),
    [lanes, onAddIssue]
  );
  const dropTargetLabel = useMemo(
    () => projectBoardDropTargetLabeler(items, renderedLanes),
    [items, renderedLanes]
  );
  const rootIds = boardQuery.data?.rootIds ?? [];
  const selectedRootArtifacts = boardSelectedRootArtifacts(
    treeData,
    rootIds,
    selectedIds
  );
  const renderedProjectVersions = boardRenderedProjectVersions(
    projectId,
    boardQuery.data?.projectVersion
  );
  const moveRootIdsForItem = (item: ArtifactBoardItem) =>
    selectedIds.includes(item.id)
      ? rootIds.filter((id) => selectedIds.includes(id))
      : [item.id];
  const moveAdmission = (
    item: ArtifactBoardItem,
    target: ArtifactBoardMoveTarget,
    movingRootIds: readonly string[] = moveRootIdsForItem(item)
  ): ProjectArtifactLanePolicyResult => {
    const rawTargets = sharedStatusEnabled
      ? projectBoardSharedStatusTargets(treeData, movingRootIds, target.laneId)
      : null;
    const rawTargetLaneId = sharedStatusEnabled
      ? rawTargets?.[item.id]
      : target.laneId;
    if (
      !(
        rawTargetLaneId &&
        projectBoardManualOrderAllowsTarget(item, target, manualOrder) &&
        movingRootIds.every((rootId) =>
          projectBoardCanMoveToLane(
            rootId,
            rawTargets?.[rootId] ?? rawTargetLaneId,
            groupBy,
            treeData
          )
        )
      )
    ) {
      return {
        allowed: false,
        reason: ProjectArtifactLanePolicyReason.UnsupportedTransition,
      };
    }
    return projectBoardLanePolicyResult({
      expectedPolicyRevision: lanePolicy?.revision,
      items: rawItems,
      policy: lanePolicy,
      rootIds: movingRootIds,
      targetLaneId: rawTargetLaneId,
      ...(rawTargets ? { targetLaneIdsByRootId: rawTargets } : {}),
    });
  };
  useProjectArtifactBoardAnalytics({
    boardError: boardQuery.error,
    cardCount: items.filter((item) => item.id === item.rootId).length,
    destinationError: null,
    groupBy: projectBoardQueryGroup(groupBy),
    isLoaded: boardQuery.isSuccess,
    laneCount: lanes.length,
    mutationError: mutation.undoMutation.error ?? mutation.error,
    mutationOperation:
      mutation.undoMutation.isPending ||
      mutation.undoMutation.data ||
      mutation.undoMutation.error
        ? ProjectArtifactPlacementKind.Undo
        : ProjectArtifactPlacementKind.Place,
    mutationResponse: mutation.undoMutation.data ?? mutation.data,
  });
  const handleMove = (
    move: ArtifactBoardMove,
    source: Exclude<
      ProjectArtifactPlacementSourceValue,
      typeof ProjectArtifactPlacementSource.Undo
    > = ProjectArtifactPlacementSource.Pointer
  ) => {
    const targetLane = lanes.find((lane) => lane.id === move.target.laneId);
    if (!targetLane) {
      return;
    }
    const activeItem = items.find((item) => item.id === move.rootIds[0]);
    if (!activeItem) {
      return;
    }
    const admission = moveAdmission(activeItem, move.target, move.rootIds);
    if (!admission.allowed) {
      setPolicyRejection(admission.reason);
      return;
    }
    setPolicyRejection(null);
    const rawTargets = sharedStatusEnabled
      ? projectBoardSharedStatusTargets(
          treeData,
          move.rootIds,
          move.target.laneId
        )
      : null;
    const rawTargetLaneId = sharedStatusEnabled
      ? rawTargets?.[move.rootIds[0] ?? ""]
      : move.target.laneId;
    if (!rawTargetLaneId) {
      setPolicyRejection(ProjectArtifactLanePolicyReason.UnsupportedTransition);
      return;
    }
    const request = boardMoveRequest({
      groupBy,
      lanePolicy,
      move: {
        ...move,
        target: { ...move.target, laneId: rawTargetLaneId },
      },
      projectId,
      source,
      targetLaneRootIds: targetLane.rootIds,
    });
    if (
      rawTargets &&
      request.lanePatch &&
      move.rootIds.some((id) => rawTargets[id] !== rawTargetLaneId)
    ) {
      request.lanePatch.valuesByRootId = rawTargets;
    }
    return resolveBoardPlacementVersions(
      apiClient?.get,
      [projectId],
      renderedProjectVersions
    ).then((expectedProjectVersions) =>
      mutation.mutate({ ...request, expectedProjectVersions })
    );
  };
  const handleCrossProjectMove = async (
    destinationProjectId: string,
    rowIds?: readonly string[]
  ) => {
    const expectedProjectVersions = await resolveBoardPlacementVersions(
      apiClient?.get,
      [projectId, destinationProjectId],
      renderedProjectVersions
    );
    return new Promise<void>((resolve, reject) => {
      mutation.mutate(
        {
          ...crossProjectBoardMoveRequest({
            destinationProjectId,
            selectedRootIds: rootIds.filter((id) =>
              (rowIds ?? selectedIds).includes(id)
            ),
          }),
          expectedProjectVersions,
        },
        {
          onError: reject,
          onSuccess: () => {
            if (!rowIds) {
              setSelectedIds([]);
            }
            resolve();
          },
        }
      );
    });
  };
  let feedback: ArtifactBoardFeedback = {
    state: ArtifactBoardMutationState.Idle,
  };
  if (boardQuery.isLoading || mutation.isPending) {
    feedback = {
      label: "Loading...",
      state: ArtifactBoardMutationState.Pending,
    };
  } else if (
    policyRejection ||
    boardQuery.error ||
    mutation.error ||
    mutation.undoMutation.error
  ) {
    feedback = policyRejection
      ? projectArtifactBoardPolicyFeedback(policyRejection)
      : {
          content:
            boardQuery.error?.message ??
            mutation.error?.message ??
            mutation.undoMutation.error?.message,
          state: ArtifactBoardMutationState.Error,
        };
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ArtifactSelectionAnnouncer count={selectedIds.length} />
      <ProjectArtifactBoardSelectionActions
        currentProjectId={projectId}
        onClear={() => setSelectedIds([])}
        onMoveToProject={handleCrossProjectMove}
        onRetain={(ids) => setSelectedIds([...ids])}
        pending={mutation.isPending || mutation.undoMutation.isPending}
        project={project}
        projects={projects.data ?? []}
        selectedArtifacts={selectedRootArtifacts}
        selectedCount={selectedIds.length}
        users={editHandlers.teamMembers}
      />
      <ProjectArtifactBoard
        canMoveItem={(item) => projectBoardCanMove(item.id, groupBy, treeData)}
        canMoveItemToTarget={(item, target) =>
          moveAdmission(item, target).allowed
        }
        feedback={feedback}
        getDropTargetLabel={dropTargetLabel}
        groupBy={sharedStatusEnabled ? null : projectBoardGroupField(groupBy)}
        items={items}
        lanes={renderedLanes}
        onMove={(move) => handleMove(move)}
        onMoveRejected={(item, target) => {
          const admission = moveAdmission(item, target);
          if (!admission.allowed) {
            setPolicyRejection(admission.reason);
          }
        }}
        onOpen={(item) => {
          const artifact = findProjectBoardArtifact(item.id, treeData);
          openProjectArtifactTarget(
            projectArtifactHref(
              artifact?.type,
              artifact ? projectBoardRoute(artifact) : null,
              buildOrgPath
            ),
            artifact?.type === ArtifactType.Deployment,
            navigation.navigate
          );
        }}
        onSelectionChange={(itemId, intent) => {
          setSelectedIds((current) =>
            projectBoardSelection(
              current,
              rootIds,
              itemId,
              intent,
              selectionAnchorRef
            )
          );
        }}
        renderActions={(item) =>
          projectBoardCanMove(item.id, groupBy, treeData) ? (
            <ProjectBoardActions
              item={item}
              lanes={lanes.map((lane) => ({
                ...lane,
                admission: moveAdmission(item, {
                  laneId: lane.id,
                  position: ArtifactBoardDropPosition.End,
                }),
              }))}
              move={(target) =>
                handleMove(
                  {
                    rootIds: moveRootIdsForItem(item),
                    sourceLaneId: item.laneId,
                    target,
                  },
                  ProjectArtifactPlacementSource.Keyboard
                )
              }
            />
          ) : null
        }
        renderField={(item, field) =>
          renderProjectBoardField(item, field, {
            documentById,
            editHandlers,
            metadata,
            treeData,
          })
        }
        renderTitle={(item, open) => {
          const document = documentById.get(item.id);
          if (!(document && editHandlers.onUpdateTitle)) {
            return (
              <Button
                className="h-auto min-h-0 w-full justify-start whitespace-normal p-0 text-left font-semibold text-base leading-6 hover:no-underline"
                onClick={open}
                variant="link"
              >
                {item.title}
              </Button>
            );
          }
          return (
            <InlineNameCell
              className="font-semibold text-base leading-6"
              label="Edit title"
              onCommit={(title, expectedTitle) =>
                editHandlers.onUpdateTitle?.(item.id, title, expectedTitle)
              }
              renderValue={(shown) => (
                <Button
                  className="h-auto min-h-0 w-full justify-start whitespace-normal p-0 text-left font-semibold text-base leading-6 hover:no-underline"
                  onClick={open}
                  variant="link"
                >
                  {shown}
                </Button>
              )}
              value={document.title}
            />
          );
        }}
        renderTypeIcon={
          boardView.arrangement.cardFieldIds.includes(
            ProjectArtifactBoardField.Type
          )
            ? (item) => projectBoardTypeIcon(item, treeData)
            : undefined
        }
        selectedIds={selectedIds}
        visibleFieldIds={visibleFieldIds}
      />
      {boardQuery.hasNextPage ? (
        <div className="flex justify-center border-t p-2">
          <Button
            disabled={boardQuery.isFetchingNextPage}
            onClick={async () => {
              await boardQuery.fetchNextPage();
            }}
            size="sm"
            variant="outline"
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function boardSelectedRootArtifacts(
  treeData: ProjectTreeDetailsResponse,
  rootIds: readonly string[],
  selectedIds: readonly string[]
): DetailedArtifact[] {
  const roots = new Set(rootIds);
  const selected = new Set(selectedIds);
  return treeData.nodes
    .map((node) => node.root)
    .filter((artifact) => roots.has(artifact.id) && selected.has(artifact.id));
}

function ProjectBoardActions({
  item,
  lanes,
  move,
}: {
  item: ArtifactBoardItem;
  lanes: readonly {
    admission: ProjectArtifactLanePolicyResult;
    id: string;
    label: string;
    rootIds: readonly string[];
  }[];
  move: (target: ArtifactBoardMoveTarget) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Actions for ${item.title}`}
          size="icon-sm"
          variant="ghost"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {lanes.map((lane) => (
          <DropdownMenuItem
            disabled={!lane.admission.allowed}
            key={lane.id}
            onSelect={() => {
              if (lane.admission.allowed) {
                move({
                  laneId: lane.id,
                  position: ArtifactBoardDropPosition.End,
                });
              }
            }}
          >
            Move to {lane.label}
            {lane.admission.allowed ? null : (
              <span className="sr-only">
                {projectArtifactLanePolicyReasonLabel(lane.admission.reason)}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function issueStatusFromLane(laneId: string): IssueStatus | null {
  const rawStatus = Object.values(IssueStatus).find(
    (status) => status === laneId
  );
  if (rawStatus) {
    return rawStatus;
  }
  const status = genericArtifactStatusDefaultForRoot(
    GenericArtifactKind.Issue,
    laneId
  );
  const raw = status
    ? genericArtifactStatusRaw({ kind: GenericArtifactKind.Issue, status })
    : null;
  return Object.values(IssueStatus).find((value) => value === raw) ?? null;
}

function projectBoardSharedStatusLaneCounts(
  lanes: readonly { id: string; count: number }[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lane of lanes) {
    const root = projectBoardSharedStatusRootFromRaw(lane.id);
    counts.set(root, (counts.get(root) ?? 0) + lane.count);
  }
  return counts;
}

function useSharedStatusBoardEnabled(groupBy: GroupByModeValue): boolean {
  const enabled = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  return enabled && groupBy === GroupByMode.Status;
}

function projectBoardQueryGroup(
  groupBy: GroupByModeValue
): ProjectArtifactBoardGroup {
  switch (groupBy) {
    case GroupByMode.Status:
      return ProjectArtifactBoardGroup.Status;
    case GroupByMode.Priority:
      return ProjectArtifactBoardGroup.Priority;
    case GroupByMode.Assignee:
      return ProjectArtifactBoardGroup.Assignee;
    case GroupByMode.None:
      return ProjectArtifactBoardGroup.None;
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

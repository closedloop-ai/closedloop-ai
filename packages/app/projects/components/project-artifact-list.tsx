"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import {
  ProjectArtifactPlacementPosition,
  type ProjectArtifactPlacementRootUpdates,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { Button } from "@repo/design-system/components/ui/button";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { ColumnFieldKind } from "@repo/design-system/lib/column-registry";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useEffect, useMemo, useState } from "react";
import { issuesPrototypeColumns } from "../../artifacts/components/artifact-list-model";
import { useDocumentsPrototypeCustomFields } from "../../documents/components/documents-prototype-custom-fields";
import {
  useFavoriteArtifacts,
  useToggleFavoriteArtifact,
} from "../../documents/hooks/use-artifact-favorites";
import {
  useFavoriteArtifactIds,
  usePendingFavoriteArtifactIds,
} from "../../documents/hooks/use-favorite-artifact-ids";
import {
  useRelatedSessionsMatches,
  useRelatedSessionsSearch,
} from "../../documents/hooks/use-related-sessions";
import {
  GenericArtifactKind,
  genericArtifactStatusDefaultForRoot,
  genericArtifactStatusRaw,
} from "../../shared/components/generic-artifact-surface/generic-artifact-status";
import type { ArtifactHierarchyDropPlacement } from "../../shared/components/generic-artifact-surface/preview/components/artifact-hierarchy";
import { ArtifactHierarchyControls } from "../../shared/components/generic-artifact-surface/preview/components/artifact-hierarchy-controls";
import { ArtifactHierarchyLead } from "../../shared/components/generic-artifact-surface/preview/components/artifact-hierarchy-row";
import { artifactManualMoveTarget } from "../../shared/components/generic-artifact-surface/preview/components/artifact-hierarchy-view";
import {
  EditableArtifactLead,
  GenericArtifactLead,
} from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-cells";
import { columnWidthBounds } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import { ArtifactListSharedToolbar } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-shared-toolbar";
import type {
  ArtifactListHostRendering,
  ArtifactListShellController,
} from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import { useGenericArtifactListController } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-shell-controller";
import type { GenericArtifact } from "../../shared/components/generic-artifact-surface/preview/fixtures";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import { useManualArtifactOrderingEnabled } from "../../shared/feature-flags/use-manual-artifact-ordering";
import { useLinkedSearchWriter } from "../../shared/hooks/use-linked-search-writer";
import { useScrollRestore } from "../../shared/hooks/use-scroll-restore";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import { getUserDisplayName } from "../../shared/lib/user-utils";
import { useTeamMembers } from "../../teams/hooks/use-team-members";
import { useCurrentUser } from "../../users/hooks/use-users";
import {
  useArtifactPlacement,
  useArtifactPlacementCapability,
} from "../hooks/use-artifact-placement";
import { useProjectArtifactGroupUpdates } from "../hooks/use-project-artifact-group-updates";
import { useProjectArtifactListMetadata } from "../hooks/use-project-artifact-list-metadata";
import { useProjectArtifactViewStateKey } from "../hooks/use-project-artifact-view-state-key";
import { useSyncProjectDefaultGroupBy } from "../hooks/use-project-default-group-by";
import {
  type ProjectHierarchyMoveIntent,
  useProjectHierarchyTransaction,
} from "../hooks/use-project-hierarchy-transaction";
import { useProjectInlineIssueCreation } from "../hooks/use-project-inline-issue-creation";
import { useProjectsByTeam } from "../hooks/use-projects";
import { PROJECT_LIST_PARENT_COLUMN_ID } from "../lib/project-artifact-board-list-filters";
import { projectArtifactFilterEvidenceUnavailable } from "../lib/project-artifact-filter-evidence";
import {
  hierarchyTargetGroupUpdates,
  projectGroupAuthority,
  projectGroupUpdates,
} from "../lib/project-artifact-group-updates";
import {
  canPlaceProjectArtifactSubtrees,
  submitProjectArtifactHierarchyDrop,
} from "../lib/project-artifact-hierarchy-drop";
import { projectArtifactListRow } from "../lib/project-artifact-list-adapter";
import {
  PROJECT_COLUMNS,
  PROJECT_HIERARCHY,
  type ProjectArtifactMove,
  projectArtifactFilterState,
  projectArtifactHref,
  projectArtifactMatchesCategory,
  projectArtifactParents,
  projectArtifactSessionOptions,
  projectRelatedSessionFilterStatus,
  statusGroupingActive,
} from "../lib/project-artifact-list-helpers";
import { projectArtifactRoute } from "../lib/project-artifact-navigation";
import { projectArtifactReadModel } from "../lib/project-artifact-read-model";
import { projectDefaultGroupBy } from "../lib/project-default-group-by";
import { ProjectArtifactListCell } from "./project-artifact-cells";
import { projectArtifactEditHandlers } from "./project-artifact-edit-handlers";
import {
  adjacentArtifactGroup,
  favoriteProjectSelection,
  moveProjectSelection,
  openProjectArtifactTarget,
  selectedArtifactIdsForMove,
} from "./project-artifact-list-actions";
import {
  ProjectArtifactBoardStatusMenu,
  ProjectArtifactListTruncationNotice,
} from "./project-artifact-list-controls";
import type { ProjectArtifactListProps } from "./project-artifact-list-props";
import { ProjectArtifactListResult } from "./project-artifact-list-result";
import { ProjectArtifactNarrowLead } from "./project-artifact-narrow-lead";
import {
  PROJECT_ARTIFACT_METRICS,
  ProjectArtifactSummary,
} from "./project-artifact-summary";
import {
  ProjectArtifactParents,
  ProjectArtifactTitle,
} from "./project-artifact-title";
import { useProjectArtifactTitleRenderers } from "./project-artifact-titles";
import type { ProjectArtifactTreeHost } from "./project-artifact-tree-grid";
import { ProjectListSelectionActions } from "./project-registered-selection-actions";
import { useProjectHierarchyLoading } from "./project-tree-expansion-pages";

/** The approved shared list renders canonical project records and server writes. */
export function ProjectArtifactList(props: ProjectArtifactListProps) {
  const persistenceKey = useProjectArtifactViewStateKey(
    props.teamId,
    props.project.id
  );
  return (
    <ProjectArtifactListBody
      key={persistenceKey ?? `${props.teamId}:${props.project.id}`}
      {...props}
      persistenceKey={persistenceKey}
    />
  );
}

function ProjectArtifactListBody({
  project,
  teamId,
  tree,
  loading,
  failed,
  onRetry,
  onRefresh,
  hasMoreRootPages,
  isLoadingMoreRootPages,
  loadMoreRootPages,
  persistenceKey,
  category = "all",
}: Parameters<typeof ProjectArtifactList>[0] & {
  persistenceKey: string | null;
}) {
  const orgPath = useOrgPath();
  const navigation = useNavigation();
  const path = usePath();
  const { replaceSearch, search: query } = useLinkedSearchWriter(
    path,
    useSearchParamsValue(),
    navigation.replace
  );
  const boardLayout = new URLSearchParams(query).get("layout") === "board";
  const manualOrderingEnabled = useManualArtifactOrderingEnabled();
  const canPlaceArtifacts = useArtifactPlacementCapability(project.id);
  const manualOrderingPermitted = manualOrderingEnabled && canPlaceArtifacts;
  const currentUser = useCurrentUser();
  const favorites = useFavoriteArtifacts();
  const favorite = useToggleFavoriteArtifact();
  const createInlineIssue = useProjectInlineIssueCreation();
  const { update } = useProjectArtifactGroupUpdates();
  const hierarchyTransaction = useProjectHierarchyTransaction(project.id);
  const placement = useArtifactPlacement(project.id, canPlaceArtifacts);
  const otherProjects = useProjectsByTeam(teamId);
  const { members: teamMembers } = useTeamMembers({
    teamIds: project.teams.map((team) => team.id),
  });
  const customFields = useDocumentsPrototypeCustomFields();
  const [search, setSearch] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  useScrollRestore(
    persistenceKey ? `${persistenceKey}:scroll` : null,
    scrollContainer
  );
  const { childLoadByParentId, expandedTree, expansion, expansionLoader } =
    useProjectHierarchyLoading(project.id, tree, persistenceKey);
  const model = useMemo(
    () => projectArtifactReadModel(expandedTree),
    [expandedTree]
  );
  const metadata = useProjectArtifactListMetadata({
    model,
    visibleArtifactIds: model.orderedArtifactIds,
    includePeople: true,
    includeRelatedSessions: true,
  });
  const eligibleSessionSourceIds = useMemo(
    () =>
      model.orderedArtifactIds.filter(
        (id) => model.artifactsById.get(id)?.type !== ArtifactType.Session
      ),
    [model]
  );
  const sessionMatches = useRelatedSessionsMatches(
    eligibleSessionSourceIds,
    selectedSessionIds,
    selectedSessionIds.length > 0
  );
  const sessionCandidates = useRelatedSessionsSearch(
    eligibleSessionSourceIds,
    sessionSearch,
    sessionSearch.trim().length > 0
  );
  const sessionOptions = useMemo(
    () =>
      projectArtifactSessionOptions(
        metadata.relatedSessions.data?.results ?? {},
        sessionCandidates.data?.items ?? []
      ),
    [metadata.relatedSessions.data, sessionCandidates.data]
  );
  const rows = useMemo(
    () =>
      model.orderedArtifactIds.flatMap((id) => {
        const artifact = model.artifactsById.get(id);
        return artifact
          ? [
              {
                ...projectArtifactListRow(
                  artifact,
                  model.parentByArtifactId.get(id) ?? null,
                  project.name,
                  Date.now()
                ),
                commentCount: metadata.peopleByArtifactId.get(id)?.commentCount,
                collaborators:
                  metadata.peopleByArtifactId
                    .get(id)
                    ?.collaborators.people.map(
                      (person) =>
                        person.displayName ?? person.login ?? person.id
                    ) ?? [],
              },
            ]
          : [];
      }),
    [model, project.name, metadata.peopleByArtifactId]
  );
  const categoryRows = useMemo(
    () =>
      rows.filter((row) =>
        projectArtifactMatchesCategory(model, row.id, category)
      ),
    [rows, model, category]
  );
  const { favoriteIds, isUnavailable: favoritesUnavailable } =
    useFavoriteArtifactIds(favorites);
  const pendingFavoriteIds = usePendingFavoriteArtifactIds();
  const href = (row: GenericArtifact) => {
    const artifact = model.artifactsById.get(row.id);
    const route = artifact && projectArtifactRoute(artifact);
    return projectArtifactHref(artifact?.type, route, orgPath);
  };
  // ISS-13035: this module's one read of `projects-portable-surface`; closed,
  // non-document rows keep the title-only lead and the list the toolbar it had
  // before the shared toolbar (ISS-13007).
  const portableSurface = useFeatureFlagEnabledOptional(
    PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
  );
  const defaultProjectGroupBy = projectDefaultGroupBy(manualOrderingEnabled);
  const controller = useGenericArtifactListController({
    artifacts: categoryRows,
    boardRootOnly: !manualOrderingEnabled,
    routeState: { search: query, replace: replaceSearch },
    textFilter: search,
    controlledArtifacts: true,
    controlledFavoriteIds: favoriteIds,
    controlledFavoritesUnavailable: favoritesUnavailable,
    controlledPendingFavoriteIds: pendingFavoriteIds,
    currentUser: {
      id: currentUser.data?.id ?? "",
      name: currentUser.data ? getUserDisplayName(currentUser.data) : "",
    },
    persistenceKey,
    ...(category === "all" && !(manualOrderingEnabled && boardLayout)
      ? {
          hierarchy: {
            ...PROJECT_HIERARCHY,
            ...(manualOrderingEnabled ? { initiallyExpanded: false } : {}),
            ...expansion,
          },
          manualOrdering: manualOrderingPermitted,
        }
      : { manualOrdering: false }),
    defaultGroupBy: defaultProjectGroupBy,
    defaultVisibleColumnIds: PROJECT_COLUMNS,
    additionalColumns: [
      {
        id: PROJECT_LIST_PARENT_COLUMN_ID,
        label: "Parent",
        kind: ColumnFieldKind.Reference,
        width: columnWidthBounds(220),
        filterable: true,
        sortable: true,
        filterValues: (row) =>
          projectArtifactParents(model, row.id).map((parent) => parent.id),
        valueLabel: (id) =>
          model.artifactsById.get(id)?.name ??
          [...model.parentContextByArtifactId.values()]
            .flat()
            .find((link) => link.parent.id === id)?.parent.name ??
          id,
        sortValue: (row) =>
          projectArtifactParents(model, row.id)
            .map((parent) => parent.name)
            .join(", "),
        renderCell: (row) => (
          <ProjectArtifactParents
            parents={projectArtifactParents(model, row.id)}
          />
        ),
      },
      ...issuesPrototypeColumns().filter((column) => column.id === "priority"),
      ...customFields.columns,
    ],
    relatedSessionsColumn: {
      id: "relatedSessions",
      label: "Related Sessions",
      kind: ColumnFieldKind.Reference,
      width: columnWidthBounds(220),
      filterable: true,
      filterOptions: sessionOptions,
      onFilterSearchChange: setSessionSearch,
      matchesFilter: (row, selected) =>
        selected.length === selectedSessionIds.length &&
        selected.every((id) => selectedSessionIds.includes(id)) &&
        (sessionMatches.data?.matchingArtifactIds.includes(row.id) ?? false),
      filterValues: (row) =>
        metadata.relatedSessions.data?.results[row.id]?.items.map(
          (session) => session.sessionArtifactId
        ) ?? [],
      valueLabel: (id) =>
        Object.values(metadata.relatedSessions.data?.results ?? {})
          .flatMap((result) => result.items)
          .find((session) => session.sessionArtifactId === id)?.name ?? id,
      renderCell: () => <GridEmptyValue title="Unavailable" />,
    },
    hasDateDimension: false,
    showDateRangeControl: false,
    showAddArtifactButton: false,
    showBoardAddButton: false,
    showAddFieldButton: true,
    inlineCreate: {
      enabled: true,
      label: "Add issue",
    },
    creationConfig: {
      kind: GenericArtifactKind.Issue,
      noun: "issue",
      slugPrefix: "ISS",
      description: "",
      defaultProject: project.name,
    },
    onOpenArtifact: (row) =>
      openProjectArtifactTarget(
        href(row),
        model.artifactsById.get(row.id)?.type === ArtifactType.Deployment,
        (target) => navigation.navigate(target)
      ),
    onOpenArtifactHref: href,
    summaryMetricDefinitions: PROJECT_ARTIFACT_METRICS.map((metric) => ({
      ...metric,
      delta: 0,
      deltaPolarity: MetricPolarity.Neutral,
    })),
    buildSummaryMetrics: () => [],
  });
  const controllerSessionIds =
    controller.extensionFilters.relatedSessions?.selectedValues ?? [];
  const selectedSessionKey = JSON.stringify(controllerSessionIds);
  useEffect(() => {
    setSelectedSessionIds(JSON.parse(selectedSessionKey));
  }, [selectedSessionKey]);
  const filterEvidenceUnavailable = projectArtifactFilterEvidenceUnavailable(
    model,
    categoryRows.map((row) => row.id),
    controller,
    metadata.peopleByArtifactId
  );
  const sessionFilter = projectRelatedSessionFilterStatus({
    selectedIds: controllerSessionIds,
    appliedIds: selectedSessionIds,
    isFetching: sessionMatches.isFetching,
    isError: sessionMatches.isError,
  });
  const filterState = projectArtifactFilterState({
    loading,
    failed,
    evidenceUnavailable: filterEvidenceUnavailable,
    sessionFilterPending: sessionFilter.pending,
    sessionFilterFailed: sessionFilter.failed,
  });
  const currentProjectVersion = tree?.projectVersion;
  const manualOrderingAvailable =
    Boolean(currentProjectVersion) &&
    controller.manualOrderingActive &&
    !statusGroupingActive(controller);
  const selectedGroupAuthority = (
    rowId: string,
    field: string,
    secondary?: string
  ) =>
    selectedIds(rowId).every((id) =>
      projectGroupAuthority(model.artifactsById.get(id)?.type, field, secondary)
    );
  const submitMove = (
    input: ProjectArtifactMove & {
      rootUpdates?: ProjectArtifactPlacementRootUpdates;
      surface?: typeof ArtifactStatusEditSurface.Board;
    },
    sourceProjectVersion = currentProjectVersion
  ) => {
    const destinationProjectId = input.targetProjectId ?? project.id;
    return placement.mutateAsync({
      sourceArtifactIds: input.artifactIds,
      destinationProjectId,
      position:
        input.placement === "start" || input.placement === "end"
          ? ProjectArtifactPlacementPosition.Root
          : input.placement,
      ...(input.targetArtifactId
        ? { targetArtifactId: input.targetArtifactId }
        : {}),
      ...(input.rootUpdates ? { rootUpdates: input.rootUpdates } : {}),
      ...(input.surface ? { surface: input.surface } : {}),
      ...(sourceProjectVersion
        ? {
            expectedProjectVersions: {
              [project.id]: sourceProjectVersion,
            },
          }
        : {}),
      source: input.source,
    });
  };
  const submitFlagOffMove = (
    intent: Omit<ProjectHierarchyMoveIntent, "sourceRevision">
  ) => {
    if (!tree?.hierarchyRevision) {
      return Promise.reject(
        new Error("Project hierarchy revision unavailable")
      );
    }
    return hierarchyTransaction.mutateAsync({
      ...intent,
      sourceRevision: tree.hierarchyRevision,
    });
  };
  const selectedIds = (id: string) =>
    selectedArtifactIdsForMove(id, rows, controller.selectedArtifactIds);
  const canPlaceHierarchySubtrees = (
    sourceId: string,
    targetId: string,
    placement: ArtifactHierarchyDropPlacement
  ) =>
    canPlaceProjectArtifactSubtrees(
      rows,
      selectedIds(sourceId),
      targetId,
      placement
    );
  const groupMovable = (id: string) =>
    selectedIds(id).every(
      (selectedId) => !model.parentByArtifactId.has(selectedId)
    );
  const performGroupDrop = (
    id: string,
    field: string,
    value: string,
    secondaryField?: string,
    secondaryValue?: string,
    placementPosition: "start" | "end" = "end",
    surface?: ArtifactStatusEditSurface,
    source: Exclude<
      ProjectArtifactPlacementSource,
      typeof ProjectArtifactPlacementSource.Undo
    > = ProjectArtifactPlacementSource.Pointer
  ) => {
    const row = rows.find((item) => item.id === id);
    if (
      !(
        row &&
        groupMovable(id) &&
        selectedIds(id).every((selectedId) =>
          projectGroupAuthority(
            model.artifactsById.get(selectedId)?.type,
            field,
            secondaryField
          )
        )
      )
    ) {
      return;
    }
    const rootUpdates = projectGroupUpdates(
      row,
      [
        [field, value],
        ...(secondaryField && secondaryValue !== undefined
          ? [[secondaryField, secondaryValue]]
          : []),
      ],
      rows
    );
    if (!rootUpdates) {
      return;
    }
    if (!manualOrderingEnabled) {
      submitFlagOffMove({
        artifactIds: selectedIds(id),
        placement: placementPosition,
        rootUpdates,
        source,
        ...(surface === ArtifactStatusEditSurface.Board ? { surface } : {}),
      }).catch(() => undefined);
      return;
    }
    if (
      !manualOrderingPermitted ||
      (surface !== ArtifactStatusEditSurface.Board && !manualOrderingAvailable)
    ) {
      return;
    }
    submitMove({
      artifactIds: selectedIds(id),
      placement: placementPosition,
      rootUpdates,
      source,
      ...(surface === ArtifactStatusEditSurface.Board ? { surface } : {}),
    }).catch(() => undefined);
  };
  const applyGroupDrop: ArtifactListShellController["applyGroupDrop"] =
    performGroupDrop;
  const rename = (
    id: string,
    title: string,
    options?: { advanceToNewRow?: boolean }
  ) => {
    const advance = () => {
      if (!options?.advanceToNewRow) {
        return;
      }
      const groupKey = controller.groupedArtifacts?.find((group) =>
        group.items.some((row) => row.id === id)
      )?.key;
      controller.setInlineDraftContext({ afterArtifactId: id, groupKey });
    };
    if (model.artifactsById.get(id)?.name === title.trim()) {
      advance();
      return;
    }
    update.mutate({ id, title: title.trim() }, { onSuccess: advance });
  };
  const editHandlers = projectArtifactEditHandlers(teamMembers, update);
  useSyncProjectDefaultGroupBy(controller, defaultProjectGroupBy, query);
  const viewController: ArtifactListShellController = {
    ...controller,
    applyGroupDrop,
    manualOrderingActive: manualOrderingAvailable,
    moveArtifactManually: (id, direction) => {
      if (!manualOrderingAvailable) {
        return;
      }
      const target = artifactManualMoveTarget(
        controller.hierarchyView.rows,
        id,
        direction
      );
      if (
        target &&
        canPlaceHierarchySubtrees(id, target.targetId, target.placement)
      ) {
        submitMove({
          artifactIds: selectedIds(id),
          placement: target.placement,
          targetArtifactId: target.targetId,
          source: ProjectArtifactPlacementSource.Keyboard,
        })
          .then(() => {
            if (
              target.placement === ProjectArtifactPlacementPosition.Inside &&
              !controller.hierarchyView.isExpanded(target.targetId)
            ) {
              controller.hierarchyView.toggleExpanded(target.targetId);
            }
          })
          .catch(() => undefined);
      }
    },
    updateArtifactTitle: rename,
    setArtifactFavorite: (id, next) =>
      favorite.mutate({ artifactId: id, isFavorite: !next }),
    changeArtifactStatus: (id, status) => {
      const row = rows.find((item) => item.id === id);
      const raw =
        row &&
        genericArtifactStatusRaw({ ...row, status, statusRaw: undefined });
      if (raw) {
        update.mutate({
          id,
          status: raw as Parameters<typeof update.mutate>[0]["status"],
          surface: ArtifactStatusEditSurface.Board,
        });
      }
    },
    createInlineArtifact: async (title, groupKey, afterId) => {
      const status =
        controller.groupBy === "status" && groupKey
          ? genericArtifactStatusDefaultForRoot(
              GenericArtifactKind.Issue,
              groupKey
            )
          : null;
      const raw = status
        ? genericArtifactStatusRaw({ kind: GenericArtifactKind.Issue, status })
        : IssueStatus.Todo;
      const groupedDefaults = groupKey
        ? projectGroupUpdates(
            { kind: GenericArtifactKind.Issue },
            [[controller.groupBy, groupKey]],
            rows
          )
        : {};
      await createInlineIssue({
        input: {
          type: DocumentType.Feature,
          projectId: project.id,
          title,
          content: "",
          status: raw as IssueStatus,
          ...(groupedDefaults?.assigneeId
            ? { assigneeId: groupedDefaults.assigneeId }
            : {}),
          ...(groupedDefaults?.priority
            ? { priority: groupedDefaults.priority }
            : {}),
        },
        groupKey,
        afterId: manualOrderingAvailable ? afterId : undefined,
        refresh: onRefresh,
        place: (id, targetArtifactId, revision) =>
          submitMove(
            {
              artifactIds: [id],
              placement: ProjectArtifactPlacementPosition.After,
              targetArtifactId,
              source: ProjectArtifactPlacementSource.Keyboard,
            },
            revision
          ),
        advance: (id) =>
          controller.setInlineDraftContext({ afterArtifactId: id, groupKey }),
      });
    },
  };
  const moveSelected = async (
    targetProjectId: string,
    rowIds?: readonly string[]
  ) => {
    if (manualOrderingEnabled && !manualOrderingPermitted) {
      return;
    }
    await moveProjectSelection(
      rows,
      new Set(rowIds ?? controller.selectedArtifactIds),
      targetProjectId,
      manualOrderingEnabled
        ? (artifactIds, destinationProjectId) =>
            submitMove({
              artifactIds,
              targetProjectId: destinationProjectId,
              placement: ProjectArtifactPlacementPosition.Root,
              source: ProjectArtifactPlacementSource.Api,
            })
        : (artifactIds, destinationProjectId) =>
            submitFlagOffMove({
              artifactIds,
              targetProjectId: destinationProjectId,
              placement: "end",
              source: ProjectArtifactPlacementSource.Api,
            }),
      () => {
        if (!rowIds) {
          controller.setSelectedArtifactIds(new Set());
        }
      }
    );
  };
  const moveProjects = (otherProjects.data ?? []).filter(
    (item) => item.id !== project.id && item.status !== ProjectStatus.Archived
  );
  const titleRenderers = useProjectArtifactTitleRenderers({
    artifactTypeOf: (artifactId) => model.artifactsById.get(artifactId)?.type,
    onCommit: rename,
    onOpenArtifact: controller.onOpenArtifact,
  });
  const host = {
    hierarchyReadState: {
      childLoadByParentId,
      hierarchyByArtifactId: model.hierarchyByArtifactId,
    },
    ...titleRenderers,
    renderBoardStatusMenu: (row: GenericArtifact) => {
      const source = model.artifactsById.get(row.id);
      return (
        <ProjectArtifactBoardStatusMenu
          artifact={source}
          editHandlers={editHandlers}
        />
      );
    },
    onHierarchyDrop: (row, target, placement) => {
      if (
        !(
          manualOrderingAvailable &&
          canPlaceHierarchySubtrees(row.id, target.id, placement)
        )
      ) {
        return;
      }
      submitProjectArtifactHierarchyDrop({
        row,
        target,
        placement,
        controller,
        rows,
        sourceIds: selectedIds(row.id),
        submitMove,
      });
    },
    canHierarchyDrop: (row, target, placement) => {
      return (
        manualOrderingAvailable &&
        hierarchyTargetGroupUpdates(row.id, target.id, controller, rows) !==
          null &&
        canPlaceHierarchySubtrees(row.id, target.id, placement)
      );
    },
    ...(filterState.unavailable
      ? {
          pagination: null,
          resultsState: (
            <div className="p-4" role="status">
              {sessionFilter.pending ? (
                "Loading project"
              ) : (
                <Button
                  onClick={() => {
                    onRetry();
                    sessionMatches.refetch?.();
                  }}
                  variant="outline"
                >
                  Try again
                </Button>
              )}
            </div>
          ),
        }
      : {}),
    resultsNotice: model.truncation ? (
      <ProjectArtifactListTruncationNotice tree={tree} />
    ) : undefined,
    search: { onChange: setSearch, value: search },
    ...(portableSurface
      ? {
          renderSharedToolbar: (shell: ArtifactListShellController) => (
            <ArtifactListSharedToolbar controller={shell} />
          ),
        }
      : {}),
    resultsRef: setScrollContainer,
    summary: (
      <ProjectArtifactSummary
        failed={filterState.summaryFailed}
        loading={filterState.summaryLoading}
        matchingArtifacts={controller.matchingArtifacts}
        model={model}
        project={project}
        visibleMetricKeys={controller.visibleMetricKeys}
      />
    ),
    creation: customFields.renderDialog(
      controller.addFieldOpen,
      controller.setAddFieldOpen,
      (id) => {
        controller.setColumnOrder((order) => [...order, id]);
        controller.setVisibleColumnIds((ids) => new Set([...ids, id]));
      }
    ),
    bulkActions: (
      <ProjectListSelectionActions
        artifactsById={model.artifactsById}
        favoriteIds={favoriteIds}
        favoritesLoaded={favorites.data !== undefined}
        moveEnabled={!manualOrderingEnabled || manualOrderingPermitted}
        onClear={() => controller.setSelectedArtifactIds(new Set())}
        onFavorite={() =>
          favoriteProjectSelection(
            controller.selectedArtifactIds,
            favoriteIds,
            favorite.mutate
          )
        }
        onMove={moveSelected}
        onRetain={(ids) => controller.setSelectedArtifactIds(new Set(ids))}
        project={project}
        projects={moveProjects}
        selectedIds={controller.selectedArtifactIds}
        selectedRows={rows.filter((row) =>
          controller.selectedArtifactIds.has(row.id)
        )}
        users={teamMembers}
      />
    ),
    canGroupDrop: (
      row: GenericArtifact,
      field: string,
      value: string,
      secondary?: string,
      secondaryValue?: string
    ) =>
      Boolean(
        (!manualOrderingEnabled ||
          (controller.layout === "board"
            ? Boolean(currentProjectVersion) && manualOrderingPermitted
            : manualOrderingAvailable)) &&
          groupMovable(row.id) &&
          selectedGroupAuthority(row.id, field, secondary) &&
          projectGroupUpdates(
            row,
            [
              [field, value],
              ...(secondary && secondaryValue !== undefined
                ? [[secondary, secondaryValue]]
                : []),
            ],
            rows
          )
      ),
    renderCell: (columnId: string, row: GenericArtifact) => (
      <ProjectArtifactListCell
        columnId={columnId}
        customFields={customFields}
        editHandlers={editHandlers}
        metadata={metadata}
        model={model}
        row={row}
      />
    ),
    renderLead: (row: GenericArtifact, context) => {
      const source = model.artifactsById.get(row.id);
      const hierarchy = controller.hierarchyRowForArtifact(row);
      const lead =
        source?.type === ArtifactType.Document ? (
          <EditableArtifactLead
            artifact={row}
            narrow={context.isNarrowList}
            onCommit={rename}
            onOpenArtifact={controller.onOpenArtifact}
            openHref={href(row)}
          />
        ) : (
          <ProjectArtifactTitle
            external={source?.type === ArtifactType.Deployment}
            href={href(row)}
            lead={
              portableSurface ||
              (hierarchy && viewController.manualOrderingActive) ? (
                <GenericArtifactLead artifact={row} />
              ) : undefined
            }
            title={row.title}
          />
        );
      const responsiveLead =
        context.isNarrowList && source ? (
          <ProjectArtifactNarrowLead
            artifact={source}
            editHandlers={editHandlers}
          >
            {lead}
          </ProjectArtifactNarrowLead>
        ) : (
          lead
        );
      if (!hierarchy) {
        return responsiveLead;
      }
      return (
        <ArtifactHierarchyLead
          artifact={row}
          depth={hierarchy.depth}
          expanded={controller.hierarchyView.isExpanded(row.id)}
          hasChildren={hierarchy.hasChildren}
          onToggleExpanded={controller.hierarchyView.toggleExpanded}
          reorderControl={
            viewController.manualOrderingActive ? (
              <ArtifactHierarchyControls
                artifact={row}
                onMoveDown={() =>
                  viewController.moveArtifactManually(row.id, "down")
                }
                onMoveGroupByOffset={
                  controller.groupedArtifacts
                    ? (offset) => {
                        const adjacent = adjacentArtifactGroup(
                          controller.groupedArtifacts ?? [],
                          row.id,
                          offset
                        );
                        if (!adjacent) {
                          return;
                        }
                        performGroupDrop(
                          row.id,
                          controller.groupBy,
                          adjacent.destinationKey,
                          controller.secondaryGroupBy,
                          adjacent.subgroupKey,
                          "end",
                          undefined,
                          ProjectArtifactPlacementSource.Keyboard
                        );
                      }
                    : undefined
                }
                onMoveIn={() =>
                  viewController.moveArtifactManually(row.id, "in")
                }
                onMoveOut={() =>
                  viewController.moveArtifactManually(row.id, "out")
                }
                onMoveUp={() =>
                  viewController.moveArtifactManually(row.id, "up")
                }
              />
            ) : null
          }
        >
          {viewController.manualOrderingActive && !context.isNarrowList ? (
            <div className="[&_span.flex>span:first-of-type]:w-20">{lead}</div>
          ) : (
            responsiveLead
          )}
        </ArtifactHierarchyLead>
      );
    },
  } satisfies ArtifactListHostRendering & ProjectArtifactTreeHost;
  return (
    <ProjectArtifactListResult
      board={{
        customFieldColumns: customFields.columns,
        editHandlers,
        project,
        search,
        teamId,
      }}
      controller={viewController}
      expansionLoader={expansionLoader}
      failed={failed}
      hasMoreRootPages={hasMoreRootPages}
      host={host}
      isLoadingMoreRootPages={isLoadingMoreRootPages}
      loading={loading}
      loadMoreRootPages={loadMoreRootPages}
      onRetry={onRetry}
    />
  );
}

"use client";
import { CollaboratorArtifactType } from "@repo/api/src/types/artifact-collaborators";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import type {
  ArtifactStatus,
  DocumentWithProject,
  FindDocumentsOptions,
  UpdateDocumentInput,
} from "@repo/api/src/types/document";
import { DocumentStatusMutationOperation } from "@repo/api/src/types/document-status-mutation";
import { DocumentsIndexEmptyState } from "@repo/app/documents/components/documents-index-empty-state";
import { useDocumentsPrototypeCustomFields } from "@repo/app/documents/components/documents-prototype-custom-fields";
import { DocumentsStaleRefreshNotice } from "@repo/app/documents/components/documents-stale-refresh-notice";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import {
  useFavoriteArtifacts,
  useToggleFavoriteArtifact,
} from "@repo/app/documents/hooks/use-artifact-favorites";
import {
  useDocuments,
  useUpdateDocument,
} from "@repo/app/documents/hooks/use-documents";
import {
  useFavoriteArtifactIds,
  usePendingFavoriteArtifactIds,
} from "@repo/app/documents/hooks/use-favorite-artifact-ids";
import { useRelatedSessionsPage } from "@repo/app/documents/hooks/use-related-sessions";
import { documentArtifactStatusCapability } from "@repo/app/documents/lib/artifact-status-capability";
import { matchesFilter } from "@repo/app/documents/lib/document-filter";
import { getDocumentRoute } from "@repo/app/documents/lib/document-navigation";
import {
  DocumentsIndexState,
  resolveDocumentsIndexState,
} from "@repo/app/documents/lib/documents-index-state";
import { ARTIFACT_NOUN } from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import { genericArtifactStatusRoot } from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import { buildBaseColumnFilterGroups } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-column-filters";
import { EditableArtifactLead } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-cells";
import { buildCustomFieldFilterGroups } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-custom-field-model";
import { ARTIFACT_GROUP_NO_VALUE } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-grouping";
import {
  type ArtifactFilters,
  buildExtensionFilterGroups,
  buildFilterViewModel,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import { ArtifactListSharedToolbar } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shared-toolbar";
import type {
  ArtifactListHostRendering,
  ArtifactListShellController,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import { useGenericArtifactListController } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-controller";
import { useArtifactListShellDerived } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-derived";
import { GenericArtifactListView } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-shells";
import { useArtifactListGridSelection } from "@repo/app/shared/components/generic-artifact-surface/preview/components/use-artifact-list-grid-selection";
import {
  ArtifactKind,
  type GenericArtifact,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { FeatureFlagged } from "@repo/app/shared/feature-flags/feature-flagged";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useArtifactCollaborators } from "@repo/app/shared/hooks/use-artifact-collaborators";
import { useSortParams } from "@repo/app/shared/hooks/use-sort-params";
import { documentStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { formatRelativeTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import {
  ARTIFACT_LIST_SUMMARY_FEATURE_FLAG_KEY,
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { withBoardCommentCounts } from "./artifact-list-board-groups";
import {
  ArtifactListCell,
  ArtifactListStatusMenu,
} from "./artifact-list-cells";
import {
  artifactMetricDefinitions,
  DOCUMENTS_PROTOTYPE_COLUMNS,
  DOCUMENTS_UNAVAILABLE_COLUMN_CAPABILITIES,
  documentsPrototypeColumns,
  documentToPrototypeListRow,
  ISSUES_PROTOTYPE_COLUMNS,
  issuesPrototypeColumns,
  productionSortColumn,
  prototypeSortColumn,
} from "./artifact-list-model";
import { ArtifactSummary } from "./artifact-summary";
import { artifactRecencyDays } from "./artifact-summary-scope";

export type ArtifactListProps = {
  documents: DocumentWithProject[];
  artifactKind?: typeof ArtifactKind.Document | typeof ArtifactKind.Issue;
  artifactHref?: (document: DocumentWithProject) => string | undefined;
  onOpenDocument?: (document: DocumentWithProject) => void;
  creation?: ReactNode;
  filterText: string;
  onFilterTextChange: (value: string) => void;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
  searchAppliedUpstream: boolean;
  editHandlers: RowEditHandlers;
  setScrollContainer: (element: HTMLElement | null) => void;
  pagination?: ReactNode;
  searchParams: FindDocumentsOptions;
  isServerPaged: boolean;
  onRecencyDaysChange?: (days: number | undefined) => void;
  /** The order the list renders and whether it has switched to its complete read. */
  onListReadChange?: (read: ArtifactListReadState) => void;
  sortPersistenceKey: string | null;
  storageKey: string | null;
  isSummaryUnsettled?: boolean;
  onRequestCreate?: (status?: GenericArtifact["status"]) => void;
  renderBulkActions?: (
    documents: DocumentWithProject[],
    onClear: () => void,
    onRetain: (ids: readonly string[]) => void
  ) => ReactNode;
};

/** The approved shared renderer with API-owned rows, writes, and read states. */
export function ArtifactList(props: ArtifactListProps) {
  return <ArtifactListBody key={props.storageKey} {...props} />;
}

function ArtifactListBody(props: ArtifactListProps) {
  const { artifactKind: kind = ArtifactKind.Document } = props;
  const isIssue = kind === ArtifactKind.Issue;
  const userRead = useCurrentUser();
  const { data: user } = userRead;
  const currentUser = {
    id: user?.id ?? "",
    name: user ? getUserDisplayName(user) : "",
  };
  const favoritesRead = useFavoriteArtifacts();
  const { favoriteIds, isUnavailable: favoritesUnavailable } =
    useFavoriteArtifactIds(favoritesRead);
  const pendingFavoriteIds = usePendingFavoriteArtifactIds();
  const rows = useMemo(
    () =>
      props.documents.map((document) =>
        documentToPrototypeListRow(document, Date.now())
      ),
    [props.documents]
  );
  const customFields = useDocumentsPrototypeCustomFields();
  const controller = useGenericArtifactListController({
    artifacts: rows,
    controlledArtifacts: true,
    inlineCreate: isIssue
      ? {
          enabled: true,
          label: "Add New Issue",
          onActivate: () => props.onRequestCreate?.(),
        }
      : undefined,
    defaultDateRange: isIssue ? "all" : undefined,
    persistenceKey: props.storageKey ? `${props.storageKey}:prototype` : null,
    controlledFavoriteIds: favoriteIds,
    controlledFavoritesUnavailable: favoritesUnavailable,
    controlledPendingFavoriteIds: pendingFavoriteIds,
    currentUser,
    columnCapabilities: DOCUMENTS_UNAVAILABLE_COLUMN_CAPABILITIES,
    additionalColumns: [
      ...(isIssue ? issuesPrototypeColumns() : documentsPrototypeColumns()),
      ...customFields.columns,
    ],
    defaultVisibleColumnIds: isIssue
      ? ISSUES_PROTOTYPE_COLUMNS
      : DOCUMENTS_PROTOTYPE_COLUMNS,
    excludedColumnIds: [],
    creationConfig: {
      kind,
      noun: isIssue ? "issue" : "document",
      slugPrefix: isIssue ? "ISS" : "DOC",
      description: "",
    },
    onOpenArtifact: () => undefined,
    relatedSessionsForArtifact: () => EMPTY_SESSION_TRACE,
    selectionNoun: isIssue
      ? { plural: "issues", singular: "issue" }
      : { plural: "documents", singular: "document" },
    showAddArtifactButton: false,
    showBoardAddButton: Boolean(props.onRequestCreate),
    showAddFieldButton: true,
    summaryMetricDefinitions: artifactMetricDefinitions(kind).map((metric) => ({
      ...metric,
      delta: 0,
      deltaPolarity: MetricPolarity.Neutral,
    })),
    buildSummaryMetrics: () => [],
  });
  return (
    <ArtifactListPopulation
      controller={controller}
      currentUser={currentUser}
      customFields={customFields}
      favoriteIds={favoriteIds}
      favoritesRead={favoritesRead}
      props={props}
      userRead={userRead}
    />
  );
}

function ArtifactListPopulation({
  controller,
  customFields,
  currentUser,
  favoriteIds,
  favoritesRead,
  props,
  userRead,
}: {
  controller: ArtifactListShellController;
  customFields: ReturnType<typeof useDocumentsPrototypeCustomFields>;
  currentUser: { id: string; name: string };
  favoriteIds: ReadonlySet<string>;
  favoritesRead: ReturnType<typeof useFavoriteArtifacts>;
  props: ArtifactListProps;
  userRead: ReturnType<typeof useCurrentUser>;
}) {
  const { artifactKind: kind = ArtifactKind.Document } = props;
  const noun = kind === ArtifactKind.Issue ? "issues" : "documents";
  const sort = useSortParams<string>({
    validColumns: [
      ...PRODUCTION_SORT_COLUMNS,
      ...controller.configuredColumns.map((column) => column.id),
    ],
    defaultColumn: null,
    defaultDirection: "asc",
    persistenceKey: props.sortPersistenceKey,
  });
  const effectiveSort = prototypeSortColumn(sort.sortBy ?? controller.sortBy);
  const sortActive = sort.sortBy !== null || controller.sortActive;
  const sortDir = sort.sortBy === null ? controller.sortDir : sort.sortDir;
  const recencyDays = artifactRecencyDays(controller);
  useEffect(() => {
    props.onRecencyDaysChange?.(recencyDays);
  }, [props.onRecencyDaysChange, recencyDays]);
  const completeRequired = documentsPrototypeNeedsCompleteRead(
    props.isServerPaged,
    controller,
    sortActive
  );
  useReportListRead(props.onListReadChange, {
    completeRead: completeRequired,
    sortActive,
    sortBy: effectiveSort,
    sortDir,
  });
  const completeRead = useDocuments(props.searchParams, {
    enabled: props.isServerPaged && completeRequired,
  });
  const source =
    completeRequired && props.isServerPaged
      ? (completeRead.data ?? [])
      : props.documents;
  const matchingSource = useMemo(
    () =>
      source.filter((document) => matchesFilter(document, props.filterText)),
    [source, props.filterText]
  );
  const documentMap = useMemo(
    () => new Map(source.map((document) => [document.id, document])),
    [source]
  );
  const artifacts = useMemo(
    () =>
      matchingSource.map((document) =>
        documentToPrototypeListRow(document, Date.now())
      ),
    [matchingSource]
  );
  const derived = useArtifactListShellDerived({
    artifacts,
    currentUserId: currentUser.id,
    currentUserName: currentUser.name,
    buildConfiguredSummaryMetrics: () => [],
    creationKind: kind,
    customFieldFilters: controller.customFieldFilters,
    customFields: controller.customFields,
    dateDimension: controller.dateDimension,
    extensionColumns: controller.extensionColumns,
    extensionFilters: controller.extensionFilters,
    favoriteArtifactIds: favoriteIds,
    filters: controller.filters,
    groupBy: controller.groupBy,
    groupOrder: controller.groupOrder,
    hierarchy: undefined,
    layout: controller.layout,
    page: controller.page,
    pageSize: controller.pageSize,
    secondaryGroupBy: controller.secondaryGroupBy,
    secondaryGroupOrder: controller.secondaryGroupOrder,
    setFilters: controller.setFilters,
    showEmptyGroups: controller.showEmptyGroups,
    showEmptySubgroups: controller.showEmptySubgroups,
    sortActive,
    sortBy: effectiveSort,
    sortDir,
  });
  const displayedArtifacts = completeRequired
    ? derived.displayedArtifacts
    : artifacts;
  const isCompleteRead = props.isServerPaged && completeRequired;
  const documentRead = isCompleteRead
    ? {
        isLoading: completeRead.isLoading || props.isLoading,
        isFetching: completeRead.isFetching || props.isFetching,
        isError: completeRead.isError,
        refetch: completeRead.refetch,
      }
    : props;
  const read = documentPrototypeReadWithDependencies(
    documentRead,
    controller.filters,
    userRead,
    favoritesRead,
    source.length
  );
  const state = resolveDocumentsIndexState({
    isLoading: read.isLoading,
    isFetching: read.isFetching,
    isError: read.isError,
    rowCount: read.rowCount,
    matchCount: derived.sortedArtifacts.length,
    hasSearch:
      props.filterText.trim() !== "" ||
      controller.filtersActive ||
      (controller.dateDimension.present &&
        controller.dateDimension.range !== "all"),
    searchAppliedUpstream: props.searchAppliedUpstream,
  });
  const stateContent = documentPrototypeStateContent(state, read.refetch, noun);
  const selection = useArtifactListGridSelection({
    displayedArtifacts,
    selectedArtifactIds: controller.selectedArtifactIds,
    selectionAnchorId: controller.selectionAnchorId,
    setSelectedArtifactIds: controller.setSelectedArtifactIds,
  });
  const collaborators = useArtifactCollaborators({
    artifactType: CollaboratorArtifactType.Document,
    artifactIds: displayedArtifacts.map((artifact) => artifact.id),
    enabled: artifactInteractionReadEnabled(
      controller.layout,
      controller.visibleColumnIds,
      read
    ),
  });
  const related = useRelatedSessionsPage(
    displayedArtifacts.map((artifact) => artifact.id),
    controller.visibleColumnIds.has("relatedSessions")
  );
  const actions = useArtifactListActions(documentMap, props);
  const sortTransaction = useRef({
    column: effectiveSort,
    direction: sortDir,
    active: sortActive,
  });
  sortTransaction.current = {
    column: effectiveSort,
    direction: sortDir,
    active: sortActive,
  };
  const filterViewModel = {
    ...buildFilterViewModel(artifacts, currentUser),
    // The built-in Type facet lists artifact kinds; a document's type is its
    // subtype, which the "document-type" extension facet carries.
    hidePriority: true,
    showTags: true,
    additionalFacetGroups: buildCustomFieldFilterGroups(
      controller.customFields,
      artifacts,
      controller.customFieldFilters,
      controller.setCustomFieldFilters
    ).concat(
      buildExtensionFilterGroups(
        controller.extensionColumns,
        artifacts,
        controller.extensionFilters,
        controller.setExtensionFilters
      )
    ),
  };
  const viewController: ArtifactListShellController = {
    ...controller,
    ...derived,
    ...selection,
    artifacts,
    displayedArtifacts,
    groupedArtifacts: withBoardCommentCounts(
      derived.groupedArtifacts,
      collaborators.data
    ),
    sortActive,
    sortBy: effectiveSort,
    sortDir,
    filterViewModel,
    columnFilterGroups: buildBaseColumnFilterGroups(
      controller.filterController,
      filterViewModel
    ).concat(filterViewModel.additionalFacetGroups),
    onOpenArtifact: actions.open,
    onOpenArtifactHref: actions.href,
    updateArtifactTitle: actions.rename,
    updateArtifact: actions.update,
    changeArtifactStatus: actions.changeStatus,
    applyGroupDrop: actions.groupDrop,
    setAddArtifactOpen: (open) => {
      if (open) {
        props.onRequestCreate?.();
      }
    },
    setArtifactFavorite: actions.favorite,
    applySavedView: (id) => applyProductionSavedView(controller, sort, id),
    setSortBy: (update) => {
      const next =
        typeof update === "function"
          ? update(sortTransaction.current.column)
          : update;
      sortTransaction.current.column = next;
      controller.setSortBy(next);
      if (sortTransaction.current.active) {
        sort.setSort(
          productionSortColumn(next),
          sortTransaction.current.direction
        );
      }
    },
    setSortDir: (update) => {
      const next =
        typeof update === "function"
          ? update(sortTransaction.current.direction)
          : update;
      sortTransaction.current.direction = next;
      controller.setSortDir(next);
      if (sortTransaction.current.active) {
        sort.setSort(
          productionSortColumn(sortTransaction.current.column),
          next
        );
      }
    },
    setSortActive: (update) => {
      const next = typeof update === "function" ? update(sortActive) : update;
      sortTransaction.current.active = next;
      if (!next) {
        sort.clearSort();
      }
      controller.setSortActive(next);
    },
  };
  // ISS-13035: the one `gridview-adoption` read for the Documents and Issues
  // toolbar; closed, the shell draws the toolbar it always drew.
  const sharedToolbar = useFeatureFlagEnabledOptional(
    GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
  const host: ArtifactListHostRendering = {
    onRequestBoardCreate: (status) => props.onRequestCreate?.(status),
    search: {
      onChange: props.onFilterTextChange,
      value: props.filterText,
    },
    ...sharedToolbarHost(sharedToolbar),
    summary: (
      <FeatureFlagged flag={ARTIFACT_LIST_SUMMARY_FEATURE_FLAG_KEY}>
        <ArtifactSummary
          artifactKind={props.artifactKind}
          complete={completeRequired}
          controller={controller}
          currentUserId={currentUser.id}
          customFields={customFields.fields}
          documents={selectedDocuments(
            new Set(derived.sortedArtifacts.map((artifact) => artifact.id)),
            documentMap
          )}
          filterText={props.filterText}
          isUnsettled={Boolean(props.isSummaryUnsettled)}
          readError={read.isError}
          readLoading={read.isLoading}
          searchParams={props.searchParams}
        />
      </FeatureFlagged>
    ),
    resultsRef: props.setScrollContainer,
    resultsNotice:
      state === DocumentsIndexState.StaleAfterFailedRefresh ? (
        <DocumentsStaleRefreshNotice noun={noun} onRetry={read.refetch} />
      ) : null,
    canGroupDrop: actions.canGroupDrop,
    renderBoardTitle: (artifact, href) =>
      documentPrototypeBoardTitle(
        artifact,
        href,
        Boolean(props.onOpenDocument)
      ),
    renderBoardStatusMenu: (artifact) => {
      const document = documentMap.get(artifact.id);
      return document ? (
        <ArtifactListStatusMenu
          document={document}
          editHandlers={props.editHandlers}
          surface={ArtifactStatusEditSurface.Board}
        />
      ) : null;
    },
    creation: (
      <>
        {props.creation}
        {customFields.renderDialog(
          controller.addFieldOpen,
          controller.setAddFieldOpen,
          (id) => {
            controller.setColumnOrder((current) => [
              ...current.filter((column) => column !== id),
              id,
            ]);
            controller.setVisibleColumnIds(
              (current) => new Set([...current, id])
            );
          }
        )}
      </>
    ),
    // Every `renderBulkActions` rail is an `ArtifactBulkActionBar` on its
    // default noun.
    bulkActionsNoun: ARTIFACT_NOUN,
    bulkActions:
      props.renderBulkActions?.(
        selectedDocuments(controller.selectedArtifactIds, documentMap),
        () => controller.setSelectedArtifactIds(new Set()),
        (ids) => controller.setSelectedArtifactIds(new Set(ids))
      ) ?? null,
    renderCell: (columnId, artifact) => {
      const document = documentMap.get(artifact.id);
      if (!document) {
        return <GridEmptyValue title="Unavailable" />;
      }
      const customCell = customFields.renderCell(document, columnId);
      if (customCell !== undefined) {
        return customCell;
      }
      if (columnId === "updated") {
        return (
          <span className="text-muted-foreground text-xs">
            {formatRelativeTimeOrFallback(document.updatedAt)}
          </span>
        );
      }
      return (
        <ArtifactListCell
          collaborators={collaborators.data?.get(document.id)?.collaborators}
          collaboratorsLoading={collaborators.isLoading}
          columnId={columnId}
          commentCount={collaborators.data?.get(document.id)?.commentCount}
          document={document}
          editHandlers={props.editHandlers}
          relatedLoading={related.isLoading}
          relatedSessions={related.data?.results[document.id]}
        />
      );
    },
    renderLead: (artifact, context) => {
      const lead = (
        <EditableArtifactLead
          artifact={artifact}
          linkComponent={props.onOpenDocument ? "a" : Link}
          narrow={context.isNarrowList}
          onCommit={actions.rename}
          onOpenArtifact={actions.open}
          openHref={actions.href(artifact)}
          openTarget={props.onOpenDocument ? "_blank" : undefined}
        />
      );
      const document = documentMap.get(artifact.id);
      if (!(context.isNarrowList && document)) {
        return lead;
      }
      return (
        <div className="flex min-w-0 items-center gap-2">
          <ArtifactListCell
            columnId="status"
            document={document}
            editHandlers={props.editHandlers}
            statusTriggerVariant={ArtifactStatusVariant.Icon}
          />
          <div className="min-w-0 flex-1">{lead}</div>
        </div>
      );
    },
  };
  if (!completeRequired) {
    host.pagination = props.pagination ?? null;
  }
  if (stateContent !== undefined) {
    host.resultsState = stateContent;
    host.pagination = null;
  }
  return <GenericArtifactListView controller={viewController} host={host} />;
}

function useArtifactListActions(
  documents: ReadonlyMap<string, DocumentWithProject>,
  props: ArtifactListProps
) {
  const navigation = useNavigation();
  const orgPath = useOrgPath();
  const update = useUpdateDocument();
  const toggleFavorite = useToggleFavoriteArtifact();
  const href = (artifact: GenericArtifact) => {
    const document = documents.get(artifact.id);
    if (document && props.artifactHref) {
      return props.artifactHref(document);
    }
    const route = document && getDocumentRoute(document);
    return route ? orgPath(route) : undefined;
  };
  const rename = (id: string, title: string) =>
    update.mutate({
      id,
      title,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
  const changeStatus = (
    id: string,
    status: GenericArtifact["status"],
    surface: ArtifactStatusEditSurface = ArtifactStatusEditSurface.InlineCell
  ) => {
    const document = documents.get(id);
    if (!document) {
      return;
    }
    const root = genericArtifactStatusRoot({
      kind: props.artifactKind ?? ArtifactKind.Document,
      status,
    });
    const capability = documentArtifactStatusCapability({
      documentType: document.type,
      operation: DocumentStatusMutationOperation.Single,
      rawStatus: document.status,
      statusMutation: document.statusMutation,
    });
    if (capability.editable) {
      const raw = capability.allowedTargets.find(
        (target) =>
          documentStatusFacet(document.type, target).normalized.root === root
      );
      if (raw) {
        props.editHandlers.onUpdateStatus?.(id, raw as ArtifactStatus, surface);
      }
    }
  };
  const mutateGroupPatch = (
    id: string,
    patch: Omit<UpdateDocumentInput, "id">
  ) => {
    if (Object.keys(patch).length > 0) {
      update.mutate({ id, ...patch });
    }
  };
  const groupPatch = (id: string, field: string, value: string) =>
    artifactListGroupPatch(documents.get(id), field, value, props.editHandlers);
  const canGroupDrop: NonNullable<ArtifactListHostRendering["canGroupDrop"]> = (
    artifact,
    field,
    value,
    secondaryField,
    secondaryValue
  ) =>
    groupPatch(artifact.id, field, value) !== null &&
    (!secondaryField ||
      secondaryValue === undefined ||
      groupPatch(artifact.id, secondaryField, secondaryValue) !== null);
  const groupDrop: ArtifactListShellController["applyGroupDrop"] = (
    id,
    field,
    value,
    secondaryField,
    secondaryValue,
    _placement,
    surface = ArtifactStatusEditSurface.InlineCell
  ) => {
    const primary = groupPatch(id, field, value);
    if (!primary) {
      return;
    }
    if (secondaryField && secondaryValue !== undefined) {
      const secondary = groupPatch(id, secondaryField, secondaryValue);
      if (!secondary) {
        return;
      }
      const patch = { ...primary, ...secondary };
      if (Object.keys(patch).length === 0) {
        return;
      }
      mutateGroupPatch(id, { ...patch, surface });
      return;
    }
    if (Object.keys(primary).length === 0) {
      return;
    }
    mutateGroupPatch(id, { ...primary, surface });
  };
  return {
    href,
    rename,
    changeStatus,
    groupDrop,
    canGroupDrop,
    open: (artifact: GenericArtifact) => {
      const route = href(artifact);
      const document = documents.get(artifact.id);
      if (document && props.onOpenDocument) {
        props.onOpenDocument(document);
        return;
      }
      if (route) {
        navigation.navigate(route);
      }
    },
    favorite: (id: string, favorite: boolean) =>
      toggleFavorite.mutate({ artifactId: id, isFavorite: !favorite }),
    update: (id: string, patch: Partial<GenericArtifact>) => {
      if (patch.title !== undefined) {
        rename(id, patch.title);
      }
      if (patch.status !== undefined) {
        changeStatus(id, patch.status);
      }
    },
  };
}

function documentPrototypeStateContent(
  state: DocumentsIndexState,
  retry: () => void,
  noun: "documents" | "issues" = "documents"
): ReactNode | undefined {
  if (state === DocumentsIndexState.Loading) {
    return (
      <div aria-busy="true" className="space-y-3 p-4">
        <span className="sr-only">Loading {noun}…</span>
        <Skeleton className="h-11" />
        <Skeleton className="h-11" />
        <Skeleton className="h-11" />
      </div>
    );
  }
  if (
    state === DocumentsIndexState.BlockingError ||
    state === DocumentsIndexState.FirstUseEmpty ||
    state === DocumentsIndexState.NoResults ||
    state === DocumentsIndexState.StaleNoResults
  ) {
    return (
      <DocumentsIndexEmptyState noun={noun} onRetry={retry} state={state} />
    );
  }
  return undefined;
}

function selectedDocuments(
  ids: ReadonlySet<string>,
  documents: ReadonlyMap<string, DocumentWithProject>
): DocumentWithProject[] {
  return [...ids].flatMap((id) => {
    const document = documents.get(id);
    return document ? [document] : [];
  });
}

const PRODUCTION_SORT_COLUMNS = [
  "title",
  "assignee",
  "type",
  "updated",
  "status",
  "slug",
  "currentVersion",
  "tags",
  "stackRank",
] as const;
const EMPTY_SESSION_TRACE = {
  endAt: "",
  startDate: "",
  startAt: "",
  wallClock: "",
  sessions: [],
} as const;

function documentsPrototypeNeedsCompleteRead(
  isServerPaged: boolean,
  controller: ArtifactListShellController,
  sortActive: boolean
): boolean {
  return (
    !isServerPaged ||
    controller.groupBy !== "none" ||
    controller.filtersActive ||
    controller.filterMenuOpen ||
    sortActive
  );
}

export function artifactListGroupPatch(
  document: DocumentWithProject | undefined,
  field: string,
  value: string,
  editHandlers: RowEditHandlers
): Omit<UpdateDocumentInput, "id"> | null {
  if (!document) {
    return null;
  }
  if (field === "priority" && editHandlers.onUpdatePriority) {
    if (value === ARTIFACT_GROUP_NO_VALUE) {
      return { priority: null };
    }
    const priority = Object.values(Priority).find(
      (candidate) => candidate === value
    );
    return priority ? { priority } : null;
  }
  if (field === "owner" && editHandlers.onUpdateAssignee) {
    if (value === ARTIFACT_GROUP_NO_VALUE) {
      return { assigneeId: null };
    }
    return editHandlers.teamMembers?.some((person) => person.id === value)
      ? { assigneeId: value }
      : null;
  }
  if (field === "status" && editHandlers.onUpdateStatus) {
    return artifactListStatusGroupPatch(document, value);
  }
  return null;
}

function applyProductionSavedView(
  controller: ArtifactListShellController,
  sort: ReturnType<typeof useSortParams>,
  id: string
) {
  controller.applySavedView(id);
  const view = controller.savedViews.find((candidate) => candidate.id === id);
  if (!view) {
    return;
  }
  if (view.state.sortActive) {
    sort.setSort(productionSortColumn(view.state.sortBy), view.state.sortDir);
  } else {
    sort.clearSort();
  }
}

function documentPrototypeReadWithDependencies(
  documentRead: Pick<
    ArtifactListProps,
    "isLoading" | "isFetching" | "isError" | "refetch"
  >,
  filters: ArtifactFilters,
  userRead: ReturnType<typeof useCurrentUser>,
  favoritesRead: ReturnType<typeof useFavoriteArtifacts>,
  rowCount: number
) {
  const dependencies: (typeof userRead | typeof favoritesRead)[] = [];
  if (filters.favoritesOnly) {
    dependencies.push(favoritesRead);
  }
  if (filters.mineOnly) {
    dependencies.push(userRead);
  }
  return {
    isLoading:
      documentRead.isLoading || dependencies.some((query) => query.isPending),
    isFetching:
      documentRead.isFetching || dependencies.some((query) => query.isFetching),
    isError:
      documentRead.isError || dependencies.some((query) => query.isError),
    rowCount: dependencies.some(
      (query) => query.isError && query.data === undefined
    )
      ? 0
      : rowCount,
    refetch: () => {
      documentRead.refetch();
      for (const query of dependencies) {
        query.refetch();
      }
    },
  };
}

function documentPrototypeBoardTitle(
  artifact: GenericArtifact,
  href: string,
  external: boolean
) {
  const className =
    "mt-0.5 block font-medium text-sm leading-5 hover:underline";
  if (external) {
    return (
      <a
        className={className}
        href={href}
        onClick={(event) => event.stopPropagation()}
        rel="noopener noreferrer"
        target="_blank"
      >
        {artifact.title}
      </a>
    );
  }
  return (
    <Link
      className={className}
      href={href}
      onClick={(event) => event.stopPropagation()}
    >
      {artifact.title}
    </Link>
  );
}

function artifactInteractionReadEnabled(
  layout: ArtifactListShellController["layout"],
  visibleColumnIds: ReadonlySet<string>,
  read: { isLoading: boolean; isError: boolean }
) {
  return (
    (layout === "board" ||
      visibleColumnIds.has("collaborators") ||
      visibleColumnIds.has("comments")) &&
    !read.isLoading &&
    !read.isError
  );
}

function artifactListStatusGroupPatch(
  document: DocumentWithProject,
  root: string
): Omit<UpdateDocumentInput, "id"> | null {
  if (
    documentStatusFacet(document.type, document.status).normalized.root === root
  ) {
    return {};
  }
  const capability = documentArtifactStatusCapability({
    documentType: document.type,
    operation: DocumentStatusMutationOperation.Single,
    rawStatus: document.status,
    statusMutation: document.statusMutation,
  });
  if (!capability.editable) {
    return null;
  }
  const raw = capability.allowedTargets.find(
    (target) =>
      documentStatusFacet(document.type, target).normalized.root === root
  );
  return raw ? { status: raw as ArtifactStatus } : null;
}

function useReportListRead(
  onListReadChange: ArtifactListProps["onListReadChange"],
  read: Omit<ArtifactListReadState, "sortBy"> & {
    sortActive: boolean;
    sortBy: string;
  }
) {
  const { completeRead, sortDir } = read;
  const sortBy = read.sortActive ? read.sortBy : null;
  useEffect(() => {
    onListReadChange?.({ completeRead, sortBy, sortDir });
  }, [onListReadChange, completeRead, sortBy, sortDir]);
}

export type ArtifactListReadState = {
  completeRead: boolean;
  sortBy: string | null;
  sortDir: string;
};

function sharedToolbarHost(
  enabled: boolean
): Pick<ArtifactListHostRendering, "renderSharedToolbar"> {
  return enabled
    ? {
        renderSharedToolbar: (shell) => (
          <ArtifactListSharedToolbar controller={shell} />
        ),
      }
    : {};
}

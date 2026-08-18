"use client";

import type { Priority } from "@repo/api/src/types/common";
import {
  DOCUMENT_LIST_MAX_LIMIT,
  type DocumentWithProject,
} from "@repo/api/src/types/document";
import { DocumentTableToolbar } from "@repo/app/documents/components/table/document-table-toolbar";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { useFavoriteArtifacts } from "@repo/app/documents/hooks/use-artifact-favorites";
import { useDeleteRowItem } from "@repo/app/documents/hooks/use-delete-row-item";
import {
  documentsPageQueryKey,
  useDocumentsPage,
  useUpdateDocument,
} from "@repo/app/documents/hooks/use-documents";
import { useGroupBy } from "@repo/app/documents/hooks/use-group-by";
import { useProjectFilters } from "@repo/app/documents/hooks/use-project-filters";
import { MyTasksCardView } from "@repo/app/my-tasks/components/my-tasks-card-view";
import { MyTasksLoadFailedState } from "@repo/app/my-tasks/components/my-tasks-load-failed-state";
import { MyTasksPaginationFooter } from "@repo/app/my-tasks/components/my-tasks-pagination-footer";
import {
  MyTasksPagedUnit,
  type MyTasksTruncation,
  mergeMyTasksTruncations,
  resolveMyTasksRangeReadout,
  resolveMyTasksTreeTruncation,
  resolveMyTasksTruncation,
} from "@repo/app/my-tasks/lib/my-tasks-range-readout";
import { MY_TASKS_RECENCY_CHIP_LABEL } from "@repo/app/my-tasks/lib/my-tasks-recency-window";
import { useProjects } from "@repo/app/projects/hooks/use-projects";
import { useFeatureFlagGate } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  DocumentColumn,
  MY_TASKS_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { useFilterCurrentUser } from "@repo/app/shared/hooks/use-filter-current-user";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { useScrollRestore } from "@repo/app/shared/hooks/use-scroll-restore";
import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import { MY_TASKS_RECENCY_WINDOW_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useOrgUsersAsPopoverUsers } from "@repo/app/users/hooks/use-org-users-as-popover-users";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { FilterChip } from "@repo/design-system/components/ui/filter-chip";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback, useMemo, useState } from "react";
import { DocumentsView } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/documents-view";
import { Header } from "@/app/(authenticated)/components/header";
import { AgentOnboardingCard } from "../../components/agent-onboarding-card";
import { InviteSpotlightHost } from "../../components/invite-spotlight-host";
import { OnboardingChecklist } from "../../components/onboarding-checklist";
import { MyTasksEmptyState } from "./components/my-tasks-empty-state";
import { MyTasksKanban } from "./components/my-tasks-kanban";
import {
  keepSamePageSizePlaceholder,
  useMyTasksCardPage,
  useMyTasksCardPageBounds,
} from "./hooks/use-my-tasks-card-page";
import {
  MY_TASKS_PAGE_SIZE,
  useMyTasksPagination,
} from "./hooks/use-my-tasks-pagination";
import { useMyTasksTreeSource } from "./hooks/use-my-tasks-tree-source";
import { resolveMyTasksListState } from "./lib/my-tasks-list-state";
import { buildArtifactListParams, selectKanbanArtifacts } from "./utils";

const VIEW_KEY = "my-tasks-view";
const COLUMN_VISIBILITY_KEY = "table:columns:my-tasks";
const COLUMN_ORDER_KEY = "table:column-order:my-tasks";
const STORAGE_KEY = "my-tasks-artifacts";

const COLUMN_DEFAULTS = {
  [DocumentColumn.Type]: true,
};

/**
 * Stable empty page so a not-yet-loaded read does not hand every downstream
 * memo a fresh array identity on each render.
 */
const NO_ARTIFACTS: DocumentWithProject[] = [];

/** Nothing was left out of the fetched window — no floor marker, no note. */
const NO_TRUNCATION: MyTasksTruncation = {
  isTotalPartial: false,
  note: null,
};

/**
 * The card board's search copy (ISS-4682 item 2). ONE sentence, used verbatim as
 * the accessible name and, with an ellipsis, as the visible placeholder — a
 * control that describes itself two ways describes itself wrongly to somebody.
 */
const CARD_SEARCH_LABEL = "Filter tasks on this page";

// This page composes many extracted siblings/helpers: the card view
// (MyTasksCardView), the kanban selection (selectKanbanArtifacts), the
// list-state resolution (resolveMyTasksListState), and — ISS-4466 — the unified
// data-layer pagination (useMyTasksPagination). The residual is the FEA-3938
// view/loading/error/empty branch matrix over many independent async signals.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: residual is the FEA-3938 view/loading/error/empty branch matrix over independent async signals.
export default function MyTasksPage() {
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  const {
    data: currentUser,
    isLoading: isUserLoading,
    isError: isUserError,
    refetch: refetchCurrentUser,
  } = useCurrentUser();
  const [view, setView] = useLocalStorageState<"list" | "card">(
    VIEW_KEY,
    "list"
  );
  const [filterText, setFilterText, clearSearch] =
    useViewStatePersistence<string>("table:search:my-tasks", "");
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  const { clearPosition: clearScroll } = useScrollRestore(
    "table:scroll:my-tasks",
    scrollContainer
  );
  const [, , clearSort] = useViewStatePersistence<null>(
    "table:sort:my-tasks",
    null
  );
  const [filterCategory, setFilterCategory] = useState<FilterCategory>("all");
  const { data: projects = [], isLoading: isProjectsLoading } = useProjects();
  const assigneeId = currentUser?.id ?? null;
  const isListView = view === "list";
  // FEA-1626 (ISS-4779 closed-by-default): whether the board asks the endpoint
  // for a bounded recency + lifecycle window instead of its full assigned
  // history. OFF (default) it sends neither param and reads exactly as today.
  // Web-only, matching the copy-polish key above.
  //
  // Gated, not just read: this flag decides the REQUEST, and PostHog resolves
  // asynchronously. Reading it through `useFeatureFlagEnabled` alone would have
  // an enabled user issue the unbounded request first and refetch once the flag
  // landed, so first paint still paid the cost this change targets (wongk).
  // `isReady` holds the query until the flag resolves — bounded, so a flag
  // service that never answers degrades to the closed default rather than an
  // endless skeleton.
  const { enabled: recencyWindowEnabled, isReady: isRecencyWindowFlagReady } =
    useFeatureFlagGate(MY_TASKS_RECENCY_WINDOW_FEATURE_FLAG_KEY);
  // The user's own removal of the recency chip, for this visit. Component state,
  // not a persisted view-state key: it is an escape hatch out of a window the
  // board applied, and it should not silently outlive the visit that needed it.
  const [isRecencyWindowRemoved, setIsRecencyWindowRemoved] = useState(false);
  const showAllTime = useCallback(() => setIsRecencyWindowRemoved(true), []);
  // The window is in force only while the flag is on AND the user has not
  // dropped it. Everything user-visible about the window keys off this ONE
  // value, so the chip, the empty state, and the request cannot disagree.
  const isRecencyWindowActive = recencyWindowEnabled && !isRecencyWindowRemoved;

  // ---- API-paged assigned-artifact read (ISS-4576) ----
  //
  // The board reads ONE server page plus the real total behind it. The card view
  // asks for a screen-sized page because it renders one card per row; the list
  // view asks for the widest window the endpoint serves because it merges this
  // stream with branch/session rows in the browser, and reports any residue
  // through `hasMore` rather than pretending the window was the whole queue.
  const cardCursor = useMyTasksCardPage(MY_TASKS_PAGE_SIZE);
  const requestedLimit = isListView
    ? DOCUMENT_LIST_MAX_LIMIT
    : MY_TASKS_PAGE_SIZE;
  const listParams = useMemo(
    () =>
      buildArtifactListParams(
        assigneeId,
        isListView
          ? { limit: DOCUMENT_LIST_MAX_LIMIT, offset: 0 }
          : { limit: MY_TASKS_PAGE_SIZE, offset: cardCursor.offset },
        recencyWindowEnabled,
        isRecencyWindowRemoved
      ),
    [
      assigneeId,
      isListView,
      cardCursor.offset,
      recencyWindowEnabled,
      isRecencyWindowRemoved,
    ]
  );
  const {
    data: artifactsPage,
    isLoading: isArtifactsLoading,
    isFetching: isArtifactsFetching,
    isError: isArtifactsError,
    refetch: refetchArtifacts,
  } = useDocumentsPage(listParams, {
    // `isRecencyWindowFlagReady` (FEA-1626): hold the read until the flag that
    // decides its params has resolved, so an enabled user issues ONE request
    // rather than the unbounded one followed by a windowed refetch.
    enabled: !!assigneeId && !isUserLoading && isRecencyWindowFlagReady,
    // Turning a card page changes the query key, so without this the board and
    // its footer — including the pagination control the user just clicked —
    // unmount while the next page loads and reappear a beat later. Holding the
    // previous page keeps the control under the cursor. Matches Sessions and
    // Branches, the repo's other server-paged surfaces.
    //
    // Scoped, NOT unconditional `keepPreviousData` (shafty023 review): the list
    // view requests a 500-row window and the card view one screen page, so
    // reusing the previous envelope across a list → card switch would keep the
    // 500-row page as placeholder while the 50-row read is in flight and
    // transiently mount all 500 draggable cards — the crash this PR fixes. The
    // scoped placeholder only reuses the previous page when its `limit` matches
    // this request's (an offset-only page turn), and drops it on the view switch.
    placeholderData: keepSamePageSizePlaceholder(requestedLimit),
  });
  // A query held on `enabled: false` reports `isLoading: false`, so without
  // folding the flag gate into the loading signal the board would render its
  // "queue is clear" state for the moment the flag is still resolving — the
  // exact class of lie the empty-state work below exists to remove.
  const isArtifactsPending = isArtifactsLoading || !isRecencyWindowFlagReady;
  const rawArtifacts = artifactsPage?.items ?? NO_ARTIFACTS;
  // The server's count of every assigned artifact, independent of this page.
  const assignedTotal = artifactsPage?.total ?? 0;
  // The key `useDocumentsPage` registered, threaded to the kanban so its
  // optimistic drag write targets the entry the board is actually subscribed to.
  // Memoized on the params: the builder returns a fresh array each call, which
  // would otherwise rebuild the board's drag handler on every render.
  const pageQueryKey = useMemo(
    () => documentsPageQueryKey(listParams),
    [listParams]
  );

  // ---- Column visibility ----

  const {
    visibility,
    toggleColumn,
    visibleColumns,
    reorderColumns,
    resetColumnOrder,
  } = useColumnVisibility({
    storageKey: COLUMN_VISIBILITY_KEY,
    orderStorageKey: COLUMN_ORDER_KEY,
    defaults: COLUMN_DEFAULTS,
    columns: MY_TASKS_DEFAULT_COLUMNS,
  });

  const { groupBy, setGroupBy } = useGroupBy("table:groupByStatus:my-tasks");

  // ---- Edit handlers ----

  const updateArtifactMutation = useUpdateDocument();
  // Type-scoped delete dispatch (branch vs document endpoint) lives in the
  // shared hook (PLN-874 Task 3.5).
  const handleDelete = useDeleteRowItem();

  const orgUsers = useOrgUsersAsPopoverUsers();

  const editHandlers: RowEditHandlers = useMemo(
    () => ({
      teamMembers: orgUsers,
      surfaceVariant: "my-tasks",
      onUpdateAssignee: (id, assigneeId) =>
        updateArtifactMutation.mutate({ id, assigneeId }),
      onUpdatePriority: (id, priority: Priority) =>
        updateArtifactMutation.mutate({ id, priority }),
      onUpdateStatus: (id, status) =>
        updateArtifactMutation.mutate({ id, status }),
    }),
    [orgUsers, updateArtifactMutation.mutate]
  );

  // ---- Items & filters ----

  const { data: favoriteArtifacts } = useFavoriteArtifacts();
  const favoriteArtifactIds = useMemo(
    () => favoriteArtifacts?.map((f) => f.id) ?? [],
    [favoriteArtifacts]
  );

  const filtersReturn = useProjectFilters({
    documents: rawArtifacts,
    filterCategory,
    currentUserId: currentUser?.id,
    persistenceKey: "table:filters:my-tasks",
    favoriteArtifactIds,
  });

  const filterCurrentUser = useFilterCurrentUser(currentUser);

  // ---- Merged project trees for cross-project nesting ----

  // FEA-1651 (parent FEA-908, flagged by wongk in the PR #1077 review): the
  // list view's tree came from ONE `GET /projects/:id/tree` per project the user
  // is assigned in. `GET /artifacts/assigned-tree` collapses that fan-out into a
  // single org-scoped request. Which read is live, the flag-readiness rules, and
  // the branch read the fan-out needs all live in the hook, so this component
  // holds one tree stream rather than two half-gated ones. Closed-by-default
  // (ISS-4779).
  //
  // Branch + tree reads feed the second task stream (branch/session rows). A
  // failure there must surface, not be silently omitted from the total (the
  // footer would otherwise report an honest-looking "of N" missing a whole
  // stream) — ISS-4466, shafty023.
  const {
    treeData: mergedTreeData,
    isTreeLoading: isTreeDataLoading,
    isTreeError: isTreeStreamError,
    refetchTree,
  } = useMyTasksTreeSource({
    assigneeId,
    isListView,
    isUserLoading,
    artifacts: rawArtifacts,
  });

  // ---- Server-side-style pagination across all three streams (ISS-4466) ----
  //
  // Pages at the DATA layer over the unified, deduped root-group list so the
  // board paginates like Sessions/Branches: ONE honest count matching every
  // visible root, filters applied across the FULL set, tree nesting preserved.
  // `DocumentsView` receives an already-paged `documents`/`treeData` subset, so
  // its render assembly is untouched. Replaces the FEA-4373 bounded-fetch cap +
  // truncation footer.
  const {
    page,
    setPage,
    totalPages,
    from: pageFrom,
    to: pageTo,
    total: pageTotal,
    pagedDocuments,
    pagedTreeData,
  } = useMyTasksPagination({
    documents: rawArtifacts,
    treeData: mergedTreeData,
    filterCategory,
    filterText,
    applyProjectFilters: filtersReturn.applyFilters,
    isFilterActive: filtersReturn.isAnyFilterActive,
    groupBy,
    sortPersistenceKey: "table:sort:my-tasks",
  });

  // The "Try again" action must retry whichever read failed, not just the
  // documents read. When `/me` fails, `assigneeId` is null and the artifacts
  // query is disabled — refetching it alone can never clear the error, and
  // manually refetching a disabled query would run its queryFn with a null
  // assignee, requesting `/documents` WITHOUT the My Tasks assignee filter
  // (codex P2). So always retry the user query, and only refetch documents once
  // a valid assignee exists (otherwise the retried user query re-enables and
  // triggers the artifacts read itself).
  //
  // The tree stream is retried too: "Couldn't load your tasks" is shown for a
  // failed TREE read as readily as a failed documents read, and a Try again
  // that cannot clear the failure it is offered for is a dead end
  // (closedloop-ai-stage, PR #4461).
  const handleRetry = useCallback(() => {
    refetchCurrentUser();
    refetchTree();
    if (assigneeId) {
      refetchArtifacts();
    }
  }, [refetchCurrentUser, refetchArtifacts, refetchTree, assigneeId]);

  // Paging to another page should land the viewer at the top of the new page
  // rather than keeping the previous page's scroll offset (the scroll-restore
  // key persists position for back/forward, so reset it explicitly here).
  const handlePageChange = useCallback(
    (nextPage: number) => {
      setPage(nextPage);
      if (scrollContainer) {
        scrollContainer.scrollTop = 0;
      }
    },
    [setPage, scrollContainer]
  );

  // The paged unit differs by tab: the All tab pages the root GROUP (each root
  // can carry a nested subtree), the flat tabs page individual TASK rows. Name
  // it so the count reads honestly instead of looking off when a big subtree
  // rides along under one counted root.
  const pageUnit =
    filterCategory === "all"
      ? MyTasksPagedUnit.TopLevelTasks
      : MyTasksPagedUnit.Tasks;

  // ISS-4576 — the list view merges the documents stream in the browser, so its
  // total is only as complete as the window that was fetched. When the server
  // reports rows beyond that window the total is a FLOOR, and the footer says
  // so instead of publishing a bounded count as if it were the whole queue. The
  // `+` marker and its explanation come from ONE resolver so the marker can
  // never render orphaned.
  //
  // FEA-1651 folds in the TREE stream's own bound: `GET /artifacts/assigned-tree`
  // reports `truncation` when its walk was capped, and the "of N" is built to
  // reconcile with every visible root across all streams — so a bounded tree
  // read makes that number a floor too, and every reason gets named rather than
  // one stream quietly leaving the count (closedloop-ai-stage, PR #4461).
  const documentsTruncation =
    isListView && (artifactsPage?.hasMore ?? false)
      ? resolveMyTasksTruncation(rawArtifacts.length, assignedTotal)
      : NO_TRUNCATION;
  const listTruncation = isListView
    ? mergeMyTasksTruncations([
        documentsTruncation,
        resolveMyTasksTreeTruncation(mergedTreeData?.truncation),
      ])
    : NO_TRUNCATION;

  // ---- List-view task-set resolution (FEA-3938) ----

  const { hasAnyTasks, isTasksError, isTasksLoading, isTotalSettled } =
    resolveMyTasksListState({
      rawArtifactCount: rawArtifacts.length,
      mergedTreeData,
      isUserLoading,
      isUserError,
      isArtifactsLoading: isArtifactsPending,
      isArtifactsFetching,
      isArtifactsError,
      isProjectsLoading,
      isTreeDataLoading,
      isTreeStreamError,
    });

  // ---- Kanban data (API-paged — ISS-4576) ----

  const kanbanArtifacts = useMemo(
    () =>
      selectKanbanArtifacts({
        rootItems: filtersReturn.rootItems,
        filterText,
        isAnyFilterActive: filtersReturn.isAnyFilterActive,
        applyFilters: filtersReturn.applyFilters,
      }),
    [
      filterText,
      filtersReturn.applyFilters,
      filtersReturn.isAnyFilterActive,
      filtersReturn.rootItems,
    ]
  );

  // Bound the card cursor against the server total only once a page has landed
  // (`undefined` while loading — see `useMyTasksCardPageBounds`).
  const cardTotalPages = useMyTasksCardPageBounds({
    page: cardCursor.page,
    setPage: cardCursor.setPage,
    total: artifactsPage?.total,
    pageSize: MY_TASKS_PAGE_SIZE,
  });
  // Every predicate the card board applies AFTER the fetch. Each one runs in the
  // browser over one page, so while any is active the server total stops
  // describing what is on screen and the footer switches wording rather than
  // presenting a page-local count as a queue-wide one.
  //
  // `filterCategory` counts even though its toggle is list-view-only: the value
  // persists across the view switch and `useProjectFilters` narrows `rootItems`
  // by it, so a card board left on the PRDs tab is showing a filtered page —
  // and has no visible control that set it.
  const isCardNarrowed =
    filterText.trim().length > 0 ||
    filtersReturn.isAnyFilterActive ||
    filterCategory !== "all";

  // ISS-4682 item 2: on the card board the search predicate runs in the browser
  // over the ONE page the server sent, so a user with 137 tasks can search a
  // title that exists, get nothing, and conclude it is absent. The footer's "on
  // this page" wording only explains that after the fact — the control itself
  // has to say what it searches BEFORE it is used. The list view fetches the
  // widest window the endpoint serves, so its search keeps the default copy.
  //
  // ISS-5280 (review): the visible placeholder and the accessible name are the
  // SAME sentence. They used to be two phrasings of it ("Filter this page…" vs
  // "Filter tasks on this page"), which gives a screen-reader user and a sighted
  // user two different descriptions of one control.
  const cardSearchCopy = isListView
    ? {}
    : {
        searchLabel: CARD_SEARCH_LABEL,
        searchPlaceholder: `${CARD_SEARCH_LABEL}...`,
      };

  // The card board's "Clear filters" affordance must clear every narrowing the
  // board counts, not just the facets: a button that reads as the way out of a
  // dead end and then leaves the board empty is worse than no button. The list
  // view's own no-match state is gated on the facets alone, so it keeps the
  // narrower `clearAllFilters`.
  const handleClearCardFilters = useCallback(() => {
    filtersReturn.clearAllFilters();
    setFilterText("");
    setFilterCategory("all");
  }, [filtersReturn.clearAllFilters, setFilterText]);

  // `filterCategory` persists across a view switch, but its toggle only renders
  // in list view — so flipping to cards while on the PRDs tab leaves the card
  // board silently filtered with no visible control that set it (and, if the
  // page's rows are all filtered out, a "No items match your filters / Clear
  // filters" empty state on a screen with no filters). Reset the category to
  // "all" when entering card view so the board shows the whole queue and its
  // footer states an unnarrowed total (closedloop-ai-stage). The card board's
  // tabs would page groups, not columns, so a reset is cleaner than rendering
  // the toggle there.
  const handleChangeView = useCallback(
    (nextView: "list" | "card") => {
      if (nextView === "card") {
        setFilterCategory("all");
      }
      setView(nextView);
    },
    [setView]
  );

  const handleResetView = useCallback(() => {
    filtersReturn.clearPersistedFilters();
    clearSearch();
    clearScroll();
    clearSort();
    resetColumnOrder();
    const params = new URLSearchParams(searchParams.toString());
    params.delete("sortBy");
    params.delete("sortDir");
    const qs = params.toString();
    navigation.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [
    filtersReturn.clearPersistedFilters,
    clearSearch,
    clearScroll,
    clearSort,
    resetColumnOrder,
    searchParams,
    navigation,
    pathname,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "My Tasks" }]} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Onboarding checklist — renders null when dismissed, no space taken */}
        <OnboardingChecklist />
        {/* ISS-5490 FR-7: anchors to the checklist's invite row above. */}
        <InviteSpotlightHost />
        <AgentOnboardingCard />

        {/* Title bar */}
        <div className={isListView ? "border-b" : ""}>
          <DocumentTableToolbar
            activeFiltersBarProps={{
              currentUser: filterCurrentUser,
              // FEA-1626: the recency window is a SERVER request parameter, not
              // one of the client-side facets `filtersReturn` models — but it
              // narrows what the user sees exactly like one, so it renders as a
              // real, removable chip in the same strip rather than as an
              // invisible optimisation. Removing it is the whole way back out:
              // one control that drops the window and refetches full history.
              extraChips: isRecencyWindowActive ? (
                <FilterChip
                  label={MY_TASKS_RECENCY_CHIP_LABEL}
                  onRemove={showAllTime}
                />
              ) : undefined,
              filtersReturn,
              hideAssignee: true,
              // The add/clear controls belong to the facet filters; suppress them
              // when the bar is on screen only to carry the recency chip, so no
              // "Clear all" sits there with nothing to clear.
              showFilterControls: filtersReturn.isAnyFilterActive,
              teamMembers: [],
              teamMembersError: null,
              teamMembersLoading: false,
            }}
            filterPopoverProps={
              filterCategory === "branches"
                ? undefined
                : {
                    currentUser: filterCurrentUser,
                    filtersReturn,
                    hideAssignee: true,
                    teamMembers: [],
                    teamMembersError: null,
                    teamMembersLoading: false,
                  }
            }
            filterText={filterText}
            leadingContent={
              isListView && (
                <ToggleGroup
                  onValueChange={(value) => {
                    if (value) {
                      setFilterCategory(value as FilterCategory);
                    }
                  }}
                  size="sm"
                  type="single"
                  value={filterCategory}
                  variant="outline"
                >
                  <ToggleGroupItem value="all">All</ToggleGroupItem>
                  <ToggleGroupItem value="documents">PRDs</ToggleGroupItem>
                  <ToggleGroupItem value="features">Issues</ToggleGroupItem>
                  <ToggleGroupItem value="plans">Plans</ToggleGroupItem>
                  <ToggleGroupItem value="branches">Branches</ToggleGroupItem>
                </ToggleGroup>
              )
            }
            onFilterTextChange={setFilterText}
            {...cardSearchCopy}
            tableViewMenuProps={{
              columns: isListView ? MY_TASKS_DEFAULT_COLUMNS : undefined,
              groupBy: isListView ? groupBy : undefined,
              onChangeGroupBy: isListView ? setGroupBy : undefined,
              onChangeView: handleChangeView,
              onResetView: handleResetView,
              onToggle: isListView ? toggleColumn : undefined,
              view,
              visibility: isListView ? visibility : undefined,
            }}
          />
        </div>

        {/* Content — card view. ISS-4576: a real server page, so the board only
            ever mounts one page's cards regardless of queue size. */}
        {!isListView && (
          <MyTasksCardView
            artifacts={kanbanArtifacts}
            assigneeId={assigneeId}
            // ISS-4683: the board and the queue-clear state reach for host-app
            // route/modal context, so they are constructed here and injected —
            // which is also what lets the moved view put all six of its states
            // on a Storybook canvas with stubs.
            board={
              <MyTasksKanban
                artifacts={kanbanArtifacts}
                assigneeId={assigneeId}
                isLoading={isArtifactsPending}
                isUserLoading={isUserLoading}
                pageQueryKey={pageQueryKey}
              />
            }
            emptyState={
              <MyTasksEmptyState
                projects={projects}
                recencyWindow={
                  isRecencyWindowActive ? { onShowAll: showAllTime } : null
                }
              />
            }
            isError={isUserError || isArtifactsError}
            isLoading={isArtifactsPending}
            isNarrowed={isCardNarrowed}
            isUserLoading={isUserLoading}
            offset={artifactsPage?.offset ?? 0}
            onClearFilters={handleClearCardFilters}
            onPageChange={cardCursor.setPage}
            onRetry={handleRetry}
            page={cardCursor.page}
            pageCount={rawArtifacts.length}
            total={assignedTotal}
            totalPages={cardTotalPages}
          />
        )}

        {/* Content — list view, a read failed. Rendered before the empty state
            so a failed `/me` or `/documents` never masquerades as "queue is
            clear" (FEA-3938). */}
        {isListView && isTasksError && (
          <MyTasksLoadFailedState onRetry={handleRetry} />
        )}

        {/* Content — list view, no tasks yet. Only after user + artifacts +
            projects loading has settled (all folded into `isTasksLoading`) and
            only when neither the documents list nor the tree has any renderable
            task, so the empty state never flashes before rows arrive
            (FEA-3938). */}
        {isListView && !(isTasksError || hasAnyTasks || isTasksLoading) && (
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <MyTasksEmptyState
              projects={projects}
              recencyWindow={
                isRecencyWindowActive ? { onShowAll: showAllTime } : null
              }
            />
          </div>
        )}

        {/* Content — list view, table (or skeleton while loading). Symmetric
            with the empty-state branch above: `DocumentsView` renders its own
            table skeleton when `isLoading` and there are no rows yet, so there
            is no gap where neither skeleton nor content shows.
            plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
        {isListView && !isTasksError && (hasAnyTasks || isTasksLoading) && (
          <div
            className="min-h-0 flex-1 overflow-auto"
            ref={setScrollContainer}
          >
            {/* ISS-4466: `DocumentsView` renders only the current page's
                already-paged documents + tree subset — its render assembly is
                unchanged; the paging happened at the data layer in
                `useMyTasksPagination`. */}
            <DocumentsView
              applyProjectFilters={
                filtersReturn.isAnyFilterActive
                  ? filtersReturn.applyFilters
                  : undefined
              }
              documents={pagedDocuments}
              editHandlers={editHandlers}
              filterCategory={filterCategory}
              filterText={filterText}
              groupBy={groupBy}
              // ISS-4466: the data is paged upstream, so `pagedDocuments` /
              // `pagedTreeData` are only the current page's subset. Pass the
              // honest unpaged "has any task at all" signal so a zero-match
              // filter shows the no-match state (with Clear filters) instead of
              // the truly-empty "No artifacts yet" state.
              hasUnpagedItems={hasAnyTasks}
              isFilterActive={filtersReturn.isAnyFilterActive}
              isLoading={isTasksLoading}
              isTreeDataLoading={isTreeDataLoading}
              loadingLabel="Loading tasks…"
              onClearFilters={filtersReturn.clearAllFilters}
              onDelete={handleDelete}
              onReorderColumns={reorderColumns}
              sortPersistenceKey="table:sort:my-tasks"
              storageKey={STORAGE_KEY}
              treeData={pagedTreeData}
              visibleColumns={visibleColumns}
            />
          </div>
        )}

        {/* Pagination footer (ISS-4466 / ISS-4576): one honest total that
            matches every visible root row, across documents, branches, and
            sessions. Gated on `isTotalSettled` so the "of N" never publishes a
            partial total while the branch/tree stream is still landing after
            documents (shafty023). ISS-4576 adds the truncation case: when the
            server reports assigned artifacts beyond the fetched window the total
            is marked a floor and the note names exactly what was left out, so a
            bounded read can no longer be read as a complete count. */}
        {isListView && !isTasksError && hasAnyTasks && isTotalSettled && (
          <MyTasksPaginationFooter
            onPageChange={handlePageChange}
            page={page}
            readout={resolveMyTasksRangeReadout({
              from: pageFrom,
              isTotalPartial: listTruncation.isTotalPartial,
              to: pageTo,
              total: pageTotal,
              unit: pageUnit,
            })}
            totalPages={totalPages}
            truncationNote={listTruncation.note}
          />
        )}
      </div>
    </div>
  );
}

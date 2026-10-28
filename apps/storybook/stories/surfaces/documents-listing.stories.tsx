import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { DocumentsIndexEmptyState } from "@repo/app/documents/components/documents-index-empty-state";
import { DocumentsStaleRefreshNotice } from "@repo/app/documents/components/documents-stale-refresh-notice";
import { getDocumentTableColumnCount } from "@repo/app/documents/components/table/document-row";
import { DocumentRowActions } from "@repo/app/documents/components/table/document-row-actions";
import { DocumentTableSkeleton } from "@repo/app/documents/components/table/document-table-skeleton";
import { DocumentTableToolbar } from "@repo/app/documents/components/table/document-table-toolbar";
import { DocumentsUngroupedTreeBody } from "@repo/app/documents/components/table/documents-ungrouped-tree-body";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { DocumentTableHeader } from "@repo/app/documents/components/table/table-header";
import { artifactFavoriteKeys } from "@repo/app/documents/hooks/artifact-favorite-keys";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { documentTreeRoots } from "@repo/app/documents/lib/documents-grid-groups";
import {
  countMatchingDocuments,
  DocumentsIndexState,
  hasActiveSearch,
  resolveDocumentsIndexState,
} from "@repo/app/documents/lib/documents-index-state";
import {
  buildParentMap,
  buildSortedGroups,
} from "@repo/app/documents/lib/table-view-pipeline";
import {
  DocumentColumn,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import { NAME_SORT_OPTIONS } from "@repo/app/shared/lib/sort-comparators";
import type { SortDirection } from "@repo/app/shared/lib/table-utils";
import { ariaTableProps } from "@repo/design-system/lib/grid-table-aria";
import type { Meta, StoryObj } from "@storybook/react";
import { useMemo, useState } from "react";
import { fn } from "storybook/test";
import { AppScreenShell, ORG_SLUG } from "./app-shell";

/**
 * The org-level Documents index (FEA-4140): the DOC list at `/documents`,
 * listing evergreen documents filed into a project or not (ISS-12858).
 *
 * WHY THIS IS NOT `DocumentsIndexView` / `DocumentsIndexBodyV1` /
 * `DocumentsIndexBodyV2` rendered directly, the way the task brief's Approach
 * B suggests: all three ultimately mount `DocumentsView`
 * (`packages/app/documents/components/table/documents-view.tsx`),
 * and `DocumentsView` calls `useOrgSlug()`
 * (`apps/app/hooks/use-org-slug.ts`), which calls Clerk's OWN `useAuth()` /
 * `useOrganization()` (`@repo/auth/client` is a bare re-export of
 * `@clerk/nextjs`). Clerk's hooks assert a `<ClerkProvider>` ancestor
 * (`useAssertWrappedByClerkProvider`, `@clerk/shared`) and throw without one.
 * This Storybook's harness (`AppCoreStoryProviders`) mounts its OWN
 * `AuthAdapterProvider` port — a deliberately separate abstraction, not a
 * Clerk shim — and no `<ClerkProvider>` exists anywhere in this Storybook, by
 * design (FEA-1510's whole point: `packages/app` proves it runs without
 * Clerk). `DocumentsView` is an `apps/app`-ROUTE component, not part of that
 * portable layer, and `useOrgSlug()` is called unconditionally with no prop
 * escape hatch — confirmed by reading `use-org-slug.ts` and Clerk's own
 * `useOrganization()` source before writing this file, not assumed.
 *
 * What this story mounts INSTEAD, to stay as real as that wall allows: every
 * OTHER piece `DocumentsView` itself is built from, unchanged —
 * `DocumentTableToolbar`, `DocumentTableHeader`, `DocumentsUngroupedTreeBody`,
 * `DocumentTableSkeleton`, `DocumentsIndexEmptyState`,
 * `DocumentsStaleRefreshNotice`, and the pure pipeline functions
 * `buildSortedGroups` / `buildParentMap` / `resolveDocumentsIndexState` /
 * `countMatchingDocuments` — all confirmed Clerk-free by reading their
 * imports. The ONE substitution is `buildParentMap`'s `orgSlug` argument,
 * which `DocumentsView` reads from the blocked hook; this story passes
 * `AppScreenShell`'s own exported `ORG_SLUG` instead. Documents never
 * carry a project tree here (`treeData` is always `null`, matching
 * `DocumentsIndexBodyV1`/`V2`'s own call), so `buildSortedGroups` resolves one
 * flat, childless group per document — the exact shape `DocumentsUngroupedTreeBody`
 * renders identically to a plain row list (verified by reading its source:
 * `hasChildren` is false, so no chevron and no nesting).
 *
 * NOT reproduced, deliberately out of scope for this pass: row selection,
 * bulk actions, and stack-rank drag-to-reorder. Each needs more `apps/app`-
 * local state and UI than this pass's populated/loading/error/empty coverage
 * calls for (`useDocumentsViewState`'s selection/dialog state plus a
 * bulk-action toolbar; `useStackRanking` plus `SortableSubtree`'s dnd-kit
 * wiring) — a genuine scope call, not a Clerk wall: `useDocumentsViewState`
 * (`packages/app/documents/hooks/use-documents-view-state.ts`) is a plain
 * `useReducer` hook with no Clerk import, confirmed by reading its source
 * before writing this note.
 *
 * The per-row overflow menu IS reproduced below, with the real
 * `DocumentRowActions` (`.../projects/[projectId]/components/
 * document-row-actions.tsx`) — also confirmed Clerk-free by reading its
 * source: it is a plain presentational component that only reads
 * `item.kind`/`getRowTypeConfig(item)` to gate its Move-to-Project and Delete
 * items. The earlier draft of this note lumped all three pieces together
 * under one "Clerk-adjacency" claim; that was wrong for this one and for
 * `useDocumentsViewState` above, corrected here rather than left standing.
 * `showRankActions` is always `false` in this story (no stack-rank surface
 * mounts here), and `onMoveToTop`/`onMoveToBottom`/`onMove`/`onDelete` are
 * `fn()` stand-ins, same as every other interaction this file wires to a real
 * handler it cannot execute against a live API.
 *
 * The state branch below mirrors `DocumentsIndexBodyV2`'s own real branching
 * over the real `resolveDocumentsIndexState` — the newer, more complete
 * six-plus-one state model (ISS-8940) — rather than re-deriving a parallel
 * set of booleans, so a reader comparing this story against that file's logic
 * is comparing against the same function, not a lookalike.
 *
 * Verification note: this file was checked by careful reading of every
 * component and hook it composes (import graphs, prop contracts, query
 * hooks), not by rendering it in a live browser — no interactive Storybook
 * session was available while writing it. The reasoning is written out above
 * so it can be checked the same way.
 */

const NAV_PATHS = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => destination.path
);

// The exact column set `documents-index-view.tsx` passes to
// `useColumnVisibility` (copied verbatim — that file is a Next.js page module,
// not something this Storybook can import). The index hard-filters to
// `DocumentType.Doc` and these documents carry no project, priority, or due
// date by convention, so Type/Parent/Priority/Tags/Project are dropped; only
// Assignee and Updated describe a standalone doc.
const DOCUMENTS_INDEX_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Assignee,
  DocumentColumn.Updated,
];

const ROWS_NOW_MS = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

function fixtureUser(
  id: string,
  firstName: string,
  lastName: string,
  email: string
): BasicUser {
  return { id, firstName, lastName, email, avatarUrl: null };
}

const OTTILIE = fixtureUser(
  "user-ottilie",
  "Ottilie",
  "Eye",
  "ottilie@closedloop.ai"
);
const PASCOE = fixtureUser(
  "user-pascoe",
  "Pascoe",
  "Birchall",
  "pascoe@closedloop.ai"
);
const MARISOL = fixtureUser(
  "user-marisol",
  "Marisol",
  "Ashgrove",
  "marisol@closedloop.ai"
);

function documentRow({
  id,
  slug,
  title,
  status,
  assignee,
  updatedDaysAgo,
  sortOrder,
}: {
  id: string;
  slug: string;
  title: string;
  status: DocumentStatus;
  assignee: BasicUser | null;
  updatedDaysAgo: number;
  sortOrder: number;
}): DocumentRowData {
  return {
    id,
    slug,
    title,
    type: DocumentType.Doc,
    status,
    priority: null,
    assigneeId: assignee?.id ?? null,
    assignee,
    createdAt: new Date(ROWS_NOW_MS - (updatedDaysAgo + 45) * DAY_MS),
    updatedAt: new Date(ROWS_NOW_MS - updatedDaysAgo * DAY_MS),
    projectId: null,
    sortOrder,
    tags: [],
    project: null,
  };
}

/** Five realistic evergreen docs, spread across status/assignee/recency so
 * the Assignee and Updated columns show real variety rather than one repeated
 * value each. `doc-5` has no assignee, the real em-dash-cell case. */
const DOCUMENTS_ROWS: DocumentRowData[] = [
  documentRow({
    id: "doc-1",
    slug: "storybook-surfaces-taxonomy",
    title: "Storybook Surfaces Taxonomy Notes",
    status: DocumentStatus.InReview,
    assignee: OTTILIE,
    updatedDaysAgo: 0,
    sortOrder: 1,
  }),
  documentRow({
    id: "doc-2",
    slug: "design-review-checklist",
    title: "Design Review Checklist",
    status: DocumentStatus.Approved,
    assignee: OTTILIE,
    updatedDaysAgo: 2,
    sortOrder: 2,
  }),
  documentRow({
    id: "doc-3",
    slug: "onboarding-runbook",
    title: "New Engineer Onboarding Runbook",
    status: DocumentStatus.Draft,
    assignee: PASCOE,
    updatedDaysAgo: 3,
    sortOrder: 3,
  }),
  documentRow({
    id: "doc-4",
    slug: "incident-postmortem-template",
    title: "Incident Postmortem Template",
    status: DocumentStatus.Approved,
    assignee: MARISOL,
    updatedDaysAgo: 6,
    sortOrder: 4,
  }),
  documentRow({
    id: "doc-5",
    slug: "q3-design-system-retro",
    title: "Q3 Design System Retro",
    status: DocumentStatus.Obsolete,
    assignee: null,
    updatedDaysAgo: 40,
    sortOrder: 5,
  }),
];

type EmptyStateVariant =
  | typeof DocumentsIndexState.FirstUseEmpty
  | typeof DocumentsIndexState.NoResults
  | typeof DocumentsIndexState.BlockingError
  | typeof DocumentsIndexState.StaleNoResults;

function isEmptyStateVariant(
  state: DocumentsIndexState
): state is EmptyStateVariant {
  return (
    state === DocumentsIndexState.FirstUseEmpty ||
    state === DocumentsIndexState.NoResults ||
    state === DocumentsIndexState.BlockingError ||
    state === DocumentsIndexState.StaleNoResults
  );
}

type DocumentsListingBodyProps = {
  documents: DocumentRowData[];
  initialFilterText: string;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  searchAppliedUpstream: boolean;
};

/**
 * Toolbar + state-resolved body. `key`-remounted by the screen below whenever
 * a control changes, while staying locally stateful in between so typing in
 * the search box, sorting a column, and toggling a column all actually work.
 */
function DocumentsListingBody({
  documents,
  initialFilterText,
  isLoading,
  isFetching,
  isError,
  searchAppliedUpstream,
}: DocumentsListingBodyProps) {
  const [filterText, setFilterText] = useState(initialFilterText);
  // The real hook (`packages/app/shared/hooks/use-column-visibility.ts`), the
  // same one `documents-index-view.tsx` calls — `storageKey: null` keeps this
  // story's toggles in memory only, the documented "organization not
  // resolved" mode, so one story's clicks can never bleed into another's via
  // localStorage.
  const { visibility, toggleColumn } = useColumnVisibility({
    columns: DOCUMENTS_INDEX_COLUMNS,
    defaults: {},
    orderStorageKey: null,
    storageKey: null,
  });
  const [sortBy, setSortBy] = useState<SortKey | null>(SortKey.StackRank);
  const [sortDir, setSortDir] = useState<SortDirection>("asc");

  const matchCount = useMemo(
    () => countMatchingDocuments(documents, filterText),
    [documents, filterText]
  );
  // The real six-plus-one state resolver (ISS-8940), fed the same shape
  // `DocumentsIndexBodyV2` builds from `DocumentsIndexView`'s query.
  const state = resolveDocumentsIndexState({
    hasSearch: hasActiveSearch(filterText),
    isError,
    isFetching,
    isLoading,
    matchCount,
    rowCount: documents.length,
    searchAppliedUpstream,
  });

  const { groups } = useMemo(
    () =>
      buildSortedGroups({
        documents,
        filterText,
        sortBy,
        sortDir,
        treeData: null,
      }),
    [documents, filterText, sortBy, sortDir]
  );
  // `treeData` is always `null` here (see file doc comment), so this returns
  // an empty map immediately — no parent/child rows exist for this surface.
  const parentMap = useMemo(() => buildParentMap(null, ORG_SLUG), []);
  const ariaColumnCount = getDocumentTableColumnCount(
    DOCUMENTS_INDEX_COLUMNS.length
  );

  return (
    <>
      <div className="border-b">
        <DocumentTableToolbar
          filterText={filterText}
          onFilterTextChange={setFilterText}
          tableViewMenuProps={{
            columns: DOCUMENTS_INDEX_COLUMNS,
            onToggle: toggleColumn,
            visibility,
          }}
        />
      </div>

      {state === DocumentsIndexState.Loading ? (
        <DocumentTableSkeleton
          label="Loading documents…"
          visibleColumns={DOCUMENTS_INDEX_COLUMNS}
        />
      ) : null}

      {isEmptyStateVariant(state) ? (
        <DocumentsIndexEmptyState onRetry={fn()} state={state} />
      ) : null}

      {state === DocumentsIndexState.Populated ||
      state === DocumentsIndexState.StaleAfterFailedRefresh ? (
        <div className="flex-1 overflow-auto">
          {state === DocumentsIndexState.StaleAfterFailedRefresh ? (
            <DocumentsStaleRefreshNotice onRetry={fn()} />
          ) : null}
          <div {...ariaTableProps(true, ariaColumnCount)}>
            <DocumentTableHeader
              insideAriaTable
              nameSortOptions={NAME_SORT_OPTIONS}
              onClearSort={() => setSortBy(null)}
              onSort={(column, direction) => {
                setSortBy(column as SortKey);
                setSortDir(direction);
              }}
              sortBy={sortBy}
              sortDir={sortDir}
              visibleColumns={DOCUMENTS_INDEX_COLUMNS}
            />
            <DocumentsUngroupedTreeBody
              insideAriaTable
              isExpanded={() => false}
              items={documentTreeRoots(groups)}
              parentMap={parentMap}
              // The real per-row overflow menu (FEA-4242) — see the file
              // doc comment on why this is in scope while selection/bulk
              // actions/drag-to-rank are not.
              renderRowActions={(item) => (
                <DocumentRowActions
                  item={item}
                  onDelete={fn()}
                  onMove={fn()}
                  onMoveToBottom={fn()}
                  onMoveToTop={fn()}
                  showRankActions={false}
                />
              )}
              toggleRow={() => undefined}
              visibleColumns={DOCUMENTS_INDEX_COLUMNS}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

type DocumentsListingScreenProps = {
  /** Org-relative path the sidebar should mark as current. */
  activePath?: string;
  /** Rows the fixture renders, up to the shared fixture's five documents. */
  rowCount?: number;
  /** No settled read yet — the real `DocumentTableSkeleton`. */
  isLoading?: boolean;
  /** A background refetch is in flight (irrelevant once rows exist). */
  isFetching?: boolean;
  /** The most recent read failed. */
  isError?: boolean;
  /** The search box's value on mount; typing afterward is live and local. */
  filterText?: string;
  /**
   * Whether `filterText` was already applied server-side before these rows
   * arrived (ISS-9762) — governs whether a zero-row read reads as "no
   * documents" or "no matches".
   */
  searchAppliedUpstream?: boolean;
};

const DocumentsListingScreen = ({
  activePath = "/documents",
  filterText = "",
  isError = false,
  isFetching = false,
  isLoading = false,
  rowCount = DOCUMENTS_ROWS.length,
  searchAppliedUpstream = false,
}: DocumentsListingScreenProps) => (
  <AppScreenShell activePath={activePath} breadcrumbs={["Documents"]}>
    <DocumentsListingBody
      documents={DOCUMENTS_ROWS.slice(0, rowCount)}
      initialFilterText={filterText}
      isError={isError}
      isFetching={isFetching}
      isLoading={isLoading}
      // Remounts on any control change so a new default actually takes
      // effect, matching the `key`-remount pattern `Surfaces/Settings` uses
      // for its Tabs — the body stays uncontrolled in between so typing,
      // sorting, and toggling columns all keep working.
      key={`${filterText}:${isLoading}:${isFetching}:${isError}:${rowCount}:${searchAppliedUpstream}`}
      searchAppliedUpstream={searchAppliedUpstream}
    />
  </AppScreenShell>
);

/**
 * The org-level Documents index at `/documents`: every evergreen document
 * outside a project, with the real toolbar, table, and per-row overflow menu,
 * across the full six-plus-one `DocumentsIndexState` model.
 */
const meta = {
  title: "Surfaces v1.0/Documents/Listing",
  component: DocumentsListingScreen,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    activePath: {
      options: NAV_PATHS,
      control: { type: "select" },
      description: "Which sidebar destination renders as current.",
      table: { category: "Shell" },
    },
    rowCount: {
      control: { type: "number", max: DOCUMENTS_ROWS.length, min: 0, step: 1 },
      description:
        "Rows the table renders, up to the shared fixture's five documents.",
      table: { category: "Content" },
    },
    filterText: {
      control: "text",
      description: "The search box's value on mount.",
      table: { category: "State" },
    },
    isLoading: {
      control: "boolean",
      description: "No settled read yet — renders the real loading skeleton.",
      table: { category: "State" },
    },
    isFetching: {
      control: "boolean",
      description: "A background refetch is in flight.",
      table: { category: "State" },
    },
    isError: {
      control: "boolean",
      description: "The most recent read failed.",
      table: { category: "State" },
    },
    searchAppliedUpstream: {
      control: "boolean",
      description:
        "Whether the search term was already applied server-side, so a zero-row read means 'no matches' rather than 'no documents'.",
      table: { category: "State" },
    },
  },
  args: {
    activePath: "/documents",
    filterText: "",
    isError: false,
    isFetching: false,
    isLoading: false,
    rowCount: DOCUMENTS_ROWS.length,
    searchAppliedUpstream: false,
  },
  parameters: {
    layout: "fullscreen",
    // A fullscreen Surface, inlined into the Docs page's own prose-width
    // column, squeezes real components into far less width than they ever
    // get in the product. `inline: false` renders the Docs preview in its
    // own full-width iframe instead, the documented Storybook fix for
    // exactly this mismatch.
    docs: { story: { inline: false, iframeHeight: 900 } },
    appCore: {
      // The real DocumentRowActions row menu renders a FavoriteButton whose
      // useIsFavoriteArtifact reads this unconditionally; unseeded, the
      // harness's fixture transport falls back to an unmatched-GET default of
      // `{}`, and `favorites?.some(...)` throws on the missing array (`.data`
      // exists, isn't an array).
      queryData: [[artifactFavoriteKeys.list(), []]],
    },
  },
} satisfies Meta<typeof DocumentsListingScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The resting surface: toolbar plus a populated table, sorted by stack
 * rank ascending — the real container's own default. */
export const Default: Story = {};

/** No settled read yet. The real `DocumentTableSkeleton`, not a hand-rolled
 * shimmer — same header chrome as the live table so nothing drifts between
 * the two. */
export const Loading: Story = {
  args: { isLoading: true, rowCount: 0 },
};

/** The read failed with nothing cached — the real
 * `DocumentsIndexEmptyState`'s "Couldn't load documents" state. Named for the
 * real `DocumentsIndexState.BlockingError` member, not the bare `Error`
 * export name every other story file in this repo avoids (it shadows the
 * global `Error` constructor). */
export const BlockingError: Story = {
  name: "Error",
  args: { isError: true, rowCount: 0 },
};

/** The organization genuinely has none yet — the real onboarding zero-state,
 * distinct on purpose from `NoSearchResults` below (ISS-9762: one means
 * "write something", the other means "type something else"). */
export const Empty: Story = {
  args: { rowCount: 0 },
};

/** A server-applied search term matched nothing. Renders the real
 * `DocumentsIndexEmptyState`'s "No documents match your search" state rather
 * than the onboarding empty state above — the whole reason the two are
 * separate members of `DocumentsIndexState`. */
export const NoSearchResults: Story = {
  name: "No search results",
  args: {
    filterText: "roadmap-2027",
    rowCount: 0,
    searchAppliedUpstream: true,
  },
};

/**
 * A background refresh failed over rows that are still usable (ISS-8940).
 * The real `DocumentsStaleRefreshNotice` sits above the real table instead of
 * replacing it — the table's own rows stay on screen and act-able.
 */
export const StaleAfterFailedRefresh: Story = {
  name: "Stale after failed refresh",
  args: { isError: true },
};

/**
 * The seventh state (ISS-8940): a background refresh failed over cached rows
 * AND the active search matches none of them, so there is nothing left on
 * screen for a "showing your last loaded documents" banner to describe. This
 * is the `StaleAfterFailedRefresh` recipe above (`isError: true`) combined
 * with `NoSearchResults`' term below — neither state alone reaches it. Renders
 * the real `DocumentsIndexEmptyState`'s combined copy instead of showing the
 * stale-refresh banner over an empty table.
 */
export const StaleNoResults: Story = {
  name: "Stale, no search results",
  args: {
    filterText: "roadmap-2027",
    isError: true,
    rowCount: DOCUMENTS_ROWS.length,
    searchAppliedUpstream: true,
  },
};

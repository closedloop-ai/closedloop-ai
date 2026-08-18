"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { LayoutListIcon } from "lucide-react";
import type { ReactNode } from "react";
import { DocumentsEmptyState } from "../../documents/components/table/documents-empty-state";
import type { DocumentRowData } from "../../documents/lib/artifact-row-adapter";
import { resolveMyTasksCardReadout } from "../lib/my-tasks-range-readout";
import { MyTasksLoadFailedState } from "./my-tasks-load-failed-state";
import { MyTasksPaginationFooter } from "./my-tasks-pagination-footer";

type MyTasksCardViewProps = {
  /** The current page's artifacts, after the client search/facet predicate. */
  artifacts: DocumentRowData[];
  assigneeId: string | null;
  /**
   * The kanban board itself (ISS-4683).
   *
   * Injected rather than imported because the board reaches for the host app's
   * `useOrgSlug` route context, which `@repo/app` cannot import — and because
   * this component's job is choosing WHICH state to show, not rendering the
   * board. Passing it in is what lets all six states sit on a Storybook canvas
   * with a stub board. Every branch that shows a board shows this same element
   * (the loading and signed-out states are the board's own, per its contract),
   * so there is exactly one board instance and nothing to keep in sync.
   */
  board: ReactNode;
  /**
   * The "your queue is clear" state (ISS-4683). Injected for the same reason as
   * `board`: it opens the host app's create-document / create-issue modals.
   */
  emptyState: ReactNode;
  /** REAL server-side count of the viewer's assigned artifacts. */
  total: number;
  /** How many rows the server returned for this page, before client narrowing. */
  pageCount: number;
  /** Zero-based offset the SERVER reports applying to this page. */
  offset: number;
  /** Zero-based current page. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** True when a client-side search or facet filter is narrowing the page. */
  isNarrowed: boolean;
  /** Clears every narrowing the board can apply — search, facets, and category. */
  onClearFilters: () => void;
  isLoading: boolean;
  isUserLoading: boolean;
  isError: boolean;
  onRetry: () => void;
};

/**
 * Card (kanban) view of My Tasks — API-paged (ISS-4576).
 *
 * FEA-4373 bounded the assigned-artifact fetch but the board still rendered
 * every fetched artifact as its own card, so a large queue rendered hundreds of
 * draggable cards in one pass — the crash that lane existed to remove. The read
 * is now a real server page (`limit`/`offset`, wired in `page.tsx`), so the
 * board only ever mounts one page's cards no matter how large the queue is.
 *
 * The count that comes back with the page is the server's, not `items.length`,
 * which is what lets the footer state a total at all. What the server cannot
 * account for is anything that narrows the page in the browser — a search/facet
 * predicate, or rows the board cannot render as cards.
 *
 * ISS-4683 moved this into `@repo/app` so its six-state matrix (load failed,
 * loading, signed-out, empty queue, filtered-to-nothing, populated-with-footer)
 * can be exercised on a Storybook canvas — it diverges only here, not in the
 * leaf pieces it composes. The two children that reach for host-app route/modal
 * context arrive as the `board` and `emptyState` slots.
 */
export function MyTasksCardView({
  artifacts,
  assigneeId,
  board,
  emptyState,
  total,
  pageCount,
  page,
  totalPages,
  onPageChange,
  isNarrowed,
  offset,
  onClearFilters,
  isLoading,
  isUserLoading,
  isError,
  onRetry,
}: Readonly<MyTasksCardViewProps>) {
  const readout = resolveMyTasksCardReadout({
    isNarrowed,
    offset,
    pageCount,
    shownCount: artifacts.length,
    total,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MyTasksCardBody
        artifacts={artifacts}
        assigneeId={assigneeId}
        board={board}
        emptyState={emptyState}
        isError={isError}
        isLoading={isLoading}
        isNarrowed={isNarrowed}
        isUserLoading={isUserLoading}
        onClearFilters={onClearFilters}
        onRetry={onRetry}
        pageCount={pageCount}
        total={total}
      />
      {/* The footer only claims a range once a page has actually landed: while
          the read is in flight or failed there is no honest range to state.
          `keepPreviousData` on the read means a page turn keeps the previous
          page mounted, so this does not flicker between pages. */}
      {!(isError || isLoading || isUserLoading) && total > 0 && (
        <MyTasksPaginationFooter
          onPageChange={onPageChange}
          page={page}
          readout={readout.readout}
          totalPages={totalPages}
          truncationNote={readout.note}
        />
      )}
    </div>
  );
}

type MyTasksCardBodyProps = Pick<
  MyTasksCardViewProps,
  | "artifacts"
  | "assigneeId"
  | "board"
  | "emptyState"
  | "isError"
  | "isLoading"
  | "isNarrowed"
  | "isUserLoading"
  | "onClearFilters"
  | "onRetry"
  | "pageCount"
  | "total"
>;

/**
 * The card view's state matrix, split out so the container above stays a thin
 * body-plus-footer composition.
 *
 * The empty branches are deliberately distinct: an empty board because the queue
 * really is empty, an empty board because a filter excluded this page's rows,
 * and (ISS-4682) an empty board because nothing on this page could be drawn as a
 * card, are three different facts. Each gets its own copy and its own way out —
 * an empty-vs-no-match conflation is the same class of lie as a wrong total.
 */
function MyTasksCardBody({
  artifacts,
  assigneeId,
  board,
  emptyState,
  isError,
  isLoading,
  isNarrowed,
  isUserLoading,
  onClearFilters,
  onRetry,
  pageCount,
  total,
}: Readonly<MyTasksCardBodyProps>) {
  // Rendered before every empty branch so a failed read can never masquerade as
  // "your queue is clear" (the FEA-3938 rule the list view already follows).
  if (isError) {
    return <MyTasksLoadFailedState onRetry={onRetry} />;
  }

  // The board owns the loading and signed-out states for this view.
  if (isUserLoading || !assigneeId || isLoading) {
    return board;
  }

  if (total === 0) {
    return <div className="flex min-h-0 flex-1 flex-col p-4">{emptyState}</div>;
  }

  if (artifacts.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-4">
        <MyTasksCardEmptyBranch
          isNarrowed={isNarrowed}
          onClearFilters={onClearFilters}
          pageCount={pageCount}
        />
      </div>
    );
  }

  return board;
}

/** ISS-4682 item 4 — copy for a page whose rows the board cannot draw. */
export const MY_TASKS_UNDRAWABLE_PAGE_TITLE = "Nothing to show on this page";
export const MY_TASKS_UNDRAWABLE_PAGE_DESCRIPTION =
  "The tasks on this page can't be shown as cards. Switch to the list view to see them, or try another page.";

/**
 * The empty branch for a page whose rows all fell out (ISS-4682 item 4).
 *
 * With no filter set, `DocumentsEmptyState`'s third branch tells the reader to
 * "try adjusting your filter or search term" — a filter they never set. That is
 * reachable whenever every row the server sent is non-navigable (a Template in
 * the queue, say): the board can draw none of them as cards, yet `isNarrowed` is
 * false and the queue is not empty. That page has to say what is actually true —
 * these tasks exist, this view just cannot draw them — and name the view that
 * can. No "Clear filters" action, because there is no filter to clear.
 *
 * ISS-5280 retired the flag that staged this, so every user gets the distinct
 * copy; only the genuinely-filtered case still routes through
 * `DocumentsEmptyState`.
 */
function MyTasksCardEmptyBranch({
  isNarrowed,
  onClearFilters,
  pageCount,
}: Readonly<{
  isNarrowed: boolean;
  onClearFilters: () => void;
  pageCount: number;
}>) {
  if (!isNarrowed && pageCount > 0) {
    return (
      <EmptyState
        description={MY_TASKS_UNDRAWABLE_PAGE_DESCRIPTION}
        icon={LayoutListIcon}
        title={MY_TASKS_UNDRAWABLE_PAGE_TITLE}
      />
    );
  }
  return (
    <DocumentsEmptyState
      hasAnyItems
      isFilterActive={isNarrowed}
      onClearFilters={onClearFilters}
    />
  );
}

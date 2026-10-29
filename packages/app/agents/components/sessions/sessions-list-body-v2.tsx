import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { ReactNode } from "react";
import type { LoadingStallPhase } from "../../../shared/lib/loading-stall-phase";
import { SessionsEmptyState } from "./sessions-empty-state";
import { renderSessionsListLoading } from "./sessions-list-loading-body";

export function renderSessionsListBody({
  errorRecoveryAction,
  filtersActive,
  hasConnectedAgent,
  isAwaitingClampedPage,
  isError,
  isPending,
  isPlaceholderPage,
  isSyncing,
  listNarrowed,
  loadingLabel,
  onboardingAction,
  onClearFilters,
  onRetry,
  onShowAllTime,
  rowCount,
  showAllTimeOffered,
  stallPhase,
}: {
  errorRecoveryAction?: ReactNode;
  /**
   * Whether "Clear filters" would actually widen the list — the gate on
   * OFFERING that action, which is a narrower question than {@link listNarrowed}.
   */
  filtersActive: boolean;
  hasConnectedAgent: boolean;
  isAwaitingClampedPage: boolean;
  isError: boolean;
  isPending: boolean;
  /**
   * ISS-9907: the rows on screen belong to a read that has not landed. With
   * nothing held that is loading, never an answer about the current filters.
   */
  isPlaceholderPage: boolean;
  isSyncing: boolean;
  /**
   * ISS-8217: whether ANYTHING is narrowing this list, including a window the
   * reader never touched. The empty state's NARRATIVE turns on this, because the
   * question it answers is "are there no sessions, or none you can currently
   * see" — and the client surface applies the default window, so a list emptied
   * by it would otherwise report an org with plenty of sessions as having none.
   */
  listNarrowed: boolean;
  /**
   * ISS-9106: what the pending read is DOING, when the host can say. Without it
   * the skeleton below is the only pending treatment, and a skeleton says
   * nothing a reader can tell apart from a list that has settled empty.
   */
  loadingLabel?: string;
  onboardingAction?: ReactNode;
  onClearFilters: () => void;
  onRetry?: () => void;
  onShowAllTime: () => void;
  rowCount: number;
  /**
   * ISS-11913: the date window alone is hiding sessions that exist — the gate
   * on offering {@link onShowAllTime}, as {@link filtersActive} gates Clear.
   */
  showAllTimeOffered: boolean;
  /** ISS-9105 @see SessionsListSurfaceV2Props.stallPhase */
  stallPhase: LoadingStallPhase;
}): ReactNode {
  // ISS-9105 / ISS-9106: the same resolver the desktop v1 body calls, so the
  // copy and the FEA-3639 escalation cannot answer differently on the two
  // stacks. The row skeleton stays the treatment for a host that supplies
  // neither — it is what this surface has always shown.
  const loading = renderSessionsListLoading({
    hasData: rowCount > 0,
    isLoading: isPending || isAwaitingClampedPage || isPlaceholderPage,
    loadingLabel,
    quietLoadingBody: <SessionsListSkeleton />,
    stallPhase,
  });
  if (loading) {
    return loading;
  }
  // This surface's own precedence, which the desktop v1 body does not share and
  // the shared resolver above therefore does not encode: a pending or clamped
  // read outranks the rows it is still HOLDING. `isAwaitingClampedPage` fires
  // when a narrowed filter shrank the page count, and `keepPreviousData` is
  // still showing the previous page's rows — rows that need not match the
  // filter the reader just applied. Covering them is the point.
  // `isPlaceholderPage` is deliberately absent here: the rows a placeholder
  // holds stay visible on a page turn. A host with loading copy never reaches
  // this line holding rows; the resolver above has already returned its copy.
  if (isPending || isAwaitingClampedPage) {
    return <SessionsListSkeleton />;
  }
  if (rowCount > 0) {
    return null;
  }
  return (
    <div className="p-4">
      <SessionsEmptyState
        errorRecoveryAction={errorRecoveryAction}
        hasConnectedAgent={hasConnectedAgent}
        isSyncing={isSyncing}
        onboardingAction={onboardingAction}
        onClearFilters={filtersActive ? onClearFilters : undefined}
        onRetry={onRetry}
        onShowAllTime={showAllTimeOffered ? onShowAllTime : undefined}
        signals={{ hasActiveFilters: listNarrowed, isUnavailable: isError }}
      />
    </div>
  );
}

function SessionsListSkeleton() {
  return (
    <div
      className="flex flex-col gap-2 p-4"
      data-testid="sessions-list-skeleton"
    >
      {SKELETON_ROW_KEYS.map((key) => (
        <Skeleton className="h-11 w-full" key={key} />
      ))}
    </div>
  );
}

const SKELETON_ROW_KEYS = [
  "skeleton-1",
  "skeleton-2",
  "skeleton-3",
  "skeleton-4",
  "skeleton-5",
];

"use client";

import type { ListEmptyStateSignals } from "@repo/api/src/list-empty-state";
import type {
  AgentSessionListItem,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { ReactNode } from "react";
import type { SessionGroupBy } from "../../lib/session-grouping";
import { SessionsEmptyState } from "./sessions-empty-state";
import { SyncedSessionsTable } from "./synced-sessions-table";

/**
 * Shared renderer for sessions-list query states. App routes own filters,
 * pagination, feature flags, and href shape; this component owns the portable
 * loading/empty/populated table body.
 */
export type AgentSessionsListContentProps = {
  items: AgentSessionListItem[];
  isLoading: boolean;
  getSessionHref: (item: AgentSessionListItem) => string;
  emptyState?: ReactNode;
  loadingClassName?: string;
  /** When provided, only these data-column ids render (autonomy always shows). */
  visibleColumns?: Set<string>;
  /** Column-header sorting — wire all three to enable clickable sort headers. */
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
  /**
   * FEA-4021: persisted data-column order (ids) + change handler for drag/keyboard
   * reorder. Forwarded to the table; absent → static headers.
   */
  columnOrder?: readonly string[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
  /** Render bare so the host owns a single bounded scroll container. */
  hostScroll?: boolean;
  /** ISS-5315: the View menu's "Group by" dimension, forwarded to the table. */
  groupBy?: SessionGroupBy;
  /**
   * FEA-4209 / FEA-4210: forwarded straight to `SyncedSessionsTable` — see
   * `SyncedSessionsTableProps` for what the opt-in and the route builder mean.
   *
   * Threaded through this shared body rather than left to the table, because
   * the desktop Sessions list reaches the table only through here: without the
   * pass-through, a cloud-mode desktop had the fields in hand and no way to
   * ask for the columns (wongk review).
   */
  showLinkedEntityColumns?: boolean;
  /** @see AgentSessionsListContentProps.showLinkedEntityColumns */
  getIssueHref?: (artifact: SessionLinkedArtifact) => string | null;
  /**
   * PRD-536 §5: whether any desktop compute target has ever connected to this
   * org. Only consulted when the list is empty and no explicit `emptyState` is
   * provided, to distinguish two very different zero-row states:
   * - `false` → the org has never connected an agent, so show an onboarding
   *   "connect your desktop agent" CTA rather than a filters message.
   * - `true`/`undefined` → an agent has connected (or the signal is still
   *   unknown), so keep the neutral "no sessions match your filters" message and
   *   never flash onboarding at an already-connected org.
   */
  hasConnectedAgent?: boolean;
  /**
   * PRD-536 §5: the actual call-to-action rendered inside the onboarding empty
   * state (only when `hasConnectedAgent === false`). Supplied by the host so
   * this shared component stays surface-agnostic — the web Sessions page passes
   * a Link to its org-scoped compute-target settings, the desktop shell points
   * at its own connect flow. Omit it to fall back to prose-only onboarding.
   */
  onboardingAction?: ReactNode;
  /**
   * FEA-4181: real signals the honest empty state derives its reason from — did
   * the read error / is the source unhydrated, are filters active, and the
   * scope's total-before-filters (`total>0 && visible=0 ⇒ filtered`). Omitted
   * when the host supplies an explicit `emptyState`, or defaults to a
   * genuinely-empty read (no filters, hydrated, succeeded).
   */
  emptySignals?: ListEmptyStateSignals;
  /** FEA-4181: clear/expand the active filters from a filtered empty. */
  onClearFilters?: () => void;
  /** FEA-4181: retry the failed read from the unavailable state. */
  onRetry?: () => void;
  /**
   * ISS-4534: a host-owned recovery affordance (a "Clear filters and reload"
   * Link back to the Sessions list root) rendered as the single primary action of
   * the errored unavailable state, so the error card is never a dead end.
   * Forwarded straight to `SessionsEmptyState`.
   */
  errorRecoveryAction?: ReactNode;
  /**
   * FEA-4181 (review cid 3653690775): among unavailable states, is the local
   * session source still coming up (vs a failed read)? A syncing source renders
   * a quiet holding message with no error chrome and no Retry. Desktop-only; the
   * web page has no local source and never sets it.
   */
  isSyncing?: boolean;
};

export function AgentSessionsListContent({
  items,
  isLoading,
  getSessionHref,
  emptyState,
  loadingClassName = "h-[320px] w-full",
  visibleColumns,
  sortBy,
  sortDir,
  onSort,
  columnOrder,
  onColumnOrderChange,
  hostScroll,
  groupBy,
  showLinkedEntityColumns,
  getIssueHref,
  hasConnectedAgent,
  onboardingAction,
  emptySignals,
  onClearFilters,
  onRetry,
  errorRecoveryAction,
  isSyncing,
}: AgentSessionsListContentProps) {
  if (isLoading) {
    return <Skeleton className={loadingClassName} />;
  }

  if (items.length === 0) {
    return (
      emptyState ?? (
        <SessionsEmptyState
          errorRecoveryAction={errorRecoveryAction}
          hasConnectedAgent={hasConnectedAgent}
          isSyncing={isSyncing}
          onboardingAction={onboardingAction}
          onClearFilters={onClearFilters}
          onRetry={onRetry}
          signals={
            emptySignals ?? {
              isUnavailable: false,
              hasActiveFilters: false,
            }
          }
        />
      )
    );
  }

  return (
    <SyncedSessionsTable
      columnOrder={columnOrder}
      getIssueHref={getIssueHref}
      getSessionHref={getSessionHref}
      groupBy={groupBy}
      hostScroll={hostScroll}
      items={items}
      onColumnOrderChange={onColumnOrderChange}
      onSort={onSort}
      showLinkedEntityColumns={showLinkedEntityColumns}
      sortBy={sortBy}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );
}

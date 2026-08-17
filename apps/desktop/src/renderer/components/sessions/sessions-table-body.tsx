import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@closedloop-ai/design-system/components/ui/alert";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import type { SortDirection } from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import type { ListEmptyStateSignals } from "@repo/api/src/list-empty-state";
import type {
  AgentSessionListItem,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import { AgentSessionsListContent } from "@repo/app/agents/components/sessions/agent-sessions-list";
import type { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import type {
  SessionSortDir,
  SessionSortKey,
} from "@repo/app/agents/lib/session-sort-group";
import { Loader2, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import type {
  LoadingStallPhase,
  LoadingStallThresholds,
} from "../../hooks/use-loading-stall";
import { desktopSessionDetailHref } from "../../shared-agent-sessions/session-hrefs";

/**
 * FEA-3639 — the max-wait budget for a blocking Sessions-list load. At `softMs`
 * the spinner gains a "still loading… / Retry" affordance; at `hardMs` it flips
 * to an actionable "temporarily unavailable" error with the same retry — so the
 * list never sits on an infinite skeleton (the reported stall). Tuned to the
 * ticket's ~10 s / ~30 s recommendations.
 */
export const SESSIONS_LIST_STALL_THRESHOLDS: LoadingStallThresholds = {
  softMs: 10_000,
  hardMs: 30_000,
};

/** Error / table body for the desktop Sessions view. */
export function SessionsTableBody({
  hasData,
  isLoading,
  sessions,
  sortBy,
  sortDir,
  onSort,
  columnOrder,
  onColumnOrderChange,
  visibleColumns,
  groupBy,
  hostScroll,
  loadingLabel,
  hasConnectedAgent,
  emptySignals,
  isSyncing,
  onClearFilters,
  onRetry,
  errorRecoveryAction,
  stallPhase,
  showLinkedEntityColumns,
  getIssueHref,
}: {
  hasData: boolean;
  isLoading: boolean;
  sessions: AgentSessionListItem[];
  sortBy: SessionSortKey | null;
  sortDir: SessionSortDir;
  onSort: (column: string, direction: SortDirection) => void;
  columnOrder?: readonly string[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
  visibleColumns: Set<string>;
  /** ISS-5315: the View menu's "Group by" dimension, forwarded to the list. */
  groupBy?: SessionGroupBy;
  hostScroll?: boolean;
  loadingLabel?: string;
  hasConnectedAgent?: boolean;
  emptySignals: ListEmptyStateSignals;
  /**
   * FEA-4181: among unavailable states, is the local session source still coming
   * up (vs a failed read)? A syncing source renders the quiet holding message (no
   * error chrome / Retry) while a real error gets the destructive alert + Retry.
   */
  isSyncing?: boolean;
  onClearFilters: () => void;
  onRetry: () => void;
  /**
   * ISS-4534: a Link back to the Sessions list root, rendered beside Retry in the
   * errored honest-empty state so the error card is not a dead end. Forwarded to
   * `AgentSessionsListContent` → `SessionsEmptyState`.
   */
  errorRecoveryAction?: ReactNode;
  stallPhase: LoadingStallPhase;
  /**
   * FEA-4209 / FEA-4210 (wongk review): the linked-entity columns' host opt-in
   * and issue-route builder, forwarded to the shared list body.
   *
   * Desktop is where the opt-in earns its keep, and it is per-MODE rather than
   * per-surface: cloud-mode rows come from the same HTTP list the web app reads
   * and carry `project`/`linkedArtifacts`, local-mode rows come from the local
   * producer and carry neither. See `useDesktopLinkedEntityColumns`.
   */
  showLinkedEntityColumns?: boolean;
  /** @see SessionsTableBody.showLinkedEntityColumns */
  getIssueHref?: (artifact: SessionLinkedArtifact) => string | null;
}): ReactNode {
  if (isLoading && !hasData) {
    const label = loadingLabel ?? "Loading sessions...";
    // FEA-3639: bound the spinner so a stuck load — the local source wedged
    // "starting", or a hung db-host read with no query-level timeout — can never
    // spin forever. Soft keeps the spinner but adds a Retry; hard flips to the
    // actionable "temporarily unavailable" + Retry.
    if (stallPhase === "hard") {
      // ISS-4534 (review): the hard-stall branch is NOT a settled read error —
      // `isBlockingLoad` requires the source to be available and the first list
      // read still pending, so nothing has failed yet. The honest recovery for a
      // wedged-but-not-errored load is Retry (which re-arms the stall detector's
      // budget), not "Clear filters and reload" — clearing the user's scope here
      // would silently discard filters they picked while nothing was actually
      // wrong with them. So the recovery Link is deliberately NOT threaded in
      // here; it belongs only to the settled-error empty state below.
      return <SessionsUnavailableState onRetry={onRetry} />;
    }
    if (stallPhase === "soft") {
      return <SessionsSlowLoadingState label={label} onRetry={onRetry} />;
    }
    return <SessionsListLoadingState label={label} />;
  }

  if (loadingLabel) {
    return <SessionsListLoadingState label={loadingLabel} />;
  }

  // FEA-4181: a transient error on a live (DB-change-driven) background refetch
  // that still has last-good rows keeps them rendered and recovers on the next
  // event (PLN-941 §5). Only an errored/unhydrated read with NO rows reaches the
  // honest empty state below, where `emptySignals.isUnavailable` routes it to the
  // "couldn't load / still syncing" surface — never a false "no sessions".
  return (
    <AgentSessionsListContent
      columnOrder={columnOrder}
      emptySignals={emptySignals}
      errorRecoveryAction={errorRecoveryAction}
      getIssueHref={getIssueHref}
      getSessionHref={desktopSessionDetailHref}
      groupBy={groupBy}
      hasConnectedAgent={hasConnectedAgent}
      hostScroll={hostScroll}
      isLoading={isLoading && !hasData}
      isSyncing={isSyncing}
      items={sessions}
      onClearFilters={onClearFilters}
      onColumnOrderChange={onColumnOrderChange}
      onRetry={onRetry}
      onSort={onSort}
      showLinkedEntityColumns={showLinkedEntityColumns}
      sortBy={sortBy}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );
}

/**
 * The plain initial loading state: a centered spinner with an accessible live
 * label. Used for the first ~10 s of a load and for the keep-previous refetch
 * label swap, before any stall escalation.
 */
function SessionsListLoadingState({ label }: { label: string }): ReactNode {
  return (
    <div
      aria-live="polite"
      className="flex min-h-80 flex-col items-center justify-center gap-3 border-t text-center text-muted-foreground text-sm"
      role="status"
    >
      <Loader2 aria-hidden="true" className="size-5 animate-spin" />
      <span className="font-medium">{label}</span>
    </div>
  );
}

/**
 * The slow-load state: the spinner is still up, but a load that has run past the
 * soft threshold now also offers a Retry so a user staring at a wedged read has
 * an out before the hard-threshold error. `onRetry` re-runs the read and
 * re-checks the local source.
 */
function SessionsSlowLoadingState({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => void;
}): ReactNode {
  return (
    <div
      aria-live="polite"
      className="flex min-h-80 flex-col items-center justify-center gap-3 border-t text-center text-muted-foreground text-sm"
      role="status"
    >
      <Loader2 aria-hidden="true" className="size-5 animate-spin" />
      <span className="font-medium">{label}</span>
      <Button onClick={onRetry} size="sm" type="button" variant="outline">
        Retry
      </Button>
    </div>
  );
}

/**
 * The actionable "temporarily unavailable" terminal state: shown once a blocking
 * load stalls past the hard threshold (a source stuck "starting" or a hung
 * db-host read with no query-level timeout). Offers a Retry that re-runs the read
 * and re-checks the local source, so recovery never needs an app restart.
 *
 * ISS-4534 (review): this reuses the shared {@link SessionsEmptyState} errored
 * surface's DS `Alert` treatment (icon + title + description) so a stalled load
 * and a settled read error look like ONE failure, not two different products — a
 * user who hits either (depending on whether the read stalled or settled with an
 * error) sees the same honest error chrome. It carries only Retry: a hard stall
 * is a wedged-but-not-errored load where nothing failed, so the "Clear filters
 * and reload" recovery of the settled-error empty (which would discard the user's
 * scope) does not belong here.
 */
function SessionsUnavailableState({
  onRetry,
}: {
  onRetry: () => void;
}): ReactNode {
  return (
    <div className="border-t p-4">
      <Alert variant="error">
        <TriangleAlertIcon className="size-4" />
        <AlertTitle>Sessions are temporarily unavailable</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          The list is taking longer than expected to load.
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

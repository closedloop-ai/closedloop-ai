"use client";

import {
  deriveListEmptyReason,
  ListEmptyReason,
  type ListEmptyStateSignals,
} from "@repo/api/src/list-empty-state";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Clock3Icon, MonitorIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * FEA-4181: the honest zero-row surface for the Sessions list, shared by the web
 * `/sessions` page and the desktop `SessionsView`. It replaces the old single
 * "No sessions found" that could not tell a filtered-away scope from a
 * genuinely-empty one from a failed read.
 *
 * It renders exactly one of the three canonical {@link ListEmptyReason} states,
 * each of which NAMES the reason and (when actionable) offers the fix:
 *
 * - {@link ListEmptyReason.Unavailable} — an errored or still-syncing read. An
 *   error alert (with Retry when the host provides `onRetry`) or a syncing
 *   message; never a false "no sessions" all-clear.
 * - {@link ListEmptyReason.Filtered} — sessions exist but the active filters
 *   (date window / facet / search) exclude all of them. Names the situation and
 *   offers the always-safe "Clear filters" fix.
 * - {@link ListEmptyReason.Empty} — the scope genuinely has no sessions. The
 *   onboarding zero-state (connect a compute target when the org has never
 *   connected an agent; otherwise the neutral "nothing yet").
 */
export type SessionsEmptyStateProps = {
  /** Real signals the reason is derived from (`total>0 && visible=0` ⇒ filtered). */
  signals: ListEmptyStateSignals;
  /** Clear/expand the active filters (offered for a filtered empty). */
  onClearFilters?: () => void;
  /**
   * Retry the failed read. A fallback for the errored unavailable state when no
   * `errorRecoveryAction` is wired — the recovery Link (a superset) is preferred
   * and, when present, renders instead of this.
   */
  onRetry?: () => void;
  /**
   * ISS-4534: the host-owned recovery affordance for the errored unavailable
   * state — a "Clear filters and reload" Link back to the Sessions list root (its
   * filters/search/page cleared). It is the single primary action here, replacing
   * (not sitting beside) Retry, because clearing-and-reloading already re-issues
   * the read and so is a superset of a bare retry. It also fixes the actual
   * dead-end: a read wedged by a stale filter/search URL is escaped by clearing
   * those filters, and the `href` still opens a working list in a new tab on a
   * modified click. Surface-agnostic like {@link onboardingAction}: both shells
   * pass a {@link SessionsRecoveryAction}. Omit it to fall back to Retry-only.
   */
  errorRecoveryAction?: ReactNode;
  /**
   * FEA-4181 (review cid 3653690775): among {@link ListEmptyReason.Unavailable}
   * states, is this the local source still coming up (`true`) rather than a
   * failed read (`false`/omitted)? A syncing source is NOT a breakage: it routes
   * to a quiet, muted holding message with no error chrome and no Retry (nothing
   * to retry — it hydrates on its own). Only a real read error gets the
   * destructive alert + Retry. The web page never sets this (it has no local
   * source), so it always renders the errored surface for an errored read.
   */
  isSyncing?: boolean;
  /**
   * PRD-536 §5: whether any compute target has ever connected to this org. When
   * `false` the genuinely-empty state shows the onboarding CTA; otherwise the
   * neutral "nothing yet" copy. Consulted only for {@link ListEmptyReason.Empty}.
   */
  hasConnectedAgent?: boolean;
  /** The onboarding CTA (a host-owned Link) rendered in the connect-agent empty. */
  onboardingAction?: ReactNode;
  className?: string;
};

/** FEA-4181: the filtered-empty (date window / facet / search narrowing). */
function GenericFilteredEmpty({
  onClearFilters,
}: {
  onClearFilters?: () => void;
}): ReactNode {
  return (
    <EmptyState
      action={
        onClearFilters ? (
          <Button onClick={onClearFilters} type="button" variant="outline">
            Clear filters
          </Button>
        ) : undefined
      }
      description="No sessions match the current filters. Try clearing or widening a filter."
      icon={Clock3Icon}
      size="compact"
      title="No matching sessions"
    />
  );
}

/**
 * FEA-4181 (review cid 3653690775): the ERRORED unavailable state — the read
 * genuinely failed. An honest destructive alert with a Retry the host wires to
 * re-run the failed read. This is the ONLY unavailable surface that gets error
 * chrome; a source that simply hasn't hydrated yet routes to {@link SyncingEmpty}.
 *
 * ISS-4534: the recovery affordance the host supplies (`errorRecoveryAction`) is
 * the single primary action here — a "Clear filters and reload" Link that clears
 * the active filters (the query-key change then re-issues the read) and, via its
 * `href`, still opens a working list in a new tab on a modified click. It is a
 * superset of a bare re-run, so it REPLACES Retry rather than sitting beside it:
 * two buttons where the second did everything the first did made the card read as
 * if it were guessing at the problem. Hosts that wire only `onRetry` (no recovery
 * Link) still fall back to a lone Retry so the card is never actionless.
 */
function ErroredEmpty({
  onRetry,
  errorRecoveryAction,
}: {
  onRetry?: () => void;
  errorRecoveryAction?: ReactNode;
}): ReactNode {
  // review cid 3653690781: the Alert sits flush (default full width) so the host
  // container — a `CardContent` on web, the desktop panel — owns the inset, the
  // same as the sibling EmptyState surfaces; no self-inset `mx-4 my-6` that
  // lands it 40px off a `px-6` card edge while its siblings sit at 24px.
  return (
    <Alert variant="error">
      <TriangleAlertIcon className="size-4" />
      <AlertTitle>Couldn't load sessions</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        Something went wrong loading your sessions.
        {/* Prefer the host's "Clear filters and reload" recovery Link (the honest
            superset action). Only when no recovery Link is wired do we fall back
            to a lone Retry, so the errored card always has exactly one action. */}
        {errorRecoveryAction ??
          (onRetry ? (
            <Button onClick={onRetry} size="sm" type="button" variant="outline">
              Retry
            </Button>
          ) : null)}
      </AlertDescription>
    </Alert>
  );
}

/**
 * FEA-4181 (review cid 3653690775): the SYNCING unavailable state — the local
 * session source isn't serving reads yet. This is not a breakage, so it carries no
 * error chrome and no Retry (there's nothing to retry — the source hydrates on its
 * own). A quiet, muted holding message that never masquerades as either a failure
 * or a false "no sessions".
 *
 * ISS-4483: this surface now also covers a TRANSIENT read failure — the local
 * db-host restarting / still importing mid-backfill — which the read auto-retries
 * and recovers from on its own.
 *
 * review cid 3679535433 / 3679535435: the copy is deliberately true in BOTH cases
 * (a first-launch source that has never connected AND a live source that dropped
 * out mid-read) and names neither internal state — a brand-new user is never told
 * we're "reconnecting" to something they never had, and we never leak our
 * "local session source" jargon or hand them a state machine to disambiguate.
 */
function SyncingEmpty(): ReactNode {
  return (
    <EmptyState
      description="We're still pulling in sessions from this machine. They'll show up here as soon as they're ready."
      icon={Clock3Icon}
      size="compact"
      title="Getting your sessions ready"
    />
  );
}

/**
 * PRD-536 §5: the genuinely-empty onboarding state. When the org has never
 * connected a compute target (`hasConnectedAgent === false`) it shows the
 * connect CTA; otherwise (an agent has connected, or the signal is still
 * unknown) the neutral "nothing yet" copy — never misleading an already-onboarded
 * org into thinking it hasn't connected.
 */
function GenuinelyEmpty({
  hasConnectedAgent,
  onboardingAction,
}: {
  hasConnectedAgent?: boolean;
  onboardingAction?: ReactNode;
}): ReactNode {
  if (hasConnectedAgent === false) {
    return (
      <EmptyState
        action={onboardingAction}
        description="Connect a compute target with desktop agent-session sync enabled to start syncing sessions."
        icon={MonitorIcon}
        size="compact"
        title="No sessions synced yet"
      />
    );
  }

  return (
    <EmptyState
      description="Sessions appear here once your connected compute targets sync their agent history."
      icon={Clock3Icon}
      size="compact"
      title="No sessions yet"
    />
  );
}

export function SessionsEmptyState({
  signals,
  onClearFilters,
  onRetry,
  errorRecoveryAction,
  hasConnectedAgent,
  onboardingAction,
  isSyncing,
}: SessionsEmptyStateProps): ReactNode {
  const reason = deriveListEmptyReason(signals);

  if (reason === ListEmptyReason.Unavailable) {
    return isSyncing ? (
      <SyncingEmpty />
    ) : (
      <ErroredEmpty
        errorRecoveryAction={errorRecoveryAction}
        onRetry={onRetry}
      />
    );
  }

  if (reason === ListEmptyReason.Filtered) {
    return <GenericFilteredEmpty onClearFilters={onClearFilters} />;
  }

  return (
    <GenuinelyEmpty
      hasConnectedAgent={hasConnectedAgent}
      onboardingAction={onboardingAction}
    />
  );
}

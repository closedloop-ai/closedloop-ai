"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { GitBranchIcon, TriangleAlertIcon } from "lucide-react";

/**
 * Shared zero-state for the Branches list, rendered by both the web `/branches`
 * page and the desktop Branches view so the two surfaces cannot drift on copy or
 * scale (bot review #3663 — the copy was duplicated verbatim across both).
 *
 * FEA-4181: it distinguishes the three honest zero-row reasons via
 * {@link BranchesEmptyVariant} — the same filtered / genuinely-empty /
 * unavailable trichotomy the Sessions surface derives from
 * {@link @repo/api/src/list-empty-state#ListEmptyReason}:
 *
 * - `no-branches` — the org has no branches at all (onboarding: connect a
 *   provider). Only render this when the read is unfiltered AND succeeded; a
 *   windowed read that came back empty is NOT "no branches", it is "none in this
 *   window", and a failed read is `unavailable`, never "no branches".
 * - `no-matches` — branches exist but none match the active date window/filters.
 *   When a date window is narrowing the result (`onShowAllTime` provided), it
 *   hands the user a "Show all time" action instead of telling them to go widen
 *   the range themselves, mirroring the judges-analytics date-range empty state.
 * - `unavailable` — the read errored. An honest error surface with an inline
 *   Retry (`onRetry`), never a false "no branches" all-clear. Both surfaces
 *   route this variant only on `isError && !hasRows`, so the copy names the
 *   failure plainly (review cid 3653690778 — it no longer hedges "…or they're
 *   still syncing", which was never a reachable state here). Consolidates the
 *   error `Alert` both surfaces previously hand-rolled and duplicated verbatim.
 *
 * Loading is still NOT an empty state — the host renders a spinner separately so
 * it never masquerades as "no branches".
 */
export const BranchesEmptyVariant = {
  NoBranches: "no-branches",
  NoMatches: "no-matches",
  Unavailable: "unavailable",
} as const;
export type BranchesEmptyVariant =
  (typeof BranchesEmptyVariant)[keyof typeof BranchesEmptyVariant];

export type BranchesEmptyStateProps = {
  variant: BranchesEmptyVariant;
  /**
   * Reset the date window to all-time. Provided by the host only when a bounded
   * window is active AND the empty is a `no-matches` filtered empty; wired to the
   * "Show all time" action so the filtered-empty state is actionable.
   */
  onShowAllTime?: () => void;
  /**
   * FEA-4181: retry the failed read. Provided by the host for the `unavailable`
   * variant; wired to the inline "Retry" action.
   */
  onRetry?: () => void;
};

export function BranchesEmptyState({
  variant,
  onShowAllTime,
  onRetry,
}: Readonly<BranchesEmptyStateProps>) {
  if (variant === BranchesEmptyVariant.Unavailable) {
    // review cid 3653690778 / 3653690781 parity: the Alert sits flush at full
    // width so the host container owns the inset (no self `mx-4 my-6`), the
    // copy names the failure plainly, and Retry stays default size — matching
    // the Sessions errored surface this variant was extracted to share.
    return (
      <Alert variant="error">
        <TriangleAlertIcon className="size-4" />
        <AlertTitle>Couldn't load branches</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          Something went wrong loading your branches.
          {onRetry ? (
            <Button onClick={onRetry} type="button" variant="outline">
              Retry
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }

  if (variant === BranchesEmptyVariant.NoMatches) {
    return (
      <EmptyState
        action={
          onShowAllTime ? (
            <Button onClick={onShowAllTime} type="button" variant="outline">
              Show all time
            </Button>
          ) : undefined
        }
        description={
          onShowAllTime
            ? "No branches were active in the selected date range."
            : "No branches match the current filters. Try clearing a filter."
        }
        icon={GitBranchIcon}
        size="compact"
        title="No matching branches"
      />
    );
  }

  // review cid 3653690784: the two shared list empties now share the DS
  // `size="compact"` in-panel scale so Branches and Sessions no longer sit at
  // different sizes.
  return (
    <EmptyState
      description="Branches appear here once they're synced from your connected provider."
      icon={GitBranchIcon}
      size="compact"
      title="No branches yet"
    />
  );
}

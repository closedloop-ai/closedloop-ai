"use client";

import { ListEmptyReason } from "@repo/api/src/list-empty-state";
import { renderListLoadingBody } from "../../shared/components/list-loading-body";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import type { LoadingStallPhase } from "../../shared/lib/loading-stall-phase";
import {
  type BranchesListState,
  BranchesListStateKind,
} from "../lib/branch-list-state";
import {
  BRANCHES_LIST_LOADING_COPY,
  BRANCHES_LISTING_LOADING_PARITY_FEATURE_FLAG_KEY,
} from "../lib/branches-list-loading-labels";
import {
  BranchesEmptyState,
  BranchesEmptyVariant,
} from "./branches-empty-state";
import {
  type BranchesStallCta,
  BranchesStallCtaSlot,
} from "./branches-stall-cta";

const STATUS_CLASS_NAME =
  "py-12 text-center text-[var(--muted-foreground)] text-sm";

/**
 * ISS-9429: renders every non-row Branches list state, so the v1 body and the v2
 * body share one rendering of the ladder as well as one
 * {@link resolveBranchesListState} decision behind it. A body that still owned
 * its own loading markup or its own reason→variant mapping is a body that can
 * drift from its sibling again.
 *
 * ISS-10645 extends that from "the two Branches bodies" to "every listing": the
 * loading rung now resolves from {@link renderListLoadingBody}, the module the
 * Sessions listing already resolves its own three states from, so a wedged read
 * cannot look like a settled one here while Sessions bounds it. The flag is read
 * ONCE, and it picks between two whole shapes rather than being threaded into
 * one.
 */
export function BranchesListStateView({
  onRetry,
  onShowAllTime,
  stallCta,
  stallPhase = "none",
  state,
}: Readonly<{
  onRetry: () => void;
  onShowAllTime: () => void;
  /** Account connection action retained while a slow read remains pending. */
  stallCta?: BranchesStallCta;
  /** ISS-10645: how long the blocking read has run. @see LoadingStallPhase */
  stallPhase?: LoadingStallPhase;
  state: Exclude<
    BranchesListState,
    { kind: typeof BranchesListStateKind.Rows }
  >;
}>) {
  const loadingParityEnabled = useFeatureFlagEnabledOptional(
    BRANCHES_LISTING_LOADING_PARITY_FEATURE_FLAG_KEY
  );
  if (state.kind === BranchesListStateKind.Loading) {
    if (!loadingParityEnabled) {
      return <div className={STATUS_CLASS_NAME}>Loading branches…</div>;
    }
    return renderListLoadingBody({
      copy: BRANCHES_LIST_LOADING_COPY,
      hasData: false,
      isLoading: true,
      loadingLabel: undefined,
      stallAction: <BranchesStallCtaSlot {...stallCta} />,
      stallPhase,
    });
  }
  if (state.reason === ListEmptyReason.Unavailable) {
    return (
      <div className="px-4">
        <BranchesEmptyState
          onRetry={onRetry}
          variant={BranchesEmptyVariant.Unavailable}
        />
      </div>
    );
  }
  if (state.reason === ListEmptyReason.Filtered) {
    return (
      <BranchesEmptyState
        onShowAllTime={state.offerShowAllTime ? onShowAllTime : undefined}
        variant={BranchesEmptyVariant.NoMatches}
      />
    );
  }
  return <BranchesEmptyState variant={BranchesEmptyVariant.NoBranches} />;
}

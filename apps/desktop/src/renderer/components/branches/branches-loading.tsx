import { CardDensity } from "@closedloop-ai/design-system/components/ui/card-density";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import {
  BRANCH_METRIC_DICTIONARY,
  type BranchMetricId,
} from "@repo/api/src/types/branch-metrics";
import {
  BRANCHES_LIST_LOADING_COPY,
  BRANCHES_LISTING_LOADING_PARITY_FEATURE_FLAG_KEY,
} from "@repo/app/branches/lib/branches-list-loading-labels";
import { CANONICAL_BRANCH_SUMMARY_CARD_IDS } from "@repo/app/branches/lib/branches-summary-card-ids";
import { renderListLoadingBody } from "@repo/app/shared/components/list-loading-body";
import {
  SummaryCardRow,
  summaryCardClass,
} from "@repo/app/shared/components/summary-card-row";
import { SummaryMetricsLoadingRow } from "@repo/app/shared/components/summary-metrics-loading-row";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { LIST_SUMMARY_LOADING_DETAIL } from "@repo/app/shared/lib/list-summary-loading-detail";

// The skeleton must reflow exactly as the live strip does, so it mounts the SAME
// `SummaryCardRow` with the SAME `wrapBelow` that `branches-view.tsx` passes
// (ISS-4787 follow-up: a hand-copied layout class here would drift the moment the
// shared per-card floor changed, and the fallback would settle into a different
// column count than the view it covers). `summary-card-row` is a leaf module, so a
// static import of it costs the eager bundle nothing like importing
// `branches-view.tsx` would — that is what the code split this skeleton exists to
// cover was protecting against.

const CARD_KEYS = ["a", "b", "c", "d"] as const;
const ROW_KEYS = ["r1", "r2", "r3", "r4", "r5", "r6"] as const;

/**
 * Loading treatment for the desktop `/branches` route (FEA-2932). Used as the
 * Suspense fallback while the lazy `BranchesView` chunk loads on first
 * navigation. Without it the whole content area showed a plain centered
 * "Loading…" on a blank canvas for the ~200ms fetch, then the cards + table
 * snapped in at once. This renders the page scaffold — a toolbar bar, the
 * metric row, and a table placeholder — so the layout is stable and
 * the reveal is calm instead of a hard blank-then-full flash.
 *
 * Layout intentionally matches `BranchesViewContent`: a fixed top toolbar bar,
 * then a scroll region holding the cards above the table.
 */
export function BranchesLoading() {
  const loadingParityEnabled = useFeatureFlagEnabledOptional(
    BRANCHES_LISTING_LOADING_PARITY_FEATURE_FLAG_KEY
  );
  // One branch, one whole scaffold. The gate decides all three of this page's
  // loading pieces together — how it announces itself, what the card strip is,
  // and what fills the table region — so the boolean never leaves this line.
  // This fallback STATES metric labels, so it names the row the strip is about
  // to paint (`approved-branches-summary-cards.tsx` reads the same list) —
  // otherwise the placeholder is a wrong claim rather than a quiet one.
  const { announcement, summary, body } = loadingParityEnabled
    ? sharedTreatment(CANONICAL_BRANCH_SUMMARY_CARD_IDS)
    : skeletonTreatment();
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="branches-loading-skeleton"
      {...announcement}
    >
      {/* Toolbar bar — mirrors the fixed filter bar (border-b, same padding). */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
        <Skeleton className="h-8 w-40 rounded-md" />
        <Skeleton className="h-8 w-28 rounded-md" />
        <Skeleton className="ml-auto h-8 w-24 rounded-md" />
      </div>

      {/* Scroll region — cards above the table, same gutters as the live view. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="sticky left-0 flex flex-col gap-3 px-4 pt-4 pb-3">
          {summary}
        </div>
        {body}
      </div>
    </div>
  );
}

/**
 * ISS-10645's treatment: the same labelled card strip and the same loading body
 * the live Branches listing resolves from, so the chunk resolving is a swap
 * between two renderings of one design rather than between two designs.
 *
 * No outer announcement: the body below is itself a labelled live region and the
 * cards carry captions, so keeping one here would announce a single wait twice.
 */
function sharedTreatment(cardIds: readonly BranchMetricId[]) {
  return {
    announcement: {} as const,
    summary: (
      <SummaryMetricsLoadingRow
        cardClassName={summaryCardClass(true)}
        // Labels only, from the React-free id list: the info popovers live on
        // the live strip's card specs, and importing that module would pull the
        // lazy Branches slice into the eager bundle and defeat the code split
        // this fallback exists to cover.
        cards={cardIds.map((id) => ({
          key: id,
          label: BRANCH_METRIC_DICTIONARY[id].label,
        }))}
        loadingDetail={LIST_SUMMARY_LOADING_DETAIL}
        wrapBelow
      />
    ),
    body: renderListLoadingBody({
      copy: BRANCHES_LIST_LOADING_COPY,
      hasData: false,
      isLoading: true,
      loadingLabel: undefined,
      stallPhase: "none",
    }),
  };
}

/**
 * The shipped treatment: anonymous blocks with no text anywhere, which is why
 * this is the arm that has to name what is loading on the wrapper itself.
 *
 * `SummaryCardRow` rather than a bare div: it publishes the `--summary-card-min`
 * custom property the grid's tracks read, so the fallback reflows into exactly
 * the column count the live strip will — pinned `Compact` (ISS-10540) for the
 * same reason the live strip is.
 */
function skeletonTreatment() {
  return {
    announcement: {
      "aria-label": "Loading branches",
      "aria-live": "polite",
      role: "status",
    } as const,
    summary: (
      <SummaryCardRow busy density={CardDensity.Compact} wrapBelow>
        {CARD_KEYS.map((key) => (
          <Skeleton className="h-[112px] rounded-xl" key={key} />
        ))}
      </SummaryCardRow>
    ),
    body: (
      <div className="flex flex-col gap-2 px-4 pb-4">
        {ROW_KEYS.map((key) => (
          <Skeleton className="h-10 w-full rounded-md" key={key} />
        ))}
      </div>
    ),
  };
}

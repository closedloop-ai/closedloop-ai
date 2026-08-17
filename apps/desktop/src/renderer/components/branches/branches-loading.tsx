import { SummaryCardRow } from "@repo/app/shared/components/summary-card-row";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";

// The skeleton must reflow exactly as the live strip does, so it mounts the SAME
// `SummaryCardRow` with the SAME `wrapBelow` that `branches-view.tsx` passes
// (ISS-4787 follow-up: a hand-copied layout class here would drift the moment the
// shared per-card floor changed, and the fallback would settle into a different
// column count than the view it covers). `summary-card-row` is a leaf module, so a
// static import of it costs the eager bundle nothing like importing
// `branches-view.tsx` would — that is what the code split this skeleton exists to
// cover was protecting against.

const CARD_KEYS = ["a", "b", "c", "d", "e"] as const;
const ROW_KEYS = ["r1", "r2", "r3", "r4", "r5", "r6"] as const;

/**
 * Loading treatment for the desktop `/branches` route (FEA-2932). Used as the
 * Suspense fallback while the lazy `BranchesView` chunk loads on first
 * navigation. Without it the whole content area showed a plain centered
 * "Loading…" on a blank canvas for the ~200ms fetch, then the cards + table
 * snapped in at once. This renders the page scaffold — a toolbar bar, the
 * five-card metric row, and a table placeholder — so the layout is stable and
 * the reveal is calm instead of a hard blank-then-full flash.
 *
 * Layout intentionally matches `BranchesViewContent`: a fixed top toolbar bar,
 * then a scroll region holding the cards above the table.
 */
export function BranchesLoading() {
  return (
    <div
      aria-label="Loading branches"
      aria-live="polite"
      className="flex h-full min-h-0 flex-col"
      data-testid="branches-loading-skeleton"
      role="status"
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
          {/* The row itself, not a bare div: it publishes the
              `--summary-card-min` custom property the grid's tracks read, so the
              fallback reflows into exactly the column count the live strip will. */}
          <SummaryCardRow busy wrapBelow>
            {CARD_KEYS.map((key) => (
              <Skeleton className="h-[112px] rounded-xl" key={key} />
            ))}
          </SummaryCardRow>
        </div>

        <div className="flex flex-col gap-2 px-4 pb-4">
          {ROW_KEYS.map((key) => (
            <Skeleton className="h-10 w-full rounded-md" key={key} />
          ))}
        </div>
      </div>
    </div>
  );
}

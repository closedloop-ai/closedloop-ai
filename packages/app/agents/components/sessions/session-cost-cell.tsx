"use client";

import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { CostAvailability } from "../../lib/cost-availability";

/**
 * ISS-5840 — the Sessions list Cost cell, as PLAIN TEXT.
 *
 * ## What changed, and what the pill actually was
 *
 * The Cost column used to route through the table's shared `renderTooltipChip`
 * helper, whose scaffold is `Tooltip → Chip variant="outline"` — an outlined
 * pill. Product's ask (Mike, 2026-08-10) is "just show the numbers", which is
 * also what this repo's own frontend rule already says: *no badge where a plain
 * string works*. A cost is a number on a continuous scale. The pill encodes no
 * state, no category and no threshold, so it was decoration carrying no
 * information — and it was decoration that COST WIDTH, which is why `$1,226….`
 * truncated inside its own border in a column that had no width to spare.
 *
 * ## ⚠️ The `$1.01` exception, answered rather than deleted
 *
 * In the reported screenshot twelve rows rendered a pill and exactly one —
 * `$1.01` — rendered as bare text. That was NOT a bug, and it was not random:
 * the pill was never keyed on the cost at all. It was keyed on whether the row
 * had a TOOLTIP, because `renderTooltipChip` was the only path that drew one.
 *
 * `COST_TOOLTIP` (`lib/cost-availability.ts`) is an exhaustive map, and
 * `CostAvailability.Available` — a genuinely priced, non-subscription cost — is
 * deliberately mapped to `null`: a real figure needs no explanation. So an
 * `Available` row fell to the bare-text branch and every other priced row
 * (`Subscription`, "Billed through your subscription") took the chip branch.
 * `$1.01` was the one API-billed row in a column of subscription-covered ones.
 *
 * The behaviour that exception represented is therefore REAL and is preserved
 * here in full: rows with something to explain still carry the explanation, rows
 * without one still render clean. What is removed is only the chrome — and
 * removing it is what makes the twelve rows and the one row finally look alike,
 * which was the visible defect underneath the ask.
 *
 * ## The tooltip keeps its keyboard path
 *
 * The chip supplied `interactive tabIndex={0}`, so the explanation was reachable
 * without a mouse. Dropping to a bare `<span>` would have silently removed that.
 * The trigger stays focusable as a `<button type="button">` — the same lint-clean
 * route `KpiDeltaPlaceholder` takes, because a literal `tabIndex={0}` on a raw
 * `<span>` trips Biome's `noNoninteractiveTabindex`. `cursor-default` is
 * load-bearing: `globals.css` gives every enabled `button` a pointer cursor, and
 * this control has no `onClick` to promise.
 *
 * ## Alignment
 *
 * `tabular-nums` gives every digit the same advance width and the column track
 * right-aligns the cell, so the figures line up for scanning down the column —
 * the thing a centred pill defeated.
 *
 * ## No ellipsis, ever (wongk review)
 *
 * The first cut of this component carried `truncate` on the shared class,
 * inherited from `renderTooltipChip`'s inner span — where it belonged, because
 * `Chip` is `overflow-hidden` and something had to give inside a fixed pill.
 * Lifting it onto the plain path was a regression: the pre-change bare span did
 * NOT truncate, and `Available` rows have no tooltip by contract
 * (`COST_TOOLTIP[Available]` is `null`), so an ellipsized API-billed figure left
 * a sighted reader no way at all to recover the amount.
 *
 * It is also the one thing this column has already been told not to do. The
 * Cost track is 124px — wider than its neighbours — precisely because "Cost is
 * the one Sessions column whose overflow is a LIE rather than an ellipsis: a
 * clipped currency string reads as a smaller number" (ISS-4891, quoted from
 * `SESSIONS_COST_COLUMN_WIDTH_PX`'s own note in
 * `agents/lib/sessions-table-columns.ts`). `$1,226,540.10` rendered as
 * `$1,226,5…` is not a shortened label, it is a different number. So the figure
 * stays whole and the cell declines to clip it; the legibility e2e on both
 * adapters pins `textOverflows: false` for the realistic range, and an
 * over-wide value overflows its track visibly rather than reading as a smaller
 * sum. Widening the track past 124px is ISS-4891's decision, not this cell's.
 */
export function SessionCostCell({
  availability,
  label,
  tooltip,
}: {
  availability: CostAvailability;
  label: string;
  tooltip?: string | null;
}) {
  if (availability === CostAvailability.NoUsage) {
    // Story-only in practice, and deliberately so: `sessions-table.tsx` returns
    // the shared sentinel BEFORE reaching this component, because
    // `isEmptyCellValue` identifies an empty cell by element TYPE and a wrapper
    // hides it. The branch stays so the component is total over its own prop
    // type and the canvas can show the state — production's Cost dash is owned
    // by the table. Same split as `LocPerDollarColumnValue`.
    //
    // Plain `GridEmptyValue`, NOT `alignEnd`: the Cost track already
    // right-aligns its cells (`className: "justify-end"`), and a different class
    // string here would break the one-shared-empty-glyph contract (ISS-4996).
    return <GridEmptyValue />;
  }
  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={`${SESSION_COST_TEXT_CLASS} cursor-default rounded-sm ${CHIP_FOCUS_RING_CLASS}`}
            data-testid={SESSION_COST_CELL_TEST_ID}
            type="button"
          >
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs break-words">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <span
      className={SESSION_COST_TEXT_CLASS}
      data-testid={SESSION_COST_CELL_TEST_ID}
    >
      {label}
    </span>
  );
}

/**
 * The one treatment every Cost cell renders, tooltip or not, so the explained
 * and unexplained rows cannot drift back apart into two looks — which is exactly
 * the defect the `$1.01` row exposed.
 *
 * Deliberately carries NO `truncate`: see "No ellipsis, ever" above. A currency
 * figure is the one string in this grid that cannot be shortened without
 * changing what it says.
 */
const SESSION_COST_TEXT_CLASS = "text-sm tabular-nums";

/** Stable hook for the regression coverage that asserts no chip wrapper. */
export const SESSION_COST_CELL_TEST_ID = "session-cost-cell";

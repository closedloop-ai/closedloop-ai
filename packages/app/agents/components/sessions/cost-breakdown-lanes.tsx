import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import {
  MetricCardLane,
  MetricCardLaneList,
} from "@repo/design-system/components/ui/primitives/metric-card-lane";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { formatCurrencyWhole } from "../../../shared/lib/format-utils";
import {
  type CostCardPresentation,
  CostCardPresentationMode,
} from "./cost-card-presentation";
import { SESSIONS_COST_BREAKDOWN_DISCLOSURE_LABEL } from "./cost-metric-card";

/**
 * ISS-4748 — the Cost card's breakdown lanes: the three buckets that sum to the
 * subscription-inclusive headline.
 *
 * Its own module rather than more weight on `cost-metric-card.tsx`, which is
 * already past the 500-line smell, and because the lane SET is a distinct
 * concern from the card chrome that hosts it.
 */

/** Share of the headline, bounded at BOTH ends. */
const SHARE_LOWER_BOUND = 0.1;
const SHARE_UPPER_BOUND = 99.9;

/**
 * Bounded like the currency formatter, and for the same reason: a real lane
 * worth 0.04% must not read `0.0%`, and a lane that is not the whole total must
 * not read `100.0%`. On the subscription-heavy cohort this card was written for,
 * both bounds are load-bearing rather than theoretical.
 *
 * Always computed from the ORIGINAL amount, never the post-allocation one
 * (whitlockk, #5953): the allocator shifts a lane to make the whole-dollar column
 * reconcile, and grading that shifted figure against the total let the shares
 * exceed 100% and sum to 200%. A share describes the payload's true proportion,
 * which no display rounding may move.
 */
function formatLaneShare(amount: number, total: number): string | undefined {
  if (!(Number.isFinite(amount) && Number.isFinite(total)) || total <= 0) {
    return undefined;
  }
  const share = (amount / total) * 100;
  if (share > 0 && share < SHARE_LOWER_BOUND) {
    return `<${SHARE_LOWER_BOUND.toFixed(1)}%`;
  }
  if (share > SHARE_UPPER_BOUND && share < 100) {
    return `>${SHARE_UPPER_BOUND.toFixed(1)}%`;
  }
  return `${share.toFixed(1)}%`;
}

/**
 * Whole-dollar lane figures that actually sum to the whole-dollar headline.
 *
 * Rounding each lane independently leaves the column a dollar off the total
 * above it, on a card whose info copy promises they sum. The largest lane
 * absorbs the remainder, where it is proportionally smallest.
 *
 * NEVER at the cost of a negative lane: three $0.50 lanes under a $1.50 total
 * round to 1+1+1 against a headline of 2, and the -1 remainder would drive the
 * absorbing lane to -$0.50 — a negative lane beneath a positive total, on the
 * card written to stop the UI lying about money. A column a dollar off is the
 * smaller error and it is visible; a negative lane is neither.
 *
 * And NEVER into or out of a lane below whole-dollar scale (whitlockk, #5953). The
 * whole premise is that ±$1 is rounding-scale noise on the absorbing lane,
 * which is false when that lane is under a dollar at EITHER end of the shift:
 *
 *   - Starting under. $0.40/$0.40/$0.20 against a $1 total pushed the first
 *     lane to $1.40, so the card rendered `$1` beside a `$0.40` it had just
 *     rewritten, and the shares totalled 200%.
 *   - Landing under. $1.40/$0.50/$0.50 against a $2.40 total rounds to 1+1+1
 *     against a headline of 2, and the -1 remainder drove the $1.40 lane to
 *     $0.40 — the largest share, 58.3%, rendering the smallest figure on the
 *     card, under a `$2` headline the column then missed by 40 cents.
 *
 * Sub-dollar lanes are not whole-dollar quantities, so a whole-dollar column
 * simply does not reconcile for them — each renders its own true value instead,
 * which is the honest outcome rather than a manufactured one.
 */
function allocateLaneRounding(
  amounts: readonly number[],
  total: number
): readonly number[] {
  if (!Number.isFinite(total)) {
    return amounts;
  }
  let largestIndex = -1;
  let largestValue = Number.NEGATIVE_INFINITY;
  let roundedSum = 0;
  for (const [index, amount] of amounts.entries()) {
    if (!Number.isFinite(amount)) {
      return amounts;
    }
    roundedSum += Math.round(amount);
    if (amount > largestValue) {
      largestValue = amount;
      largestIndex = index;
    }
  }
  const remainder = Math.round(total) - roundedSum;
  if (remainder === 0 || largestIndex === -1) {
    return amounts;
  }
  const absorbed = largestValue + remainder;
  // BOTH ends of the shift, not just the one the lane started at. The landing
  // half also subsumes the negative case: a negative `absorbed` rounds to at
  // most 0, so it fails this same test rather than needing its own.
  if (Math.round(largestValue) < 1 || Math.round(absorbed) < 1) {
    return amounts;
  }
  return amounts.map((amount, index) =>
    index === largestIndex ? absorbed : amount
  );
}

/**
 * "Billing unknown", never the bare "Unknown": the Sessions Cost FACET already
 * uses that word for the missing-cost population, which renders a dash and
 * contributes nothing. This lane is the opposite — real money whose billing
 * method was never determined — and the retired honest-mode caption (ISS-8791)
 * settled on this same wording for the same collision.
 */
const LANE_LABELS = {
  api: "API-billed",
  subscription: "Subscription-covered",
  unknown: "Billing unknown",
} as const;

/**
 * ISS-8157 — the disclosure trigger. Sentence case: product corrected this from
 * "Cost Breakdown" on 2026-08-25, against the prototype.
 */
export const COST_BREAKDOWN_DISCLOSURE_LABEL = "Cost breakdown";

/** Ties the popover heading to its `role="dialog"` as an accessible name. */
const COST_BREAKDOWN_DISCLOSURE_HEADING_ID =
  "cost-breakdown-disclosure-heading";

/**
 * The lanes for a settled, splittable payload, or `undefined` when there is
 * nothing honest to render.
 *
 * `undefined` covers two different situations on purpose, because the card
 * treats them the same: a payload still loading (no figures to state yet) and a
 * total that could not be priced (nothing about the split is knowable either, so
 * printing `$0.00` lanes under a dashed headline would be the fabricated zero
 * this card exists to stop).
 */
export function buildCostBreakdownLanes(
  usage: AgentSessionUsageSummary | undefined
): ReactNode | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const { totalEstimatedCost, subscriptionEstimatedCost } = usage;
  const metered = usage.meteredEstimatedCost;
  const unknown = usage.unknownEstimatedCost;
  if (
    !(
      Number.isFinite(totalEstimatedCost) &&
      totalEstimatedCost > 0 &&
      Number.isFinite(subscriptionEstimatedCost) &&
      typeof metered === "number" &&
      Number.isFinite(metered) &&
      typeof unknown === "number" &&
      Number.isFinite(unknown)
    )
  ) {
    return undefined;
  }
  const [api, subscription, billingUnknown] = allocateLaneRounding(
    [metered, subscriptionEstimatedCost, unknown],
    totalEstimatedCost
  );
  const lanes = (
    <MetricCardLaneList>
      <MetricCardLane
        label={LANE_LABELS.api}
        share={formatLaneShare(metered, totalEstimatedCost)}
        value={formatCurrencyWhole(api)}
      />
      <MetricCardLane
        label={LANE_LABELS.subscription}
        share={formatLaneShare(subscriptionEstimatedCost, totalEstimatedCost)}
        value={formatCurrencyWhole(subscription)}
      />
      {/* NOT muted (operator decision, 2026-08-26). "Billing unknown" is a
          disclosure rather than a third category of spend, which is what the
          muted treatment was for — but on a subscription-heavy account it is the
          WHOLE non-subscription bucket, and receding the label of the one lane
          that says "we could not determine this" is a softer version of the
          hiding this card exists to undo. All three lanes read equally; the
          reader decides which matters. */}
      <MetricCardLane
        label={LANE_LABELS.unknown}
        share={formatLaneShare(unknown, totalEstimatedCost)}
        value={formatCurrencyWhole(billingUnknown)}
      />
    </MetricCardLaneList>
  );
  // ALWAYS behind the disclosure (operator decision, 2026-08-26), at every
  // width. An earlier revision of this PR kept a second, INLINE copy behind a
  // 19rem container query, on the belief that the strip could never give the
  // lane row the ~300px it needs. That belief was wrong: the strip is an
  // `auto-fit` grid whose empty tracks collapse, so the five cards absorb the
  // remaining width, and a display wider than ~2200px — or hiding a card from
  // the options menu — does reach it. The inline branch was live on real
  // hardware, and product retired it rather than ship a card whose shape
  // depends on the reader's monitor.
  return <CostBreakdownDisclosure>{lanes}</CostBreakdownDisclosure>;
}

/**
 * ISS-8157 — the "Cost breakdown" disclosure.
 *
 * Lives here rather than in `packages/design-system`: `MetricCardLane` owns lane
 * GEOMETRY and is project-agnostic, while WHETHER a surface states its lanes
 * behind a disclosure is a fact about that surface, which only its consumer
 * knows.
 */
function CostBreakdownDisclosure({ children }: { children: ReactNode }) {
  return (
    <Popover>
      {/* `-my-1 h-6` is a real 24px hit target that collapses back into the
          caption's line box. The prototype's first pass measured 18.5px. */}
      <PopoverTrigger className="-my-1 flex h-6 items-center gap-1 rounded-sm text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {COST_BREAKDOWN_DISCLOSURE_LABEL}
        <ChevronDownIcon aria-hidden="true" className="size-3.5" />
      </PopoverTrigger>
      {/* Radix gives this `role="dialog"`, and the heading below is only a
          paragraph inside it, so without the association a screen reader
          announces an unnamed dialog. */}
      <PopoverContent
        align="start"
        aria-labelledby={COST_BREAKDOWN_DISCLOSURE_HEADING_ID}
        className="w-80 p-3"
      >
        <p
          className="pb-2 font-semibold text-[11px] uppercase tracking-[0.12em]"
          id={COST_BREAKDOWN_DISCLOSURE_HEADING_ID}
        >
          {SESSIONS_COST_BREAKDOWN_DISCLOSURE_LABEL}
        </p>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The lane slot for a resolved presentation: lanes in breakdown mode, nothing in
 * `Total` mode, where the producer could not substantiate a partition.
 *
 * Both conditions live HERE rather than at the call site so the card component
 * holds no branch of its own — `AlwaysAvailableCards` is already at the
 * cognitive-complexity ceiling, and either conditional there costs a refactor of
 * a function this change has no other reason to touch.
 */
export function resolveCostBreakdownLanes(
  presentation: Readonly<Pick<CostCardPresentation, "mode">>,
  usage: AgentSessionUsageSummary | undefined,
  dashed: boolean
): ReactNode | undefined {
  if (presentation.mode !== CostCardPresentationMode.Breakdown) {
    return undefined;
  }
  // A DASHED card has declined to state its own value — errored, unpriceable,
  // or the Unknown facet active. Lanes beneath that dash would render real
  // dollar amounts under a card that just said it has none, which is the same
  // contradiction the dash exists to prevent (tamsinb, #5953).
  if (dashed) {
    return undefined;
  }
  return buildCostBreakdownLanes(usage);
}

"use client";

import {
  CostAvailability,
  deriveCostAvailability,
  formatCostLabel,
  getCostTooltip,
} from "@repo/app/agents/lib/cost-availability";
import {
  isSessionDetailDurationClockRelevant,
  resolveSessionDetailDurationEmptyReason,
  resolveSessionDetailDurationWindow,
} from "@repo/app/agents/lib/session-detail-duration-window";
import {
  resolveSessionWallClockLabel,
  SESSION_DURATION_TICK_MS,
} from "@repo/app/agents/lib/session-duration";
import { useCoarseNow } from "@repo/app/shared/hooks/use-coarse-now";
import { formatTokenCount } from "@repo/app/shared/lib/format-utils";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import type { ReactNode } from "react";

/**
 * ISS-5970 — the Session Timeline's run-level summary: what the run cost, how
 * many tokens it burned, and how long it took, on one line in the timeline
 * header.
 *
 * Matches the prototype's strip (`apps/prototypes/app/p/sessions/components/
 * session-timeline.tsx`, the `ml-auto` row beside the heading): value in
 * `text-foreground` with `tabular-nums`, unit in muted text, the three facts
 * trailing the title rather than stacked above the controls.
 *
 * IT DERIVES NOTHING ITSELF, AND THAT IS THE POINT. Every one of the three
 * numbers already exists somewhere else on this same page, so a second
 * derivation here would be a second answer the reader could catch disagreeing
 * with the first:
 *
 *  - COST goes through {@link deriveCostAvailability} + {@link formatCostLabel},
 *    the same availability-then-format pair the Properties Cost row and the Cost
 *    metric card use. That is what keeps ISS-5401/ISS-5572's rule intact: a cost
 *    that could not be computed renders an em-dash with the reason attached,
 *    never a `$0.00` that reads as a genuinely free run.
 *  - DURATION goes through {@link resolveSessionDetailDurationWindow} +
 *    {@link resolveSessionWallClockLabel}, the exact chain
 *    `SessionDurationProperty` runs, ticking on the same
 *    {@link SESSION_DURATION_TICK_MS} while the session is live. Deliberately
 *    NOT the timeline's own `calendar span` caption, which measures the windowed
 *    AXIS rather than the run and would reintroduce the very bar-label-vs-
 *    Properties disagreement ISS-5563/ISS-5578 were filed for.
 *  - TOKENS sums the four counters the detail Tokens metric sums, so the strip
 *    and that card cannot print different totals.
 *
 * ZERO IS NOT UNKNOWN. A session with no token counters recorded renders the
 * em-dash and says why, rather than a confident `0` — a real zero-token run and
 * a run whose usage never synced are different facts and must not read alike.
 *
 * EVERY EXPLANATION IS REACHABLE WITHOUT A MOUSE (#design review). The
 * explanations ride the design-system `Tooltip` on a focusable trigger, the
 * pattern `SessionCostCell` established and documented for this exact reason — a
 * native `title` is mouse-only, so the answer to "why is this a dash" would not
 * exist for a keyboard, touch or screen-reader user.
 */
export function SessionTimelineSummary({
  session,
}: Readonly<{ session: SessionTimelineSummarySession }>) {
  // ISS-5575: the same displayed-status window the Properties Duration row and
  // the Sessions LIST cell resolve, so this strip cannot report a span for a run
  // the rest of the screen has already folded to "Stale". The tick gates on the
  // status predicate rather than on the window, which is now downstream of `now`
  // — see `SessionDurationProperty` for why that ordering is load-bearing.
  const now = useCoarseNow(
    SESSION_DURATION_TICK_MS,
    isSessionDetailDurationClockRelevant(session)
  );
  const durationWindow = resolveSessionDetailDurationWindow({
    awaitingInputSince: session.awaitingInputSince,
    endedAt: session.endedAt,
    lastActivityAt: session.lastActivityAt,
    now,
    startedAt: session.startedAt,
    status: session.status,
  });
  const durationEmptyReason = resolveSessionDetailDurationEmptyReason({
    // ISS-6455: the same two fields `durationWindow` read, so the sentence
    // cannot describe a state the number was not resolved from.
    awaitingInputSince: session.awaitingInputSince,
    endedAt: session.endedAt,
    lastActivityAt: session.lastActivityAt,
    now,
    startedAt: session.startedAt,
    status: session.status,
    window: durationWindow,
  });
  const durationLabel = resolveSessionWallClockLabel(
    session.startedAt ?? null,
    durationWindow,
    now.getTime()
  );
  /*
   * The availability enum is resolved ONCE and everything about cost is asked
   * of it — the label, the explanation, and whether this is a dash at all.
   *
   * Not a string comparison against a re-declared "—" (#review). That literal
   * already lives inside `formatCostLabel`, and branching the honesty behaviour
   * on a copy of it means the day that literal changes, the comparison silently
   * stops matching: the dash would still render, but bare and unexplained, with
   * no failure anywhere. The enum is the contract, so the enum is what is asked.
   */
  const costAvailability = deriveCostAvailability(session);
  const costTooltip = getCostTooltip(costAvailability);
  const costUnavailable = !COST_FIGURE_AVAILABILITIES.has(costAvailability);
  const totalTokens = sumSessionTokens(session);

  /*
   * Placement is the header's job: `.sd3-act-head` is already
   * `flex; justify-content: space-between`, so a second child trails the title
   * without this strip asserting its own margin.
   *
   * `flex-wrap` + `min-w-0` because three facts are ~257px of unbreakable text
   * and a phone gives this row 288px at 320px wide (#4869 design review). Left
   * nowrap, the strip overflowed a `.sd3-scroll` ancestor that is
   * `overflow-x: hidden`, so the third fact was CLIPPED rather than scrollable —
   * `2h 17m elap`. Wrapping is also what the prototype's header row does
   * (`session-timeline.tsx:450`, `flex flex-wrap`) and what the sibling section
   * below already does (`.sd3-segs-headmeta`); this build had just dropped it.
   */
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-muted-foreground text-xs">
      <SummaryFact
        /*
         * Attached whenever the map HAS something to say, not only on the dash
         * (#design review). A subscription run formats a real `$0.00` and still
         * carries "Billed through your subscription" — dropping it there left
         * this screen saying a covered run was free while the Sessions list two
         * clicks away explained it. `COST_TOOLTIP` already returns `null` for
         * the cases that need no explanation, so the map decides, not this.
         */
        tooltip={costTooltip}
        unit="cost"
        value={
          costUnavailable ? (
            <GridEmptyValue />
          ) : (
            formatCostLabel(costAvailability, session.estimatedCost)
          )
        }
      />
      <SummaryFact
        tooltip={resolveTokensTooltip(totalTokens)}
        unit="tokens"
        value={
          totalTokens == null || totalTokens === 0 ? (
            <GridEmptyValue />
          ) : (
            formatTokenCount(totalTokens)
          )
        }
      />
      <SummaryFact
        /*
         * Carries a unit word like its siblings (#design review). The prototype
         * leaves duration bare, which reads fine for `2h 17m` — but the
         * prototype never drew the unmeasurable case, and bare leaves a naked
         * dash on the right edge naming nothing, for eyes and screen readers
         * alike. Cost and tokens survive their own empty state precisely
         * BECAUSE they are named.
         */
        /* ISS-5575: the reason is RESOLVED, not a fixed sentence. It used to say
           "No start time recorded" for every empty Duration, which was true of
           the only population that reached it; the staleness fold routes a much
           larger one here — runs that HAVE a start time, printed two rows away —
           so the fixed string would have pointed the reader at the wrong field.
           Shared with the Properties Duration row so one state has one
           explanation. */
        tooltip={durationEmptyReason}
        unit="elapsed"
        value={durationLabel ?? <GridEmptyValue />}
      />
    </div>
  );
}

/**
 * One `<value> <unit>` pair. Extracted so the three facts cannot drift apart in
 * type scale, weight or number alignment — the hierarchy the prototype sets is a
 * property of the strip, not of each fact.
 *
 * `whitespace-nowrap` because a value and its unit are one token to a reader:
 * without it a narrow container breaks `3h 44m` across two lines, which is a
 * broken number rather than a wrapped label.
 */
function SummaryFact({
  tooltip,
  unit,
  value,
}: Readonly<{
  tooltip: string | null;
  unit: string;
  value: ReactNode;
}>) {
  const body = (
    <>
      <b className="font-semibold text-foreground tabular-nums">{value}</b>
      {` ${unit}`}
    </>
  );
  if (tooltip == null) {
    return <span className="whitespace-nowrap">{body}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`cursor-default whitespace-nowrap rounded-sm ${CHIP_FOCUS_RING_CLASS}`}
          type="button"
        >
          {body}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-words">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The four token counters the detail Tokens metric sums
 * (`detail-content.ts`, "Input + output + cache"). Read from the NON-nullable
 * family on `AgentSessionListItem`; the nullable `tokensIn`/`tokensOut` pair the
 * Properties Tokens row reads is a different, per-counter presentation.
 */
function sumSessionTokens(
  session: SessionTimelineSummarySession
): number | null {
  const total =
    session.inputTokens +
    session.outputTokens +
    (session.cacheReadTokens ?? 0) +
    (session.cacheWriteTokens ?? 0);
  /*
   * A non-finite or negative total means a corrupt counter reached the render,
   * not a small run. Falling through to the em-dash says "not computed", which
   * is true, instead of printing `NaN tokens` or a negative count. No log here:
   * this is a `"use client"` module and the client-debug-logging gate owns that.
   *
   * `null` rather than `0` (#4869 design review), because those are two
   * different facts and this strip's own docstring forbids conflating them:
   * folding corruption into the zero branch printed "No token usage recorded",
   * which is a claim about the RUN, on a session that did record usage we could
   * not trust. Same dash either way — a reader gets no wrong number — but the
   * explanation under it is now true of the case it describes.
   */
  if (!Number.isFinite(total) || total < 0) {
    return null;
  }
  return total;
}

/**
 * Which explanation belongs under the tokens fact. Three inputs, three answers,
 * resolved in one place so the value branch above and the sentence cannot drift
 * into disagreeing about what the dash means.
 */
function resolveTokensTooltip(totalTokens: number | null): string | null {
  if (totalTokens == null) {
    return TOKENS_UNTRUSTWORTHY_TITLE;
  }
  if (totalTokens > 0) {
    return null;
  }
  return TOKENS_UNAVAILABLE_TITLE;
}

/**
 * The availabilities that carry a real figure — the exact pair
 * {@link formatCostLabel} formats rather than dashes. Named here so "is this a
 * dash?" is answered by the same distinction the formatter makes, and a new
 * `CostAvailability` member has one obvious place to be classified.
 */
const COST_FIGURE_AVAILABILITIES: ReadonlySet<CostAvailability> = new Set([
  CostAvailability.Available,
  CostAvailability.Subscription,
]);

const TOKENS_UNAVAILABLE_TITLE = "No token usage recorded for this session";
const TOKENS_UNTRUSTWORTHY_TITLE =
  "Token usage for this session could not be read";

/**
 * The slice of `AgentSessionDetail` the strip reads, declared structurally for
 * the same reason `SessionDurationProperty`'s is: the single production call
 * site passes its `session` straight through, while tests and stories can drive
 * every state from a small literal.
 */
export type SessionTimelineSummarySession = Readonly<{
  status?: string | null;
  startedAt?: Date | string | null;
  endedAt?: Date | string | null;
  /** ISS-5575: the staleness anchor the DISPLAYED status is derived from.
   * See `SessionDurationPropertySession`. */
  lastActivityAt?: Date | string | null;
  /** ISS-5575: the durable awaiting-input signal. See
   * `SessionDurationPropertySession`. */
  awaitingInputSince?: Date | string | null;
  estimatedCost: number;
  billingMode?: string | null;
  turns?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolUseCount?: number;
  model?: string | null;
}>;

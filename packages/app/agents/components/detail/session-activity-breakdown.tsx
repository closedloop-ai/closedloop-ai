"use client";

import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels";
import type {
  ActivitySegment,
  AgentSessionDetail,
} from "@repo/api/src/types/agent-session";
import { SessionTracePhaseSourceType } from "@repo/api/src/types/agent-session";
import { ScrollFadeTrack } from "@repo/app/shared/components/scroll-fade-track";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { formatCompact, formatCost } from "@repo/app/shared/lib/format-utils";
import { largestRemainderPercents } from "@repo/app/shared/lib/percent-shares";
import {
  reconcileDisplayedCostCents,
  toDisplayCents,
} from "@repo/app/shared/lib/reconciled-cost-cents";
import { cn } from "@repo/design-system/lib/utils";
import { UNATTRIBUTED_KEY } from "@repo/lib/branches/activity-rollup";
import {
  buildActivitySegments,
  IDLE_PHASE_KEY,
} from "@repo/lib/sessions/activity-segment-aggregation";
import {
  ActivityBreakdownSlot,
  getPhaseDisplay,
  SHARE_COLUMN_LABEL,
  type ShareColumnLabel,
} from "../../lib/session-activity-phases";
import {
  NO_RESIDUAL_INDEX,
  withUnattributedResidual,
} from "./activity-breakdown-residual";

/**
 * FEA-2275 — the per-session activity breakdown panel. Renders one row per
 * derived {@link ActivitySegment} (per-phase absolute tokens/cost/duration + the
 * relative % share of the session total), a compact proportional bar, the
 * inferred-vs-declared provenance, the numeric confidence, and the honest
 * `other`/`idle` remainders — never hidden or zeroed. The segments come from the
 * shared `@repo/lib` aggregator via the detail projection, so web and desktop
 * render this identically (parity by construction). Pixel-level visual design is
 * owned by the Branches Page handoff; this is data + behavior.
 */
export type SessionActivityBreakdownProps = {
  session: AgentSessionDetail;
};

export function SessionActivityBreakdown({
  session,
}: SessionActivityBreakdownProps) {
  // ISS-5564: closed-by-default gate for the confidence-basis footer sentence.
  // Optional read — this panel also mounts in Storybook and unit tests with no
  // FeatureFlagAdapterProvider, where it resolves off (today's behavior).
  const phaseConfidenceDisclosure = useFeatureFlagEnabledOptional(
    SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY
  );
  const {
    segments: attributedSegments,
    mode,
    rowsTruncated,
  } = resolveActivitySegments(session);
  const costUnavailable = mode === ActivityBreakdownMode.CostUnavailable;
  // ISS-5128: Derived mode reports `sum(segments)` as the session total, but the
  // segments are built over the token events the detail read supplies while
  // `estimatedCost` is a separately-sourced rollup — so when the read supplies
  // fewer events than the rollup covered, the sum under-reports and is presented
  // as the total anyway ($4.46 against a $508.75 Properties cost). Carry the
  // difference in an
  // explicit row so the header stays the sum of the column AND reconciles with
  // the cost shown elsewhere on this screen. Empty/CostUnavailable already
  // reconcile by their own paths, so the residual is scoped to Derived only.
  //
  // Scoped to the UNTRUNCATED case for the SAME reason `reconcileDisplayedCostCents`
  // below is (#4395 review). When the row cap bites, `activitySegments` is a
  // start-ordered PREFIX while `estimatedCost` stays the full rollup, so the
  // shortfall is the cost of phases that were attributed fine and merely cut
  // off. Filing that under a row `packages/api/src/activity-phase-labels.ts`
  // defines as spend the classifier never observed would say the opposite of
  // what happened, and it would contradict the truncation footer directly below
  // it, which is still telling the reader these totals cover only the phases
  // above. Truncated sessions keep the retained-phase total and that footer.
  // ISS-5366 retired the ISS-5000 gate that used to lead this condition, so the
  // residual now turns purely on the mode and the truncation state.
  const residualEnabled =
    mode === ActivityBreakdownMode.Derived && !rowsTruncated;
  const { segments, residualIndex } = residualEnabled
    ? withUnattributedResidual(attributedSegments, session)
    : { residualIndex: NO_RESIDUAL_INDEX, segments: attributedSegments };
  // In the cost-unavailable case the per-segment costs are all 0 (pricing was
  // dropped/incomplete), so the header must show the session's own rollup total
  // rather than a $0.00 that would falsely claim this session was free. In every
  // other mode the per-phase sum IS the reconciled session cost, so it stays
  // authoritative.
  const perPhaseCostTotal = sumBy(segments, (segment) => segment.costUsd);
  const costTotal = costUnavailable
    ? (session.estimatedCost ?? 0)
    : perPhaseCostTotal;
  const durationTotal = sumBy(segments, (segment) => segment.durationMs);
  // The share metric is cost when there is trustworthy per-phase spend to
  // divide, else wall-time — so a cost-unavailable session (per-phase cost
  // dropped) or an unpriced session with real time still shows a duration split
  // rather than a flat empty bar. Shares are always against the SESSION total
  // (incl. `other`/`idle`), so the unclassified gap stays visible.
  //
  // ISS-4685 (wongk): this is derived from the COST SIGNAL, not from the mode.
  // `costUnavailable` answers a narrower question — "were the per-phase cost
  // cells dropped?" — and `Empty` is not in it, so keying the basis off the mode
  // alone claimed a cost basis for every Empty session. But Empty only proves
  // there is no tiling; it proves nothing about pricing. Its single row is
  // priced from `session.estimatedCost`, which is 0 on an unpriced session (no
  // token usage, no billing mode — the desktop seed's shape, where the
  // projection floors a NULL `cost_usd_estimated`), so the panel would have
  // headed the column "Cost %" and described a session-cost share while the rest
  // of session detail showed the cost as unknown. A
  // positive `costTotal` is the same predicate `resolveActivitySegments` already
  // uses to admit the Derived mode, so cost availability now means one thing
  // panel-wide. This flag names the column (SHARE_COLUMN_LABEL) and drives the
  // footer sentence as well as the math, so the label can never claim a basis
  // the column is not computing.
  const costAvailable = !costUnavailable && costTotal > 0;
  const shareByTime = !costAvailable;
  const shareTotal = shareByTime ? durationTotal : costTotal;
  const shareOf = (segment: ActivitySegment): number =>
    shareByTime ? segment.durationMs : segment.costUsd;
  // One reconciled percentage per row, summing to exactly 100 — the SAME
  // largest-remainder helper the sibling branch Cost-to-merge panel uses for the
  // same concept. Per-row `Math.round` renders three equal-cost phases as
  // 33/33/33 = 99, which a column literally headed "Cost %" exposes as a share
  // of the session that does not total the session.
  //
  // `null` (rendered as an em dash) when there is nothing to divide by: a 0%
  // under a "Cost %"/"Time %" header is the unknown-denominator case wearing a
  // true zero's clothes, and the proportional bar already bails on the same
  // condition — so the column must not keep claiming a share the bar declined
  // to draw.
  const shares: (number | null)[] =
    shareTotal > 0
      ? largestRemainderPercents(segments.map(shareOf), shareTotal)
      : segments.map(() => null);
  const activeDurationMs = sumBy(
    segments.filter((segment) => segment.key !== IDLE_PHASE_KEY),
    (segment) => segment.durationMs
  );
  // ISS-5000: the Cost column is presented as the decomposition of the header
  // figure ("Shares are by cost, not time."), so it has to add up to it. Rounding
  // each phase to cents independently of the total let the column shed a cent per
  // row — $24.79 + $3.40 + $3.25 + $0.00 + $1.40 = $32.84 under a $32.86 header.
  // The parts were the wrong side of that: the header is the exact sum of the
  // unrounded attribution and agrees with the Properties strip. So the cents are
  // allocated across the rows instead, exactly as the % column beside them
  // already is. Skipped when the flag is off (today's independent rounding) and
  // on the cost-unavailable path, where every Cost cell reads "—" and the header
  // is explicitly labelled "session total" rather than a column sum.
  //
  // wongk (#4324): `reconcileDisplayedCostCents` returns null when the parts are
  // not something it can honestly reconcile — a non-finite or negative phase
  // cost, which the upstream token-event aggregation really can produce. In that
  // case the panel falls back to today's unreconciled rendering rather than
  // manufacturing a column: a clamped `$0.00` would hide the corrupt phase AND
  // quietly move its dollars onto the phase beside it.
  //
  // Scoped to the UNTRUNCATED case (#4324 review). `activitySegments` is a
  // start-ordered PREFIX when the row cap bites, so on a truncated session the
  // header is the cost of the RETAINED phases only. Reconciling the column to it
  // would dress a partial decomposition up as a complete one — the column would
  // now add up exactly, next to a Properties-strip session cost that is higher,
  // which is a more confident lie than the cent it fixes. Truncated sessions
  // keep today's independent rounding and the footer says coverage is partial.
  const reconciledCosts =
    costUnavailable || rowsTruncated
      ? null
      : reconcileDisplayedCostCents(
          segments.map((segment) => segment.costUsd),
          costTotal
        );
  const costReconciled = reconciledCosts !== null;
  const displayedCosts =
    reconciledCosts ?? segments.map((segment) => segment.costUsd);
  // The header is rendered from the SAME quantization the rows were allocated
  // against, not from the raw float independently. `Math.round` and the 2dp
  // currency formatter disagree on a value sitting within a hair of a half-cent,
  // and a one-cent disagreement between the header and the column is exactly the
  // defect being fixed here — so the two must not be derived separately.
  const displayedCostTotal = costReconciled
    ? toDisplayCents(costTotal) / 100
    : costTotal;
  // ISS-5564: is the contradiction the footer sentence exists to resolve
  // actually on screen right now? Computed from the DISPLAYED costs, not the raw
  // `segment.costUsd`, so the trigger keys off the same figures the reader sees
  // in the Cost column — a phase reconciled down to $0.00 has no dollars to
  // defend and needs no defence.
  const showConfidenceBasis =
    phaseConfidenceDisclosure === true &&
    !costUnavailable &&
    hasZeroConfidenceCostAttribution(segments, displayedCosts);

  return (
    <section
      aria-label="Activity breakdown"
      className="@container/breakdown mt-3 space-y-2"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="font-medium text-sm">Activity breakdown</h2>
        {/* The header figure is the panel's rollup, pinned to the panel's right
            edge — deliberately NOT described as sitting over the Cost column,
            because the column set is responsive (ISS-4674) and that spatial
            relationship does not survive a narrow viewport.

            Whether it IS the sum of the column below is mode-dependent, and the
            label says which (#4324 review — this comment previously asserted a
            flat "it is NOT the sum", which the reconciliation contradicts):
              • cost-unavailable — the per-phase Cost cells all read "—", so the
                rollup is labelled "session total" and must NOT be read as a
                column sum (ISS-4446);
              • priced + reconciled (ISS-5000, flag on, untruncated) — it is the
                exact sum of the column, by construction: both are derived from
                the same `toDisplayCents` quantization;
              • priced otherwise — each cell rounds independently, so the column
                can still fall a cent short of it. */}
        <span className="font-mono text-muted-foreground text-xs tabular-nums">
          {formatCost(displayedCostTotal)}
          {costUnavailable ? " session total" : ""}
        </span>
      </div>

      <ProportionalBar
        displayedCosts={displayedCosts}
        segments={segments}
        shareByTime={shareByTime}
        shareOf={shareOf}
        shareTotal={shareTotal}
      />

      {/* ISS-4674. The eight columns' fixed tracks alone come to ~498px, so on a
          390px phone (a 358px content box) the grid had nothing left for the
          flexible Phase track and crushed it to a bare dot.

          The primary fix is the responsive column set below `sm` (see
          ROW_GRID_CLASS): the panel keeps phase · time · cost · share, which
          fits with room to spare, so Cost and the share column — the two this
          panel exists for — are on screen at rest rather than a swipe away.
          Scrolling alone would have pushed exactly those two off the right
          edge.

          The scroll track is the SAFETY NET, not the primary answer: the detail
          pane is resizable (the comments rail drags), so a desktop-width viewport
          can still squeeze the full eight-column layout below its ~498px
          intrinsic width. There the list overflows and scrolls instead of
          crushing again. This is deliberately NOT the `GridTable` card fallback
          (FEA-3865) every list table takes: this is a 4-8 row summary read by
          comparing rows down a column, and one card per phase would destroy the
          comparison the panel is for. The bar and footer stay outside the track
          so they keep measuring the full panel width. */}
      <ScrollFadeTrack
        scrollableRegionLabel="Activity breakdown columns"
        trackClassName="w-full"
      >
        <ul className="w-full min-w-fit space-y-0.5">
          <BreakdownHeader shareByTime={shareByTime} />
          {segments.map((segment, index) => (
            <BreakdownRow
              carriesUnattributedResidual={index === residualIndex}
              costUnavailable={costUnavailable}
              displayedCostUsd={displayedCosts[index] ?? segment.costUsd}
              key={segment.key}
              segment={segment}
              share={shares[index] ?? null}
            />
          ))}
        </ul>
      </ScrollFadeTrack>

      <BreakdownFooter
        activeDurationMs={activeDurationMs}
        durationTotal={durationTotal}
        hasUnattributedResidual={residualIndex !== NO_RESIDUAL_INDEX}
        mode={mode}
        rowsTruncated={rowsTruncated}
        showConfidenceBasis={showConfidenceBasis}
      />
    </section>
  );
}

function ProportionalBar({
  segments,
  shareOf,
  shareTotal,
  shareByTime,
  displayedCosts,
}: {
  segments: ActivitySegment[];
  shareOf: (segment: ActivitySegment) => number;
  shareTotal: number;
  shareByTime: boolean;
  /**
   * The SAME per-phase amounts the Cost column renders (#4324 review). The bar
   * previously formatted `segment.costUsd` directly, so with the reconciliation
   * on, the phase that absorbed the leftover cent read $3.41 in its Cost cell
   * and $3.40 on hover over its own bar segment — one panel, one phase, two
   * numbers, which is the disagreement ISS-5000 exists to remove.
   */
  displayedCosts: number[];
}) {
  if (shareTotal <= 0) {
    return null;
  }
  return (
    <div
      aria-hidden
      className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      {segments.map((segment, index) => {
        const width = (shareOf(segment) / shareTotal) * 100;
        if (width <= 0) {
          return null;
        }
        const display = getPhaseDisplay(segment.key);
        // The swatch already names the phase by color; the tooltip carries the
        // measure this bar is drawn from — duration when it is a time bar
        // (cost unavailable), cost otherwise — so a hover adds information
        // instead of repeating the color legend.
        //
        // The cost is read from `displayedCosts`, the SAME array the Cost column
        // renders, never from `segment.costUsd` (#4324 review).
        const measure = shareByTime
          ? formatCoarseDurationMs(segment.durationMs)
          : formatCost(displayedCosts[index] ?? segment.costUsd);
        return (
          <span
            className="h-full"
            key={segment.key}
            style={{
              width: `${width}%`,
              background: display.colorVar,
              opacity: isInferred(segment) ? 0.55 : 1,
            }}
            title={`${display.label} · ${measure}`}
          />
        );
      })}
    </div>
  );
}

// A muted header row on the same grid tracks as the data rows: six numeric
// values (two of which are different percentages — confidence vs share) are
// unreadable without labels, and the per-value `title` tooltips never fire for
// touch or keyboard (FEA-4239). Aligned to the rows by construction because it
// shares ROW_GRID_TEMPLATE — no by-eye width matching.
//
// Every header cell clips to its own track (ISS-4674). A grid item defaults to
// `min-width: auto`, so a label wider than its track spills over the next
// column's label instead of being clipped — that is how "Phase" and "Source"
// rendered as the illegible "PSaosuerce" at a phone width. The data rows already
// truncated; the header did not, so it is fixed here independently of the scroll
// track above (a header can still out-measure its track at any width — a longer
// column name, a larger user font size — and must clip rather than collide).
//
// The last column's label is NOT static (ISS-4685): the share is cost-based by
// default and time-based only when cost is unavailable, so a fixed "Share" left
// the common priced case with no unit at all — and the panel's other copy frames
// it in time ("Time" column, "Active work: 9% of 93h 41m"), so two phases with
// equal Time and unequal Share read as a contradiction rather than as a cost
// split. The label is driven by the SAME `shareByTime` flag the math uses, so it
// cannot claim a basis the column is not showing. It is abbreviated ("Cost %",
// not "Cost share") because the track is a fixed 3.25rem in both column sets;
// the prose expansion lives in the footer, which is also the ONLY carrier for
// screen readers since this header row is `aria-hidden`.
function BreakdownHeader({ shareByTime }: { shareByTime: boolean }) {
  return (
    <li
      aria-hidden
      className={cn(
        ROW_GRID_CLASS,
        "items-center gap-2 px-1 pb-1 text-muted-foreground text-xs"
      )}
    >
      <span />
      <span className={HEADER_CELL_CLASS}>Phase</span>
      <span className={cn(HEADER_CELL_CLASS, SECONDARY_CELL_CLASS)}>
        Source
      </span>
      <span
        className={cn(HEADER_CELL_CLASS, SECONDARY_CELL_CLASS, "text-right")}
      >
        Conf.
      </span>
      <span className={cn(HEADER_CELL_CLASS, "text-right")}>Time</span>
      <span
        className={cn(HEADER_CELL_CLASS, SECONDARY_CELL_CLASS, "text-right")}
      >
        Tokens
      </span>
      <span className={cn(HEADER_CELL_CLASS, "text-right")}>Cost</span>
      <span className={cn(HEADER_CELL_CLASS, "text-right")}>
        {shareColumnLabel(shareByTime)}
      </span>
    </li>
  );
}

function BreakdownRow({
  segment,
  share,
  costUnavailable,
  displayedCostUsd,
  carriesUnattributedResidual,
}: {
  segment: ActivitySegment;
  /**
   * ISS-5128 (#4395 review): this row carries spend the phase tiling never
   * placed, so a 0 in Time or Tokens is the absence of a measurement rather than
   * one. `BreakdownRow` had an unknown affordance for Cost and Tokens but none
   * for Time, so the row holding $504 of a $508 session rendered
   * `formatCoarseDurationMs(0)` and read as having taken zero seconds.
   *
   * The flag is the row's IDENTITY, not a second copy of the value:
   * `ActivitySegment.durationMs` is a wire-contract `number` with nowhere to put
   * "unknown", and inventing a span would be worse than the zero. On any other
   * row a 0 really is measured, so this stays scoped to the residual.
   */
  carriesUnattributedResidual: boolean;
  /**
   * ISS-5000: the cost this row RENDERS — already reconciled to whole cents
   * against the header total, so the column sums to the figure it is presented
   * as a breakdown of. Distinct from `segment.costUsd`, which stays the
   * unrounded attributed value and is what the share math divides.
   */
  displayedCostUsd: number;
  // `null` when the panel has no denominator to divide by — an em dash, never a
  // 0% that would read as a measured share of nothing.
  share: number | null;
  // Capped session: per-phase cost + tokens were dropped (pricing exceeds the
  // cap), so those two columns show an honest "—" instead of a fabricated $0.00
  // that would contradict the header's rollup total and the phase strip above.
  // Duration, confidence, provenance, and the duration-based share still render.
  costUnavailable: boolean;
}) {
  const display = getPhaseDisplay(segment.key);
  const tokens = totalTokens(segment);
  // A zero on the residual row is an unknown wearing a measurement's clothes, so
  // it takes the same dash the Cost and Tokens columns already use for a value
  // this panel cannot know (ISS-5128, #4395 review). Scoped to zero rather than
  // applied to the whole row: when the residual folds into an `unattributed`
  // segment the producer tiled, that row DOES have measured time and tokens for
  // the part the classifier saw, and dashing those out would discard real
  // attribution to make a point.
  const durationUnknown =
    carriesUnattributedResidual && segment.durationMs === 0;
  const tokensUnknown =
    costUnavailable || (carriesUnattributedResidual && tokens === 0);
  // Shared grid tracks (not per-span `w-*`) size each column once for every
  // row: a wide value — a two-token coarse duration ("2h 15m") or a
  // thousands-grouped cost ("$1,234.56") — grows its whole column uniformly
  // instead of overflowing its own box and knocking the later columns out of
  // alignment on that one row (FEA-4239).
  return (
    <li
      className={cn(
        ROW_GRID_CLASS,
        "items-center gap-2 rounded px-1 py-1 text-sm"
      )}
    >
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ background: display.colorVar }}
      />
      {/* The phase name WRAPS rather than truncates (ISS-4674). Every real phase
          label ("Implement", "Validate") clears the 6rem floor, so the only
          casualty of truncation was "Other / unclassified" — which in the Empty
          mode is the panel's ONLY row, and would have read "Other / uncl…" next
          to a dash. Wrapping costs a second line on 4-8 rows and keeps the
          honest-remainder row honest.

          `break-words` (`overflow-wrap: anywhere`) is REQUIRED, not cosmetic:
          `phase` is a bounded free string, not the closed eight-key taxonomy
          (getPhaseDisplay titleizes an unknown key straight through), so a
          future classifier key like `post_review_validation` titleizes to one
          unbreakable ~22-char token. With `min-w-0` and no break rule that token
          out-measures the 6rem track and paints over the right-aligned Time cell
          next to it — the same value-over-value collision this PR fixes on the
          header side. `anywhere` breaks that lone token as a last resort while
          still preferring the space in "Other / unclassified". */}
      <span
        className={cn(
          "min-w-0 [overflow-wrap:anywhere]",
          segment.isUnclassified && "text-muted-foreground"
        )}
        data-slot={ActivityBreakdownSlot.PhaseCell}
      >
        {/* The phase NAME is its own element, not a bare text node, because the
            narrow set folds the provenance word into this same cell below: the
            cell's text content then reads "Implementdeclared", so nothing in the
            DOM carries the bare phase name and a text-based locator matches
            NOTHING at exactly the phone width this panel was fixed for. Do not
            inline it back — the anchors are documented on
            `ActivityBreakdownSlot`, and the layout guards key off them. */}
        <span data-slot={ActivityBreakdownSlot.PhaseName}>{display.label}</span>
        {/* Provenance survives the narrow column set (AC-005.2). Below
            `@sm/breakdown` the standalone Source column is dropped, so declared
            vs inferred — the one non-numeric, honest-attribution qualifier in
            the panel — would otherwise vanish on exactly the phone viewport this
            responsive set exists for, leaving a guessed phase reading identical
            to a declared one. Fold it into the phase cell as a muted suffix
            there; at `@sm`+ the standalone column carries it and this hides to
            avoid duplicating the word. */}
        <InlineProvenanceSuffix source={segment.source} />
      </span>
      <ProvenanceLabel source={segment.source} />
      {/* Secondary metrics stay muted/small so they recede behind cost. */}
      <span
        className={cn(
          SECONDARY_CELL_CLASS,
          "text-right text-muted-foreground text-xs tabular-nums"
        )}
      >
        {segment.confidence == null
          ? UNKNOWN_CELL
          : `${getDisplayedConfidencePercent(segment.confidence)}%`}
      </span>
      <span className="text-right text-muted-foreground text-xs tabular-nums">
        {durationUnknown
          ? UNKNOWN_CELL
          : formatCoarseDurationMs(segment.durationMs)}
      </span>
      <span
        className={cn(
          SECONDARY_CELL_CLASS,
          "text-right text-muted-foreground text-xs tabular-nums"
        )}
        title={tokensUnknown ? undefined : tokenSplitTitle(segment)}
      >
        {tokensUnknown ? UNKNOWN_CELL : formatCompact(tokens)}
      </span>
      {/* Cost is the reason this panel exists — give it and its share the
          visual weight so the eye lands there, not on the muted columns. When
          the session is capped the per-phase cost was dropped, so an honest "—"
          replaces a fabricated $0.00 (the footer explains why). */}
      <span
        className="text-right font-medium font-mono text-sm tabular-nums"
        data-slot={ActivityBreakdownSlot.CostCell}
      >
        {costUnavailable ? UNKNOWN_CELL : formatCost(displayedCostUsd)}
      </span>
      <span className="text-right font-medium text-xs tabular-nums">
        {share == null ? UNKNOWN_CELL : `${share}%`}
      </span>
    </li>
  );
}

// Provenance as a muted inline label rather than a badge: the proportional
// bar's opacity already carries "inferred", so a pill on every row is redundant
// ink. The word still distinguishes declared vs inferred (AC-005.2) for a
// glance and for screen readers, without competing with the cost figure. The
// empty case still occupies its grid cell, so the later columns stay aligned.
function ProvenanceLabel({ source }: { source: ActivitySegment["source"] }) {
  if (source == null) {
    return <span className={SECONDARY_CELL_CLASS} />;
  }
  return (
    <span className={cn(SECONDARY_CELL_CLASS, "text-muted-foreground text-xs")}>
      {provenanceWord(source)}
    </span>
  );
}

// The narrow-set carrier for provenance: a muted "declared"/"inferred" suffix
// folded into the phase-name cell, shown ONLY below `@sm/breakdown` where the
// standalone Source column is dropped (AC-005.2 must survive the phone set).
// Hidden at `@sm`+ so the standalone column is the sole carrier there and the
// word is never doubled. Shares `provenanceWord` with ProvenanceLabel so the two
// carriers cannot drift. Nothing renders when provenance is unknown.
function InlineProvenanceSuffix({
  source,
}: {
  source: ActivitySegment["source"];
}) {
  if (source == null) {
    return null;
  }
  return (
    <span className="ml-1.5 @sm/breakdown:hidden text-muted-foreground text-xs">
      {provenanceWord(source)}
    </span>
  );
}

// One helper for the provenance word so the standalone column and the narrow-set
// inline suffix render the identical term for the same source and cannot drift.
function provenanceWord(
  source: NonNullable<ActivitySegment["source"]>
): "declared" | "inferred" {
  return source === SessionTracePhaseSourceType.Explicit
    ? "declared"
    : "inferred";
}

function BreakdownFooter({
  mode,
  activeDurationMs,
  durationTotal,
  rowsTruncated,
  hasUnattributedResidual,
  showConfidenceBasis,
}: {
  mode: ActivityBreakdownMode;
  activeDurationMs: number;
  durationTotal: number;
  /**
   * ISS-5128 (#4395 review): the Derived column now grows a row the reader has
   * no way to account for. Only the priced footer can carry the explanation.
   * Empty already names its own residual row and CostUnavailable never gets one,
   * so this is passed through rather than switched on inside each footer.
   */
  hasUnattributedResidual: boolean;
  /**
   * ISS-5564: whether a phase is currently showing the `Conf. 0%` / real-dollars
   * contradiction the confidence-basis sentence resolves. Passed through for the
   * same reason `hasUnattributedResidual` is — only the priced footer can carry
   * it. CostUnavailable has no dollars to defend (every Cost cell reads "—") and
   * Empty renders a single unclassified row it already explains in full.
   */
  showConfidenceBasis: boolean;
  // The raw tiling this breakdown derives from is an intentionally partial,
  // start-ordered prefix (row-cap / byte-budget). When set, later phases are
  // missing, so the shares are computed over only the retained window — the
  // footer says so instead of letting the panel imply full coverage.
  //
  // #4324 review: this is meaningful in the DERIVED (priced) mode too, not only
  // in cost-unavailable as previously claimed here. `activitySegments` is the
  // same prefix, so a truncated priced session's header is the cost of the
  // retained phases alone. Both footers now surface it.
  rowsTruncated?: boolean | null;
}) {
  // Idle is excluded from the active-work share (it is not work), but still
  // shown for time honesty in its own row above. This is the one number still
  // fully true on a cost-unavailable session, so it is kept there too — not
  // dropped on the floor (ISS-4446).
  const activeLine = buildActiveWorkLine(activeDurationMs, durationTotal);
  // Exhaustive over every ActivityBreakdownMode so a future mode cannot silently
  // inherit another mode's footer — the `never` default fails typecheck until it
  // is handled (shafty023 review).
  switch (mode) {
    case ActivityBreakdownMode.Empty:
      return <EmptyFooter />;
    case ActivityBreakdownMode.CostUnavailable:
      return (
        <CostUnavailableFooter
          activeLine={activeLine}
          rowsTruncated={rowsTruncated}
        />
      );
    case ActivityBreakdownMode.Derived:
      return (
        <DerivedFooter
          activeLine={activeLine}
          hasUnattributedResidual={hasUnattributedResidual}
          rowsTruncated={rowsTruncated}
          showConfidenceBasis={showConfidenceBasis}
        />
      );
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

// (c) Genuinely no tiling — the honest "no attribution yet" empty. Distinct from
// the cost-unavailable footer: here we truly cannot say which phases ran, so the
// whole session sits in the single `unattributed` residual.
//
// ISS-4790: this sentence must name the row it explains. It said "shown as
// unclassified" while the row above it read a different word, so the one panel
// whose whole job in this state is to explain itself named the same bucket two
// ways.
// ISS-4685: this state deliberately carries NO basis sentence. It renders
// exactly one row at 100% (or an em dash when there is no denominator at all),
// so there is no split a reader could misread as the wrong unit — a sentence
// defining a column against nothing to compare it to is a glossary entry, not an
// explanation. The header still names its basis honestly here, because
// `shareByTime` is derived from the cost signal rather than from this mode.
function EmptyFooter() {
  return (
    <p className="text-muted-foreground text-xs">
      No per-phase attribution is available for this session yet. The full cost
      and tokens are in the {ACTIVITY_PHASE_LABEL.unattributed} row.
    </p>
  );
}

// (b) Phases are known (the strip above proves it), but the per-phase COST is
// unavailable — the session was too large to price, or its cost stream was
// incomplete — so a per-phase cost sum would under-report and is withheld. Say
// that in the reader's language (no "event set" / "pricing cap" jargon): the
// phases and their durations ARE attributed, only cost is missing. The share
// column above is by TIME here, so this sentence names that basis in plain
// English rather than by dropping the abbreviated column name mid-clause: a
// header string with a percent sign in it ("the Time % above are still
// accurate") parses as a value, not as a noun, and stumbles where naming the
// measure does not. Its counterpart in the priced mode is `ShareBasisLine`;
// between them every mode that shows a comparable split states its unit
// (ISS-4685). When the tiling is a truncated prefix, add that later phases are
// missing.
function CostUnavailableFooter({
  activeLine,
  rowsTruncated,
}: {
  activeLine: string | null;
  rowsTruncated?: boolean | null;
}) {
  return (
    <div className="space-y-1 text-muted-foreground text-xs">
      <p>
        Per-phase cost isn&rsquo;t available; this session was too large to
        price. Phase times and their share of the session time above are still
        accurate
        {rowsTruncated
          ? ", though later phases are cut off and not shown here"
          : ""}
        .
      </p>
      {activeLine == null ? null : <p>{activeLine}</p>}
    </div>
  );
}

// The default priced breakdown, and the one the ISS-4685 report came from: the
// share column is by COST here, and nothing else in this mode said so. The
// panel's other copy is time-framed (a Time column, "Active work: X% of Y"), so
// two phases with the same Time and different shares read as a contradiction
// until the basis is named. The CostUnavailable footer had always named its own
// basis; this one now does the same.
//
// The active-work FIGURE leads and the basis sentence sits under it: support
// copy goes beneath the data it supports, so the first thing the eye meets in
// the footer is a number rather than a definition.
//
// The basis sentence renders unconditionally rather than riding the
// `activeLine` early-return this footer used to have: the sentence is what makes
// the share column legible at all, so it must not be able to vanish with an
// unrelated time line.
//
// It is also the only place a screen reader hears the unit at all, since the
// header row above is `aria-hidden` (it labels columns for sighted readers of a
// non-table grid). That is CONTEXT, not a label, and this panel's a11y is NOT
// finished here: a reader still hears seven unnamed numbers per row before
// reaching this sentence, with nothing tying "39%" to the share column — the
// same hole `Conf.` has. Naming those cells wants an `sr-only` prefix per cell
// (the pattern `session-trace-subagent.tsx` uses) across BOTH columns at once,
// so it is deliberately its own ticket rather than a half-labelled panel here.
// #4324 review: the priced footer now carries the truncation note too. It was
// only ever rendered by `CostUnavailableFooter`, whose own comment claimed
// truncation was "only meaningful in the cost-unavailable mode" — the projection
// contradicts that, because `activitySegments` is the same start-ordered prefix
// and the priced header is then the cost of the RETAINED phases alone. A panel
// that presents a Cost column as a decomposition has to say when the population
// under it is partial, otherwise the reader reconciles it against the (higher)
// session cost in the Properties strip and cannot tell which number is wrong.
function DerivedFooter({
  activeLine,
  rowsTruncated,
  hasUnattributedResidual,
  showConfidenceBasis,
}: {
  activeLine: string | null;
  rowsTruncated?: boolean | null;
  hasUnattributedResidual: boolean;
  showConfidenceBasis: boolean;
}) {
  return (
    <div className="space-y-1 text-muted-foreground text-xs">
      {activeLine == null ? null : <p>{activeLine}</p>}
      <ShareBasisLine />
      {showConfidenceBasis ? <ConfidenceBasisLine /> : null}
      {hasUnattributedResidual ? <UnattributedResidualLine /> : null}
      {rowsTruncated ? (
        <p>
          Later phases are cut off and not shown, so these totals cover only the
          phases above.
        </p>
      ) : null}
    </div>
  );
}

// The one sentence naming the cost basis in the priced mode. It answers the
// question the reader actually has with a Time column sitting right there —
// which measure is this column dividing? — rather than restating the header:
// "Cost % is each phase's share of the session cost" names the column and then
// defines it back, which reads as a glossary entry. This is deliberately NOT
// built from `SHARE_COLUMN_LABEL`: an abbreviated header string carries a
// percent sign, so dropping it into a sentence reads as a value rather than as a
// noun. The two vocabularies are allowed to differ because both are selected by
// the same `shareByTime` flag that drives the MATH — that flag, not a shared
// string, is what stops the label and the prose naming different bases.
function ShareBasisLine() {
  return <p>Shares are by cost, not time.</p>;
}

// ISS-5564: the third sentence of the same kind, and the same fix `ShareBasisLine`
// was. The panel prints two percentages per row that measure completely
// different things — `Conf.` is how sure the classifier is of the phase LABEL,
// `Cost %` is that phase's share of real spend — and nothing said so. On the
// reported session the row holding 79% of the money read `Conf. 0%`, so the
// panel asserted a precise dollar attribution and, one column over, admitted no
// confidence in the classification the dollars were grouped under. There is no
// way to read that pair without concluding one of the two numbers is junk, and
// a reader reasonably picks the dollars.
//
// The dollars are the trustworthy half: they are measured token cost attributed
// by the phase's time window, which happens the same way whatever the tiling
// decided to CALL that window. So the sentence resolves the contradiction in the
// direction that is true, rather than suppressing the row (which would move real
// spend off the panel) or hiding the confidence (which would drop an honest
// qualifier the panel is right to publish).
//
// It renders only when a phase is actually showing the pair, so an all-confident
// session does not pay for a caveat it does not need.
function ConfidenceBasisLine() {
  return (
    <p>
      Confidence describes the phase name, not the money. A phase at 0% still
      carries its measured cost — only the label it is filed under is a guess.
    </p>
  );
}

// ISS-5128 (#4395 review): the sentence that makes the residual row legible.
// Without it the panel grew a row that on the production shape holds 99% of the
// money and said nothing about where it came from, while the Empty mode two
// branches up has always spelled its own residual out. Same voice as
// `EmptyFooter`, and it names the row by the canonical label rather than
// re-spelling it, for the reason ISS-4790 exists.
//
// It also carries the dash. `BreakdownRow` renders one in Time and Tokens for
// this row when there is nothing measured behind them, and a bare dash with no
// legend is a shrug. This is the ONLY carrier for screen readers as well, since
// the column header row above is `aria-hidden`.
function UnattributedResidualLine() {
  return (
    <p>
      Some spend has no phase attribution. It is in the{" "}
      {ACTIVITY_PHASE_LABEL.unattributed} row, where a dash means the time or
      tokens behind it were never measured.
    </p>
  );
}

// "Active work: X% of Y" — the active (non-idle) wall-time and its share of the
// session's total wall-time. Null when there is no measured time to report.
function buildActiveWorkLine(
  activeDurationMs: number,
  durationTotal: number
): string | null {
  if (durationTotal <= 0) {
    return null;
  }
  const activePercent = percentOf(activeDurationMs, durationTotal);
  return `Active work: ${activePercent}% of ${formatCoarseDurationMs(durationTotal)}`;
}

/**
 * The three honest states this panel can be in, driven by what data the detail
 * projection could supply for the session:
 *
 * - `Derived` — the priced `activitySegments` are present AND carry real
 *   per-phase cost: the full per-phase cost + token + duration breakdown.
 * - `CostUnavailable` — the phases and their durations ARE known (the Activity
 *   phases strip renders them), but per-phase COST is not: either the priced
 *   segments were dropped because the session was too large to price (the
 *   `SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS` cap), or a nonempty but $0-cost
 *   breakdown was derived from an unpriced/incomplete cost stream (desktop
 *   builds segments from raw rows even with no token events; cloud does the same
 *   for mixed streams while `reconcileSessionCost` falls back to the rollup — so
 *   a nonempty `activitySegments` array is NOT proof cost is available, wongk).
 *   Either way we show the phase breakdown with an honest "—" per-phase cost so
 *   this panel agrees with the strip instead of contradicting it, or fabricating
 *   $0.00 against a nonzero session cost. This is ISS-4446: cost-unavailable ≠
 *   no-attribution.
 * - `Empty` — no phase attribution at all: no priced segments and no usable raw
 *   tiling (a pre-FEA-3568 desktop build / pre-backfill history, or a tiling
 *   whose rows are all malformed to zero duration): the single honest
 *   `unattributed` residual, priced from the session totals — the same bucket
 *   the branch rollup files these sessions under. Here attribution really is
 *   unavailable; the classifier never saw this spend.
 */
export const ActivityBreakdownMode = {
  Derived: "derived",
  CostUnavailable: "cost_unavailable",
  Empty: "empty",
} as const;
export type ActivityBreakdownMode =
  (typeof ActivityBreakdownMode)[keyof typeof ActivityBreakdownMode];

/**
 * Resolve the segments to render plus the honest {@link ActivityBreakdownMode}
 * and whether the underlying tiling was a truncated prefix.
 *
 * Priced `activitySegments` win ONLY when they carry real per-phase cost — a
 * nonempty array whose per-phase cost sums to 0 is an unpriced/incomplete stream
 * (desktop/cloud build segments even without token events), so it is treated as
 * cost-unavailable rather than trusted as a $0.00 breakdown. When there are no
 * usable priced segments but the raw `activitySegmentRows` tiling is present, we
 * derive the per-phase breakdown from those rows with no cost — the SAME shared
 * aggregator the projection uses, called with an empty token-event list — so the
 * breakdown tells the same phase story as the Activity phases strip above. Both
 * the priced-but-unpriced and the raw-rows paths require a positive total
 * duration; a tiling that clamps to zero duration carries no attributable time,
 * so we degrade to the single honest `unattributed` fallback.
 */
export function resolveActivitySegments(session: AgentSessionDetail): {
  segments: ActivitySegment[];
  mode: ActivityBreakdownMode;
  rowsTruncated: boolean;
} {
  const rowsTruncated = session.activitySegmentRowsTruncated === true;
  const priced = session.activitySegments;
  if (priced && priced.length > 0 && hasPositiveDuration(priced)) {
    // A nonempty derived breakdown whose per-phase cost is entirely 0 is an
    // unpriced/incomplete cost stream — the completeness signal `estimatedCost`
    // already honors — so it is cost-unavailable, not a trustworthy $0.00
    // breakdown (wongk). The phases/durations still render.
    const mode =
      sumBy(priced, (segment) => segment.costUsd) > 0
        ? ActivityBreakdownMode.Derived
        : ActivityBreakdownMode.CostUnavailable;
    return { segments: priced, mode, rowsTruncated };
  }
  const rows = session.activitySegmentRows;
  if (rows && rows.length > 0) {
    // No token events → per-phase cost/tokens are all 0 (honestly unpriced),
    // while durations/confidence/provenance come straight from the tiling.
    const costUnpricedSegments = buildActivitySegments(rows, []);
    if (
      costUnpricedSegments.length > 0 &&
      hasPositiveDuration(costUnpricedSegments)
    ) {
      return {
        segments: costUnpricedSegments,
        mode: ActivityBreakdownMode.CostUnavailable,
        rowsTruncated,
      };
    }
  }
  return {
    segments: [buildFallbackSegment(session)],
    mode: ActivityBreakdownMode.Empty,
    rowsTruncated: false,
  };
}

// A breakdown is only attributable time when its segments carry a positive total
// duration. `buildActivitySegments` clamps malformed spans to zero duration
// rather than dropping them, so a tiling of all-bad bounds yields phase rows
// that are 0s/0% — guarding here lets those fall through to the honest Empty
// fallback instead of a table of zeros under a "durations still attributed"
// footer (ISS-4446).
function hasPositiveDuration(segments: readonly ActivitySegment[]): boolean {
  return sumBy(segments, (segment) => segment.durationMs) > 0;
}

function buildFallbackSegment(session: AgentSessionDetail): ActivitySegment {
  const startMs = toEpochMs(session.startedAt);
  const endMs = toEpochMs(session.endedAt ?? session.updatedAt);
  const rangeMs = endMs - startMs;
  return {
    // ISS-4790: this fallback fires ONLY in Empty mode — no tiling at all — so
    // the bucket is `unattributed` (spend the classifier never saw), NOT `other`
    // (spend it tiled but could not classify). The distinction is not pedantic:
    // `packages/lib/branches/activity-rollup.ts` drops a session with no
    // segments entirely into its `unattributed` residual, so labelling it
    // "Other" here made branch detail and session detail disagree about whether
    // the classifier ever looked, for the same dollars. The key is
    // client-synthesized (this segment never rides the wire) and is not the
    // `idle` key, so the idle exclusion above is unaffected.
    key: UNATTRIBUTED_KEY,
    // Read from the canonical map rather than re-declaring a literal — a
    // hand-copied string is exactly how this bucket ended up spelled three ways.
    label: ACTIVITY_PHASE_LABEL.unattributed,
    inputTokens: session.inputTokens ?? 0,
    outputTokens: session.outputTokens ?? 0,
    cacheReadTokens: session.cacheReadTokens ?? 0,
    cacheWriteTokens: session.cacheWriteTokens ?? 0,
    costUsd: session.estimatedCost ?? 0,
    durationMs: Number.isFinite(rangeMs) && rangeMs > 0 ? rangeMs : 0,
    confidence: null,
    source: null,
    isUnclassified: true,
  };
}

function isInferred(segment: ActivitySegment): boolean {
  return segment.source === SessionTracePhaseSourceType.LoopPerf;
}

function totalTokens(segment: ActivitySegment): number {
  return (
    segment.inputTokens +
    segment.outputTokens +
    segment.cacheReadTokens +
    segment.cacheWriteTokens
  );
}

function tokenSplitTitle(segment: ActivitySegment): string {
  return `in ${formatCompact(segment.inputTokens)} · out ${formatCompact(
    segment.outputTokens
  )} · cache ${formatCompact(
    segment.cacheReadTokens + segment.cacheWriteTokens
  )}`;
}

function percentOf(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((value / total) * 100);
}

function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0);
}

function toEpochMs(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Date.parse(value);
  }
  return Number.NaN;
}

/**
 * Coarse, single-unit duration for the compact per-phase column (`45s`, `5m`,
 * `2h 15m`) — deliberately distinct from the shared, finer-grained
 * `@repo/app/shared/lib/format-duration-ms` (`ms`/`12.3s`/`2m 5s`), whose
 * two-unit output would overflow this narrow tabular column. Named apart so it
 * is not mistaken for that shared contract.
 */
function formatCoarseDurationMs(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

// Shared column tracks for the breakdown header and every data row, following
// the sibling `grid grid-cols-[…]` tables in this feature (agents-table,
// sessions-table). Sizing lives in one place so the columns line up by
// construction and a longer value in any single row widens its whole column
// uniformly rather than nudging its neighbors. The cost track is the widest of
// the numeric columns because thousands-grouped costs ("$1,234.56") are the
// longest value the panel emits.
//
// TWO column sets (ISS-4674), because the full eight do not fit a phone:
//
// - Base (narrow): dot · phase · time · cost · share — 5 tracks, ~326px with
//   gaps and padding, comfortably inside a 390px phone's 358px content box. The
//   three cells this drops (`SECONDARY_CELL_CLASS`) are the muted ones the row
//   already de-emphasizes; keeping all eight and scrolling instead would have
//   left Cost and Share — the columns the panel exists for — off the right edge
//   at rest, inverting the hierarchy the row styling states.
// - `@sm` and up: all eight — dot · phase · provenance · confidence · duration ·
//   tokens · cost · share. Unchanged from before this fix.
//
// The breakpoint is a CONTAINER query (`@sm/breakdown`, keyed off the
// `@container/breakdown` on the panel's `<section>`), NOT the viewport `sm:`.
// The thing that actually starves these columns is the detail PANE, not the
// window: the comments rail is a fixed ~360px and the doc padding takes more, so
// a ~900px window with the rail open leaves this panel well under the ~498px the
// eight columns need — a viewport `sm:` would still hand it the eight-column set
// and push it into the sideways-scroll safety net at exactly the width the tidy
// five-column set was designed for. Keying off the panel's own inline size puts
// the breakpoint on the axis that constrains it, so the scroll track goes back
// to being the genuine last resort it is described as. Follows the in-package
// precedent (`@container/checks` in compute/components/system-check-results.tsx).
//
// The phase track carries a 6rem FLOOR in both sets, never `minmax(0, …)`: a 0
// floor is what let the fixed tracks starve the phase name to nothing, and it is
// also what the enclosing `min-w-fit` list resolves its overflow width against
// when the pane is squeezed narrower than the eight-column set needs.
const ROW_GRID_CLASS =
  "grid grid-cols-[0.625rem_minmax(6rem,1fr)_3.5rem_4.5rem_3.25rem] @sm/breakdown:grid-cols-[0.625rem_minmax(6rem,1fr)_3.5rem_2.75rem_3.5rem_3.5rem_4.5rem_3.25rem]";

// The three columns the base (narrow) column set drops. Applied to BOTH the
// column label and its data cell so a hidden column takes no grid track and the
// remaining cells stay paired with the base template's five tracks. Container
// query (`@sm/breakdown`), matching ROW_GRID_CLASS, so a cell and its track
// appear/disappear together off the same panel-width signal.
const SECONDARY_CELL_CLASS = "hidden @sm/breakdown:block";

// Column-label cells clip inside their own track instead of overflowing into
// the next column's label (ISS-4674): `min-w-0` defeats a grid item's
// `min-width: auto` so the track can actually clip it, and `truncate` renders
// the overflow as an ellipsis. Labels are short and fixed, so clipping them is
// safe — unlike the phase-name DATA cell, which wraps instead (see BreakdownRow)
// so the long "Other / unclassified" remainder is never cut off.
const HEADER_CELL_CLASS = "min-w-0 truncate";

// One selector for the share column's name, so the header cell and both footer
// sentences resolve the same string from the same `shareByTime` flag the share
// MATH uses. The label therefore cannot name a basis the column is not
// computing, in either mode — which is the whole of ISS-4685. Do not inline
// either literal at a call site.
function shareColumnLabel(shareByTime: boolean): ShareColumnLabel {
  return shareByTime ? SHARE_COLUMN_LABEL.time : SHARE_COLUMN_LABEL.cost;
}

// The one glyph this panel uses for a value it cannot know, across all five
// columns that can hold one (confidence, time, tokens, cost, share). It was
// spelled inline four times before ISS-5128 added the fifth, which is how a
// panel whose whole doctrine is "a dash and a true zero must stay visibly
// distinct" ends up with one column quietly rendering something else.
//
// Exported so a test asserts against the glyph the panel actually renders
// rather than re-typing a character that looks similar.
export const UNKNOWN_CELL = "—";

/**
 * ISS-5564: the confidence percentage as the reader SEES it. One helper so the
 * `Conf.` cell and the footer's trigger below cannot drift: the sentence must
 * appear exactly when a row is displaying `0%`, and if the cell rounded one way
 * while the trigger tested another, the panel would either caveat a row showing
 * `1%` or leave a row showing `0%` unexplained.
 */
function getDisplayedConfidencePercent(confidence: number): number {
  return Math.round(confidence * 100);
}

/**
 * ISS-5564: true when some phase is displaying `Conf. 0%` while still carrying a
 * nonzero cost in the Cost column — the exact pair the footer sentence resolves.
 *
 * Deliberately keyed on the DISPLAYED confidence rather than on a "low
 * confidence" threshold of our own choosing. `0%` is the only value where the
 * panel is literally telling the reader it has no confidence at all, and it is
 * what the reader can see; a phase at `Conf. 3%` reads as low-but-nonzero and
 * needs no contradiction resolved. Picking an invented cutoff would also mean
 * the sentence could appear with nothing on screen to justify it.
 *
 * A `null` confidence does NOT trigger it. The cell renders the shared unknown
 * dash there, which claims nothing about certainty — the synthesized residual
 * row is the main such case, and `UnattributedResidualLine` already explains it.
 *
 * Costs come in as the displayed array so a phase reconciled to `$0.00` is not
 * treated as carrying money; `displayedCosts` is index-aligned with `segments`
 * by construction at the call site, and a missing entry (defensive `?? 0`)
 * counts as no cost rather than throwing.
 *
 * The `> 0` test is applied to the CENT QUANTIZATION, not the raw float (code
 * review). When cost reconciliation is off, `displayedCosts` is the unrounded
 * `segment.costUsd`, so a phase holding $0.001 is `> 0` as a float while its
 * Cost cell renders `$0.00` through `formatCost`. Triggering on that would put
 * a sentence about "its measured cost" beside a row showing no cost at all —
 * the same read-what-is-rendered rule `getDisplayedConfidencePercent` exists
 * for, applied to the other half of the pair.
 */
function hasZeroConfidenceCostAttribution(
  segments: readonly ActivitySegment[],
  displayedCosts: readonly number[]
): boolean {
  return segments.some((segment, index) => {
    if (segment.confidence == null) {
      return false;
    }
    if (getDisplayedConfidencePercent(segment.confidence) !== 0) {
      return false;
    }
    return toDisplayCents(displayedCosts[index] ?? 0) > 0;
  });
}

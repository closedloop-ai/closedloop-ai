"use client";

/**
 * The Sessions strip's two CLOUD-ONLY delivery cards (`PRs Shipped`, `LOC / $`)
 * and the two module-local values only they use.
 *
 * Extracted from `sessions-summary-cards.tsx` (ISS-5842 follow-up, wongk review
 * on #4907) under the root AGENTS.md file-size discipline: that file is a
 * grandfathered over-ceiling module, and a substantive change to one must leave
 * it meaningfully smaller rather than adding to it. The seam is a real
 * responsibility boundary, not a line-count slice — this card owns the FEA-3574
 * three-state auth machine (signed out / failed read / signed-in empty) that the
 * always-available cards do not have, and nothing outside it reads
 * `resolveDeliveryDeltaPlaceholder` or `UNAVAILABLE_DETAIL`.
 */

import { KpiDeltaPlaceholder } from "@repo/app/insights/components/kpi-delta-placeholder";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { MetricDeltaTreatment } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { ReactNode } from "react";
import type { SessionSummaryDeltas } from "../../lib/session-summary-deltas";
import { SessionsSignInIndicator } from "./sessions-sign-in-indicator";
import type { SessionsDeltaSlotProps } from "./sessions-summary-delta-slots";

/**
 * A cloud-only delivery card (PRs Shipped / LOC / $ — FEA-4126 removed
 * Median PR Size from this bar) with the FEA-3574 three-state auth machine. The
 * local SQLite folds never set
 * these metrics, so `value` is `undefined` on the local producer and a nullable
 * number on the cloud producer.
 */
export function DeliveryMetricCard({
  label,
  value,
  formatValue,
  availableDetail,
  info,
  cardClassName,
  isError,
  signedOut,
  perCardIndicatorSuppressed,
  onSignIn,
  signInError,
  deltaProps,
  deltaPlaceholder,
  deltaTreatment,
}: {
  label: string;
  value: number | null | undefined;
  formatValue: (value: number) => string;
  availableDetail: string;
  info: { what: string; how: string };
  cardClassName: string;
  isError: boolean;
  /**
   * Signed-out (state 2) — a data-honesty gate that OUTRANKS `hasValue`. When
   * signed out these cloud-only cards can't vouch for merged-PR data we can't
   * see, so they render the neutral dash with NO scope caption regardless of any
   * `value` still in hand (wongk review).
   */
  signedOut: boolean;
  /**
   * The single ask was hoisted into the banner above the row (or the shell owns
   * it), so drop the per-card sign-in affordance — the dash stays caption-less.
   * When `false` and signed out, the per-card `SessionsSignInIndicator` renders
   * (a live CTA with a handler, else informational copy: the "no ask to hoist"
   * degrade).
   */
  perCardIndicatorSuppressed: boolean;
  onSignIn?: () => void;
  signInError?: string | null;
  /**
   * FEA-4202: this card's period-over-period movement, already resolved by
   * `deltaSlotProps` (empty when there is no honest comparison).
   *
   * It is spread on the AVAILABLE branch ONLY, and that placement is the whole
   * honesty contract for these cards rather than a rendering detail. Each of the
   * three other branches returns a `—`, and a movement chip beside a dash would
   * grade a change in a number the card has just refused to state:
   *  - signed out, we cannot see the cloud merged-PR layer at all, so a chip
   *    would describe data we are simultaneously declining to show;
   *  - a failed read is `Unavailable`, where a trend is not merely unknown but
   *    unfounded;
   *  - a signed-in empty is an absent metric, and `pctDelta` was never given a
   *    current value to compare.
   * Keeping the spread inside the one branch that produced a real, finite,
   * formatted number makes those three cases impossible by construction instead
   * of by three separate guards that can each be forgotten.
   */
  deltaProps?: SessionsDeltaSlotProps;
  /**
   * The "No prior period" affordance for the same slot, on a host that compares
   * periods but has no comparison for THIS card yet. Omitted (like `deltaProps`)
   * on a host that never compares, so the card keeps its chip-free footer rather
   * than a permanent placeholder. Rides the available branch for the same reason
   * `deltaProps` does — see above.
   */
  deltaPlaceholder?: ReactNode;
  /**
   * ISS-5842 (follow-up): the surface's delta treatment, REQUIRED and resolved
   * by the caller rather than by a `useMetricDeltaTreatment()` call in here.
   *
   * The hook used to live in this component, which meant only the branch that
   * happened to spell the prop got the treatment — the `hasValue` branch — while
   * the signed-out, error and signed-in-empty branches fell back to
   * `MetricCard`'s `Legacy` default. Those three render no chip today, so the
   * omission was invisible; it was still a card whose delta FAMILY depended on
   * its render state, one delta away from becoming visible. Taking it as a
   * required prop and spelling it on every return makes the four branches agree
   * by construction, and lets the parent resolve the flag ONCE for the pair.
   */
  deltaTreatment: MetricDeltaTreatment;
}) {
  // Signed-out (state 2) OUTRANKS an available value: the card must show the
  // neutral dash — never a real number captioned with a scope claim — because
  // signed out we can't see the cloud merged-PR layer these describe (wongk).
  if (signedOut) {
    // No `availableDetail` caption on the dash: a "merged in range" / "per merged
    // PR in these sessions" line under a `—` is a claim about data we can't see.
    // The detail is the per-card sign-in affordance, unless the ask was hoisted
    // into the single banner above the row (then the dash is caption-less).
    const signedOutDetail: ReactNode =
      perCardIndicatorSuppressed ? undefined : (
        <SessionsSignInIndicator
          onSignIn={onSignIn}
          signInError={signInError}
        />
      );
    return (
      <MetricCard
        className={cardClassName}
        deltaTreatment={deltaTreatment}
        detail={signedOutDetail}
        info={info}
        label={label}
        value="—"
      />
    );
  }

  // Available: a real, finite value → the formatted metric (value present).
  const hasValue = !isError && value != null && Number.isFinite(value);
  if (hasValue) {
    return (
      <MetricCard
        className={cardClassName}
        {...deltaProps}
        deltaPlaceholder={deltaPlaceholder}
        // AFTER the spread on purpose: `deltaProps` is a caller-built bag, and a
        // reserved presentation key must win over it rather than be clobbered.
        // ISS-5842 (follow-up): the bag now carries a `deltaTreatment` of its
        // own, and this is not a redundant re-statement of it — the parent feeds
        // both from ONE `useMetricDeltaTreatment()` call, so the values agree,
        // and spelling it here is what puts this branch on the same footing as
        // the three below, which have no bag to inherit from.
        deltaTreatment={deltaTreatment}
        detail={availableDetail}
        info={info}
        label={label}
        value={formatValue(value)}
      />
    );
  }

  // Error (a failed read) reads differently from an honest empty (FEA-3574
  // review): dim the card and caption it "Unavailable" — matching Branches'
  // `BranchKpiCard` — so a broken usage read never reads as a real "no PRs
  // merged in range" empty. The `muted` dim carries NO "Sample" badge (that
  // means demo-data-pending, not "couldn't load"). An error is authenticated-
  // agnostic and never routes to the sign-in CTA.
  if (isError) {
    return (
      <MetricCard
        className={cardClassName}
        deltaTreatment={deltaTreatment}
        detail={UNAVAILABLE_DETAIL}
        info={info}
        label={label}
        muted
        value="—"
      />
    );
  }

  // Signed-in empty (state 3): authenticated but the metric is absent (out of
  // range, offline, or GitHub not connected — FEA-3159 keeps that here, NOT a
  // connect CTA). Dash the value and keep the plain `availableDetail` scope
  // caption with no CTA, so state 3 never reads as the signed-out state 2 (which
  // is handled above the value gate and never reaches here).
  return (
    <MetricCard
      className={cardClassName}
      deltaTreatment={deltaTreatment}
      detail={availableDetail}
      info={info}
      label={label}
      value="—"
    />
  );
}

/**
 * FEA-4202: what fills a DELIVERY card's delta slot when it carries no chip.
 *
 * The shared `KpiDeltaPlaceholder`, NOT this strip's `SUMMARY_NO_PRIOR_PERIOD`
 * text — because on these two cards that text would usually be FALSE. "No prior
 * period" asserts the comparison window does not exist; on every bounded range
 * it does exist and `priorUsageQuery` read it successfully, and the comparison
 * was declined for some other reason. Two of those reasons are routine rather
 * than degenerate on a small-integer delivery metric: the producer collapses a
 * real zero merged-PR count to `null` ("no fabricated '0 merged PRs'"), and
 * `pctDelta` declines any magnitude at or past its ±999% ceiling, which a count
 * going 1 → 12 clears easily. Captioning either of those "No prior period"
 * beside a live count would tell the reader last week did not happen.
 *
 * `KpiDeltaPlaceholder` is the repo's canonical affordance for exactly this and
 * is deliberately reason-agnostic: its default sentence names the OUTCOME ("no
 * prior-period comparison is available for this range") and its docblock lists
 * the over-ceiling and near-zero-base declines among the cases it covers. It
 * also keeps the slot occupied, so the row does not end on a hollow card and the
 * loading shell's reserved slot settles into a filled one on all five cards.
 *
 * `reason` overrides that sentence for a card whose comparison is not merely
 * unavailable for the range but never computed at all — the ISS-4995 case, which
 * is what `LOC / $` is. A card we DO compare passes nothing and keeps the
 * default, because for it an absent delta really is a fact about the window.
 */
export function resolveDeliveryDeltaPlaceholder(
  deltas: SessionSummaryDeltas | undefined,
  reason?: string
): ReactNode {
  if (!deltas) {
    return undefined;
  }
  return <KpiDeltaPlaceholder reason={reason} />;
}

/**
 * The caption for a delivery card whose read FAILED (FEA-3574 review) —
 * distinct from an honest authenticated-empty, matching Branches' `BranchKpiCard`
 * "Unavailable" treatment so a broken read never reads as a real zero.
 */
const UNAVAILABLE_DETAIL = "Unavailable";

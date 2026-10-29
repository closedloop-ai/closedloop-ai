"use client";

/**
 * The Sessions strip's two CLOUD-ONLY delivery cards (`PRs Shipped`, `LOC / $`)
 * and the two module-local values only they use.
 *
 * Extracted from `sessions-summary-cards.tsx` (ISS-5842 follow-up, whitlockk review
 * on #4907) under the root AGENTS.md file-size discipline, so this card lives in
 * a sibling rather than growing an already-large file. The seam is a real
 * responsibility boundary, not a line-count slice — this card owns the gating
 * ladder (gated / failed read / empty) that the always-available cards do not
 * have, and nothing outside it reads `resolveDeliveryDeltaPlaceholder` or
 * `UNAVAILABLE_DETAIL`.
 */

// Cross-slice on purpose (ISS-7869), the same way this file already reaches
// into insights for `KpiDeltaPlaceholder`: `ConnectGitHubIndicator` is the ONE
// connect affordance Branches, the Insights grid and the Dashboard stats row
// all render. Declaring a sessions-local variant is exactly how this strip
// drifted into having no ask at all.
import { ConnectGitHubIndicator } from "@repo/app/branches/components/connect-github-indicator";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { KpiDeltaPlaceholder } from "@repo/app/insights/components/kpi-delta-placeholder";
import { GatedMetricIndicatorVariant } from "@repo/app/shared/components/gated-metric-indicator";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { MetricDeltaTreatment } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { ReactNode } from "react";
import type { SessionSummaryDeltas } from "../../lib/session-summary-deltas";
import {
  type SessionsDeltaSlotProps,
  SUMMARY_COMPARISON_PENDING,
} from "./sessions-summary-delta-slots";

/**
 * A cloud-only delivery card (PRs Shipped / LOC / $ — FEA-4126 removed Median
 * PR Size from this bar). The local SQLite folds never set these metrics, so
 * `value` is `undefined` on the local producer and a nullable number on the
 * cloud producer.
 *
 * Both gated states — signed out, and signed in with no GitHub connection —
 * render the one `ConnectGitHubIndicator` ask over a withdrawn value, matching
 * the Dashboard, the Insights grid and Branches (ISS-7866). They stay separate
 * branches only because they rank differently against a value already in hand.
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
  deltaProps,
  deltaPlaceholder,
  deltaTreatment,
  deliveryNoDataEnabled,
  unavailableReason,
  githubDisconnected = false,
  githubConnect,
}: {
  label: string;
  value: number | null | undefined;
  formatValue: (value: number) => string;
  availableDetail: string;
  info: { what: string; how: string };
  cardClassName: string;
  isError: boolean;
  /**
   * Signed-out — a data-honesty gate that OUTRANKS `hasValue`. When signed out
   * these cloud-only cards can't vouch for merged-PR data we can't see, so they
   * withdraw the value regardless of any `value` still in hand (whitlockk review).
   *
   * ISS-7866: this state renders the SAME connect ask as `githubDisconnected`
   * below — not a sign-in ask of its own. It keeps a separate branch only
   * because the two rank differently against `hasValue`, which is a statement
   * about how far we can trust a value in hand, not about what to ask for.
   */
  signedOut: boolean;
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
  /**
   * ISS-7845: dash through `MetricCard`'s own no-data treatment — muted, normal
   * weight — instead of handing it the em dash as a VALUE, which leaves `noData`
   * false and paints the dash semibold at full foreground beside three cards
   * that already dash the other way (ISS-5401 put them there).
   *
   * Resolved by the caller for the PAIR, like `deltaTreatment` above and for the
   * same reason: a card must not derive its absent-value treatment from its own
   * render state, and the two delivery cards must flip together or the row shows
   * one absent value two ways — which is the defect, one card narrower.
   */
  deliveryNoDataEnabled: boolean;
  /**
   * ISS-7705: a reason this card must DECLINE to state its value even though a
   * finite one is in hand — the producer measured the number but cannot stand
   * behind it.
   *
   * Distinct from `isError` (the read failed and there is no number) and from
   * the signed-in empty (there is genuinely nothing to show). It outranks
   * `hasValue` deliberately: a value that survived an incomplete denominator is
   * exactly the confidently-wrong number the gate exists to suppress, so
   * checking it after the value gate would render the inflated figure whenever
   * one happened to exist.
   *
   * The sentence is rendered in TEXT beside the `Unavailable` caption, never
   * carried by the `muted` dim alone (WCAG 1.4.1): the dim is a second, visual
   * statement of a fact the caption already makes in words.
   */
  unavailableReason?: string | null;
  /**
   * ISS-7869: signed in, but the account has no GitHub connection through
   * EITHER source — so this card has nothing to state AND the reader has an
   * action that would fix it.
   *
   * Resolved by the caller, which owns both the connection read and the
   * closed-by-default gate, so this component stays flag-agnostic. It is
   * deliberately NOT `!connected`: an unknown connection state (still loading,
   * or a failed read) is not a disconnection and must never produce an ask.
   *
   * Ranks BELOW `hasValue` on purpose. A cloud value can outlive the personal
   * grant that produced it (or arrive via an org App installation), and
   * withdrawing a real merged-PR count to show an ask would trade away data the
   * reader can use for a prompt they did not need.
   */
  githubDisconnected?: boolean;
  /** What the connect CTA does on this surface (href on web, handler on desktop). */
  githubConnect?: GitHubConnectTarget;
}) {
  // ISS-7866 review: ONE renderer for BOTH gated states — signed out, and
  // signed in with GitHub not connected. They stay separate BRANCHES because
  // they rank differently against a value in hand, but what they render is
  // identical, and two copies is how a fix to one silently misses the other.
  //
  // The ask is Connect GitHub, the same one the dashboard shows in this state.
  // It used to be a per-card "Sign in" indicator, which meant one user at one
  // moment met two different verbs for one wall depending on which screen they
  // were on. No `availableDetail` caption either: a "merged in range" line under
  // a withdrawn value is a claim about data we can't see.
  // Supporting sentence: ISS-12638 operator instruction, matching the
  // dashboard's gated cards.
  const renderGatedCard = () => (
    <MetricCard
      className={cardClassName}
      deltaTreatment={deltaTreatment}
      detail={
        <ConnectGitHubIndicator
          connect={githubConnect}
          variant={GatedMetricIndicatorVariant.Card}
          withSupportingCopy
        />
      }
      info={info}
      label={label}
      value={null}
    />
  );

  // Signed out OUTRANKS an available value: the card must withdraw the number
  // — never a real figure captioned with a scope claim — because signed out we
  // can't see the cloud merged-PR layer these describe (whitlockk).
  if (signedOut) {
    return renderGatedCard();
  }

  // ISS-7858: ONE spelling of the dash for the three UNGATED empty branches
  // below, and the only one in this file: the glyph is `MetricCard`'s to own
  // (`KPI_NO_VALUE`, the same one the three cards beside these render), not a
  // literal re-typed per branch. Flag OFF this is that literal and the render is
  // byte-for-byte today's; flag ON it is `null`, which is what routes the card
  // to the primitive's muted no-data slot. Either way the glyph is identical —
  // only weight and colour move.
  //
  // The two gated states withdraw the value outright and never reach here, so
  // they take neither the literal nor the flag: a gate is not an empty, and
  // ISS-7866 gave it its own settled treatment (`value={null}` with the
  // primitive's "No data", the ask in the caption).
  const dashValue = deliveryNoDataEnabled ? null : KPI_NO_VALUE;

  // ISS-7705: the producer measured a number it cannot stand behind. Checked
  // BEFORE the value gate — see the prop docs — and rendered with the same
  // `muted` + `Unavailable` treatment a failed read gets, because to the reader
  // both mean "this figure is not available", plus the reason in words so an
  // uncovered ratio is never mistaken for a measured one.
  if (!isError && unavailableReason) {
    return (
      <MetricCard
        className={cardClassName}
        deltaTreatment={deltaTreatment}
        detail={`${UNAVAILABLE_DETAIL} — ${unavailableReason}`}
        info={info}
        label={label}
        muted
        value={dashValue}
        valueUnavailableLabel={KPI_NO_VALUE}
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
  // review): dim the card and caption it "Unavailable" — the treatment the
  // Branches list card carried until ISS-9961 removed it — so a broken usage
  // read never reads as a real "no PRs merged in range" empty. The `muted` dim carries NO "Sample" badge (that
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
        value={dashValue}
        valueUnavailableLabel={KPI_NO_VALUE}
      />
    );
  }

  // ISS-7869: authenticated, nothing to state, and we KNOW there is no GitHub
  // connection — the one case in state 3 the reader can actually act on. Renders
  // the same per-card affordance Branches rendered for its own gated KPIs
  // before ISS-9961 (`value={null}` → the muted "No data" glyph, ask in the
  // caption slot), so the four GitHub-truth surfaces finally answer this state
  // the same way. FEA-3159's modal is untouched and still owns the proactive ask.
  if (githubDisconnected) {
    return renderGatedCard();
  }

  // Signed-in empty (state 3): authenticated but the metric is absent for a
  // reason connecting GitHub would not fix — out of range, offline, or a
  // connection state we could not read. Dash the value and keep the plain
  // `availableDetail` scope caption with no CTA, so state 3 never reads as the
  // signed-out state 2 (handled above the value gate and never reaching here).
  //
  // ISS-9749 ruled this card OUT of `metric-card-hide-unavailable`, and it is
  // this branch's own comment that rules it out: "offline, or a connection state
  // we could not read" is a failed read arriving in the shape of an empty. The
  // two branches above that DO know they failed say so with `muted` and are
  // already protected; this one cannot, so hiding it would retire a card whose
  // number may simply not have arrived. The gated branches are out for the
  // separate ISS-7866 reason — they carry an ask the reader can act on.
  return (
    <MetricCard
      className={cardClassName}
      deltaTreatment={deltaTreatment}
      detail={availableDetail}
      info={info}
      label={label}
      value={dashValue}
      valueUnavailableLabel={KPI_NO_VALUE}
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
  reason?: string,
  honestLoadingEnabled = false
): ReactNode {
  if (!deltas) {
    return undefined;
  }
  // ISS-7422: a pending read has no verdict yet, and `KpiDeltaPlaceholder`'s
  // sentence is a verdict ("no prior-period comparison IS available for this
  // range") — settled-sounding on a card whose comparison is still arriving.
  //
  // A card carrying its own `reason` is exempt by construction, not by a second
  // call-site guard: that reason is the ISS-4995 never-computed case (LOC / $),
  // an absence with no pending state at all because no amount of waiting
  // produces the comparison. Tying the exemption to the argument keeps a card
  // that genuinely cannot be compared from ever shimmering as though it might.
  if (honestLoadingEnabled && deltas.pending && reason === undefined) {
    return SUMMARY_COMPARISON_PENDING;
  }
  return <KpiDeltaPlaceholder reason={reason} />;
}

/**
 * The caption for a delivery card whose read FAILED (FEA-3574 review) —
 * distinct from an honest authenticated-empty, matching the "Unavailable"
 * treatment the Branches list card carried until ISS-9961 so a broken read
 * never reads as a real zero.
 */
const UNAVAILABLE_DETAIL = "Unavailable";

import {
  SummaryCardRow,
  summaryCardClass,
} from "@repo/app/shared/components/summary-card-row";
import { WithUnifiedDeltaPill } from "@repo/app/shared/feature-flags/metric-delta-treatment-fixtures";
import { MAX_DELTA_PCT } from "@closedloop-ai/loops-api/insights";
import type { Meta, StoryObj } from "@storybook/react";
import {
  COST_METRIC_CARD_LABEL,
  CostMetricCard,
  formatCostMetricDetail,
  formatHonestCostMetricDetail,
  SESSIONS_COST_HONEST_METRIC_CARD_INFO,
  SESSIONS_COST_HONEST_METRIC_CARD_LABEL,
  SESSIONS_COST_METRIC_CARD_LABEL,
} from "./cost-metric-card";

/**
 * ISS-5451: the cost card's state matrix, isolated.
 *
 * This card is the component ISS-5401 named for conflating an unavailable cost
 * with a genuine `$0`, and until now there was no way to see the two side by
 * side. The distinction is the whole point of the component, so the stories
 * below put `Unavailable` (`—`) and `GenuineZero` (`$0`) adjacent rather than
 * burying either in an args table: a reviewer should be able to tell at a glance
 * that the card never reports a confident zero for a cost it could not compute.
 *
 * The delta chip is polarity-aware and cost is `LowerIsBetter`, so a RISING cost
 * is a regression (red) and a FALLING cost is an improvement (green) — the
 * inverse of most metrics. Both directions get a story because getting that
 * backwards is a silent, plausible-looking bug.
 *
 * ISS-5842: the chip no longer prints a "better"/"worse" verdict beside the
 * figure, and all three tones — including neutral — now share one pill geometry.
 * {@link DeltaToneMatrix} is the canvas that proves the second half.
 *
 * This card needs nothing from the app-core harness the preview mounts globally
 * (ISS-5665): it reads a static polarity const and a pure formatter, and its
 * only provider need — the info tooltip — is met by the preview's
 * `TooltipProvider`. So it declares no `parameters.appCore`.
 */
const meta = {
  title: "App Core/Agents/Cost Metric Card",
  component: CostMetricCard,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-full max-w-xs">
        <Story />
      </div>
    ),
  ],
  args: {
    cost: 9061,
  },
} satisfies Meta<typeof CostMetricCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default Dashboard framing — the bare `COST_METRIC_CARD_LABEL` ("Cost")
 * the component falls back to when the host names nothing.
 */
export const Default: Story = {};

/**
 * A genuine zero-spend result set. This MUST render `$0`, not the `—` sentinel:
 * the set was computed and the answer really is nothing.
 */
export const GenuineZero: Story = {
  args: { cost: 0 },
};

/**
 * Cost could not be computed. Renders `—`, never a confident `$0` (ISS-5401).
 * `undefined` and non-finite values take the same branch.
 */
export const Unavailable: Story = {
  args: { cost: null },
};

/** A non-finite figure is unavailable, not zero — the same honest `—`. */
export const UnavailableNonFinite: Story = {
  args: { cost: Number.NaN },
};

/** The value slot is skeletonised while the chrome and label stay put. */
export const Loading: Story = {
  args: { loading: true },
};

/** The Sessions framing: the label names what the number excludes. */
export const SessionsNonSubscriptionLabel: Story = {
  args: { label: SESSIONS_COST_METRIC_CARD_LABEL },
};

/**
 * ISS-4773 honest-cost mode: the headline counts only API-billed spend, and the
 * detail line accounts for what the subscription covered plus what could not be
 * attributed at all — so the three buckets visibly sum to the population.
 */
export const HonestApiBilledWithDetail: Story = {
  args: {
    cost: 14_204,
    label: SESSIONS_COST_HONEST_METRIC_CARD_LABEL,
    info: SESSIONS_COST_HONEST_METRIC_CARD_INFO,
    detail: formatHonestCostMetricDetail(2030, 16_783),
  },
};

/** The subscription-estimate detail line on the non-honest card. */
export const WithSubscriptionDetail: Story = {
  args: {
    label: SESSIONS_COST_METRIC_CARD_LABEL,
    detail: formatCostMetricDetail(2030),
  },
};

/**
 * Cost is `LowerIsBetter`, so a rise is a REGRESSION — red, trending up. Paired
 * with {@link FallingCostIsImprovement} because inverting polarity is the
 * plausible-looking bug this card is most exposed to.
 *
 * ISS-5842: no "worse" word. The tone and the arrow carry the reading; the card
 * no longer editorialises.
 */
export const RisingCostIsRegression: Story = {
  args: { delta: 38, deltaLabel: "QoQ" },
};

/** The mirror: a falling cost is an improvement — green, trending down. */
export const FallingCostIsImprovement: Story = {
  args: { delta: -38, deltaLabel: "QoQ" },
};

/**
 * ISS-5842 — the neutral tone, which is the state this ticket changed. A flat
 * delta now keeps the PILL: same shape, same padding as the two above, in a
 * muted fill. It previously dropped to bare text, so a row of cards read as
 * three different components instead of one component in three tonal states.
 *
 * Read this one next to {@link NoPriorPeriod}: the fill is deliberately
 * `bg-foreground/5` rather than the placeholder's flat `bg-muted`, so "no
 * verdict on a real number" and "no number at all" stay separable.
 */
export const FlatDelta: Story = {
  args: { delta: 0, deltaLabel: "QoQ" },
  decorators: [
    (Story) => (
      <WithUnifiedDeltaPill>
        <Story />
      </WithUnifiedDeltaPill>
    ),
  ],
};

/**
 * ISS-5842 — the three tonal states side by side, which is the whole point of
 * the change and the thing a per-story canvas cannot show. The geometry must be
 * identical down the column; only the colour may differ.
 *
 * Mounted through `WithUnifiedDeltaPill` because the treatment is gated
 * closed-by-default (ISS-4779): without the provider these cards render the
 * LEGACY tones — neutral bare, verdict word present — and the row would
 * demonstrate the opposite of its own caption. The `LegacyDeltaToneMatrix`
 * below is that default, shown deliberately so the two are comparable.
 */
export const DeltaToneMatrix: Story = {
  render: () => (
    <WithUnifiedDeltaPill>
      <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
        <CostMetricCard cost={9061} delta={38} deltaLabel="QoQ" />
        <CostMetricCard cost={9061} delta={0} deltaLabel="QoQ" />
        <CostMetricCard cost={9061} delta={-38} deltaLabel="QoQ" />
      </div>
    </WithUnifiedDeltaPill>
  ),
};

/**
 * The SHIPPED default (flag off): scored tones carry the pill, the neutral tone
 * drops to bare text, and the caption leads with the verdict word. Kept beside
 * the matrix above so a reviewer can see exactly what the flag changes — and so
 * the default render has a canvas of its own rather than being invisible.
 */
export const LegacyDeltaToneMatrix: Story = {
  render: () => (
    <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
      <CostMetricCard cost={9061} delta={38} deltaLabel="QoQ" />
      <CostMetricCard cost={9061} delta={0} deltaLabel="QoQ" />
      <CostMetricCard cost={9061} delta={-38} deltaLabel="QoQ" />
    </div>
  ),
};

/** Beyond the display ceiling the chip caps rather than printing a wild figure. */
export const CappedDelta: Story = {
  args: {
    delta: MAX_DELTA_PCT,
    deltaCapped: true,
    deltaLabel: "QoQ",
  },
};

/**
 * No prior period to compare against. The placeholder states that plainly
 * instead of rendering a `0%` that would imply "unchanged".
 */
export const NoPriorPeriod: Story = {
  args: { deltaPlaceholder: "No prior period" },
};

/** A delta with its trailing sparkline. */
export const WithSparkline: Story = {
  args: {
    delta: -12,
    deltaLabel: "QoQ",
    sparkline: [12_400, 11_900, 12_100, 10_800, 9900, 9400, 9061],
  },
};

/**
 * The Cost card carries the info trigger after its label, so it is the case that
 * has to prove the two-line label reservation holds — it needs a second line
 * before its rowmates do, even now that "Non-subscription Cost" has been
 * shortened and no shipped label wraps at the strip's width.
 *
 * That reservation is NOT the card's own: `MetricCard` deliberately carries no
 * height floor, because a floor baked into every tile would pad tiles that do
 * not need one. It belongs to `SummaryCardRow`, which applies it as a descendant
 * selector over its children. So this story renders the real row rather than a
 * bare fixed-width wrapper — a wrapper would show the label wrapping with no
 * reservation applied at all, which is the pre-ISS-4787 behaviour, not the fix.
 *
 * A baseline is only observable across siblings, so a short-labelled card sits
 * beside the long one: their value rows should align despite the label above one
 * of them running to two lines.
 */
export const LongLabelSharedBaseline: Story = {
  render: () => (
    <SummaryCardRow>
      <CostMetricCard
        className={summaryCardClass()}
        cost={9061}
        label={SESSIONS_COST_METRIC_CARD_LABEL}
      />
      <CostMetricCard
        className={summaryCardClass()}
        cost={412}
        label={COST_METRIC_CARD_LABEL}
      />
    </SummaryCardRow>
  ),
};

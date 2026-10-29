import { formatDeltaPct } from "@closedloop-ai/loops-api/insights";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { TOTAL_ESTIMATED_COST_ALIAS_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import {
  KpiDeltaPlaceholder,
  NO_COMPARISON_CHIP_LABEL,
} from "@repo/app/insights/components/kpi-delta-placeholder";
import {
  SummaryCardRow,
  summaryCardClass,
} from "@repo/app/shared/components/summary-card-row";
import {
  WithNeutralDeltaPill,
  WithUnifiedDeltaPill,
} from "@repo/app/shared/feature-flags/metric-delta-treatment-fixtures";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { formatCurrencyTileValue } from "@repo/app/shared/lib/format-utils";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  DELTA_PILL_GEOMETRY_CLASS,
  DELTA_SENTIMENT_CAPTION,
  DeltaSentiment,
  deltaPillClass,
  deltaPillGeometryClass,
  deltaSentiment,
  MetricDeltaTreatment,
  MetricPolarity,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import type { SessionSummaryDeltas } from "../../lib/session-summary-deltas";
import { resolveCostCardPresentation } from "./cost-card-presentation";
import {
  createAgentSessionUsageSummaryFixture,
  createSessionSummaryDeltasFixture,
} from "./session-list-fixtures";
import {
  PRS_SHIPPED_METRIC_CARD_LABEL,
  SESSIONS_METRIC_CARD_LABEL,
  TOTAL_TOKENS_METRIC_CARD_LABEL,
} from "./sessions-summary-card-labels";
import {
  costDeltaKey,
  deliveryComparableDeltas,
  deltaSlotProps,
  honestSummaryDeltaPlaceholder,
  resolveComparableDeltas,
  type SessionsDeltaKey,
  shippedSummaryDeltaPlaceholder,
} from "./sessions-summary-delta-slots";

/**
 * ISS-5698: how a Sessions summary card's DELTA SLOT gets filled.
 *
 * The module under study is three pure functions plus one JSX constant, not a
 * component. What it decides, though, is entirely visual: whether a card shows a
 * graded movement chip, the "No prior period" placeholder, ISS-7525's declined
 * "No comparison" line, the delivery pair's "No comparison" pill, or an empty
 * footer. Five outcomes a reader has to be able to tell apart, and that a unit
 * test asserting the returned object shape cannot show. The last two share a
 * label on purpose — one noun for one concept (ISS-4995) — and differ in the
 * affordance the card they sit on already uses.
 *
 * So the stories mount a card and reproduce `AlwaysAvailableCards`' wiring
 * verbatim: `resolveComparableDeltas`, then `deltaSlotProps`, then the spread,
 * with the gate picking the slot's affordance
 * What renders here is what the strip renders. Change the wiring in
 * `sessions-summary-cards.tsx` and these stories go stale visibly rather than
 * quietly.
 *
 * The distinction each story exists for: an "All time" range, a metric with no
 * entry, a comparison the producer measured and declined, and a suppressed
 * comparison are four different facts, and none of them is allowed to borrow
 * another's wording.
 */

/**
 * The cost entry, named so {@link CostBasisPair} can state the basis it expects
 * each card to have resolved to without re-typing a delta key. It moves the
 * OPPOSITE way from its rowmates on purpose: a card that grades the wrong key
 * then renders a chip pointing the wrong way, which is a visible failure rather
 * than a plausible one — the #4480 defect was one figure graded against another.
 */
const TOTAL_COST_DELTA = {
  delta: -12,
  deltaPolarity: MetricPolarity.LowerIsBetter,
} as const;

/**
 * A bounded range whose prior read landed, carrying an entry for every
 * always-available card.
 */
const BOUNDED_DELTAS: SessionSummaryDeltas = {
  label: "vs. prior 30 days",
  totalCost: TOTAL_COST_DELTA,
  sessions: { delta: 24, deltaPolarity: MetricPolarity.HigherIsBetter },
  tokens: { delta: 61, deltaPolarity: MetricPolarity.Neutral },
};

/**
 * The same landed read with spend moving UP, for {@link SpendRiseReadsAsWorse}.
 * {@link BOUNDED_DELTAS} grades cost DOWN, which is the improvement case.
 */
const RISING_SPEND_DELTAS: SessionSummaryDeltas = {
  ...BOUNDED_DELTAS,
  totalCost: { delta: 18, deltaPolarity: MetricPolarity.LowerIsBetter },
};

/**
 * A SETTLED payload whose three lanes reconcile with `totalEstimatedCost`, which
 * since ISS-8791 is the whole precondition for the breakdown basis — its flag is
 * gone. Break the reconciliation and this fixture drops to the collapsed basis
 * below, and {@link CostBasisPair} then renders one label twice.
 */
const BREAKDOWN_BASIS_USAGE = createAgentSessionUsageSummaryFixture(
  AgentSessionViewerScope.Organization,
  {
    totalEstimatedCost: 16_867,
    subscriptionEstimatedCost: 42,
    apiEstimatedCost: 16_825,
    meteredEstimatedCost: 42,
    unknownEstimatedCost: 16_783,
  }
);

/**
 * The same cohort from a producer that cannot split the bucket at all, which is
 * what reaches the collapsed API basis now that neither elevated mode is gated
 * on a flag.
 */
const COLLAPSED_BASIS_USAGE = createAgentSessionUsageSummaryFixture(
  AgentSessionViewerScope.Organization,
  {
    totalEstimatedCost: 16_867,
    subscriptionEstimatedCost: 42,
    apiEstimatedCost: 16_825,
    meteredEstimatedCost: 42,
    unknownEstimatedCost: undefined,
  }
);

/** The Cost card on the breakdown basis: the total under its own label. */
const BREAKDOWN_COST_PRESENTATION = resolveCostCardPresentation(
  BREAKDOWN_BASIS_USAGE
);

/** The mode an unsplittable payload falls to: the same total, minus the lanes. */
const COLLAPSED_COST_PRESENTATION = resolveCostCardPresentation(
  COLLAPSED_BASIS_USAGE
);

/** The caption every card in these stories carries, so only the slot varies. */
const IN_RANGE_DETAIL = "in the active filter set";

const meta = {
  title: "Composites v1.0/Sessions/Sessions Summary Delta Slots",
  component: SessionsDeltaSlotCard,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-full max-w-xs">
        <Story />
      </div>
    ),
  ],
  args: {
    deltaKey: "sessions",
    deltas: BOUNDED_DELTAS,
    detail: IN_RANGE_DETAIL,
    label: SESSIONS_METRIC_CARD_LABEL,
    value: "1,284",
  },
  argTypes: {
    deltaKey: {
      control: { type: "select" },
      options: ["sessions", "totalCost", "prsShipped", "tokens"],
    },
  },
} satisfies Meta<typeof SessionsDeltaSlotCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** `MetricCard`'s own chip marker, the presence test for a graded movement. */
const DELTA_CHIP_TEST_ID = "metric-delta-chip";

/** `KpiDeltaPlaceholder`'s marker, the delivery pair's "No comparison" pill. */
const KPI_DELTA_PLACEHOLDER_TEST_ID = "kpi-delta-placeholder";

/** The visible verdict words, read from the canonical map rather than retyped. */
const IMPROVEMENT_VERDICT = DELTA_SENTIMENT_CAPTION[DeltaSentiment.Improvement];
const REGRESSION_VERDICT = DELTA_SENTIMENT_CAPTION[DeltaSentiment.Regression];

/**
 * The copy inside `SUMMARY_NO_PRIOR_PERIOD`, which is a JSX constant rather than
 * an exported string. Restated here so the `play` assertions can name it; a
 * change to the constant's wording fails these stories, which is the intent.
 */
const NO_PRIOR_PERIOD_COPY = "No prior period";

/**
 * ISS-7525's counterpart, restated here for the same reason and with the same
 * consequence: these stories name the shipped words rather than import the node
 * that holds them, so a wording change has to come past this file.
 */
const DECLINED_COPY = "No comparison";

/**
 * The settled, comparable case: a bounded range, a landed prior read, and a
 * metric whose rise is genuinely good news. Chip plus the visible verdict word,
 * which is what carries the good/bad reading for a reader who cannot separate the
 * success and destructive tints (WCAG 2.2 SC 1.4.1).
 */
export const GradedRise: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId(DELTA_CHIP_TEST_ID)).toBeVisible();
    await expect(canvas.getByText(String(IMPROVEMENT_VERDICT))).toBeVisible();
  },
};

/**
 * Token volume, graded NEUTRAL, and the `play` is the point of the story.
 *
 * A rise in tokens is not a win: tokens are the substance of spend, so tinting a
 * rise green would contradict the Cost card sitting beside it in the same rank.
 * The chip still reports the real direction; it just makes no claim about it, so
 * NEITHER verdict word appears. Asserting both absences is what would catch a
 * future polarity default quietly regrading this card.
 */
export const NeutralMovement: Story = {
  args: {
    deltaKey: "tokens",
    label: TOTAL_TOKENS_METRIC_CARD_LABEL,
    value: "1.26B",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId(DELTA_CHIP_TEST_ID)).toBeVisible();
    await expect(
      canvas.queryByText(String(IMPROVEMENT_VERDICT))
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByText(String(REGRESSION_VERDICT))
    ).not.toBeInTheDocument();
  },
};

/**
 * Spend, which is `LowerIsBetter`: the arrow honestly points UP and the card
 * reads "worse". Inverting this is the plausible-looking bug the paired
 * `delta`/`deltaPolarity` union exists to make impossible, and it is worth a
 * story because a rising red figure is the one chip a reviewer is most likely to
 * skim past as correct.
 */
export const SpendRiseReadsAsWorse: Story = {
  args: {
    deltaKey: "totalCost",
    deltas: RISING_SPEND_DELTAS,
    label: TOTAL_ESTIMATED_COST_ALIAS_LABEL,
    value: "$16,825",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(String(REGRESSION_VERDICT))).toBeVisible();
  },
};

/**
 * The "All time" range. There is no window before "everything", so
 * `sessionPriorWindowLabel` returns null, and the null LABEL is the guard that
 * drops the chip on EVERY card regardless of what entries the object happens to
 * carry. This story keeps the full entry set precisely to prove that: the
 * `sessions` movement is right there in the object and is still not rendered.
 *
 * The placeholder fills the same slot the chip would, so a range switch does not
 * move the card's height, and it says which state the reader is in rather than
 * leaving a silent gap.
 */
export const AllTimeHasNoPriorPeriod: Story = {
  args: { deltas: { ...BOUNDED_DELTAS, label: null } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByTestId(DELTA_CHIP_TEST_ID)
    ).not.toBeInTheDocument();
    await expect(canvas.getByText(NO_PRIOR_PERIOD_COPY)).toBeVisible();
  },
};

/**
 * A bounded range where THIS card has no entry and no comparison rode the
 * response at all — the host compares, and nothing came back to compare with.
 *
 * Renders identically to {@link AllTimeHasNoPriorPeriod}, which is now the
 * narrow claim it always should have been: both really are "no prior period in
 * hand". The case that used to share these pixels and should not — a prior
 * window measured and declined — is {@link ComparisonDeclined} below.
 */
export const NoEntryForThisCard: Story = {
  args: { deltas: { label: BOUNDED_DELTAS.label } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(NO_PRIOR_PERIOD_COPY)).toBeVisible();
  },
};

/**
 * ISS-7525 — the settled-but-DECLINED comparison, the state this slot used to
 * deny outright.
 *
 * A prior window exists for this range, the producer measured it, and it
 * emitted no percent for this card: the base was too near zero to divide by, or
 * the movement ran past the display ceiling `pctDelta` refuses to clamp. Saying
 * "No prior period" here is false about the data, not merely terse — the prior
 * period is right there in the response, carrying the dates it was measured
 * over.
 *
 * Read this against {@link NoEntryForThisCard}: the same empty slot, two
 * different facts, and now two different sentences. The distinction is carried
 * entirely by the WORDS — same muted caption token, same slot geometry, no hue
 * (WCAG 1.4.1) — so it survives a screen reader and a monochrome render alike.
 *
 * Flag-gated (`sessions-summary-honest-loading`, default off), so this story
 * pins the flag ON and its rowmates above pin the shipped closed default.
 */
export const ComparisonDeclined: Story = {
  args: {
    deltas: { label: BOUNDED_DELTAS.label, priorPeriodMeasured: true },
    honestLoadingEnabled: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(DECLINED_COPY)).toBeVisible();
    await expect(
      canvas.queryByText(NO_PRIOR_PERIOD_COPY)
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByTestId(DELTA_CHIP_TEST_ID)
    ).not.toBeInTheDocument();
  },
};

/**
 * The SAME declined payload with the gate closed — the shipped default, and the
 * old wording verbatim.
 *
 * Its whole job is to prove the change is behind the flag rather than beside
 * it: this story and {@link ComparisonDeclined} differ in exactly one arg.
 */
export const ComparisonDeclinedFlagOff: Story = {
  args: { deltas: { label: BOUNDED_DELTAS.label, priorPeriodMeasured: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(NO_PRIOR_PERIOD_COPY)).toBeVisible();
    await expect(canvas.queryByText(DECLINED_COPY)).not.toBeInTheDocument();
  },
};

/**
 * The desktop cloud-failure path: the cards fell back to LOCAL SQLite totals, so
 * the value beside the slot is no longer the figure the prior-period read was
 * computed against.
 *
 * The slot empties entirely, no chip and no placeholder, because the two
 * available lines would both be false here. Grading a movement would compare two
 * different populations, and "No prior period" would deny a prior period the host
 * actually has. The `play` asserts both absences, which is the only way this
 * state is distinguishable from the two above.
 */
export const SuppressedOnLocalFallback: Story = {
  args: { showingLocalFallback: true, value: "412" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByTestId(DELTA_CHIP_TEST_ID)
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByText(NO_PRIOR_PERIOD_COPY)
    ).not.toBeInTheDocument();
  },
};

/**
 * A failed read. The value collapses to the muted "No data" slot and the delta
 * slot goes with it: a card that just declined to state its own value must not
 * caption a comparison of it. The card keeps its label and its footer caption, so
 * a failed read still reads as a failed read and never as a confirmed zero.
 */
export const SuppressedOnFailedRead: Story = {
  args: { errored: true, value: null },
};

/**
 * #4480: the same delta object read on the two bases the Cost card's headline can
 * take, side by side in a real `SummaryCardRow`.
 *
 * `resolveCostCardPresentation` used to pick between two figures, and one "cost"
 * delta would have graded whichever basis this module happened to choose against
 * whatever the card actually rendered, two different figures under one chip. The
 * cost movement deliberately points the OPPOSITE way from its rowmates, so a
 * card reading the wrong key is visible at a glance instead of being plausible.
 *
 * PR #4814 review: nothing here spells a delta key. An earlier draft passed the
 * basis literals directly, which made the story a COPY of production's mapping
 * rather than a reader of it — re-point `costDeltaKey` at another entry and this
 * canvas would have gone on showing the correct pairing. Both
 * cards are now built from a real `resolveCostCardPresentation` result: the
 * label and the headline come off that object, and the delta key comes from the
 * shared `costDeltaKey` the production strip calls, so the story moves when the
 * wiring moves.
 */
export const CostBasisPair: Story = {
  tags: ["!manifest"],
  render: () => (
    <SummaryCardRow>
      {[BREAKDOWN_COST_PRESENTATION, COLLAPSED_COST_PRESENTATION].map(
        (presentation) => (
          <SessionsDeltaSlotCard
            cardClassName={summaryCardClass()}
            deltaKey={costDeltaKey(presentation)}
            deltas={BOUNDED_DELTAS}
            detail={presentation.info.what}
            key={presentation.label}
            label={presentation.label}
            value={formatCurrencyTileValue(presentation.cost)}
          />
        )
      )}
    </SummaryCardRow>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // ISS-10597's ruling collapsed the two bases onto ONE label and ONE figure,
    // so this canvas no longer contrasts two names — it shows that the two modes
    // agree. Two cards, one label, and since 2026-09-20 that label is ruling 7's
    // alias, which the resolver returns for both modes.
    await expect(
      canvas.getAllByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)
    ).toHaveLength(2);

    // `BOUNDED_DELTAS` points cost the opposite way from its rowmates, which is
    // what keeps this discriminating now that the labels match: both cards must
    // grade the TOTAL movement, so a mode re-pointed at any other entry renders
    // that rowmate's percentage instead. Expectations go through
    // `formatDeltaPct`, the same SSOT the chip renders with, so this pins the KEY
    // each card resolved rather than the chip's formatting.
    //
    // ISS-10734 retired the `apiCost` entry this used to contrast against, so a
    // mode pointed there now fails `tsc` rather than this canvas.
    const chips = canvas.getAllByTestId(DELTA_CHIP_TEST_ID);
    expect(chips.map((chip) => chip.textContent)).toEqual([
      formatDeltaPct(TOTAL_COST_DELTA.delta),
      formatDeltaPct(TOTAL_COST_DELTA.delta),
    ]);
  },
};

/**
 * FEA-4202, NOT adopted: the flag-off delivery footer, byte-for-byte as ISS-5315
 * shipped it.
 *
 * `deliveryComparableDeltas` reads `deliveryCompared`, not the object's mere
 * PRESENCE, and that distinction is the whole reason it exists. Every caller
 * already hands the component a delta object for the always-available cards, so
 * reading presence as consent published the new "No comparison" pill to hosts
 * that never opted in. The footer here carries no chip and no pill.
 */
export const DeliveryComparisonNotAdopted: Story = {
  render: () => (
    <SessionsDeliveryDeltaSlotCard
      deltas={BOUNDED_DELTAS}
      label={PRS_SHIPPED_METRIC_CARD_LABEL}
      value="9"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByTestId(DELTA_CHIP_TEST_ID)
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByTestId(KPI_DELTA_PLACEHOLDER_TEST_ID)
    ).not.toBeInTheDocument();
  },
};

/**
 * FEA-4202 adopted, with a movement to show: `PRs Shipped` joins the comparing
 * cards. Shipping more merged PRs is more delivery, so it is graded the same way
 * the Sessions count is.
 */
export const DeliveryComparisonAdopted: Story = {
  render: () => (
    <SessionsDeliveryDeltaSlotCard
      deltas={DELIVERY_COMPARED_DELTAS}
      label={PRS_SHIPPED_METRIC_CARD_LABEL}
      value="9"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId(DELTA_CHIP_TEST_ID)).toBeVisible();
  },
};

/**
 * FEA-4202 adopted, comparison DECLINED: an empty prior window (which the
 * producer sends as `null`), or a movement past the ±999% ceiling that a small
 * integer count clears easily.
 *
 * The delivery card fills the slot with `KpiDeltaPlaceholder`'s "No comparison"
 * pill and deliberately does NOT borrow the "No prior period" wording its
 * rowmates use: on a bounded range that period exists and was read, so saying
 * otherwise would be false. Read this against {@link NoEntryForThisCard}, the
 * same absent entry stated as two different true sentences.
 */
export const DeliveryComparisonDeclined: Story = {
  render: () => (
    <SessionsDeliveryDeltaSlotCard
      deltas={{ deliveryCompared: true, label: BOUNDED_DELTAS.label }}
      label={PRS_SHIPPED_METRIC_CARD_LABEL}
      value="9"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(NO_COMPARISON_CHIP_LABEL)).toBeVisible();
    await expect(
      canvas.queryByText(NO_PRIOR_PERIOD_COPY)
    ).not.toBeInTheDocument();
  },
};

/** The FEA-4202 opt-in: the same object, with the delivery pair participating. */
const DELIVERY_COMPARED_DELTAS: SessionSummaryDeltas = {
  ...BOUNDED_DELTAS,
  deliveryCompared: true,
  prsShipped: { delta: 33, deltaPolarity: MetricPolarity.HigherIsBetter },
};

/**
 * One always-available card, wired exactly as `AlwaysAvailableCards` wires it.
 *
 * The three-step chain is the contract. `resolveComparableDeltas` decides whether
 * a comparison is honest at all for the card's current state, `deltaSlotProps`
 * turns a surviving object into the spreadable `delta`/`deltaPolarity`/
 * `deltaLabel` trio (or, when no movement survives, a bag carrying only
 * `deltaTreatment` — ISS-5842 replaced the former empty object, so the
 * presentation family no longer depends on whether a card happens to have a
 * delta), and the gate picks between `honestSummaryDeltaPlaceholder` and
 * `shippedSummaryDeltaPlaceholder` — which is
 * what makes the suppressed states render an empty footer rather than a claim,
 * and (ISS-7525) what tells a declined comparison apart from an absent one.
 * Calling the real resolver rather than naming a constant is deliberate: a story
 * that hard-codes the placeholder cannot go stale when the resolver's answer
 * changes, which is the one thing these stories exist to notice.
 */
function SessionsDeltaSlotCard({
  cardClassName,
  cardsLoading = false,
  deltaKey,
  deltas,
  detail,
  errored = false,
  honestLoadingEnabled = false,
  label,
  showingLocalFallback = false,
  value,
}: Readonly<{
  cardClassName?: string;
  cardsLoading?: boolean;
  deltaKey: SessionsDeltaKey;
  deltas: SessionSummaryDeltas | undefined;
  detail: string;
  errored?: boolean;
  /**
   * ISS-7525: the `sessions-summary-honest-loading` gate, as
   * `AlwaysAvailableCards` resolves it. Passed as a prop rather than read from a
   * provider so a single story can pin the flag-ON slot; default OFF keeps every
   * story above rendering the shipped closed-default wording.
   */
  honestLoadingEnabled?: boolean;
  label: string;
  showingLocalFallback?: boolean;
  value: string | null;
}>) {
  const comparableDeltas = resolveComparableDeltas(deltas, {
    cardsLoading,
    errored,
    showingLocalFallback,
  });
  // ISS-5842 (follow-up): resolved the same way `AlwaysAvailableCards` resolves
  // it, so this helper keeps mirroring production rather than pinning a
  // treatment of its own — which is what lets ONE helper render both families.
  // Each story decides which it gets by whether it mounts a flag provider:
  // `UnifiedPillTones` wraps this in `WithUnifiedDeltaPill` and gets the pill,
  // and every other story mounts none, so `useFeatureFlagEnabledOptional`
  // resolves false and it renders the shipped `Legacy` default.
  const deltaTreatment = useMetricDeltaTreatment();
  return (
    <MetricCard
      className={cardClassName}
      detail={detail}
      {...deltaSlotProps(comparableDeltas, deltaKey, deltaTreatment)}
      deltaPlaceholder={
        honestLoadingEnabled
          ? honestSummaryDeltaPlaceholder(comparableDeltas)
          : shippedSummaryDeltaPlaceholder(comparableDeltas)
      }
      label={label}
      value={value}
    />
  );
}

/**
 * One DELIVERY card, wired as `SessionsSummaryCards` wires the `PRs Shipped`
 * tile. The pair's participation is gated by `deliveryComparableDeltas` and its
 * absent state is `KpiDeltaPlaceholder`, not the always-available cards' "No
 * prior period" line. A non-participating card gets neither.
 */
function SessionsDeliveryDeltaSlotCard({
  deltas,
  label,
  value,
}: Readonly<{
  deltas: SessionSummaryDeltas | undefined;
  label: string;
  value: string | null;
}>) {
  const deliveryDeltas = deliveryComparableDeltas(deltas);
  const deltaTreatment = useMetricDeltaTreatment();
  return (
    <MetricCard
      detail="merged in range"
      {...deltaSlotProps(deliveryDeltas, "prsShipped", deltaTreatment)}
      deltaPlaceholder={deliveryDeltas ? <KpiDeltaPlaceholder /> : undefined}
      label={label}
      value={value}
    />
  );
}

/** Class strings from the polarity SSOT arrive space-joined; assert them singly. */
const CLASS_SEPARATOR = /\s+/;

function unifiedPillClassNames(classes: string): string[] {
  return classes.trim().split(CLASS_SEPARATOR);
}

/**
 * ISS-5842: one card per SENTIMENT, so the unified treatment's central claim —
 * identical geometry on every tone, colour as the only variable — is a single
 * canvas rather than three stories a reader has to hold in their head.
 *
 * Each entry states only its movement; the sentiment is DERIVED with the same
 * `deltaSentiment` the chip itself calls, so a story cannot assert a tone the
 * component would not actually produce. The deltas come from the shared
 * `createSessionSummaryDeltasFixture` (per `agents/AGENTS.md`), which is the same
 * fixture `sessions-summary-cards-delta-treatment.test.tsx` renders — the story
 * and the test describe one scenario, not two that can drift.
 */
const UNIFIED_PILL_TONE_CARDS = [
  {
    deltaKey: "sessions",
    deltas: createSessionSummaryDeltasFixture({
      sessions: { delta: 18, deltaPolarity: MetricPolarity.HigherIsBetter },
    }),
    label: SESSIONS_METRIC_CARD_LABEL,
    sentiment: deltaSentiment(18, MetricPolarity.HigherIsBetter),
    value: "1,284",
  },
  {
    // The operator's card, on the operator's figure: a real movement that grades
    // out NEUTRAL, which is the only tone the two treatments render differently.
    deltaKey: "tokens",
    deltas: createSessionSummaryDeltasFixture(),
    label: TOTAL_TOKENS_METRIC_CARD_LABEL,
    sentiment: deltaSentiment(-52, MetricPolarity.Neutral),
    value: "1.26B",
  },
  {
    // Spend rising is a regression, so the third pill is the destructive tone.
    deltaKey: "totalCost",
    deltas: createSessionSummaryDeltasFixture({
      totalCost: { delta: 18, deltaPolarity: MetricPolarity.LowerIsBetter },
    }),
    label: TOTAL_ESTIMATED_COST_ALIAS_LABEL,
    sentiment: deltaSentiment(18, MetricPolarity.LowerIsBetter),
    value: "$412",
  },
] as const satisfies ReadonlyArray<{
  deltaKey: SessionsDeltaKey;
  deltas: SessionSummaryDeltas;
  label: string;
  sentiment: DeltaSentiment;
  value: string;
}>;

/**
 * ISS-6493 — the baseline row of the treatment matrix: the same three tones with
 * NO gate at all, which is what every user sees today.
 *
 * This exists so the matrix is one wall rather than three stories a reader holds
 * in their head. {@link NeutralMovement} above is also `Legacy`, but it is one
 * card rather than the three-tone row and it sits ten stories away, so it cannot
 * be read against the pilled rows. These three — this story,
 * {@link NeutralPillTones} and {@link UnifiedPillTones} — render the identical
 * card set in reading order with exactly one variable between them, so the
 * middle card is the defect: bare here, pilled in both rows below.
 *
 * It mounts no flag provider, which IS the flag-off case:
 * `useFeatureFlagEnabledOptional` resolves false without one, so this is the
 * shipped `Legacy` default rather than a treatment spelled by hand.
 */
export const LegacyTones: Story = {
  tags: ["!manifest"],
  render: () => (
    <SummaryCardRow>
      {UNIFIED_PILL_TONE_CARDS.map((tone) => (
        <SessionsDeltaSlotCard
          cardClassName={summaryCardClass()}
          deltaKey={tone.deltaKey}
          deltas={tone.deltas}
          detail={IN_RANGE_DETAIL}
          key={tone.label}
          label={tone.label}
          value={tone.value}
        />
      ))}
    </SummaryCardRow>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chips = canvas.getAllByTestId(DELTA_CHIP_TEST_ID);
    await expect(chips).toHaveLength(UNIFIED_PILL_TONE_CARDS.length);

    for (const [index, tone] of UNIFIED_PILL_TONE_CARDS.entries()) {
      const chip = chips[index];
      const geometry = deltaPillGeometryClass(
        tone.sentiment,
        MetricDeltaTreatment.Legacy
      );
      if (geometry) {
        // A scored tone is pilled here too — only the neutral one is not, which
        // is exactly the row-level inconsistency ISS-6493 removes.
        for (const className of unifiedPillClassNames(geometry)) {
          await expect(chip).toHaveClass(className);
        }
      } else {
        // The one tone Legacy leaves bare. Named rather than inferred, so this
        // branch cannot quietly start describing a scored card.
        await expect(tone.sentiment).toBe(DeltaSentiment.Neutral);
        for (const className of unifiedPillClassNames(
          DELTA_PILL_GEOMETRY_CLASS
        )) {
          await expect(chip).not.toHaveClass(className);
        }
      }
    }
  },
};

/**
 * ISS-6493 — the SAME three tones again, on the gate that can actually ship.
 *
 * The state matrix is the point, and it only reads as one with all three
 * treatments on the wall: {@link NeutralMovement} is `Legacy`, the shipped
 * default, where the middle card is bare; this story is `NeutralPill`, where it
 * takes the pill; {@link UnifiedPillTones} is `UnifiedPill`, which pills it too
 * AND drops the verdict word. Put side by side, the pair of pilled stories shows
 * exactly what ISS-6493 buys and what it deliberately leaves behind.
 *
 * That leaving-behind is the whole reason this treatment exists, so it is what
 * the `play` checks hardest. `metric-delta-unified-pill` is blocked on #4823
 * because a `+38%` higher-is-better and a `+38%` lower-is-better become
 * separable by hue alone once "better" / "worse" is gone. This gate must not
 * inherit that debt — a neutral tone grades nothing, so pilling it costs no cue
 * — and a canvas is where a designer can actually confirm the words are still
 * there beside the scored pills.
 */
export const NeutralPillTones: Story = {
  tags: ["!manifest"],
  render: () => (
    <WithNeutralDeltaPill>
      <SummaryCardRow>
        {UNIFIED_PILL_TONE_CARDS.map((tone) => (
          <SessionsDeltaSlotCard
            cardClassName={summaryCardClass()}
            deltaKey={tone.deltaKey}
            deltas={tone.deltas}
            detail={IN_RANGE_DETAIL}
            key={tone.label}
            label={tone.label}
            value={tone.value}
          />
        ))}
      </SummaryCardRow>
    </WithNeutralDeltaPill>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chips = canvas.getAllByTestId(DELTA_CHIP_TEST_ID);
    await expect(chips).toHaveLength(UNIFIED_PILL_TONE_CARDS.length);

    for (const [index, tone] of UNIFIED_PILL_TONE_CARDS.entries()) {
      const chip = chips[index];
      // AC1 on a canvas: one geometry for every tone, the neutral one included.
      for (const className of unifiedPillClassNames(
        deltaPillGeometryClass(tone.sentiment, MetricDeltaTreatment.NeutralPill)
      )) {
        await expect(chip).toHaveClass(className);
      }
      // …with colour as the only thing that varies between them.
      for (const className of unifiedPillClassNames(
        deltaPillClass(tone.sentiment, MetricDeltaTreatment.NeutralPill)
      )) {
        await expect(chip).toHaveClass(className);
      }
      // AC3, and the line between this ticket and the blocked one: a scored tone
      // still spells its verdict out. `UnifiedPillTones` renders these same
      // cards with no word at all, so this assertion is what separates the two
      // stories rather than duplicating one.
      const verdict = DELTA_SENTIMENT_CAPTION[tone.sentiment];
      if (verdict) {
        await expect(canvas.getAllByText(verdict).length).toBeGreaterThan(0);
      }
    }
  },
};

/**
 * ISS-5842 — the SAME three tones with `metric-delta-unified-pill` ON.
 *
 * Every other story in this file mounts without a flag provider, which is the
 * shipped default and therefore the right baseline — but it also meant the
 * treatment this ticket added could not be rendered in Storybook at all. Tests
 * pin the class strings; only a canvas shows the geometry, the tone pairing and
 * how three pills crowd at the strip's real card width.
 *
 * Read it against {@link NeutralMovement}, its `Legacy` counterpart. The middle
 * card is the whole operator-reported defect: under `Legacy` a neutral movement
 * renders BARE — no pill at all — so a Sessions or Total Tokens card that fell
 * back to the default sat next to a properly pilled Cost card showing a naked
 * grey figure. Under `UnifiedPill` it takes the same rounded geometry as its
 * scored neighbours and is separated from them by COLOUR alone, which is the
 * claim this story exists to let a designer check.
 */
export const UnifiedPillTones: Story = {
  tags: ["!manifest"],
  render: () => (
    <WithUnifiedDeltaPill>
      <SummaryCardRow>
        {UNIFIED_PILL_TONE_CARDS.map((tone) => (
          <SessionsDeltaSlotCard
            cardClassName={summaryCardClass()}
            deltaKey={tone.deltaKey}
            deltas={tone.deltas}
            detail={IN_RANGE_DETAIL}
            key={tone.label}
            label={tone.label}
            value={tone.value}
          />
        ))}
      </SummaryCardRow>
    </WithUnifiedDeltaPill>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chips = canvas.getAllByTestId(DELTA_CHIP_TEST_ID);
    await expect(chips).toHaveLength(UNIFIED_PILL_TONE_CARDS.length);

    for (const [index, tone] of UNIFIED_PILL_TONE_CARDS.entries()) {
      const chip = chips[index];
      // ISS-5842's geometry claim: identical shape on EVERY tone, including the
      // neutral one that renders bare under `Legacy`.
      for (const className of unifiedPillClassNames(
        deltaPillGeometryClass(tone.sentiment, MetricDeltaTreatment.UnifiedPill)
      )) {
        await expect(chip).toHaveClass(className);
      }
      // …and the tone pairing, which is the only channel left once the geometry
      // stops varying. Read from the canonical map, never retyped.
      for (const className of unifiedPillClassNames(
        deltaPillClass(tone.sentiment, MetricDeltaTreatment.UnifiedPill)
      )) {
        await expect(chip).toHaveClass(className);
      }
    }
  },
};

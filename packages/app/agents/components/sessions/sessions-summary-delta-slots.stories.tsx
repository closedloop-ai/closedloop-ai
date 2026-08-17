import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  KpiDeltaPlaceholder,
  NO_COMPARISON_CHIP_LABEL,
} from "@repo/app/insights/components/kpi-delta-placeholder";
import {
  SummaryCardRow,
  summaryCardClass,
} from "@repo/app/shared/components/summary-card-row";
import { WithUnifiedDeltaPill } from "@repo/app/shared/feature-flags/metric-delta-treatment-fixtures";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { formatCurrencyTileValue } from "@repo/app/shared/lib/format-utils";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  DELTA_SENTIMENT_CAPTION,
  DeltaSentiment,
  deltaPillClass,
  deltaPillGeometryClass,
  deltaSentiment,
  MetricDeltaTreatment,
  MetricPolarity,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import { formatDeltaPct } from "@closedloop-ai/loops-api/insights";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import type { SessionSummaryDeltas } from "../../lib/session-summary-deltas";
import { resolveCostCardPresentation } from "./cost-card-presentation";
import {
  SESSIONS_COST_HONEST_METRIC_CARD_LABEL,
  SESSIONS_COST_METRIC_CARD_LABEL,
} from "./cost-metric-card";
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
  resolveComparableDeltas,
  type SessionsDeltaKey,
  SUMMARY_NO_PRIOR_PERIOD,
} from "./sessions-summary-delta-slots";

/**
 * ISS-5698: how a Sessions summary card's DELTA SLOT gets filled.
 *
 * The module under study is three pure functions plus one JSX constant, not a
 * component. What it decides, though, is entirely visual: whether a card shows a
 * graded movement chip, the "No prior period" placeholder, the delivery pair's
 * "No comparison" pill, or an empty footer. Four outcomes a reader has to be able
 * to tell apart, and that a unit test asserting the returned object shape cannot
 * show.
 *
 * So the stories mount a card and reproduce `AlwaysAvailableCards`' wiring
 * verbatim: `resolveComparableDeltas`, then `deltaSlotProps`, then the spread,
 * with `SUMMARY_NO_PRIOR_PERIOD` supplied only when a comparable object survived.
 * What renders here is what the strip renders. Change the wiring in
 * `sessions-summary-cards.tsx` and these stories go stale visibly rather than
 * quietly.
 *
 * The distinction each story exists for: an "All time" range, a metric with no
 * entry, and a suppressed comparison are three different facts, and two of them
 * are NOT allowed to borrow the third's wording.
 */

/**
 * The two cost entries, named so {@link CostBasisPair} can state which basis it
 * expects each card to have resolved to without re-typing a delta key. They move
 * in OPPOSITE directions on purpose: a card that grades the wrong basis then
 * renders a chip pointing the wrong way, which is a visible failure rather than
 * a plausible one — the #4480 defect was one figure graded against another.
 */
const HONEST_COST_DELTA = {
  delta: -12,
  deltaPolarity: MetricPolarity.LowerIsBetter,
} as const;
const COLLAPSED_COST_DELTA = {
  delta: 18,
  deltaPolarity: MetricPolarity.LowerIsBetter,
} as const;

/**
 * A bounded range whose prior read landed, carrying an entry for every
 * always-available card.
 */
const BOUNDED_DELTAS: SessionSummaryDeltas = {
  apiCost: COLLAPSED_COST_DELTA,
  label: "vs. prior 30 days",
  meteredCost: HONEST_COST_DELTA,
  sessions: { delta: 24, deltaPolarity: MetricPolarity.HigherIsBetter },
  tokens: { delta: 61, deltaPolarity: MetricPolarity.Neutral },
};

/**
 * A SETTLED usage payload whose metered + unknown split reconciles with the API
 * total. That reconciliation is the precondition `resolveCostCardPresentation`
 * tests before it will take the honest basis, so this fixture is what makes the
 * honest branch reachable rather than assumed.
 */
const RECONCILING_USAGE = createAgentSessionUsageSummaryFixture(
  AgentSessionViewerScope.Organization,
  {
    totalEstimatedCost: 16_867,
    subscriptionEstimatedCost: 42,
    apiEstimatedCost: 16_825,
    meteredEstimatedCost: 42,
    unknownEstimatedCost: 16_783,
  }
);

/** The Cost card as the honesty flag renders it: the metered basis. */
const HONEST_COST_PRESENTATION = resolveCostCardPresentation(
  true,
  RECONCILING_USAGE
);

/** The same payload with the flag off: the collapsed API basis. */
const COLLAPSED_COST_PRESENTATION = resolveCostCardPresentation(
  false,
  RECONCILING_USAGE
);

/** The caption every card in these stories carries, so only the slot varies. */
const IN_RANGE_DETAIL = "in the active filter set";

const meta = {
  title: "App Core/Agents/Sessions Summary Delta Slots",
  component: SessionsDeltaSlotCard,
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
    deltaKey: "sessions",
    deltas: BOUNDED_DELTAS,
    detail: IN_RANGE_DETAIL,
    label: SESSIONS_METRIC_CARD_LABEL,
    value: "1,284",
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
    deltaKey: "apiCost",
    label: SESSIONS_COST_METRIC_CARD_LABEL,
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
 * A bounded range where THIS card has no entry: a prior read that has not landed,
 * or a baseline too small for `pctDelta` to divide by.
 *
 * Renders identically to {@link AllTimeHasNoPriorPeriod} on purpose. The host
 * compares, and this one card cannot, which is the same thing to say. The two
 * stories exist separately because the CAUSES are different and someone reading
 * one of them will want to know the other reaches the same pixels.
 */
export const NoEntryForThisCard: Story = {
  args: { deltas: { label: BOUNDED_DELTAS.label } },
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
 * `resolveCostCardPresentation` picks the metered figure when the honesty flag is
 * on and the producer sent a usable split, and the API figure otherwise. One
 * "cost" delta would have graded whichever basis this module happened to choose
 * against whatever the card actually rendered, two different figures under one
 * chip. The movements deliberately point OPPOSITE ways, so a card reading the
 * wrong key is visible at a glance instead of being plausible.
 *
 * PR #4814 review: nothing here spells a delta key. An earlier draft passed the
 * literals `"meteredCost"` and `"apiCost"`, which made the story a COPY of
 * production's mapping rather than a reader of it — flip
 * `sessions-summary-cards.tsx` to grade the metered chip against the API
 * headline and this canvas would have gone on showing the correct pairing. Both
 * cards are now built from a real `resolveCostCardPresentation` result: the
 * label and the headline come off that object, and the delta key comes from the
 * shared `costDeltaKey` the production strip calls, so the story moves when the
 * wiring moves.
 */
export const CostBasisPair: Story = {
  render: () => (
    <SummaryCardRow>
      {[HONEST_COST_PRESENTATION, COLLAPSED_COST_PRESENTATION].map(
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
    // The two cards must not be the same card: the honest basis carries its own
    // label, and a regression that collapsed the presentation would render the
    // fallback label twice.
    await expect(
      canvas.getByText(SESSIONS_COST_HONEST_METRIC_CARD_LABEL)
    ).toBeVisible();
    await expect(
      canvas.getByText(SESSIONS_COST_METRIC_CARD_LABEL)
    ).toBeVisible();

    // `BOUNDED_DELTAS` points the two bases in OPPOSITE directions, so the pair
    // of rendered chips is a direct read of which key each card chose. Swap the
    // mapping in `costDeltaKey` and these two swap with it. Expectations go
    // through `formatDeltaPct`, the same SSOT the chip renders with, so this
    // pins the KEY each card resolved and not the chip's formatting.
    const chips = canvas.getAllByTestId(DELTA_CHIP_TEST_ID);
    expect(chips.map((chip) => chip.textContent)).toEqual([
      formatDeltaPct(HONEST_COST_DELTA.delta),
      formatDeltaPct(COLLAPSED_COST_DELTA.delta),
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
 * delta), and `SUMMARY_NO_PRIOR_PERIOD` is offered as the placeholder only when a
 * comparable object survived, which is what makes the suppressed states render an
 * empty footer rather than a claim.
 */
function SessionsDeltaSlotCard({
  cardClassName,
  cardsLoading = false,
  deltaKey,
  deltas,
  detail,
  errored = false,
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
      deltaPlaceholder={comparableDeltas ? SUMMARY_NO_PRIOR_PERIOD : undefined}
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
    deltaKey: "apiCost",
    deltas: createSessionSummaryDeltasFixture({
      apiCost: { delta: 18, deltaPolarity: MetricPolarity.LowerIsBetter },
    }),
    label: SESSIONS_COST_METRIC_CARD_LABEL,
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

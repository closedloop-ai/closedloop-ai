import { metrics } from "@repo/app/agents/lib/session-mock-data";
import { KpiDeltaPlaceholder } from "@repo/app/insights/components/kpi-delta-placeholder";
import {
  SummaryCardRow,
  summaryCardClass,
} from "@repo/app/shared/components/summary-card-row";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  MetricCardLane,
  MetricCardLaneList,
} from "@repo/design-system/components/ui/primitives/metric-card-lane";
import {
  MetricDeltaTreatment,
  MetricPolarity,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Composites v1.0/Data Display/Metric Card",
  component: MetricCard,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    label: {
      control: "text",
      description: "Uppercase caption rendered above the value.",
    },
    value: {
      control: "text",
      description: "Formatted metric value (string or number).",
    },
    unitLabel: {
      control: "text",
      description: "Unit suffix rendered beside the value (FEA-2416).",
    },
    detail: {
      control: "text",
      description: "Secondary caption in the footer.",
    },
    trend: {
      control: "text",
      description: "Emphasised trend text aligned to the footer end.",
    },
    delta: {
      control: { type: "select" },
      options: [undefined, -8, 0, 12],
      description:
        "Period-over-period change (`number`). Renders a signed chip whose glyph follows the number's direction and whose colour follows `deltaPolarity`. When omitted, `deltaPlaceholder` (if provided) fills the same delta slot.",
    },
    deltaPolarity: {
      control: { type: "radio" },
      options: [
        MetricPolarity.HigherIsBetter,
        MetricPolarity.LowerIsBetter,
        MetricPolarity.Neutral,
      ],
      description:
        'Which direction is GOOD for this metric (ISS-4633). Defaults to `higher-is-better`; a spend/latency/backlog metric MUST pass `lower-is-better` or a rise renders as if the card were improving. The caption leads with a visible "better"/"worse" so the verdict is never colour-only.',
    },
    deltaLabel: {
      control: "text",
      description: 'Caption beside the delta chip (e.g. "vs. prior 90 days").',
    },
    deltaTreatment: {
      control: { type: "radio" },
      options: [
        MetricDeltaTreatment.Legacy,
        MetricDeltaTreatment.NeutralPill,
        MetricDeltaTreatment.UnifiedPill,
      ],
      description:
        "Which delta chrome the CONSUMER resolved (ISS-5842, ISS-6493). Defaults to `legacy`, so a caller that passes nothing renders exactly what shipped before. `neutral-pill` pills every tone and KEEPS the verdict word; `unified-pill` is its strict superset and also drops the word. Only a NEUTRAL tone renders differently across the three — scored tones share geometry and colour throughout.",
    },
    deltaPlaceholder: {
      control: false,
      description:
        '"No comparison" affordance rendered in the delta slot when `delta` is omitted, so the footer layout stays stable across ranges.',
    },
    sparkline: {
      control: "object",
      description:
        "Recent values, oldest first; when the delta is a number and at least two points are finite, the chip renders a sparkline instead of an icon. A `null` is a bucket that could not be computed: it holds its own slot and breaks the stroke there rather than closing the line over it.",
    },
    sparklineWithoutDelta: {
      control: "boolean",
      description:
        "Opt in to drawing `sparkline` in the delta slot even with no numeric delta (ISS-10363), so a card with a real series and no prior window is not left blank.",
    },
    info: {
      control: "object",
      description: "`{ what, how? }` explainer rendered in a label popover.",
    },
    placeholder: {
      control: "boolean",
      description:
        'Dims the card and adds a "Sample" badge for placeholder data.',
    },
    loading: {
      control: "boolean",
      description:
        "Keeps the card frame (label, info, footer/detail) and skeletons ONLY the value while it hydrates — the partial-load pattern, never a bare slab.",
    },
    valueUnavailable: {
      control: "boolean",
      description:
        'Forces the no-data value slot for a non-null placeholder value. A nullish `value` triggers the same state automatically, so callers usually pass `value={null}` instead of setting this. Renders `valueUnavailableLabel` ("No data") muted at the SAME 2xl size the value occupies — the card keeps full opacity (unlike `muted`, which dims the whole card for a failed read) and stays baseline-aligned with a sibling that has a value.',
    },
    valueUnavailableLabel: {
      control: "text",
      description:
        'Copy for the no-data value slot when the value is absent (default "No data").',
    },
    hideWhenUnavailable: {
      control: "boolean",
      description:
        "ISS-9730, off by default: a NOT-COMPUTABLE card renders nothing at all — no card, no glyph, no caption — instead of the no-data slot. Only that one state hides: `loading` keeps its skeleton, `muted` (a FAILED read) keeps rendering because an error is not an absence, and a real `0` was never a no-data state. In `packages/app` the value comes from `useMetricCardHideUnavailable()`; the primitive takes it as a prop because the design system is gated from reading app flags.",
    },
  },
  parameters: {
    layout: "centered",
  },
  args: {
    label: "Active sessions",
    value: 18,
    className: "w-[280px]",
  },
} satisfies Meta<typeof MetricCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Overview grid of the dashboard KPI mocks (label/value/detail/trend only). */
export const Default: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-[960px] gap-4 md:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <MetricCard key={metric.label} {...metric} />
      ))}
    </div>
  ),
  parameters: { controls: { disable: true } },
};

/** `unitLabel` renders a unit suffix beside the formatted value (FEA-2416). */
export const WithUnitLabel: Story = {
  args: {
    label: "Avg. session length",
    value: 42,
    unitLabel: "min",
    detail: "P50 across all agents",
  },
};

/**
 * On a higher-is-better metric (the default polarity), a rise is a green up chip
 * captioned "better …".
 */
export const WithDelta: Story = {
  args: {
    label: "Events processed",
    value: "28.4k",
    delta: 12,
    deltaLabel: "vs. prior 90 days",
    deltaPolarity: MetricPolarity.HigherIsBetter,
  },
};

/**
 * The same higher-is-better metric falling: a red down chip captioned "worse …".
 */
export const WithNegativeDelta: Story = {
  args: {
    label: "Failed sessions",
    value: 6,
    delta: -8,
    deltaLabel: "vs. prior 90 days",
    deltaPolarity: MetricPolarity.HigherIsBetter,
  },
};

/**
 * ISS-4633: the SAME +38% on a lower-is-better metric. The arrow stays honest
 * (the number went up) while the colour and the visible "worse" caption report
 * the sentiment — a growing bill must never read as an improvement.
 */
export const LowerIsBetterRising: Story = {
  args: {
    label: "Cost",
    value: "$123,607",
    delta: 38,
    deltaLabel: "vs. prior 90 days",
    deltaPolarity: MetricPolarity.LowerIsBetter,
  },
};

/**
 * A metric with no good direction (raw token volume, models in use) states the
 * movement without a verdict: muted chip, no "better"/"worse" word.
 */
export const NeutralPolarity: Story = {
  args: {
    label: "Tokens",
    value: "24.1B",
    delta: 38,
    deltaLabel: "vs. prior 90 days",
    deltaPolarity: MetricPolarity.Neutral,
  },
};

/** A flat 0% holds steady: a minus glyph and a muted chip, never a green win. */
export const FlatDelta: Story = {
  args: {
    label: "Merged PRs",
    value: 42,
    delta: 0,
    deltaLabel: "vs. prior 90 days",
    deltaPolarity: MetricPolarity.HigherIsBetter,
  },
};

/**
 * ISS-6493 `MetricDeltaTreatment.NeutralPill`, mounted on the ONE branch that
 * exercises it. A scored tone gets identical geometry AND colour under every
 * treatment, so a card stuck on the `Legacy` default still looks correct there —
 * a story built on a green +12% would pin nothing. NEUTRAL is the only tone the
 * treatments render differently: `Legacy` (see {@link FlatDelta} and
 * {@link NeutralPolarity} directly above, both neutral and both BARE) leaves the
 * chip without pill chrome, and this treatment gives it the shared pill geometry
 * plus `bg-foreground/5`.
 *
 * The verdict word is the axis this treatment deliberately does NOT move: it
 * still leads the caption exactly as under `Legacy`. That separation is the
 * whole ticket — `UnifiedPill` is the strict superset that also drops the word,
 * and it remains gated behind the unanswered #4823 hue-alone question.
 */
export const NeutralPillTreatment: Story = {
  args: {
    label: "Tokens",
    value: "24.1B",
    delta: -52,
    deltaLabel: "vs. prior 90 days",
    deltaPolarity: MetricPolarity.Neutral,
    deltaTreatment: MetricDeltaTreatment.NeutralPill,
  },
  name: "Neutral delta, NeutralPill treatment",
};

/**
 * With no numeric `delta`, `deltaPlaceholder` fills the SAME delta slot the chip
 * would occupy, so a card without a comparison keeps a stable footer layout
 * rather than dropping the delta info to a different corner.
 *
 * ISS-4995: this renders the real `KpiDeltaPlaceholder`, the component every
 * production caller passes here. It used to be a hand-copied `<span>` with the
 * chip's classes pasted in, which stopped matching the moment the chip became a
 * focusable button with a focus ring and a `cursor-default` override.
 */
export const WithDeltaPlaceholder: Story = {
  args: {
    label: "Estimated cost",
    value: "$219.43",
    deltaPlaceholder: <KpiDeltaPlaceholder />,
    detail: "Awaiting first full comparison window",
  },
};

/**
 * When `sparkline` has at least two finite points, the numeric delta chip
 * renders a real trend sparkline in place of the directional icon.
 */
export const WithSparkline: Story = {
  args: {
    label: "Running agents",
    value: 44,
    delta: 11,
    deltaLabel: "vs. prior 90 days",
    deltaPolarity: MetricPolarity.HigherIsBetter,
    sparkline: [28, 31, 30, 34, 38, 41, 44],
  },
};

/**
 * The standalone mark (ISS-10363): `sparklineWithoutDelta` draws the series in
 * the delta slot for a card that has no comparable prior figure.
 *
 * The series and the delta answer two different questions — what the period
 * looked like, and how it compares to the one before it. Before this mode the
 * mark lived only INSIDE the delta chip, so a card with a real series and no
 * prior window drew nothing: one absent operand deleted a capability computed
 * from the other. On Branches that is every card in every window.
 */
export const StandaloneSparkline: Story = {
  args: {
    label: "Total LOC pushed",
    value: "18,402",
    detail: "Last 90 days",
    sparkline: [28, 31, 30, 34, 38, 41, 44],
    sparklineWithoutDelta: true,
  },
  name: "Standalone sparkline (no delta)",
};

/**
 * A bucket the producer could not compute is `null`, and it keeps its SLOT.
 *
 * The stroke breaks at the gap rather than closing over it, so the mark never
 * claims a trend through a period that was not measured; a measured bucket with
 * unmeasured neighbours stays visible as its own point rather than silently
 * drawing nothing. Beside it, the same series with the gaps filled in, so the
 * two shapes can be compared directly.
 */
export const StandaloneSparklineWithGaps: Story = {
  render: () => (
    <div className="grid w-[600px] grid-cols-2 gap-4">
      <MetricCard
        detail="Partial coverage"
        label="Median PR size"
        sparkline={[28, null, 30, 34, null, null, 44]}
        sparklineWithoutDelta
        value="34"
      />
      <MetricCard
        detail="Complete coverage"
        label="Median PR size"
        sparkline={[28, 29, 30, 34, 38, 41, 44]}
        sparklineWithoutDelta
        value="34"
      />
    </div>
  ),
  name: "Standalone sparkline holds uncomputable buckets open",
};

/**
 * Both operands absent-or-present independently: the card states the missing
 * comparison in words AND draws the period it does know, rather than letting
 * either stand in for the other.
 */
export const StandaloneSparklineBesidePlaceholder: Story = {
  args: {
    label: "Merge rate",
    value: "72%",
    sparkline: [61, 64, 63, 68, 70, 71, 72],
    sparklineWithoutDelta: true,
    deltaPlaceholder: (
      <KpiDeltaPlaceholder reason="No prior window to compare" />
    ),
  },
  name: "Standalone sparkline beside a no-comparison placeholder",
};

/** `info` renders an explainer popover trigger beside the label. */
export const WithInfoTooltip: Story = {
  args: {
    label: "Events processed",
    value: "28.4k",
    info: {
      what: "Total realtime events ingested across all connected agents.",
      how: "Counted from the ingest pipeline over the selected time range.",
    },
  },
  name: "With info popover",
};

/**
 * `placeholder` dims the card and adds a "Sample" badge to flag values that are
 * mock data pending real backend wiring.
 */
export const Placeholder: Story = {
  args: {
    label: "Estimated cost",
    value: "$219.43",
    detail: "Last 30 days",
    placeholder: true,
  },
};

/**
 * `loading` keeps the card's label, info popover, and detail caption intact and
 * skeletons ONLY the value slot — the partial-load pattern, so a hydrating card
 * still says what it is and why it's blank instead of collapsing to a bare slab.
 */
export const Loading: Story = {
  args: {
    label: "Sessions",
    value: 0,
    detail: "Importing your history",
    info: {
      what: "Agent sessions matching the current filters and time range.",
      how: "Count of session records in the active filter set.",
    },
    loading: true,
  },
};

/**
 * A genuine no-data state (FEA-4236): a nullish `value` renders the muted "No
 * data" glyph in the value slot INSTEAD of a bold 2xl em-dash — which reads like
 * a struck/rule value rather than "nothing to show". The card stays at FULL
 * opacity (unlike `muted`, which dims the whole card for a failed read) and the
 * value keeps its 2xl slot, so it stays baseline-aligned with a sibling that has
 * a value and the card doesn't reflow. Pair it with a `detail` caption that says
 * WHY the value is absent.
 */
export const ValueUnavailable: Story = {
  args: {
    label: "Value per $",
    value: null,
    detail: "This branch merged, but its lines changed haven't synced yet.",
    info: {
      what: "Total lines changed (added + removed) per dollar spent.",
      how: "Lines changed ÷ estimated cost. Prefers the connected PR's live LOC.",
    },
  },
  name: "Value unavailable (no data)",
};

/**
 * The no-data state sits at full opacity beside a card with a real value, so the
 * two cards stay baseline-aligned and the muted "No data" reads as an absent
 * metric — never as the dimmed whole-card `muted` failed-read treatment.
 */
export const ValueUnavailableBesideValue: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-[576px] grid-cols-2 gap-4">
      <MetricCard
        detail="Lines changed ÷ estimated cost"
        label="Value per $"
        value="128 LOC/$"
      />
      <MetricCard
        detail="Estimated cost is unavailable."
        label="Value per $"
        value={null}
      />
    </div>
  ),
  name: "Value unavailable beside a value",
};

/**
 * ISS-4787: the SUMMARY STRIP reserves a two-line label region for its cards, so
 * a card whose label wraps at the strip's card width starts its value on the
 * same line as its one-line siblings. Before the reservation the wrapped card's
 * value sagged a whole line-height below the rest and the row read as a jagged
 * baseline instead of one aligned rank of numbers.
 *
 * The wrapping label here is a SYNTHETIC FIXTURE, not shipped copy. It used to
 * be the Sessions Cost card's "Non-subscription Cost", which was the only label
 * either strip shipped that wrapped at all; that card is now labelled "Cost" and
 * nothing in the shipped set reaches a second line. Naming a real label here
 * again would put this story back at the mercy of the next copy edit — the
 * geometry it demonstrates is a property of `SummaryCardRow`, so its input is
 * pinned to a string chosen to wrap rather than to whatever the product happens
 * to call a metric this quarter.
 *
 * The reservation belongs to `SummaryCardRow`, not to `MetricCard` — a floor in
 * the primitive charged every consumer, including the fixed-height Insights KPI
 * tiles (review, whitlockk). So this story renders the real `SummaryCardRow`: it is
 * what produces the effect, not just a convenient width.
 */
export const WrappingLabelBaseline: Story = {
  tags: ["!manifest"],
  render: () => (
    <SummaryCardRow>
      <MetricCard
        className={summaryCardClass()}
        detail="in the selected range"
        label="Sessions"
        value="1,284"
      />
      <MetricCard
        className={summaryCardClass()}
        detail="+$412 if billed to API"
        info={{
          what: "What the matched sessions cost that's not covered by a subscription or seat.",
        }}
        label={WRAPPING_FIXTURE_LABEL}
        value="$19,608"
      />
      <MetricCard
        className={summaryCardClass()}
        detail="merged in the selected range"
        label="PRs Shipped"
        value="96"
      />
    </SummaryCardRow>
  ),
  name: "Wrapping label keeps the baseline",
};

/**
 * The reservation is a FLOOR, not a clamp. Squeezed into the two-column mobile
 * grid the strip falls back to, a long label can still take a third line — the
 * label stays fully readable and that card alone gives up the shared baseline,
 * which is the right trade on a two-up grid that never reads as a rank of numbers
 * the way a five-across strip does. Shown so the narrow case is visible here
 * rather than only on someone's phone.
 *
 * The story pins a 360×720 VIEWPORT rather than wrapping the strip in a 360px
 * box (review, whitlockk): `SummaryCardRow`'s `max-md:` fallback is a Tailwind media
 * query, so it keys off the viewport, not the element width — a narrow wrapper
 * inside a wide canvas renders the `md+` auto-fit grid and never shows the
 * mobile case this story claims to cover.
 */
export const WrappingLabelNarrowColumn: Story = {
  globals: { viewport: { value: "360-720" } },
  tags: ["!manifest"],
  render: () => (
    <SummaryCardRow wrapBelow>
      <MetricCard
        className={summaryCardClass(true)}
        detail="in the selected range"
        label="Sessions"
        value="1,284"
      />
      <MetricCard
        className={summaryCardClass(true)}
        detail="+$412 if billed to API"
        label={WRAPPING_FIXTURE_LABEL}
        value="$19,608"
      />
    </SummaryCardRow>
  ),
  name: "Wrapping label in a narrow column",
};

/**
 * The label the two `WrappingLabel*` stories above feed the strip, chosen ONLY
 * because it is long enough to take a second line at the strip's card width (and
 * a third in the two-column mobile fallback). It is deliberately not any string
 * the product ships: those stories demonstrate `SummaryCardRow`'s label
 * reservation, which is geometry, and pinning them to real copy is what let a
 * label rename silently turn both into one-line stories that no longer showed
 * the thing they are named for.
 */
const WRAPPING_FIXTURE_LABEL = "A Deliberately Long Metric Label";

/**
 * The `lanes` slot: a breakdown of the headline into named parts, composed from
 * `MetricCardLane`. The share column is a fixed track, so it stays aligned down
 * the list however long the labels are — the whole reason the geometry lives in
 * the primitive rather than at each call site.
 */
export const WithLanes: Story = {
  args: {
    label: "Total estimated cost",
    value: "$154,524",
    delta: -4.2,
    deltaPolarity: MetricPolarity.LowerIsBetter,
    deltaLabel: "vs. prior 30 days",
    lanes: (
      <MetricCardLaneList>
        <MetricCardLane label="API-billed" share="0.0%" value="$0" />
        <MetricCardLane
          label="Subscription-covered"
          share=">99.9%"
          value="$154,314"
        />
        {/* NOT muted: $210 is a real, separately-known amount, which the `muted`
            contract excludes. `LanesWithWrappingLabel` below is the story that
            demonstrates the treatment. */}
        <MetricCardLane label="Billing unknown" share="0.1%" value="$210" />
      </MetricCardLaneList>
    ),
  },
};

/**
 * A long lane label WRAPS rather than truncating. `truncate` would be
 * `overflow:hidden`, which clips away any affordance the label carries; the
 * fixed value track means a wrapping label cannot collide with the figures.
 */
export const LanesWithWrappingLabel: Story = {
  args: {
    label: "Total estimated cost",
    value: "$8,413",
    lanes: (
      <MetricCardLaneList>
        <MetricCardLane
          label="Subscription-covered"
          share="94.9%"
          value="$7,980"
        />
        {/* `muted` marks a lane that is not a figure in its own right — this
            one stands in for two the source could not separate. A lane carrying
            a real, separately-known amount keeps full weight. */}
        <MetricCardLane
          label="Not subscription-covered"
          muted
          share="5.1%"
          value="$433"
        />
      </MetricCardLaneList>
    ),
  },
};

/** No `lanes` slot: byte-for-byte the shipped card, so the prop is additive. */
export const WithoutLanes: Story = {
  args: {
    label: "Total estimated cost",
    value: "$154,524",
    detail: "+$154,314 if billed to API",
  },
};

/**
 * ISS-9730 `hideWhenUnavailable`, the mode that renders NOTHING. Shown as a row
 * so the sweep can see what the reader actually gets: the middle card is not
 * computable and is gone, and the row closes over the gap rather than leaving a
 * hole — the same three-column grid, two cards wide.
 *
 * Compare it against {@link ValueUnavailableBesideValue} directly above, which
 * is this exact condition with the gate OFF and is what ships today.
 */
export const HiddenWhenUnavailable: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-[880px] grid-cols-3 gap-4">
      <MetricCard detail="Last 30 days" label="Merged PRs" value="42" />
      <MetricCard
        detail="Estimated cost is unavailable."
        hideWhenUnavailable
        label="Value per $"
        value={null}
      />
      <MetricCard detail="Last 30 days" label="Median PR size" value="148" />
    </div>
  ),
  name: "Hidden when unavailable (gate on)",
};

/**
 * The three states the hide must never swallow, under the SAME enabled gate.
 * Each one still renders, and each says something different: a hydrating card
 * keeps its skeleton rather than shedding and regrowing mid-fetch, a failed read
 * keeps the reader's only signal that something broke, and a real `$0.00` is a
 * fact about the population rather than an absence.
 */
export const HideGateSpares: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-[880px] grid-cols-3 gap-4">
      <MetricCard
        detail="Importing your history"
        hideWhenUnavailable
        label="Sessions"
        loading
        value={null}
      />
      <MetricCard
        detail="Unavailable"
        hideWhenUnavailable
        label="Merge rate"
        muted
        value="—"
      />
      <MetricCard
        detail="Last 30 days"
        hideWhenUnavailable
        label="AI spend"
        value="$0.00"
      />
    </div>
  ),
  name: "Hide gate spares loading, failed, and a real zero",
};

import { metrics } from "@repo/app/agents/lib/session-mock-data";
import { KpiDeltaPlaceholder } from "@repo/app/insights/components/kpi-delta-placeholder";
import {
  SummaryCardRow,
  summaryCardClass,
} from "@repo/app/shared/components/summary-card-row";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  MetricDeltaTreatment,
  MetricPolarity,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A card for one headline number with a signed change chip showing a rise or
 * fall, best for a single metric with a meaningful comparison rather than
 * many rows at once.
 */
const meta = {
  title: "Composites/Data Display/Metric Card",
  component: MetricCard,
  tags: ["autodocs"],
  argTypes: {
    label: {
      control: "text",
      description: "Uppercase caption rendered above the value.",
      table: { category: "Content" },
    },
    value: {
      control: "text",
      description: "Formatted metric value (string or number).",
      table: { category: "Content" },
    },
    unitLabel: {
      control: "text",
      description: "Unit suffix rendered beside the value (FEA-2416).",
      table: { category: "Content" },
    },
    detail: {
      control: "text",
      description: "Secondary caption in the footer.",
      table: { category: "Content" },
    },
    trend: {
      control: "text",
      description: "Emphasised trend text aligned to the footer end.",
      table: { category: "Content" },
    },
    info: {
      control: "object",
      description: "`{ what, how? }` explainer rendered in a label popover.",
      table: { category: "Content" },
    },
    delta: {
      // Bounded to the display ceiling the component's own formatter uses
      // (MAX_DELTA_PCT); past it a caller is expected to pass `deltaCapped`.
      control: { type: "number", min: -999, max: 999, step: 1 },
      description:
        "Period-over-period change (`number`). Renders a signed chip whose glyph follows the number's direction and whose colour follows `deltaPolarity`. When omitted, `deltaPlaceholder` (if provided) fills the same delta slot.",
      table: { category: "Delta" },
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
      table: { category: "Delta" },
    },
    deltaLabel: {
      control: "text",
      description: 'Caption beside the delta chip (e.g. "vs. prior 90 days").',
      table: { category: "Delta" },
    },
    deltaCapped: {
      control: "boolean",
      description:
        'Marks a numeric `delta` as clamped by the caller, so the chip renders the ">999%" / "<-999%" affordance instead of implying the exact figure.',
      table: { category: "Delta" },
    },
    deltaTreatment: {
      control: { type: "radio" },
      options: [MetricDeltaTreatment.Legacy, MetricDeltaTreatment.UnifiedPill],
      description:
        "Which delta presentation the consumer has opted into (ISS-5842). `legacy` scores the chip and prints the verdict word; `unified-pill` gives every tone the same pill geometry and drops the word.",
      table: { category: "Delta" },
    },
    deltaPlaceholder: {
      control: false,
      description:
        '"No comparison" affordance rendered in the delta slot when `delta` is omitted, so the footer layout stays stable across ranges.',
      table: { category: "Delta" },
    },
    sparkline: {
      control: "object",
      description:
        "Recent values; when the delta is a number and at least two points are finite, the chip renders a sparkline instead of an icon.",
      table: { category: "Delta" },
    },
    placeholder: {
      control: "boolean",
      description:
        'Dims the card and adds a "Sample" badge for placeholder data.',
      table: { category: "State" },
    },
    muted: {
      control: "boolean",
      description:
        'Dims the card WITHOUT the "Sample" badge, for a value that failed to load rather than demo data. Ignored when `placeholder` is set.',
      table: { category: "State" },
    },
    loading: {
      control: "boolean",
      description:
        "Keeps the card frame (label, info, footer/detail) and skeletons ONLY the value while it hydrates — the partial-load pattern, never a bare slab.",
      table: { category: "State" },
    },
    valueUnavailable: {
      control: "boolean",
      description:
        'Forces the no-data value slot for a non-null placeholder value. A nullish `value` triggers the same state automatically, so callers usually pass `value={null}` instead of setting this. Renders `valueUnavailableLabel` ("No data") muted at the SAME 2xl size the value occupies — the card keeps full opacity (unlike `muted`, which dims the whole card for a failed read) and stays baseline-aligned with a sibling that has a value.',
      table: { category: "State" },
    },
    valueUnavailableLabel: {
      control: "text",
      description:
        'Copy for the no-data value slot when the value is absent (default "No data").',
      table: { category: "State" },
    },
    className: {
      control: "text",
      description: "Extra classes merged onto the card frame.",
      table: { category: "Appearance" },
    },
  },
  parameters: {
    layout: "centered",
  },
  args: {
    label: "Active sessions",
    value: 18,
    className: "w-[280px]",
    deltaTreatment: MetricDeltaTreatment.Legacy,
    deltaCapped: false,
    placeholder: false,
    muted: false,
    loading: false,
    valueUnavailable: false,
  },
} satisfies Meta<typeof MetricCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Overview grid of the dashboard KPI mocks (label/value/detail/trend only). */
export const Default: Story = {
  render: () => (
    <div className="grid w-[960px] gap-4 md:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <MetricCard key={metric.label} {...metric} />
      ))}
    </div>
  ),
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
  },
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
    sparkline: [28, 31, 30, 34, 38, 41, 44],
  },
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
 * tiles (review, wongk). So this story renders the real `SummaryCardRow`: it is
 * what produces the effect, not just a convenient width.
 */
export const WrappingLabelBaseline: Story = {
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
 * box (review, wongk): `SummaryCardRow`'s `max-md:` fallback is a Tailwind media
 * query, so it keys off the viewport, not the element width — a narrow wrapper
 * inside a wide canvas renders the `md+` auto-fit grid and never shows the
 * mobile case this story claims to cover.
 */
export const WrappingLabelNarrowColumn: Story = {
  globals: { viewport: { value: "360-720" } },
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

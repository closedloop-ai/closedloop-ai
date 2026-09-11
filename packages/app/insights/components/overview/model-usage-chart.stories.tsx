import type { TimeSeries } from "@repo/api/src/types/insights";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import { ModelUsageChart } from "./model-usage-chart";

/**
 * ISS-5523 (wongk story-reviewer, #4717): canvas for the dashboard's model
 * usage graph, which had no story anywhere.
 *
 * The sibling `TokenTrendChart` already carries a co-located story for exactly
 * this reason, and its doc comment notes the design-system story "covers none of
 * this". The same holds here, more so: `TimeSeriesAreaChart`'s own
 * `ManySeriesCapped`/`Uncapped` stories prove the FOLD, but they render a bare
 * chart. What they cannot show is how the aggregate band sits inside this card's
 * real chrome — the `SectionHeader`, the live `$`/`#` and model/provider toggles,
 * and the loading / "unavailable" states this component resolves on its own.
 *
 * The cap is gated, so a capped story must turn the gate ON via
 * `parameters.appCore.enabledFlags`. `useChartMaxSeries` reads the flag through
 * the OPTIONAL adapter, so a story that names no flag renders the pre-ISS-5523
 * view rather than throwing — which is what `Default` is.
 *
 * ON PROVIDER GROUPING. The review asked for a provider-grouped CAPPED variant
 * too. That state is not reachable, and deliberately so: `groupByProvider`
 * collapses every model onto `providerOf(...)`, which yields a handful of
 * buckets, so the provider axis cannot exceed a cap of ten. The
 * `usageOtherSeriesLabel` doc comment says the same thing about its own
 * "Remaining providers" branch — written to stay correct if the provider set
 * ever grows, not because it renders today. `ProviderGrouped` below therefore
 * pins the provider axis in its real (unfolded) form; a story asserting
 * "Remaining providers (N)" would be pinning a screen no user can reach.
 */

const DAYS = 14;
const FIRST_DAY = Date.parse("2026-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function dayLabel(offset: number): string {
  return new Date(FIRST_DAY + offset * DAY_MS).toISOString().slice(0, 10);
}

const MODEL_NAMES = [
  "claude-opus-4-5",
  "gpt-5.4",
  "claude-sonnet-4-5",
  "gemini-3-pro",
  "gpt-5-mini",
  "claude-haiku-4",
  "llama-4-405b",
  "mistral-large-3",
  "gemini-3-flash",
  "grok-4",
  "deepseek-v4",
  "qwen-3-max",
  "command-r-plus-2",
  "phi-5",
  "gpt-4.1-legacy",
  "claude-opus-4-1",
  "titan-text-premier",
];

/**
 * `count` models over a fortnight with clearly separated magnitudes, so the
 * fold's ranking is unambiguous and the legend order is stable between reloads.
 * Real-looking ids on purpose: the palette is keyed positionally, and model ids
 * containing a "." are the reason colours are bound to the `<Area>` directly
 * rather than through a `--color-<key>` CSS variable.
 */
function modelSeries(count: number, scale = 1): TimeSeries {
  const names = Array.from({ length: count }, (_unused, index) =>
    index < MODEL_NAMES.length ? MODEL_NAMES[index] : `custom-model-${index}`
  );
  return {
    series: names.map((name) => ({ key: name, label: name })),
    points: Array.from({ length: DAYS }, (_unused, day) => ({
      date: dayLabel(day),
      values: Object.fromEntries(
        names.map((name, index) => [
          name,
          // Descending by rank, with a gentle per-day wobble so the stack has
          // shape rather than reading as flat bands.
          Number(
            ((count - index) * scale * (1 + Math.sin(day / 3) * 0.15)).toFixed(
              2
            )
          ),
        ])
      ),
    })),
  };
}

/** Seven models — the most either producer emits today (see the note on Default). */
const REALISTIC_SPEND = modelSeries(7, 0.9);
const REALISTIC_TOKENS = modelSeries(7, 120_000);

/** Seventeen models — the population that provoked ISS-5523. */
const MANY_SPEND = modelSeries(17, 0.9);
const MANY_TOKENS = modelSeries(17, 120_000);

/** Eleven models — exactly one past the cap. */
const BOUNDARY_SPEND = modelSeries(11, 0.9);

function CardFrame({ children }: Readonly<{ children: ReactNode }>) {
  // Mirrors the dashboard's own card box for this row (`h-[340px]`), so the
  // legend and plot get the height they actually have in production rather than
  // an unconstrained canvas that hides clipping.
  return (
    <div className="max-w-4xl p-6">
      <div className="h-[340px] rounded-lg border bg-card p-4">{children}</div>
    </div>
  );
}

const storyDecorator: Decorator = (Story) => (
  <CardFrame>
    <Story />
  </CardFrame>
);

/**
 * A dashboard card charting AI spend or token usage over time by model or
 * provider, folding the smallest models into one Other models band past ten.
 */
const meta = {
  title: "Composites/Insights/Model Usage Chart",
  component: ModelUsageChart,
  tags: ["autodocs"],
  argTypes: {
    series: {
      control: "object",
      description:
        "Spend by model over time. Undefined is the whole card's loading sentinel.",
    },
    tokenSeries: {
      control: "object",
      description:
        "Optional token volume. Undefined while spend has arrived is a completed absence, and the # view resolves to the unavailable empty state.",
    },
  },
  parameters: { layout: "fullscreen" },
  args: { series: REALISTIC_SPEND, tokenSeries: REALISTIC_TOKENS },
  decorators: [storyDecorator],
} satisfies Meta<typeof ModelUsageChart>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The everyday view, gate CLOSED — the pre-ISS-5523 behaviour every user sees
 * today. Seven models, because that is the most either producer emits: both
 * `apps/api`'s `modelUsageSeries` and desktop's `buildModelSeries` keep a top-6
 * plus a producer-side "Other" bucket. Note that producer "Other" is a REAL
 * series with a real colour, and is not the ISS-5523 aggregate band.
 *
 * Both toggles are live here: `$`/`#` swaps spend for token volume, and
 * By model / By provider re-aggregates client-side.
 */
export const Default: Story = {};

/**
 * The state this PR exists to create. Gate OPEN with seventeen models: ten keep
 * a distinguishable colour and the remaining seven fold into a single neutral
 * band reading "Other models (7)".
 *
 * The band is the only parenthesised entry in the legend and the only one drawn
 * in the achromatic neutral — both deliberate, so it cannot be mistaken for one
 * more model. Toggle `#` to confirm the fold re-ranks on the metric actually
 * shown rather than carrying spend's ranking over to tokens.
 */
export const ManySeriesCapped: Story = {
  args: { series: MANY_SPEND, tokenSeries: MANY_TOKENS },
  parameters: {
    appCore: { enabledFlags: [CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY] },
  },
};

/**
 * Eleven models — exactly one past the cap, and the boundary the fold threshold
 * originally got wrong (wongk review). It folded nothing here, drew all eleven,
 * and painted the eleventh in the colour reserved for the aggregate band.
 *
 * Correct rendering: ten named models plus "Other models (1)". Worth pinning
 * precisely because it looks unremarkable — the failure mode was a real model
 * quietly wearing the neutral, which reads as legitimate until you compare it
 * against the band in the story above.
 */
export const CappedAtBoundary: Story = {
  args: { series: BOUNDARY_SPEND, tokenSeries: undefined },
  parameters: {
    appCore: { enabledFlags: [CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY] },
  },
};

/**
 * The provider axis in its real, unfolded form — see the note at the top of this
 * file for why a capped provider variant is not reachable. Flip to By provider:
 * seventeen models collapse onto a handful of provider buckets, well inside the
 * cap, so no aggregate band appears even with the gate open.
 */
export const ProviderGrouped: Story = {
  args: { series: MANY_SPEND, tokenSeries: MANY_TOKENS },
  parameters: {
    appCore: { enabledFlags: [CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY] },
  },
};

/**
 * Spend has not arrived, so the whole card is still in flight — `series` is the
 * load sentinel for both metrics. A skeleton, never an empty chart.
 */
export const Loading: Story = {
  args: { series: undefined, tokenSeries: undefined },
};

/**
 * FEA-3699 — spend arrived but the producer omitted the optional token series.
 * That is a COMPLETED result, not a pending one, so `#` must resolve to the
 * explicit "Token usage wasn't recorded for this range" empty state rather than
 * a stuck skeleton or a silent fallback to spend's numbers.
 *
 * Flip to `#` to see it; `$` stays populated.
 */
export const TokensUnavailable: Story = {
  args: { series: REALISTIC_SPEND, tokenSeries: undefined },
};

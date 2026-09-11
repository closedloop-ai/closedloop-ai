import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import type {
  TokenTrendPoint,
  TokenTrendResponse,
} from "@repo/api/src/types/agent-component-analytics";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import { agentComponentTokenTrendKeys } from "../../hooks/use-agent-component-token-trend";
import { TokenTrendChart } from "./token-trend-chart";

/**
 * ISS-4802 (wongk review, #4322): canvas for the token-trend chart, which had no
 * story anywhere.
 *
 * This chart carries more contract than any one screen can show, and almost none
 * of it is reachable on purpose in the running app: the empty state is now
 * selected on TWO axes (`sessions` × metric, so four copy paths) on top of the
 * `$`/`#` and model/provider toggles, the skeleton, the error line, and the
 * version markers. Seeing the `attributed` copy live requires a component that
 * has sessions but no per-model rollup; seeing markers land requires multiple
 * revisions with distinct created and first-used days.
 *
 * The co-located tests pin which STRING is selected. What they cannot show is
 * how the empty overlay reads sitting under live toggles — and
 * `TimeSeriesAreaChart`'s own story takes `emptyMessage` as a prop, so it covers
 * none of this.
 *
 * Reads resolve from the seeded QueryClient cache
 * (`queryData={[[agentComponentTokenTrendKeys.detail(slug), fixture]]}`), so no
 * hook mocking is needed. A story that seeds NOTHING leaves the query pending,
 * which is exactly the loading state.
 */

const SLUG = "subagent::orchestrator";
const OTHER_SLUG = "subagent::never-seeded";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_DAY = Date.parse("2026-06-01T09:00:00.000Z");

function makePoint(
  dayOffset: number,
  model: string,
  overrides: Partial<TokenTrendPoint> = {}
): TokenTrendPoint {
  return {
    sessionId: `session-${model}-${dayOffset}`,
    sessionStartedAt: new Date(FIRST_DAY + dayOffset * DAY_MS).toISOString(),
    model,
    inputTokens: 12_000 + dayOffset * 900,
    outputTokens: 3400 + dayOffset * 260,
    cacheReadTokens: 5600,
    cacheWriteTokens: 1200,
    estimatedCostUsd: 0.42 + dayOffset * 0.05,
    runtimeMs: 240_000 + dayOffset * 15_000,
    componentInvocations: 3,
    componentErrorCount: 0,
    ...overrides,
  };
}

/** Two models across a fortnight, so both the legend and the grouping toggle do work. */
const populatedTrend: TokenTrendResponse = {
  slug: SLUG,
  models: ["claude-opus-4-5", "gpt-5"],
  points: Array.from({ length: 14 }, (_unused, day) => day).flatMap((day) => [
    makePoint(day, "claude-opus-4-5"),
    makePoint(day, "gpt-5", {
      inputTokens: 4200 + day * 300,
      outputTokens: 1100 + day * 80,
      estimatedCostUsd: 0.11 + day * 0.02,
    }),
  ]),
};

/**
 * Real token volume, NO cost — the `$`-toggle case that used to name the wrong
 * missing thing ("no per-model token usage" on a chart whose tokens are the one
 * thing present). Cost is non-finite rather than `0`, which is the honest
 * "never computed" shape after ISS-4802 stopped coercing it to zero.
 */
const trendWithoutCost: TokenTrendResponse = {
  slug: SLUG,
  models: ["claude-opus-4-5"],
  points: Array.from({ length: 10 }, (_unused, day) =>
    makePoint(day, "claude-opus-4-5", {
      estimatedCostUsd: Number.NaN,
    })
  ),
};

/** A component whose sessions exist but carry no token rollup at all. */
const emptyTrend: TokenTrendResponse = {
  slug: SLUG,
  models: [],
  points: [],
};

/**
 * ISS-5523: model rosters big enough to exercise the series cap on THIS chart.
 *
 * This is the cap's live surface, which is why it is pinned here and not only on
 * the dashboard sibling. `/agent-components/{slug}/token-trend` caps the ROWS it
 * returns (`MAX_TOKEN_TREND_USAGE_ROWS`) but never the model CARDINALITY, so a
 * long-lived component really can report more distinct models than the palette
 * has colours — the 17-model population in ISS-5523 came from this chart. The
 * dashboard's `modelUsageOverTime` cannot: both producers cap it at six plus a
 * producer-side "other" bucket, so the fold is unreachable there in production.
 */
const MANY_MODEL_NAMES = [
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
 * `count` models over the same fortnight, with strictly descending per-model
 * magnitudes so the fold's ranking is unambiguous and the legend order is stable
 * between reloads. Real-looking ids on purpose: the palette is keyed
 * positionally, and ids containing a "." are why colours bind to the `<Area>`
 * directly rather than through a `--color-<key>` CSS variable.
 */
function manyModelTrend(count: number): TokenTrendResponse {
  const models = Array.from({ length: count }, (_unused, index) =>
    index < MANY_MODEL_NAMES.length
      ? MANY_MODEL_NAMES[index]
      : `custom-model-${index}`
  );
  return {
    slug: SLUG,
    models,
    points: Array.from({ length: 14 }, (_unused, day) => day).flatMap((day) =>
      models.map((model, index) =>
        makePoint(day, model, {
          inputTokens: (count - index) * 9000,
          outputTokens: (count - index) * 2200,
          estimatedCostUsd: (count - index) * 0.08,
        })
      )
    ),
  };
}

/** Seventeen models — the population that provoked ISS-5523. */
const manyModelsTrend = manyModelTrend(17);

/** Eleven models — exactly one past the cap. */
const boundaryModelsTrend = manyModelTrend(11);

/**
 * Two revisions with distinct created days, and usage first attributed to each
 * on a different day — the precondition for BOTH marker kinds to land apart.
 */
const versions: AgentComponentDetail["versions"] = [
  {
    hash: "abc1234def5678",
    source: "acme/repo",
    format: "md",
    createdAt: "2026-06-08T00:00:00.000Z",
    isCurrent: true,
    content: "You are an expert orchestrator agent.",
  },
  {
    hash: "0999888777666",
    source: "acme/repo",
    format: "md",
    createdAt: "2026-06-01T00:00:00.000Z",
    isCurrent: false,
    content: "You are an orchestrator agent.",
  },
];

const usageSessions: AgentComponentDetail["usageSessions"] =
  populatedTrend.points.map((point, index) => ({
    sessionId: point.sessionId,
    invocationCount: 1,
    versionHash: index < 10 ? "0999888777666" : "abc1234def5678",
  }));

function PanelFrame({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="max-w-5xl p-6">{children}</div>;
}

// ISS-5697: `.storybook/preview.tsx` mounts the app-core harness globally
// (ISS-5665), so this is now only the panel frame and each story seeds its own
// cache through `parameters.appCore.queryData`.
const storyDecorator: Decorator = (Story) => (
  <PanelFrame>
    <Story />
  </PanelFrame>
);

/**
 * A stacked area chart of one component's token or dollar usage over time,
 * split by model or by provider depending on the toggle above it. Vertical
 * markers on the timeline mark when each version of the component was
 * created and when it was first used, so you can read a usage change against
 * the release that likely caused it. Unlike the model and user usage tables,
 * which show a snapshot total, this chart shows the trend day by day; while
 * data loads it shows a skeleton, and its empty message changes depending on
 * whether the component has ever had any usage at all.
 */
const meta = {
  title: "Composites/Agents/Token Trend Chart",
  component: TokenTrendChart,
  tags: ["autodocs"],
  argTypes: {
    slug: {
      control: "text",
      description:
        "Key the trend query resolves against; a slug with no seeded cache entry leaves the query pending.",
    },
    versions: { control: "object" },
    usageSessions: { control: "object" },
    sessions: {
      control: { type: "number", min: 0, step: 1 },
      description:
        "The component's session count. `null` means the producer could not measure it, which the empty copy must not read as zero.",
    },
  },
  parameters: {
    layout: "fullscreen",
    appCore: {
      queryData: [[agentComponentTokenTrendKeys.detail(SLUG), populatedTrend]],
    },
  },
  args: {
    slug: SLUG,
    versions: [],
    usageSessions: [],
    sessions: 14,
  },
  decorators: [storyDecorator],
} satisfies Meta<typeof TokenTrendChart>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Two models over a fortnight WITH both version markers — the populated case.
 * Flip the `$`/`#` and model/provider toggles here; every combination has data,
 * so nothing falls through to an empty state.
 */
export const PopulatedWithVersionMarkers: Story = {
  args: { versions, usageSessions },
};

/**
 * The query never resolves, so the skeleton holds. Seeded with a DIFFERENT
 * slug's data so the cache is genuinely empty for this one rather than the
 * component being handed an empty response.
 */
export const Loading: Story = {
  args: { slug: OTHER_SLUG },
};

/**
 * True zero — no sessions, no rollup. "No usage" is honest here, and this is the
 * only empty state that may say so.
 */
export const EmptyNoSessions: Story = {
  args: { sessions: 0, usageSessions: [] },
  parameters: {
    appCore: {
      queryData: [[agentComponentTokenTrendKeys.detail(SLUG), emptyTrend]],
    },
  },
};

/**
 * The regression this story exists for: sessions ARE recorded (14, the same
 * number the Sessions card renders above), but no per-model rollup was
 * attributed. The copy must name what is actually missing rather than deny
 * usage the reader can already see on screen.
 */
export const EmptyAttributed: Story = {
  args: { sessions: 14 },
  parameters: {
    appCore: {
      queryData: [[agentComponentTokenTrendKeys.detail(SLUG), emptyTrend]],
    },
  },
};

/**
 * ISS-5363 — the count itself is unavailable (`sessions: null`), so the Sessions
 * card above renders a dash. The copy may not deny usage it never measured, and
 * may not claim usage was recorded either.
 */
export const EmptyUnknownSessionCount: Story = {
  args: { sessions: null, usageSessions: [] },
  parameters: {
    appCore: {
      queryData: [[agentComponentTokenTrendKeys.detail(SLUG), emptyTrend]],
    },
  },
};

/**
 * Real tokens, no cost estimate. Flip to `$`: the empty copy must name SPEND,
 * not tokens — the exact case that used to read "No per-model token usage
 * recorded" on a chart whose tokens were the one thing present.
 */
export const EmptyAttributedOnCostToggle: Story = {
  args: { sessions: 10 },
  parameters: {
    appCore: {
      queryData: [
        [agentComponentTokenTrendKeys.detail(SLUG), trendWithoutCost],
      ],
    },
  },
};

/**
 * ISS-5523 (wongk story-reviewer, #4717) — the cap on THIS chart, gate OPEN.
 * Seventeen models: ten keep a distinguishable colour and the remaining seven
 * fold into one neutral band reading "Other models (7)".
 *
 * `TimeSeriesAreaChart`'s own `ManySeriesCapped` story proves the fold in
 * isolation, but it renders a bare chart. What only this story can show is how
 * the aggregate band sits under this component's real chrome — the live `$`/`#`
 * and model/provider toggles, the version markers, and the panel's fixed `h-56`
 * box. Flip to `$` to confirm the fold re-ranks on the metric actually shown
 * rather than carrying the token ranking over to spend, and to By provider to
 * watch the roster collapse back inside the cap so the band disappears.
 *
 * The gate is opened through `parameters.appCore.enabledFlags`; `useChartMaxSeries`
 * reads the flag through the OPTIONAL adapter, so the stories that name no flag
 * above render the pre-ISS-5523 view rather than throwing.
 */
export const ManySeriesCapped: Story = {
  args: { versions, usageSessions },
  parameters: {
    appCore: {
      enabledFlags: [CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY],
      queryData: [[agentComponentTokenTrendKeys.detail(SLUG), manyModelsTrend]],
    },
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
  parameters: {
    appCore: {
      enabledFlags: [CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY],
      queryData: [
        [agentComponentTokenTrendKeys.detail(SLUG), boundaryModelsTrend],
      ],
    },
  },
};

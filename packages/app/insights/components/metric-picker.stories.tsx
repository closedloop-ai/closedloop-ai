import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  INSIGHTS_SECTION_OPTIONS,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { fn } from "storybook/test";
import {
  makeAgentsSections,
  makeDeliverySections,
  spendByOutcomeFixture,
} from "./insights-section-fixtures";
import { MetricPicker } from "./metric-picker";

const agentsSections = makeAgentsSections(spendByOutcomeFixture);
const deliverySections = makeDeliverySections([
  ["2026-01-01", 8],
  ["2026-01-02", 18],
  ["2026-01-03", 13],
]);

/** The one ungated Cost tile, present with the flag both on and off. */
const COST_BY_MODEL_TILE_ID = "chart:modelBreakdown:donut";
/** The ISS-4463 gated tile the picker must only offer when the flag is on. */
const SPEND_BY_OUTCOME_TILE_ID = "chart:spendByOutcome";
/**
 * The DONUT rendering of the same data (ISS-5335 review). The bar tile above
 * cannot stand in for it: a bar that fades into the card still has a labelled
 * axis and a value label, whereas a ring slice's ARC is the only thing encoding
 * its value, so an illegible slice there is a number the reader cannot recover.
 * The ring is also where slice ADJACENCY exists at all — four slices, four
 * boundaries — which is what the separator stroke fixes.
 */
const SPEND_BY_OUTCOME_DONUT_TILE_ID = "chart:spendByOutcome:donut";

// Annotated `boolean` rather than inferred: a story arg widening a meta arg has
// to stay assignable to it, and an inferred `() => false` / type-predicate
// signature is narrower than the `(id: string) => boolean` prop.
const nonePinned = (_id: string): boolean => false;

function onlyPinned(pinnedId: string): (id: string) => boolean {
  return (id: string): boolean => id === pinnedId;
}

function withSpendOutcomeFlag(children: ReactNode) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

const meta = {
  title: "App Core/Insights/Metric Picker",
  component: MetricPicker,
  tags: ["autodocs"],
  argTypes: {
    open: { control: "boolean", table: { category: "State" } },
    editingTileId: {
      control: "text",
      description:
        "A pinned tile id puts the dialog in edit mode (Edit widget heading, Remove beside Save). Null or unset opens the add flow.",
      table: { category: "State" },
    },
    comparisonAvailable: { control: "boolean", table: { category: "State" } },
    comparisonLabel: { control: "text", table: { category: "State" } },
    availableSections: {
      control: { type: "check" },
      description: "Which insight sections the picker may offer metrics from.",
      options: INSIGHTS_SECTION_OPTIONS,
      table: { category: "Data" },
    },
    sections: {
      control: "object",
      description: "The fixture data the preview tile draws from.",
      table: { category: "Data" },
    },
    comparisonSections: { control: "object", table: { category: "Data" } },
    githubConnectHref: { control: "text", table: { category: "Data" } },
    isPinned: { control: false, table: { category: "Data" } },
    getTileSettings: { control: false, table: { category: "Data" } },
    getTileAvailability: {
      control: false,
      description:
        "Returning a gated state swaps the preview body for the connect CTA.",
      table: { category: "Data" },
    },
    onOpenChange: { control: false, table: { category: "Events" } },
    onPinTile: { control: false, table: { category: "Events" } },
    onReplaceTile: { control: false, table: { category: "Events" } },
    onUnpinTile: { control: false, table: { category: "Events" } },
    onConnectGitHub: {
      control: false,
      description:
        "Left unset in these stories on purpose: the connect CTA prefers it over `githubConnectHref`, which is what UnavailableWithConnectGitHub pins.",
      table: { category: "Events" },
    },
  },
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    isPinned: nonePinned,
    // Stories are presentational; pin/replace/unpin are wired by the page.
    onPinTile: fn(),
    onReplaceTile: fn(),
    onUnpinTile: fn(),
    getTileSettings: () => ({}),
    availableSections: [InsightsSection.Agents],
    sections: agentsSections,
    comparisonAvailable: false,
  },
} satisfies Meta<typeof MetricPicker>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The add-a-metric dialog as it opens: "Add metric" heading, no Remove action,
 * and the first metric of the first available section pre-selected.
 */
export const AddMetric: Story = {};

/**
 * ISS-4463, flag OFF — the picker's half of the gate.
 *
 * The pair is anchored on a Cost tile rather than on a freshly-opened add
 * dialog deliberately. `Cost` is published by ungated tiles too, so the flag
 * changes no METRIC in the list; its only reachable effect on this dialog is
 * the Cost metric's Group by list, which gains `Session outcome`. A pair of
 * just-opened add dialogs would render identically (the picker opens on the
 * section's first metric, `Input + output tokens`) and pin nothing.
 *
 * So: flag off, Group by holds only what the ungated Cost tiles supply — Model
 * and Date. Read against {@link SpendOutcomeFlagOn}, which differs by nothing
 * but the flag.
 *
 * This is the picker's own gate, not the grid's: `dashboard-grid.test.tsx`
 * covers the grid refusing to RENDER an already-pinned gated tile, which is a
 * different gate on the same flag.
 */
export const SpendOutcomeFlagOff: Story = {
  args: {
    editingTileId: COST_BY_MODEL_TILE_ID,
    isPinned: onlyPinned(COST_BY_MODEL_TILE_ID),
  },
};

/** ISS-4463, flag ON — the same tile, with `Session outcome` now offered. */
export const SpendOutcomeFlagOn: Story = {
  args: {
    editingTileId: COST_BY_MODEL_TILE_ID,
    isPinned: onlyPinned(COST_BY_MODEL_TILE_ID),
  },
  decorators: [(Story) => withSpendOutcomeFlag(<Story />)],
};

/**
 * Edit mode on an already-pinned tile: "Edit widget" heading and a Remove
 * action beside Save. The pinned tile here is the gated spend-by-outcome bar,
 * so the preview also renders the real chart with its semantic colour map
 * rather than the index palette.
 */
export const EditingPinnedSpendOutcomeTile: Story = {
  args: {
    editingTileId: SPEND_BY_OUTCOME_TILE_ID,
    isPinned: onlyPinned(SPEND_BY_OUTCOME_TILE_ID),
  },
  decorators: [(Story) => withSpendOutcomeFlag(<Story />)],
};

/**
 * ISS-5335 (review): the same gated metric as the story above, but the DONUT.
 *
 * That one mounts `chart:spendByOutcome`, which is the category bar — so the
 * ring, which is the shape the contrast floor and the slice separator exist for,
 * was never in front of visual review. This puts it there: four slices on one
 * card, each held to 3:1 against `--card`, with the `var(--card)` hairline
 * between them at the four boundaries no rotation could fix. The fixture makes
 * "not recorded" the second-largest bucket, so if that slice ever goes back to a
 * surface token it shows up here as a hole in a third of the ring rather than as
 * a sliver nobody would question.
 */
export const EditingPinnedSpendOutcomeDonutTile: Story = {
  args: {
    editingTileId: SPEND_BY_OUTCOME_DONUT_TILE_ID,
    isPinned: onlyPinned(SPEND_BY_OUTCOME_DONUT_TILE_ID),
  },
  decorators: [(Story) => withSpendOutcomeFlag(<Story />)],
};

/**
 * A tile whose data needs a GitHub connection the org does not have. The
 * preview swaps its body for the shared connect CTA instead of drawing an empty
 * chart the reader would mistake for "no PRs merged".
 */
export const UnavailableWithConnectGitHub: Story = {
  args: {
    availableSections: [InsightsSection.Delivery],
    sections: deliverySections,
    getTileAvailability: () => ({ state: BranchKpiState.Gated }),
    githubConnectHref: "https://example.com/connect/github",
  },
};

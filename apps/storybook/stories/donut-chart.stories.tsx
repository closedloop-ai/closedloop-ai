import { spendByOutcomeFixture } from "@repo/app/insights/components/insights-section-fixtures";
import {
  SPEND_OUTCOME_COLORS,
  SPEND_OUTCOME_TEXTURE_MARK_COLORS,
  SPEND_OUTCOME_TEXTURES,
} from "@repo/app/insights/lib/spend-outcome-palette";
import { DonutChart } from "@repo/design-system/components/ui/donut-chart";
import type { Meta, StoryObj } from "@storybook/react";

const donutData = [
  { key: "planning", label: "Planning", value: 18 },
  { key: "build", label: "Build", value: 42 },
  { key: "review", label: "Review", value: 27 },
  { key: "verify", label: "Verify", value: 14 },
];

/**
 * The shipping map minus its last bucket in render order, for the partial-map
 * fallback story. Derived so no outcome key is spelled out here — a hand-written
 * key is exactly how the full map drifted onto banned colours in the first place.
 */
const partialOutcomeColors: Record<string, string> = Object.fromEntries(
  spendByOutcomeFixture
    .slice(0, -1)
    .map((bucket) => [bucket.key, SPEND_OUTCOME_COLORS[bucket.key]])
);

const meta = {
  title: "Composites v1.0/Charts/Donut Chart",
  component: DonutChart,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
  args: {
    data: donutData,
  },
  decorators: [
    // ISS-5362 (#4514 review): `bg-card`, not `bg-background`. Every donut in
    // the product sits in a Card, and the slice textures are painted in
    // `var(--card)` — on any other surface the marks read as faint grid LINES
    // instead of as holes punched in the slice, which is the opposite of what
    // the story is here to let a reviewer judge. In dark the two tokens differ
    // (0.24 vs 0.255), so this is not a distinction without a difference.
    (Story) => (
      <div className="h-72 w-[520px] rounded-lg border bg-card p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DonutChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    data: [],
    emptyMessage: "No categories matched the current filters.",
  },
};

/**
 * ISS-4463: the share-percentage legend. Three EQUAL slices are the interesting
 * case — independent rounding gives each 33% and prints 99% against a ring the
 * reader can see is full, so the remainder is allocated by largest fractional
 * part and this story must read 34/33/33.
 */
export const WithSharePercent: Story = {
  args: {
    data: [
      { key: "clean", label: "Ended clean", value: 10 },
      { key: "errored", label: "Ended with error", value: 10 },
      { key: "running", label: "Still running", value: 10 },
    ],
    showSharePercent: true,
  },
};

/**
 * ISS-4463: a fixed key→colour map, for a ring whose slices are SEMANTIC rather
 * than merely categorical.
 *
 * ISS-5335 (review): this used to hand-copy the map — `clean` on `var(--chart-4)`,
 * which measures 1.31:1 against the card in light and is exactly what that ticket
 * banned. A copied map drifts silently, so the story now imports the shipping
 * `SPEND_OUTCOME_COLORS` and its fixture. This is the only place a human can LOOK
 * at the ring, so it has to show what actually ships, not a stale snapshot of it.
 */
export const SemanticColors: Story = {
  args: {
    data: spendByOutcomeFixture,
    colorByKey: SPEND_OUTCOME_COLORS,
    showSharePercent: true,
  },
};

/**
 * The documented fallback, split out of `SemanticColors` by ISS-5335 (review)
 * rather than dropped: an unmapped key keeps the index palette, so a PARTIAL map
 * stays safe instead of leaving a slice unfilled.
 *
 * The omitted key is DERIVED from the shipping map rather than named, so this
 * story cannot go stale by pinning an outcome that gets renamed or removed.
 */
export const PartialSemanticColors: Story = {
  args: {
    data: spendByOutcomeFixture,
    colorByKey: partialOutcomeColors,
    showSharePercent: true,
  },
};

/**
 * Long labels at a narrow width, with the share suffix appended. The legend has
 * to stay legible once ` 34%` is added to an already-long label — the layout
 * regression the share mode can introduce.
 */
export const LongLabelsNarrow: Story = {
  args: {
    data: [
      {
        key: "clean",
        label: "Ended clean without any unrecovered error",
        value: 34,
      },
      {
        key: "errored",
        label: "Ended with an unrecovered harness error",
        value: 33,
      },
      {
        key: "unknown",
        label: "Outcome was never recorded by the collector",
        value: 33,
      },
    ],
    showSharePercent: true,
  },
  decorators: [
    (Story) => (
      <div className="h-72 w-[320px] rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
};

/**
 * ISS-5362: the REDUNDANT, non-colour identity channel.
 *
 * A donut carries category identity in hue and nothing else, which is the one
 * channel a colour-vision deficiency removes. On a SEMANTIC palette that cannot
 * be re-picked for separation without giving up its meaning, texture is what
 * makes a slice identifiable — so this is the story to LOOK at through a
 * protanopia/deuteranopia filter, where the flat slice and the three textured
 * ones must still read as four categories.
 *
 * Weighted the way the real spend-by-outcome data usually is: the ended-clean
 * and never-recorded buckets dominate, which is exactly when two slices
 * separated by hue alone merge into one block.
 */
export const RedundantSliceTextures: Story = {
  args: {
    data: [
      { key: "clean", label: "Ended clean", value: 45 },
      { key: "unknown", label: "Not recorded", value: 32 },
      { key: "errored", label: "Ended with error", value: 15 },
      { key: "running", label: "Still running", value: 8 },
    ],
    // Imported, not restated: this is the story a reviewer LOOKS at through a
    // CVD filter, so it has to show the palette that actually ships. A local
    // copy would keep passing review while drifting from the real one.
    colorByKey: SPEND_OUTCOME_COLORS,
    showSharePercent: true,
    textureByKey: SPEND_OUTCOME_TEXTURES,
    // The "not recorded" bucket is the one to look hardest at: it is the
    // faintest slice by design, so its marks are drawn DARKER than the slice
    // rather than in the card colour. Without this override the texture that
    // bucket most needs is the one texture that cannot be seen.
    textureMarkColorByKey: SPEND_OUTCOME_TEXTURE_MARK_COLORS,
  },
};

/**
 * The same ring at the size the smallest dashboard tile actually gives it.
 *
 * The band is roughly 20px there and "Still running" is routinely single
 * digits, so the slice that is hardest to place by position is also the one
 * with the least room for the texture meant to rescue it (#4514 review). If a
 * texture stops reading as a texture anywhere, it is here.
 */
export const RedundantSliceTexturesSmallTile: Story = {
  args: RedundantSliceTextures.args,
  decorators: [
    (Story) => (
      <div className="h-40 w-64 rounded-lg border bg-card p-2">
        <Story />
      </div>
    ),
  ],
};

/**
 * ISS-9842: a ring whose `data` is a capped PREFIX of a larger population.
 *
 * The desktop's Local-mode "Tool usage share" keeps the top 20 tools of however
 * many exist, so a ring drawn against the sum of those 20 overstates every
 * slice. With `total` and `omittedCount` the arcs are drawn against the whole
 * population and the remainder becomes a neutral "Other tools (N)" slice whose
 * label carries the number of tools it folds. Here four of nine tools are
 * shown: the four sum to 70 of 100 runs, so the residual is 30 runs across
 * five tools and the share legend reads 30/20/12/8/30.
 */
export const WithPopulationResidual: Story = {
  args: {
    data: [
      { key: "Bash", label: "Bash", value: 30 },
      { key: "Read", label: "Read", value: 20 },
      { key: "Edit", label: "Edit", value: 12 },
      { key: "Grep", label: "Grep", value: 8 },
    ],
    omittedCount: 5,
    otherSeriesLabel: "Other tools",
    showSharePercent: true,
    total: 100,
  },
};

/**
 * The same residual as the shipped tiles actually draw it (marisolashgrove
 * review). `showSharePercent` is set on exactly one catalog tile
 * (`chart:spendByOutcome`), so neither "Tool usage share" nor "Events by type"
 * prints a percentage: on them the fix is the arc proportion plus the labelled
 * "Other tools (5)" slice, with the legend showing counts only. The story above
 * turns percentages on so the denominator is legible; this one is the shipped
 * appearance.
 */
export const WithPopulationResidualAsShipped: Story = {
  args: {
    ...WithPopulationResidual.args,
    showSharePercent: false,
  },
};

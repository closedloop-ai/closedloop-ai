import {
  type AgentComponent,
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  AgentMetricMode,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { ComponentScope } from "@repo/api/src/types/component-scope";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { expect, fn, within } from "storybook/test";
import { AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import { makeComponent } from "./agent-component-fixtures";
import { AgentsTable } from "./agents-table";

/**
 * ISS-4973 canvas for the agents inventory grid, and specifically for the
 * count-column alignment variant (review cid 3707493700).
 *
 * `agents-table.test.tsx` and `agents-count-column-alignment.test.tsx` assert
 * that the `ml-auto` / `justify-end` classes LAND. That is not the same question
 * as whether the grid READS right — whether a `1,234` actually stacks over an
 * `8`, and whether an em-dash "unavailable" cell still reads as absent rather
 * than as a zero, once they share a right edge. These stories are that second
 * question. ISS-5366 retired the two gates to their enabled state, so the
 * alignment and the Metric precision are what every story now renders; the one
 * that still contrasts is {@link NarrowCardFallback}, where the card must NOT
 * align.
 *
 * `mode` is pinned per story rather than left on `auto`: the alignment is
 * grid-ONLY by design, so `expanded` (grid) and `compact` (narrow card list)
 * are the two layouts that actually differ and each needs its own canvas.
 */

/** Give the grid a real scroll viewport, matching `branches-table.stories.tsx`. */
function TableFrame({ children }: Readonly<{ children: ReactNode }>) {
  return <main className="h-96 overflow-auto">{children}</main>;
}

/**
 * The flag is read through `useFeatureFlagEnabledOptional`, so the story
 * harness's static adapter is the whole gate — no PostHog, no decorator of our
 * own. Flags default to disabled, which is the closed-by-default baseline.
 *
 * ISS-5697: the harness itself is mounted globally by `.storybook/preview.tsx`
 * (ISS-5665), so this decorator is now only the table frame and the flags ride
 * `parameters.appCore.enabledFlags`.
 */
const storyDecorator: Decorator = (Story) => (
  <TableFrame>
    <Story />
  </TableFrame>
);

/**
 * Magnitudes chosen to make the alignment legible: four digits over one digit
 * is the spread that a ragged column loses. `versionCount` is set on the
 * `Subagent` rows because the Versions column only renders a count for a kind
 * with a real version-history affordance.
 */
const MIXED_MAGNITUDE_COMPONENTS: AgentComponent[] = [
  makeComponent({
    id: "uuid-sub-1",
    slug: "subagent::orchestrator",
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
    invocations: 1234,
    sessions: 8,
    versionCount: 12,
    locPerDollar: 12.4,
  }),
  makeComponent({
    id: "uuid-sub-2",
    slug: "subagent::reviewer",
    name: "Code Review Agent",
    kind: AgentComponentKind.Subagent,
    invocations: 87,
    sessions: 41,
    versionCount: 3,
    locPerDollar: 0.88,
  }),
  makeComponent({
    id: "uuid-sub-3",
    slug: "subagent::migrator",
    name: "Schema Migration Agent",
    kind: AgentComponentKind.Subagent,
    invocations: 5,
    sessions: 2,
    versionCount: 2,
    locPerDollar: 1234.5,
  }),
];

/**
 * The case the review named: a `1,234` sitting next to an em-dash empty value.
 * A component discovered but never invoked has no counts to report, and the
 * column must keep showing the distinct "unavailable" em-dash rather than a
 * fabricated aligned `0` (the UI never lies about data).
 */
const MIXED_WITH_UNAVAILABLE_COMPONENTS: AgentComponent[] = [
  ...MIXED_MAGNITUDE_COMPONENTS.slice(0, 2),
  makeComponent({
    id: "uuid-sub-never-run",
    slug: "subagent::never-invoked",
    name: "Discovered, Never Invoked",
    kind: AgentComponentKind.Subagent,
    invocations: null,
    sessions: null,
    locPerDollar: null,
  }),
];

/**
 * ISS-5333: the Metric column's four precision states IN THE GRID.
 *
 * They existed only in isolation (`loc-per-dollar-cell.stories.tsx`), one cell
 * at a time — which cannot answer the question the fixed precision was added to
 * answer: whether a stack of them reads as a scannable column. Four magnitudes
 * plus the two honest non-numbers:
 *
 * - `1,234.50` over `0.88` — the spread the fixed two decimals exist for.
 * - `< 0.01` — a real but sub-threshold ratio, which must NOT floor to `0.00`
 *   and claim the component delivered nothing.
 * - `0.00` — a GENUINE zero, which must stay distinguishable from both of the
 *   above and from the unavailable dash.
 * - `—` — no ratio computable at all.
 */
const METRIC_PRECISION_COMPONENTS: AgentComponent[] = [
  makeComponent({
    id: "uuid-metric-large",
    slug: "subagent::high-yield",
    name: "High Yield Agent",
    kind: AgentComponentKind.Subagent,
    invocations: 1204,
    sessions: 96,
    versionCount: 4,
    locPerDollar: 1234.5,
  }),
  makeComponent({
    id: "uuid-metric-small",
    slug: "subagent::low-yield",
    name: "Low Yield Agent",
    kind: AgentComponentKind.Subagent,
    invocations: 61,
    sessions: 12,
    versionCount: 2,
    locPerDollar: 0.88,
  }),
  makeComponent({
    id: "uuid-metric-below-floor",
    slug: "subagent::sub-threshold",
    name: "Sub Threshold Agent",
    kind: AgentComponentKind.Subagent,
    invocations: 9,
    sessions: 4,
    versionCount: 1,
    locPerDollar: 0.004,
  }),
  makeComponent({
    id: "uuid-metric-true-zero",
    slug: "subagent::no-merged-lines",
    name: "Nothing Merged Agent",
    kind: AgentComponentKind.Subagent,
    invocations: 33,
    sessions: 7,
    versionCount: 1,
    locPerDollar: 0,
  }),
  makeComponent({
    id: "uuid-metric-unavailable",
    slug: "subagent::uncosted",
    name: "Uncosted Agent",
    kind: AgentComponentKind.Subagent,
    invocations: null,
    sessions: null,
    locPerDollar: null,
  }),
];

/**
 * FEA-4032: representative Type labels beside the unchanged Harness badges.
 *
 * Skill and MCP tool previously inherited conspicuous `info` / `warning` text
 * from their kind variants, while Tool and Memory & config were already the
 * neutral `muted` / `outline` controls. Showing both groups together makes the
 * new single muted Type treatment legible without losing the canonical icon
 * that distinguishes each kind. The four Harness variants intentionally stay
 * mixed so this canvas also catches an accidental flattening of those badges.
 */
const TYPE_PRESENTATION_COMPONENTS: AgentComponent[] = [
  makeComponent({
    harness: Harness.Claude,
    id: "uuid-type-skill",
    kind: AgentComponentKind.Skill,
    name: "Release Notes Skill",
    slug: "skill::release-notes",
  }),
  makeComponent({
    harness: Harness.Codex,
    id: "uuid-type-mcp",
    kind: AgentComponentKind.Mcp,
    name: "Issue Tracker MCP",
    slug: "mcp::issue-tracker",
  }),
  makeComponent({
    harness: Harness.Opencode,
    id: "uuid-type-tool",
    kind: AgentComponentKind.Tool,
    name: "Repository Search Tool",
    slug: "tool::repository-search",
  }),
  makeComponent({
    harness: Harness.Both,
    id: "uuid-type-config",
    kind: AgentComponentKind.Config,
    name: "Team Conventions",
    slug: "config::team-conventions",
  }),
];

const meta = {
  title: "App Core/Agents/Agents Table",
  component: AgentsTable,
  tags: ["autodocs"],
  argTypes: {
    items: { control: "object", table: { category: "Data" } },
    groups: {
      control: "object",
      description:
        "When set, `items` is ignored and one section renders per group.",
      table: { category: "Data" },
    },
    columnOrder: { control: "object", table: { category: "Data" } },
    // A `Set`, which an object control would hand back as a plain object and
    // the table would call `.has` on.
    visibleColumns: { control: false, table: { category: "Data" } },
    getComponentHref: { control: false, table: { category: "Content" } },
    sortBy: {
      control: "select",
      options: Object.values(AgentComponentSortKey),
      table: { category: "State" },
    },
    sortDir: {
      control: "radio",
      options: Object.values(AgentComponentSortDir),
      table: { category: "State" },
    },
    metricMode: {
      control: "radio",
      options: Object.values(AgentMetricMode),
      table: { category: "State" },
    },
    mode: {
      control: "radio",
      options: ["auto", "compact", "expanded"],
      table: { category: "Appearance" },
    },
    alwaysShowActions: {
      control: "boolean",
      description:
        "Unset keeps the pointer-aware default; true pins the row actions open.",
      table: { category: "Appearance" },
    },
    onSort: { control: false, table: { category: "Events" } },
    onColumnOrderChange: { control: false, table: { category: "Events" } },
  },
  parameters: { layout: "fullscreen" },
  args: {
    items: MIXED_MAGNITUDE_COMPONENTS,
    metricMode: AgentMetricMode.LocPerDollar,
    mode: "expanded",
    onColumnOrderChange: fn(),
    onSort: fn(),
    sortBy: "name",
    sortDir: AgentComponentSortDir.Asc,
  },
  decorators: [storyDecorator],
} satisfies Meta<typeof AgentsTable>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The shipped grid. All three count columns (Invocations / Sessions / Versions)
 * right-align together, headers included, so the `tabular-nums` these cells
 * already render stacks digit over digit. Aligning one number column while its
 * two numeric siblings stayed ragged is the outcome ISS-4973 avoids, which is
 * why the three move as one.
 */
export const Default: Story = {};

/**
 * A row with no counts at all. The em-dash keeps reading as "unavailable" beside
 * a right-aligned `1,234` — alignment is presentation only, and must not turn an
 * absent count into a plausible-looking zero.
 */
export const AlignedWithUnavailableCounts: Story = {
  args: { items: MIXED_WITH_UNAVAILABLE_COMPONENTS },
};

/**
 * The narrow-card fallback. The SAME `renderCell` feeds the grid rows and the
 * card body, so this canvas is the guard that the alignment does not reach the
 * card: a card lays these values out as an inline key/value list, where
 * stretching a count to the far edge would orphan it from its own label.
 * Deliberately NOT aligned — compare against {@link Default}.
 */
export const NarrowCardFallback: Story = {
  args: { items: MIXED_WITH_UNAVAILABLE_COMPONENTS, mode: "compact" },
};

/**
 * FEA-4032: the wide grid comparison for formerly colored and neutral Type
 * kinds. Type is now one quiet icon-and-label family; Harness remains a toned
 * badge family and should still carry the stronger categorical emphasis.
 */
export const TypePresentationInExpandedGrid: Story = {
  args: { items: TYPE_PRESENTATION_COMPONENTS },
};

/**
 * FEA-4032: the same comparison in the narrow card header, where the Type icon
 * and truncating label must stay compact above the unchanged Harness badge in
 * the card body.
 */
export const TypePresentationInCompactCards: Story = {
  args: { items: TYPE_PRESENTATION_COMPONENTS, mode: "compact" },
};

/**
 * ISS-5333 — the Metric column's fixed-precision states stacked in the real grid
 * (see {@link METRIC_PRECISION_COMPONENTS}).
 *
 * This is also the canvas for the header fix: `Invocations`, `Sessions` and
 * `Metric` are SORTABLE, so their labels live inside a `flex-1` sort button and
 * a `justify-end` on the header cell never reached them — they read as
 * left-aligned headers over right-aligned values. `Versions` is not sortable and
 * was the only one that ever moved. All four LABELS should now land on the same
 * right rail as the digits beneath them, with the caret and the Metric header's
 * help icon LEADING the label rather than pushing it inboard, and the
 * unavailable row's em-dashes under the digits they stand in for.
 *
 * Sorted on `metric` descending, matching the order the rows are actually in:
 * a canvas whose header claims one sort while the data shows another is the kind
 * of small lie this pack exists to catch. It is also the only story that renders
 * the ACTIVE sort caret at a right-aligned header, which is the exact state the
 * fix is about — the inactive caret is `opacity-0` until hover.
 */
export const MetricPrecisionInGrid: Story = {
  args: {
    items: METRIC_PRECISION_COMPONENTS,
    sortBy: "metric",
    sortDir: AgentComponentSortDir.Desc,
  },
};

const SOURCE_PROVENANCE_FLAGS = [
  AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY,
] as const;

/**
 * ISS-5009 canvas: a Source column carrying all three shapes the producer can
 * emit at once, so the two sides of the gate can be read against each other.
 *
 * Row 1 has REAL provenance whose legacy `source` was still the identity-key
 * echo — flag ON it reads `user` behind a Local glyph instead of `skill::python`
 * behind a Repo one. Row 2 is the plugin whose pack id, key and name are the
 * same string, the case the ticket is named for. Row 3 has genuine repo
 * provenance and is the control: it must look identical on both sides.
 */
const SOURCE_PROVENANCE_COMPONENTS: AgentComponent[] = [
  makeComponent({
    id: "uuid-skill-python",
    slug: "skill::python",
    name: "Python Expert Skill",
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "skill::python",
    honestSource: {
      hasProvenance: true,
      source: ComponentScope.User,
      sourceType: SourceType.Local,
    },
  }),
  makeComponent({
    id: "uuid-plugin-code",
    slug: "plugin::code",
    name: "code",
    kind: AgentComponentKind.Plugin,
    sourceType: SourceType.Pack,
    source: "code",
    honestSource: {
      hasProvenance: false,
      source: null,
      sourceType: SourceType.Local,
    },
  }),
  makeComponent({
    id: "uuid-sub-orchestrator",
    slug: "subagent::orchestrator",
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/agent-packs",
    honestSource: {
      hasProvenance: true,
      source: "acme/agent-packs",
      sourceType: SourceType.Repo,
    },
  }),
];

/**
 * The shipped Source column with the flag OFF — the baseline ISS-5009 is
 * measured against. Two of the three rows print their own identifier back at the
 * Component column beside them, one behind a repo glyph it was never in.
 */
export const SourceEchoBaseline: Story = {
  args: { items: SOURCE_PROVENANCE_COMPONENTS },
};

/**
 * The flag ON. The provenance-less plugin drops to the shared em-dash empty
 * glyph (hover: "No source recorded") rather than restating its own name, the
 * scope-only skill reads `user` behind a Local glyph, and the genuinely
 * repo-sourced agent is untouched — compare against
 * {@link SourceEchoBaseline}, where all three columns still read as identifiers.
 */
export const SourceProvenanceHonest: Story = {
  args: { items: SOURCE_PROVENANCE_COMPONENTS },
  parameters: { appCore: { enabledFlags: SOURCE_PROVENANCE_FLAGS } },
  play: async ({ canvasElement }) => {
    // ISS-5697: this story and {@link SourceEchoBaseline} pass IDENTICAL `items`
    // and differ ONLY by `enabledFlags`, so without an assertion here dropping
    // that parameter would render the baseline and the all-stories sweep — which
    // only proves a story MOUNTS — would stay green forever.
    const canvas = within(canvasElement);
    await expect(canvas.getByText(ComponentScope.User)).toBeInTheDocument();
    // The flag-OFF echo: the skill restating its own identity key as its source.
    await expect(canvas.queryByText("skill::python")).not.toBeInTheDocument();
  },
};

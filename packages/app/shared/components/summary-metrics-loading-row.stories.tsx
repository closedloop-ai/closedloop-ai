import { SUMMARY_COMPARISON_SHELL_SHIMMER } from "@repo/app/agents/components/sessions/sessions-summary-delta-slots";
import { LIST_SUMMARY_LOADING_DETAIL } from "@repo/app/shared/lib/list-summary-loading-detail";
import type { Meta, StoryObj } from "@storybook/react";
import { summaryCardClass } from "./summary-card-row";
import { SummaryMetricsLoadingRow } from "./summary-metrics-loading-row";

/**
 * ISS-9887 (#6962 review, whitlockk): this row is the promoted, prop-driven shell
 * both list summary strips now render, and its state matrix was only reachable
 * through its two wrappers — so the common loading GEOMETRY, which is the whole
 * point of unifying them, was rendered nowhere.
 *
 * What the vitest suites already pin is the wiring: which card set each host
 * passes, that the reload path renders this row at all, that the Branches host
 * deliberately does not filter by its data-derived hidden set. None of that
 * renders a pixel. What these stories pin instead is the thing a unification
 * regression actually breaks — that a shell slot occupies the same box as the
 * settled card that replaces it, at both hosts' configurations and at the
 * widths where the row's column derivation changes its answer.
 *
 * The two axes that matter are the ones the hosts differ on:
 *
 *   - the COMPARISON slot. A comparing surface (web Sessions, web Branches)
 *     reserves it with a shimmer; a non-comparing one (desktop) passes nothing
 *     and the shell is a row shorter. Get this wrong in either direction and
 *     the strip settles by jumping, which is the defect ISS-9887 closed.
 *   - the INFO popover, read off `MetricCard`'s own prop type. A shell that
 *     drops it renders a label line box a different height from the settled
 *     card's, for the reason `summary-card-row.stories.tsx` records at length
 *     about the trigger's inline advance.
 *
 * Every story pins a VIEWPORT rather than a fixed-width wrapper, for the reason
 * the sibling row's stories give: the layout keys off the viewport through a
 * media query, so a narrow box inside a wide canvas renders the wide case and
 * proves nothing.
 */

/** The Cost card's popover, carried so the label line box is the settled one. */
const COST_INFO = {
  what: "Spend not covered by a Claude subscription.",
  how: "Sums per-session API cost across the selected range.",
};

/** The five-card Sessions strip, in shipped order. */
const SESSIONS_CARDS = [
  { key: "sessions", label: "Sessions" },
  { key: "tokens", label: "Total Tokens" },
  { key: "cost", label: "cost", info: COST_INFO },
  { key: "prs", label: "PRs Shipped" },
  { key: "locPerDollar", label: "LOC / $" },
];

/**
 * The Branches strip. Its host passes the FULL card set while reloading on
 * purpose — the only hidden set available mid-reload is the OUTGOING scope's,
 * and filtering by it would make the shell claim which metrics are computable
 * for a window nobody has read yet. So the widest case is the shipped one here,
 * not an edge, and it is the one that has to survive the narrow widths below.
 */
const BRANCHES_CARDS = [
  { key: "approved", label: "Approved" },
  { key: "merged", label: "Merged" },
  { key: "cycleTime", label: "Cycle Time", info: COST_INFO },
  { key: "reviewDepth", label: "Review Depth" },
  { key: "locPerDollar", label: "LOC / $" },
  { key: "revertRate", label: "Revert Rate" },
];

const meta = {
  title: "Composites v1.0/App Shell/Summary Metrics Loading Row",
  tags: ["deprecated"],
  component: SummaryMetricsLoadingRow,
  parameters: { layout: "padded" },
  args: {
    cardClassName: summaryCardClass(true),
    cards: SESSIONS_CARDS,
    loadingDetail: LIST_SUMMARY_LOADING_DETAIL,
    wrapBelow: true,
  },
} satisfies Meta<typeof SummaryMetricsLoadingRow>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The web Sessions configuration: comparing, so the delta slot is reserved with
 * a shimmer and never with the settled "No prior period" line. That distinction
 * is the one worth looking at — the row does not yet know whether a prior period
 * exists, so printing that placeholder here would be a claim the read has not
 * returned, and it would render identically to the settled state that means
 * something entirely different.
 */
export const ComparingSurface: Story = {
  globals: { viewport: { value: "1512-900" } },
  args: { deltaPlaceholder: SUMMARY_COMPARISON_SHELL_SHIMMER },
  name: "Comparing surface: the delta slot shimmers, never claims",
};

/**
 * The desktop configuration: no comparison, so no delta row at all. Paired with
 * the story above this is the height contract — a shell that reserved the slot
 * on a non-comparing surface would settle SHORTER than the card replacing it,
 * and one that omitted it on a comparing surface would settle TALLER. Both are
 * the jump ISS-9887 exists to remove, and neither fails a jsdom assertion.
 */
export const NonComparingSurface: Story = {
  globals: { viewport: { value: "1512-900" } },
  args: { deltaPlaceholder: undefined },
  name: "Non-comparing surface: no delta row reserved",
};

/**
 * The Branches host at its six-card width, comparing. Six is the widest set
 * either host passes, and the host passes it unfiltered mid-reload by design,
 * so this is where the row's column derivation has the least slack per card.
 */
export const BranchesFullSet: Story = {
  globals: { viewport: { value: "1131-900" } },
  args: {
    cards: BRANCHES_CARDS,
    deltaPlaceholder: SUMMARY_COMPARISON_SHELL_SHIMMER,
  },
  name: "Branches full set at the launch track",
};

/**
 * Below `md`, where the row's static two-column class owns the layout and an odd
 * last card spans both. The shell has to wrap the same way the settled strip
 * does; a shell that stayed on one rank here would be the crowded case the
 * sibling row's `TwoUpBelowMd` story guards on the settled side.
 */
export const TwoUpBelowMd: Story = {
  globals: { viewport: { value: "360-720" } },
  args: { deltaPlaceholder: SUMMARY_COMPARISON_SHELL_SHIMMER },
  name: "Two up below md, with the odd card spanning",
};

import type { BranchRow } from "@repo/api/src/types/branch";
import { BranchStatus } from "@repo/api/src/types/branch";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { AGENTS_PAGE_SIZE } from "../../lib/agents-timeframe";
import { DetailBranchesTab } from "./detail-branches-tab";

/**
 * ISS-5464 (wongk review): canvas for the agent-component detail Branches tab —
 * the one sibling on this page that had no story, while `DetailSessionsTab` got
 * the same treatment in #4291.
 *
 * The child `BranchesTable` has its own story, but none of the states THIS
 * wrapper owns are reachable from it, and ISS-5464 gave the truncation notice
 * real logic worth pinning visually:
 *
 *   - the notice's total is ALWAYS a floor (`N of M+ branches`). `branches.length`
 *     is a capped array length — the wire `branchesTab` is bounded upstream by the
 *     `MAX_DETAIL_SESSION_IN_IDS` session fan-out plus the `seenBranchIds` dedupe
 *     — and the detail carries no uncapped branch count to state instead. Before
 *     ISS-5464 this printed as an exact total, so the same page read
 *     "Showing 50 of 1,218 sessions" on one tab and "Showing 50 of 50 branches"
 *     on the next;
 *   - the notice appears on two independent triggers: this tab visibly cutting
 *     the delivered array (`rows.length < branches.length`), or the producer's
 *     `branchesTabTruncated` saying the array itself is a sample. The second is
 *     invisible from the rows alone, which is exactly why it needs a canvas;
 *   - the empty state, which must NOT claim "no branches reference this
 *     component" — desktop's local reader always returns `branchesTab: []`
 *     (wongk, #3688).
 *
 * The co-located tests pin the string and the arithmetic; these stories pin the
 * geometry.
 */

function makeBranches(count: number): BranchRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `owner%2Frepo::story-branch-${index}`,
    branchName: `feat/story-branch-${index}`,
    baseBranch: "main",
    repoFullName: "closedloop-ai/symphony-alpha",
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    // Monotonically increasing, so the tab's recency sort is observable on the
    // canvas: higher index == more recently active.
    lastActivityAt: new Date(
      Date.UTC(2026, 0, 1) + index * 60_000
    ).toISOString(),
    sessionIds: [],
  })) as unknown as BranchRow[];
}

/** Comfortably under the render cap — no notice, nothing cut. */
const ordinaryBranches = makeBranches(6);
/** Past the render cap, so this tab visibly cuts the delivered array. */
const manyBranches = makeBranches(AGENTS_PAGE_SIZE + 12);

function PanelFrame({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="max-w-5xl p-6">{children}</div>;
}

// ISS-5697: the app-core harness is mounted globally by `.storybook/preview.tsx`
// (ISS-5665), so this decorator is now only the panel frame. Flags default to
// disabled — the closed-by-default baseline — and a story that needs one sets
// `parameters.appCore.enabledFlags`.
const storyDecorator: Decorator = (Story) => (
  <PanelFrame>
    <Story />
  </PanelFrame>
);

const meta = {
  title: "App Core/Agents/Detail Branches Tab",
  component: DetailBranchesTab,
  parameters: { layout: "fullscreen" },
  args: {
    branches: ordinaryBranches,
    getBranchHref: (item: { branchName: string }) =>
      `/branches/${item.branchName}`,
  },
  decorators: [storyDecorator],
} satisfies Meta<typeof DetailBranchesTab>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The ordinary case: a handful of branches, no footer. */
export const Default: Story = {};

/**
 * Past `AGENTS_PAGE_SIZE`: this tab cut the delivered array itself, so the
 * notice appears — with the total marked a floor, because the array it counts
 * was already bounded upstream.
 */
export const TruncatedByTheRenderCap: Story = {
  args: { branches: manyBranches },
};

/**
 * The trigger the rows cannot reveal: only `AGENTS_PAGE_SIZE` branches arrived,
 * so nothing was cut HERE, but the producer says the fan-out slice cost branches
 * upstream. Without the flag this renders silently and implies completeness.
 */
export const TruncatedByTheProducer: Story = {
  args: {
    branches: makeBranches(AGENTS_PAGE_SIZE),
    branchesTabTruncated: true,
  },
};

/**
 * Zero rows. The copy must not deny that branches exist — desktop's local reader
 * always returns `branchesTab: []` while its metrics say otherwise (wongk, #3688).
 */
export const Empty: Story = {
  args: { branches: [] },
};

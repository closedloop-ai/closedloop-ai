import { BranchKpiState } from "@repo/api/src/types/branch";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import type { Meta, StoryObj } from "@storybook/react";
import { DashboardEmptySurface } from "./dashboard-empty-surface";

/**
 * The dashboard's empty surface, promoted out of the Web Master prototype
 * (ISS-10567) — which is the moment `packages/app/AGENTS.md` says a prop-driven
 * component owes its own story, because its states stop being covered by the
 * host's single-shape fixture.
 *
 * Three seams live here and none of them is reachable from a string assertion:
 *
 *  - `readsCloud`, which decides what a zero may be CALLED (ISS-6972). A cloud
 *    zero may not be reported as an empty Mac.
 *  - availability, which decides whether a GitHub-truth tile carries an EMPTY
 *    caption or a connect ask. Three of the five headline tiles are GitHub
 *    truth, and two of those a local read can never satisfy.
 *  - the label each tile takes, which is the CATALOG's on both sides of first
 *    data since ISS-12638 retired the response-derived heading — so the card
 *    cannot rename itself when data lands. That one is a STRING, so it is
 *    pinned by `__tests__/dashboard-empty-surface.test.tsx` rather than here;
 *    stories pin geometry and tone (`packages/app/AGENTS.md`).
 *
 * What the stories pin that tests cannot: whether five cards plus seven full
 * -width sections still read as ONE page at narrow width, and whether a
 * caption-slot connect ask sits on the same baseline as its four plain
 * rowmates.
 */
const meta: Meta<typeof DashboardEmptySurface> = {
  title: "Composites v1.0/Insights/Dashboard Empty Surface",
  component: DashboardEmptySurface,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof DashboardEmptySurface>;

/**
 * Desktop reading its OWN database. The Recent Sessions sentence is the one
 * only a local read may make.
 */
export const LocalRead: Story = {
  args: { readsCloud: false },
};

/**
 * The same surface reading the workspace. A device still uploading is not an
 * empty workspace, so the sentence changes and the card titles do not.
 */
export const CloudRead: Story = {
  args: { readsCloud: true },
};

/**
 * No GitHub connection: the three GitHub-truth tiles carry the connect ask in
 * their caption slot instead of a completed-zero caption, and keep the
 * CATALOG's name — an ask names the metric it is offering, never the local
 * population it is declining to report.
 */
export const GitHubGated: Story = {
  args: {
    readsCloud: false,
    githubConnect: {
      action: GitHubConnectAction.Connect,
      href: "#connect-github",
    },
    getTileAvailability: (tile) => ({
      state: GITHUB_TRUTH_IDS.has(tile.id)
        ? BranchKpiState.Gated
        : BranchKpiState.Available,
    }),
  },
};

/**
 * A local read, where `kpi:kloc` and `kpi:pr-size` are unavailable however
 * healthy the connection — desktop measures a captured-PR population, which is
 * not the merged-PR one the tile names.
 */
export const LocallyUnavailable: Story = {
  args: {
    readsCloud: false,
    getTileAvailability: (tile) => ({
      state: CLOUD_ONLY_IDS.has(tile.id)
        ? BranchKpiState.Unavailable
        : BranchKpiState.Available,
    }),
  },
};

const GITHUB_TRUTH_IDS = new Set<string>([
  "kpi:merged",
  "kpi:kloc",
  "kpi:pr-size",
]);

const CLOUD_ONLY_IDS = new Set<string>(["kpi:kloc", "kpi:pr-size"]);

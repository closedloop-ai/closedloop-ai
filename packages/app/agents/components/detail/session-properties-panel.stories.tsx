import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { createAgentSessionDetailFixture } from "./agent-session-detail-fixtures";
import { SessionPropertiesPanel } from "./session-properties-panel";

const PROPERTIES_RE = /Properties/;

/**
 * ISS-5818 (#4739 review, whitlockk): the Session detail PROPERTIES panel, promoted
 * out of `agent-session-detail-view.tsx` into its own exported module — which is
 * the `packages/app/AGENTS.md` trigger for a co-located story. Every sibling row
 * this panel composes already has one; the panel that arranges them did not.
 *
 * The states below are the ones the parent's page-level stories cannot reach.
 * `agent-session-detail-view.stories.tsx` mounts one session shape at a time
 * through the whole page, so its Properties pane only ever shows the default
 * collapsed strip — while this file's two variants are distinct render paths
 * that a screenshot is the only honest way to check:
 *
 *  - the collapsed strip WITHOUT the status word, taken when the prototype-parity
 *    gate is on and the title above carries the chip instead. What matters there
 *    is the crowding: three items where there were four, and no orphaned dot.
 *  - the UNRESOLVED repository, which renders muted and non-mono beside items
 *    that stay full-strength. Tests pin the string "Unknown"; only a story shows
 *    whether it reads as an absent value rather than as a repository named
 *    Unknown.
 *
 * The panel is mounted inside the page's `.sd3` scope because `styles.css`
 * conditions the monospace face on that ancestor (`.sd3 .mono`) — the same
 * reason `SessionPropertiesFrame` exists for the single-row stories. Without it
 * the model and repository items render in the body face here and in monospace
 * in production.
 */
const detailScopeDecorator: Decorator = (Story) => (
  <div className="sd3 max-w-[1000px] bg-background p-6">
    <Story />
  </div>
);

const meta = {
  title: "Composites v1.0/Agents/Detail/Session Properties Panel",
  component: SessionPropertiesPanel,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [detailScopeDecorator],
} satisfies Meta<typeof SessionPropertiesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The collapsed strip as it ships. No status word: the title one line up already
 * carries a status chip, so repeating it here would state the same fact twice in
 * one viewport (ISS-5818; the gate that made it conditional was retired by
 * ISS-5999). Click the header to see the expanded grid the panel discloses.
 *
 * Worth looking at rather than only asserting: the strip stays balanced with one
 * fewer item, and no leading dot is left behind without its label.
 */
export const Default: Story = {
  args: { session: runningSessionFixture() },
};

/** Expanded Properties row using the canonical Session status word and mark. */
export const UniversalArtifactStatus: Story = {
  args: { session: runningSessionFixture() },
  parameters: {
    appCore: { enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("button", { name: PROPERTIES_RE });
    await userEvent.click(toggle);
    await expect(canvas.getByText("Running")).toBeVisible();
  },
};

/**
 * FEA-3780: no Git remote resolved, so the repository is genuinely unknown. The
 * item renders muted and non-mono — the same treatment the Sessions list gives
 * its empty repo cell — so absent data does not read like a value sitting beside
 * real `owner/repo` names. The tooltip is dropped too: there is no full name to
 * reveal, and repeating "Unknown" a pixel away says nothing.
 */
export const RepositoryUnresolved: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      cwd: "/",
      name: "Session with no resolved remote",
      repo: null,
      repositoryFullName: null,
      status: SESSION_STATUS.ACTIVE,
    }),
  },
};

/**
 * ISS-7737, gate ON: expand the grid and read Turns, Tokens, and Cost together.
 * Three rows on one panel now carry a focusable sentence each, which is exactly
 * the thing a screenshot answers and an assertion cannot — whether three
 * disclosure buttons in one grid read as considered or as clutter, and whether
 * the 8.26B token value still reads as the row's subject with a tooltip trigger
 * wrapped round it.
 *
 * The session is the ticket's own: a parent-only 1,016 turns four rows from a
 * subagent-folded 8,260,678,836 / $6,229.94. With the gate OFF (every other
 * story here) the same panel renders those figures bare.
 */
export const MetricPopulationsNamed: Story = {
  args: { session: foldedSessionFixture() },
  decorators: [
    (Story) => (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY],
        })}
      >
        <Story />
      </FeatureFlagAdapterProvider>
    ),
  ],
};

/** A live run, so the strip and the expanded grid both have real values to show. */
function runningSessionFixture() {
  return createAgentSessionDetailFixture({
    endedAt: null,
    name: "Properties panel session",
    status: SESSION_STATUS.ACTIVE,
  });
}

/** Session 795c67ae's real magnitudes, at the two populations ISS-7737 names. */
function foldedSessionFixture() {
  return createAgentSessionDetailFixture({
    cache: 7_994_296_736,
    cacheReadTokens: 7_994_296_736,
    cacheWrite: 238_501_193,
    cacheWriteTokens: 238_501_193,
    endedAt: null,
    estimatedCost: 6229.941_627_15,
    inputTokens: 97_223,
    name: "Session with delegated subagent work",
    outputTokens: 27_783_684,
    status: SESSION_STATUS.ACTIVE,
    tokensIn: 97_223,
    tokensOut: 27_783_684,
    turns: 1016,
  });
}

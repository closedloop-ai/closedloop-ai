import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { createAgentSessionDetailFixture } from "./agent-session-detail-fixtures";
import { SessionPropertiesPanel } from "./session-properties-panel";

/**
 * ISS-5818 (#4739 review, wongk): the Session detail PROPERTIES panel, promoted
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
  title: "App Core/Agents/Detail/Session Properties Panel",
  component: SessionPropertiesPanel,
  tags: ["autodocs"],
  argTypes: {
    artifactHrefPending: { control: "boolean" },
    buildArtifactHref: { control: false },
    getBranchHref: { control: false },
    /*
     * `AgentSessionDetail` carries real `Date` fields (`startedAt`,
     * `updatedAt`, ...). An object control serializes them to strings on edit,
     * which the derivations this panel reads cannot take, so the session is
     * changed by picking a story rather than by typing into the panel.
     */
    session: { control: false },
  },
  args: { artifactHrefPending: false },
  parameters: { layout: "fullscreen" },
  decorators: [detailScopeDecorator],
} satisfies Meta<typeof SessionPropertiesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shipped default: collapsed, gate off, status restated in the strip. This
 * is what every reader sees today, and the baseline the two variants below are
 * read against. Click the header to see the expanded grid the panel discloses.
 */
/**
 * The collapsed strip as it ships. No status word: the title one line up carries
 * a status chip from a DIFFERENT axis (`SESSION_STATUS` in the chip,
 * `AgentSessionState` here), so the two could legitimately disagree and would
 * sit ~24px apart saying different words. The redundant statement went rather
 * than the axes being aliased, which is forbidden (ISS-5818; the gate that made
 * it conditional was retired by ISS-5999).
 *
 * Worth looking at rather than only asserting: the strip stays balanced with one
 * fewer item, and no leading dot is left behind without its label.
 */
export const Default: Story = {
  args: { session: runningSessionFixture() },
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

/** A live run, so the strip and the expanded grid both have real values to show. */
function runningSessionFixture() {
  return createAgentSessionDetailFixture({
    endedAt: null,
    name: "Properties panel session",
    status: SESSION_STATUS.ACTIVE,
  });
}

import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ComponentProps } from "react";
import { expect, within } from "storybook/test";
import {
  createAgentSessionDetailFixture,
  emptyAgentsAgentSessionDetailFixture,
  noErrorAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "./agent-session-detail-fixtures";
import { ErrorPropagationMap } from "./error-propagation-map";

/**
 * ISS-5698: the error map's four claims, each rendered rather than asserted.
 *
 * This panel says four things at once, and three of them are only checkable by
 * looking. A node is red, faded to 70%, or faded to 40% depending on whether the
 * errors are its own, its subtree's, or nobody's; a connector rail turns red only
 * when a parent AND a child both failed; and a summary badge at the top has to
 * reconcile against the badges on the nodes below it. `detail-analytics-panels`
 * pins two strings. The tone ladder and the reconciliation are what these
 * stories own.
 *
 * The fourth claim is the honest one, and it gets two stories of its own:
 * "0 error events" is NOT "no errors". A failed agent that emitted no error
 * telemetry, and error telemetry belonging to an agent that never synced, both
 * have to stay visible instead of rounding to the all-clear panel.
 */

type ErrorMapArgs = ComponentProps<typeof ErrorPropagationMap>;

/** Base instant every generated roster hangs its timestamps off. */
const ROSTER_START_MS = Date.parse("2026-06-10T12:00:00.000Z");

/** The all-clear headline, suppressed the moment anything failed. */
const ALL_CLEAR_HEADLINE = "No errors in this session";

/** A phone-width column, where the node row's badges have to wrap. */
const NARROW_COLUMN_PX = 320;

const meta = {
  title: "App Core/Agents/Detail/Error Propagation Map",
  component: ErrorPropagationMap,
  tags: ["autodocs"],
  argTypes: {
    agents: {
      control: "object",
      description:
        "Synced roster. A failed status alone reddens a node, with or without error events.",
    },
    events: {
      control: "object",
      description:
        "Synced events. Error rows are counted per agent, and any that name no synced agent become the unattributed total.",
    },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ErrorPropagationMap>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shipped shape, and the only view with all three node tones on screen at
 * once: the failed review lane in red, its clean parent at 70% because its
 * subtree is not clean, and the untouched sibling at 40%. The rail stays grey,
 * because a parent with no errors of its own is not a propagation chain.
 *
 * Read the two faded tones against each other. They are 30 percentage points
 * apart and carry different meanings, so if they stop being separable the panel
 * has lost a whole level of its vocabulary.
 */
export const IsolatedLeafFailure: Story = {
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    events: populatedAgentSessionDetailFixture.events,
  },
};

/**
 * A failure that actually propagated: the grandchild threw, the child failed
 * with it, and the root failed on top. Both rails turn red and both elbows
 * follow, which is the geometry the footnote at the bottom of the panel
 * describes and the reason the panel exists at all.
 *
 * The distinction from {@link IsolatedLeafFailure} is the whole design. One is a
 * contained fault; the other took the session down. If both render with grey
 * rails, the panel is drawing a tree and claiming to draw a chain.
 */
export const PropagatedChain: Story = {
  args: propagatedChainRoster(),
};

/**
 * A lane whose status is `failed` while its event stream carries no error at
 * all, which is what a worker killed by a watchdog syncs. The count is a real
 * zero, so the summary reads "0 error events total" beside "1 agent encountered
 * errors", and the node earns a plain `failed` badge instead of a count.
 *
 * That pairing looks wrong at a glance and is exactly right: it is the panel
 * refusing to round an unexplained failure down to the all-clear. The `play`
 * pins both halves, because the failure mode here is silent, a `totalErrors`
 * check that forgets `isFailed` renders a green tick over a dead session.
 */
export const FailedWithoutErrorEvents: Story = {
  args: failedWithoutTelemetryRoster(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText("0 error events total")).toBeVisible();
    expect(canvas.queryByText(ALL_CLEAR_HEADLINE)).not.toBeInTheDocument();
    // Twice: the node's status word, and the standalone `failed` badge that
    // takes the slot a count badge would have filled. Losing the second one
    // leaves a node with no red mark at all on a lane that died.
    expect(canvas.getAllByText("failed")).toHaveLength(2);
  },
};

/**
 * Every agent completed and nothing threw, so the tree is replaced outright by
 * a single tick and a sentence. Worth pinning as its own render: a grid of
 * three faded 40% nodes would say the same thing far less clearly, and the
 * count in the sentence is the panel's own reconciliation of the roster it just
 * decided not to draw.
 */
export const NoErrors: Story = {
  args: {
    agents: noErrorAgentSessionDetailFixture.agents,
    events: noErrorAgentSessionDetailFixture.events,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText(ALL_CLEAR_HEADLINE)).toBeVisible();
    expect(
      canvas.getByText("All 3 agents completed without errors.")
    ).toBeVisible();
  },
};

/**
 * One attributed error on the review lane, plus three error events whose agent
 * row never synced. The orphans get a card of their own under the tree, and the
 * summary badge has to count both sides.
 *
 * This is the reconciliation story. The header badge is the sum, and the two
 * populations it sums are rendered inches apart, so a total that quietly drops
 * the unattributed side is visible here and nowhere else. The `play` asserts the
 * sum rather than the mere presence of the card, because 1 + 3 rendering as
 * "1 error event total" is the specific bug.
 */
export const UnattributedErrors: Story = {
  args: unattributedErrorsRoster(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText("4 error events total")).toBeVisible();
    expect(canvas.getByText("1 agent encountered errors")).toBeVisible();
    expect(canvas.getByText("3 errors")).toBeVisible();
  },
};

/**
 * Error telemetry with no roster behind it at all, which is what a session that
 * synced events before its agent rows looks like mid-flight. There is no tree to
 * draw, so the panel drops to the orphan card alone and states "0 agents
 * encountered errors" over a red total.
 *
 * Do not read that zero as an empty state. It is the honest answer to a
 * different question than {@link NoAgentData} answers, and the two must not
 * render alike.
 */
export const OnlyUnattributedErrors: Story = {
  args: orphanTelemetryOnlyRoster(),
};

/**
 * Nothing synced. The panel says so in one line rather than showing an all-clear
 * tick, because "we found no errors" and "we have nothing to look at" are
 * different sentences and only one of them is reassuring.
 */
export const NoAgentData: Story = {
  args: {
    agents: emptyAgentsAgentSessionDetailFixture.agents,
    events: emptyAgentsAgentSessionDetailFixture.events,
  },
};

/**
 * The propagated chain in a 320px column. Each node row is a wrapping flex line
 * carrying a name, a status badge, and a count badge, and every level of nesting
 * takes another 28px off the width available for them. This is where the badges
 * either stay on the name's line or stack under it, and where a long lane name
 * decides whether the count badge is still findable.
 */
export const NarrowColumn: Story = {
  args: propagatedChainRoster(),
  decorators: [columnAtWidth(NARROW_COLUMN_PX)],
};

/** An ISO instant `minutes` after the shared roster start. */
function at(minutes: number): string {
  return new Date(ROSTER_START_MS + minutes * 60_000).toISOString();
}

/**
 * Routes a custom roster through the shared session factory so the arrays these
 * stories hand the panel are the same ones the detail screen reads, rather than
 * a second hand-built session shape drifting beside it.
 */
function rosterArgs(
  agents: SyncedAgentSessionAgent[],
  events: SyncedAgentSessionEvent[]
): ErrorMapArgs {
  const session = createAgentSessionDetailFixture({ agents, events });
  return { agents: session.agents, events: session.events };
}

/** One error event attributed to `agentId`. */
function errorEvent(
  agentId: string | null,
  index: number,
  summary: string
): SyncedAgentSessionEvent {
  return {
    externalEventId: `error-${index}`,
    agentExternalId: agentId,
    eventType: "tool_error",
    toolName: "vitest",
    summary,
    createdAt: at(index),
  };
}

/** A three-deep chain where every level failed, so both rails turn red. */
function propagatedChainRoster(): ErrorMapArgs {
  const agents: SyncedAgentSessionAgent[] = [
    {
      externalAgentId: "chain-root",
      name: "Session orchestrator",
      type: "main",
      status: "failed",
      task: "Land the slice end to end.",
      currentTool: null,
      startedAt: at(0),
      updatedAt: at(20),
      endedAt: at(20),
      parentExternalAgentId: null,
    },
    {
      externalAgentId: "chain-implement",
      name: "Implementation lane",
      type: "subagent",
      subagentType: "implement",
      status: "failed",
      task: "Write the migration and the service.",
      currentTool: null,
      startedAt: at(2),
      updatedAt: at(16),
      endedAt: at(16),
      parentExternalAgentId: "chain-root",
    },
    {
      externalAgentId: "chain-migrate",
      name: "Migration lane",
      type: "subagent",
      subagentType: "database",
      status: "failed",
      task: "Apply the prefix-contiguous migration.",
      currentTool: null,
      startedAt: at(4),
      updatedAt: at(9),
      endedAt: at(9),
      parentExternalAgentId: "chain-implement",
    },
  ];
  const events = [
    errorEvent("chain-migrate", 9, "Migration prefix collided with main."),
    errorEvent(
      "chain-implement",
      16,
      "Service build failed on the missing table."
    ),
    errorEvent(
      "chain-root",
      19,
      "Lane reported failure; aborting the session."
    ),
    errorEvent("chain-root", 20, "Cleanup could not roll the worktree back."),
  ];
  return rosterArgs(agents, events);
}

/** A failed lane that emitted no error telemetry, beside a clean sibling. */
function failedWithoutTelemetryRoster(): ErrorMapArgs {
  const agents: SyncedAgentSessionAgent[] = [
    {
      externalAgentId: "reaped-root",
      name: "Session orchestrator",
      type: "main",
      status: "completed",
      task: "Run two lanes to completion.",
      currentTool: null,
      startedAt: at(0),
      updatedAt: at(12),
      endedAt: at(12),
      parentExternalAgentId: null,
    },
    {
      externalAgentId: "reaped-lane",
      name: "Reaped worker",
      type: "subagent",
      subagentType: "implement",
      status: "failed",
      task: "Ran past the watchdog and was killed before it could report.",
      currentTool: "bash",
      startedAt: at(1),
      updatedAt: at(11),
      endedAt: null,
      parentExternalAgentId: "reaped-root",
    },
  ];
  const events: SyncedAgentSessionEvent[] = [
    {
      externalEventId: "reaped-tool",
      agentExternalId: "reaped-lane",
      eventType: "tool_use",
      toolName: "bash",
      summary: "Started the long-running build.",
      createdAt: at(2),
    },
  ];
  return rosterArgs(agents, events);
}

/** One attributed error plus three orphans, so the total has to sum both. */
function unattributedErrorsRoster(): ErrorMapArgs {
  const orphans = [
    errorEvent(
      "agent-never-synced",
      21,
      "Worker exited before its row synced."
    ),
    errorEvent(null, 22, "Harness reported a parse failure with no agent."),
    errorEvent(
      "agent-never-synced",
      23,
      "Retry also failed to attach an agent."
    ),
  ];
  return rosterArgs(populatedAgentSessionDetailFixture.agents, [
    ...populatedAgentSessionDetailFixture.events,
    ...orphans,
  ]);
}

/** Error telemetry with no roster behind it. */
function orphanTelemetryOnlyRoster(): ErrorMapArgs {
  return rosterArgs(
    [],
    [
      errorEvent(null, 3, "Transcript could not be parsed."),
      errorEvent("agent-never-synced", 4, "Gateway dropped the agent row."),
    ]
  );
}

/** Renders the map inside a fixed-width column, the way a rail hands it one. */
function columnAtWidth(widthPx: number): Decorator {
  return (Story) => (
    <div
      className="overflow-hidden rounded-md border p-3"
      style={{ width: widthPx }}
    >
      <Story />
    </div>
  );
}

import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ComponentProps } from "react";
import { expect, within } from "storybook/test";
import {
  createAgentSessionDetailFixture,
  noErrorAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "./agent-session-detail-fixtures";
import { ToolExecutionFlow } from "./tool-execution-flow";

/**
 * ISS-5698: the tool timeline, at the densities and the degenerate windows that
 * decide whether it means anything.
 *
 * Every dot on this strip is positioned as a percentage of the session's own
 * tool window, so the component's whole output is geometry. Three of its
 * branches are invisible to a string assertion and dangerous in production:
 *
 *  - a session whose tool events share one instant has a zero-width window, and
 *    every dot lands on 50%. One mark, N invocations.
 *  - an unparseable timestamp ALSO lands on 50%, sitting in the middle of the
 *    track as though it had been measured there.
 *  - a busy lane packs dots at 12px into a track that does not grow, so they
 *    overlap and the count column becomes the only true statement on the row.
 *
 * The count on the right of each lane is the reconciliation for all three, which
 * is why it is what the `play` functions assert.
 */

type ToolFlowArgs = ComponentProps<typeof ToolExecutionFlow>;

/** Base instant every generated roster hangs its timestamps off. */
const ROSTER_START_MS = Date.parse("2026-06-10T12:00:00.000Z");

/** The lane label the flow appends for tool events no agent row claims. */
const UNATTRIBUTED_LANE = "Unattributed telemetry";

/** A phone-width column, narrower than the strip's own 360px floor. */
const NARROW_COLUMN_PX = 320;

const meta = {
  title: "App Core/Agents/Tool Execution Flow",
  component: ToolExecutionFlow,
  tags: ["autodocs"],
  argTypes: {
    agents: {
      control: "object",
      description:
        "Agent rows the lanes are built from. A tool event whose agent is absent here falls to the trailing unattributed lane.",
    },
    events: {
      control: "object",
      description:
        "Session events. Only those carrying a toolName draw a dot; the rest are ignored.",
    },
  },
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    events: populatedAgentSessionDetailFixture.events,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ToolExecutionFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shipped shape: three lanes, one tool call each, spread across a real
 * window. The failed lane's dot is red and the other two take a hue hashed from
 * the tool name, so this is the baseline for reading colour as identity rather
 * than as severity.
 */
export const SpreadTimeline: Story = {
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    events: populatedAgentSessionDetailFixture.events,
  },
};

/**
 * Every tool event at the same instant, which is what a batch of calls flushed
 * in one sync write produces. The window has zero width, so the position maths
 * short-circuits and each dot is pinned to 50%: two lanes, seven invocations,
 * two visible marks.
 *
 * The strip is not lying here so much as it has nothing to say, and the count
 * column is the only place the truth survives. The `play` asserts those counts
 * because a reader who trusts the dots will be off by four on one row.
 */
export const SingleInstant: Story = {
  args: singleInstantRoster(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText("4")).toBeVisible();
    expect(canvas.getByText("3")).toBeVisible();
  },
};

/**
 * Forty calls on one lane over half an hour. The track is a fixed-height bar
 * that does not grow with the population, so the dots overlap and cluster; that
 * is the honest picture of a busy agent and the reason the count sits beside it.
 *
 * What to look at is whether the four error dots still read as red through the
 * pile, and whether the clustering distinguishes a burst from steady work.
 */
export const DenseLane: Story = {
  args: denseLaneRoster(),
};

/**
 * Tool events whose agent row never synced, appended as a trailing lane rather
 * than dropped. The lane takes the grey dot of an `unknown` status and sits at
 * depth zero because it has no place in the tree.
 *
 * Keeping it is the point. Silently discarding these would leave the strip
 * disagreeing with the session's own tool-call total, and nothing on screen
 * would say why. The `play` pins the lane's presence and both counts, so the
 * three attributed calls and the two orphaned ones stay separately visible.
 */
export const UnattributedLane: Story = {
  args: unattributedLaneRoster(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText(UNATTRIBUTED_LANE)).toBeVisible();
    expect(canvas.getByText("3")).toBeVisible();
    expect(canvas.getByText("2")).toBeVisible();
  },
};

/**
 * Two measured calls and two whose `createdAt` will not parse. The unparseable
 * pair falls to the same 50% the zero-width window uses, so they land midway
 * along the track beside dots that were actually measured there.
 *
 * Hover them: the card prints the raw string instead of a time, which is the
 * only cue distinguishing "at the midpoint" from "we do not know when". That
 * gap between what the position claims and what the tooltip admits is the
 * finding this story exists to make visible.
 */
export const UnparseableTimestamps: Story = {
  args: unparseableTimestampRoster(),
};

/**
 * A four-level chain, every level busy. Lane depth is paid for out of the fixed
 * 160px label column, so the deepest label has 12px less room per level and the
 * name truncates while the tracks below stay aligned.
 *
 * The `title` attribute is the only recovery for a truncated name, so check that
 * a lane which has lost its label to the ellipsis is still identifiable.
 */
export const DeepLaneLabels: Story = {
  args: deepLaneRoster(),
};

/**
 * Events synced, none of them a tool call. Distinct from a session with no
 * events at all, and it says so: the strip is replaced by a sentence instead of
 * drawing empty tracks, which would read as tools that ran and produced nothing.
 */
export const NoToolInvocations: Story = {
  args: {
    agents: noErrorAgentSessionDetailFixture.agents,
    events: noErrorAgentSessionDetailFixture.events.map((event) => ({
      ...event,
      toolName: null,
    })),
  },
};

/**
 * The dense lane in a 320px column, which is under the strip's own 360px floor.
 * The flow keeps its minimum width and scrolls horizontally rather than
 * compressing the track, so the earlier/later axis stays honest; the label
 * column and the count column are what the reader loses first.
 */
export const NarrowColumn: Story = {
  args: denseLaneRoster(),
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
): ToolFlowArgs {
  const session = createAgentSessionDetailFixture({ agents, events });
  return { agents: session.agents, events: session.events };
}

/** A worker agent with the given id, name, and parent. */
function worker(
  externalAgentId: string,
  name: string,
  parentExternalAgentId: string | null,
  status = "completed"
): SyncedAgentSessionAgent {
  return {
    externalAgentId,
    name,
    type: parentExternalAgentId === null ? "main" : "subagent",
    subagentType: parentExternalAgentId === null ? null : "implement",
    status,
    task: `${name} did its share of the slice.`,
    currentTool: null,
    startedAt: at(0),
    updatedAt: at(30),
    endedAt: at(30),
    parentExternalAgentId,
  };
}

/** One tool invocation, error-flagged through its event type. */
function toolEvent(
  externalEventId: string,
  agentExternalId: string | null,
  toolName: string,
  createdAt: string,
  isError = false
): SyncedAgentSessionEvent {
  return {
    externalEventId,
    agentExternalId,
    eventType: isError ? "tool_error" : "tool_use",
    toolName,
    summary: `${toolName} ran on the worktree.`,
    createdAt,
  };
}

/** Seven invocations across two lanes, all sharing one instant. */
function singleInstantRoster(): ToolFlowArgs {
  const flushedAt = at(6);
  const agents = [
    worker("burst-root", "Session orchestrator", null),
    worker("burst-lane", "Implementation lane", "burst-root"),
  ];
  const rootTools = ["rg", "read", "edit", "bash"].map((toolName, index) =>
    toolEvent(`burst-root-${index}`, "burst-root", toolName, flushedAt)
  );
  const laneTools = ["vitest", "biome", "tsc"].map((toolName, index) =>
    toolEvent(`burst-lane-${index}`, "burst-lane", toolName, flushedAt)
  );
  return rosterArgs(agents, [...rootTools, ...laneTools]);
}

/** Forty invocations on one lane, four of them errors. */
function denseLaneRoster(): ToolFlowArgs {
  const tools = ["rg", "read", "edit", "bash", "vitest"];
  const events = Array.from({ length: 40 }, (_, index) =>
    toolEvent(
      `dense-${index}`,
      "dense-lane",
      tools[index % tools.length],
      at(index * 0.75),
      index % 11 === 3
    )
  );
  return rosterArgs(
    [
      worker("dense-root", "Session orchestrator", null),
      worker("dense-lane", "Implementation lane", "dense-root", "running"),
    ],
    [
      toolEvent("dense-root-0", "dense-root", "task", at(0)),
      toolEvent("dense-root-1", "dense-root", "task", at(30)),
      ...events,
    ]
  );
}

/** Three attributed calls, plus two from an agent row that never synced. */
function unattributedLaneRoster(): ToolFlowArgs {
  return rosterArgs(
    [worker("orphan-root", "Session orchestrator", null)],
    [
      toolEvent("orphan-known-0", "orphan-root", "rg", at(0)),
      toolEvent("orphan-known-1", "orphan-root", "edit", at(20)),
      toolEvent("orphan-known-2", "orphan-root", "read", at(26)),
      toolEvent("orphan-0", "agent-never-synced", "bash", at(8)),
      toolEvent("orphan-1", null, "vitest", at(14), true),
    ]
  );
}

/** Two measured calls and two whose timestamps will not parse. */
function unparseableTimestampRoster(): ToolFlowArgs {
  return rosterArgs(
    [worker("skew-root", "Session orchestrator", null)],
    [
      toolEvent("skew-0", "skew-root", "rg", at(0)),
      toolEvent("skew-1", "skew-root", "bash", "not-a-timestamp"),
      toolEvent("skew-2", "skew-root", "vitest", "0000-00-00T00:00:00Z", true),
      toolEvent("skew-3", "skew-root", "edit", at(30)),
    ]
  );
}

/** A four-level chain, every level carrying tool calls. */
function deepLaneRoster(): ToolFlowArgs {
  const chain = [
    { id: "deep-root", name: "Session orchestrator", parent: null },
    {
      id: "deep-plan",
      name: "Plan writer lane",
      parent: "deep-root",
    },
    {
      id: "deep-implement",
      name: "Implementation worker lane",
      parent: "deep-plan",
    },
    {
      id: "deep-review",
      name: "Rendered-UI verification lane with a long name",
      parent: "deep-implement",
    },
  ];
  const agents = chain.map((entry) =>
    worker(entry.id, entry.name, entry.parent)
  );
  const events = chain.flatMap((entry, depth) =>
    ["rg", "read", "edit"].map((toolName, index) =>
      toolEvent(
        `${entry.id}-${index}`,
        entry.id,
        toolName,
        at(depth * 6 + index * 2)
      )
    )
  );
  return rosterArgs(agents, events);
}

/** Renders the strip inside a fixed-width column, the way a rail hands it one. */
function columnAtWidth(widthPx: number): Decorator {
  return (Story) => (
    <div className="rounded-md border p-3" style={{ width: widthPx }}>
      <Story />
    </div>
  );
}

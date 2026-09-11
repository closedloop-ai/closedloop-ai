import { AGENT_FAILED_STATUS_PATTERN } from "@repo/api/src/agent-session-status";
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
  populatedAgentSessionDetailFixture,
} from "./agent-session-detail-fixtures";
import { SubagentEffectivenessPanel } from "./subagent-effectiveness-panel";

/**
 * ISS-5698: the per-agent table, and specifically the three cells that can lie.
 *
 * A row here carries a duration, a tool count, and an error count, all right
 * aligned in a numeric column. Two of the values that column can hold are not
 * numbers at all:
 *
 *  - `formatDurationMs(null)` renders an em dash for an agent whose start or end
 *    was never recorded. That is "not measured", and it sits directly above a
 *    genuine `0ms` from an agent that started and ended on the same instant.
 *  - the errors column prints a muted `0` for a clean lane, which has to stay
 *    distinguishable from the red count beside it without relying on colour
 *    alone to carry the meaning.
 *
 * The legend above the table is the third: it splits the roster into completed,
 * failed, and other, so a live session legitimately reads "0 completed" and that
 * zero must not look like missing data. Tests pin these strings individually.
 * Only a render shows them stacked in one column, which is where they get
 * confused.
 */

type PanelArgs = ComponentProps<typeof SubagentEffectivenessPanel>;

/** Base instant every generated roster hangs its timestamps off. */
const ROSTER_START_MS = Date.parse("2026-06-10T12:00:00.000Z");

/**
 * What `formatDurationMs` prints for a null duration. Its own output, not copy
 * written here, so the assertion below breaks if the unavailable marker ever
 * silently becomes a zero.
 */
const UNAVAILABLE_DURATION = "—";

/** A phone width, well under the table's 720px floor. */
const NARROW_VIEWPORT_PX = 380;

/**
 * Lists every agent in a session with status, duration, and errors, indented
 * by delegation, with a dash instead of a false zero for missing timestamps.
 */
const meta = {
  title: "Composites/Agents/Subagent Effectiveness Panel",
  component: SubagentEffectivenessPanel,
  tags: ["autodocs"],
  argTypes: {
    agents: { control: "object" },
    events: { control: "object" },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SubagentEffectivenessPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shipped shape: a root and two children, one of which failed. The legend
 * reads 2 completed, 1 failed, 0 other, and the tree indent plus the elbow glyph
 * carry the hierarchy inside a flat table. Baseline for everything below.
 */
export const MixedRoster: Story = {
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    events: populatedAgentSessionDetailFixture.events,
  },
};

/**
 * The reason this file exists. Four rows, stacked in one right-aligned column:
 * a lane never measured (em dash), a lane that started and ended on the same
 * instant (`0ms`), a lane that ran five seconds, and a lane that ran twenty
 * minutes. Two of those four are zero-ish and they mean completely different
 * things.
 *
 * The same row set does it again for counts: an unrecorded lane with no events
 * shows `0` tool uses because it emitted none, not because it did none. Nothing
 * on the row separates those readings, which is worth knowing when reading this
 * table for effectiveness.
 *
 * The `play` pins the em dash and the `0ms` in the same assertion. Collapsing
 * one into the other is the specific regression, and it is invisible to a test
 * that only checks a duration formatter in isolation.
 */
export const UnavailableVersusZero: Story = {
  args: unavailableVersusZeroRoster(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText(UNAVAILABLE_DURATION)).toBeVisible();
    expect(canvas.getByText("0ms")).toBeVisible();
    expect(canvas.getByText("5.0s")).toBeVisible();
  },
};

/**
 * A session still in flight: nothing has completed and nothing has failed, so
 * the legend reads "0 completed, 0 failed, 3 other". Both zeros are real
 * measurements of a live roster.
 *
 * Worth its own canvas because the legend's third bucket only ever carries a
 * number in this state, and a reader who has only seen {@link MixedRoster} has
 * never seen the emerald and red dots both sitting on a zero.
 */
export const NoTerminalStatuses: Story = {
  args: inFlightRoster(),
};

/**
 * Five levels of delegation flattened into table rows. Depth is paid in 16px of
 * left padding plus an elbow glyph, inside a cell that also holds the name, so
 * this is where the tree either stays traceable or turns into a ragged list.
 * The deepest row is 64px in.
 */
export const DeepNesting: Story = {
  args: deepNestingRoster(),
};

/**
 * Twelve lanes with counts spanning one digit to four. The numeric columns are
 * right aligned and thousand separated, so a `1,284` has to stack cleanly over
 * an `8`, and the red error counts have to stay findable in a column that is
 * mostly muted zeros. Density at this size is the whole question.
 */
export const LargeRoster: Story = {
  args: largeRoster(),
};

/**
 * The shipped roster in a 380px viewport. The table carries a 720px floor
 * deliberately (FEA-3866): a nested tree cannot collapse to a phone width
 * without losing the hierarchy, so it scrolls horizontally instead. Check that
 * the scroll is reachable and that the agent column, which is the one a reader
 * needs to keep, is the one still on screen at rest.
 */
export const NarrowViewport: Story = {
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    events: populatedAgentSessionDetailFixture.events,
  },
  decorators: [viewportAtWidth(NARROW_VIEWPORT_PX)],
};

/**
 * No agents synced. The table and its legend both go, replaced by one line,
 * because a header row over an empty body reads as a roster of zero effective
 * agents rather than as an absence of data.
 */
export const NoAgentData: Story = {
  args: {
    agents: emptyAgentsAgentSessionDetailFixture.agents,
    events: emptyAgentsAgentSessionDetailFixture.events,
  },
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
): PanelArgs {
  const session = createAgentSessionDetailFixture({ agents, events });
  return { agents: session.agents, events: session.events };
}

/** `count` events for one agent, the first `errors` of them error-typed. */
function eventsFor(
  agentExternalId: string,
  count: number,
  errors: number
): SyncedAgentSessionEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    externalEventId: `${agentExternalId}-event-${index}`,
    agentExternalId,
    eventType: index < errors ? "tool_error" : "tool_use",
    toolName: "bash",
    summary: `${agentExternalId} invoked bash.`,
    createdAt: at(index),
  }));
}

/** The four duration readings the column can hold, in one roster. */
function unavailableVersusZeroRoster(): PanelArgs {
  const agents: SyncedAgentSessionAgent[] = [
    {
      externalAgentId: "measured-root",
      name: "Session orchestrator",
      type: "main",
      status: "completed",
      task: "Ran the slice end to end.",
      currentTool: null,
      startedAt: at(0),
      updatedAt: at(20),
      endedAt: at(20),
      parentExternalAgentId: null,
    },
    {
      externalAgentId: "unmeasured-lane",
      name: "Lane with no recorded end",
      type: "subagent",
      subagentType: "implement",
      status: "running",
      task: "Its start synced; its end never did.",
      currentTool: "bash",
      startedAt: at(1),
      updatedAt: at(4),
      endedAt: null,
      parentExternalAgentId: "measured-root",
    },
    {
      externalAgentId: "instant-lane",
      name: "Lane that ended on its start instant",
      type: "subagent",
      subagentType: "review",
      status: "completed",
      task: "Refused the task and returned immediately.",
      currentTool: null,
      startedAt: at(5),
      updatedAt: at(5),
      endedAt: at(5),
      parentExternalAgentId: "measured-root",
    },
    {
      externalAgentId: "brief-lane",
      name: "Lane that ran five seconds",
      type: "subagent",
      subagentType: "review",
      status: "failed",
      task: "Threw on its first tool call.",
      currentTool: null,
      startedAt: at(6),
      updatedAt: at(6),
      endedAt: new Date(ROSTER_START_MS + 6 * 60_000 + 5000).toISOString(),
      parentExternalAgentId: "measured-root",
    },
  ];
  return rosterArgs(agents, [
    ...eventsFor("measured-root", 9, 0),
    ...eventsFor("instant-lane", 1, 0),
    ...eventsFor("brief-lane", 3, 2),
  ]);
}

/** A roster where nothing has reached a terminal status yet. */
function inFlightRoster(): PanelArgs {
  const statuses = ["running", "awaiting_input", "queued"];
  const agents = statuses.map((status, index) => ({
    externalAgentId: `live-${status}`,
    name: `${status} lane`,
    type: index === 0 ? "main" : "subagent",
    subagentType: index === 0 ? null : "implement",
    status,
    task: `Currently ${status}.`,
    currentTool: status === "running" ? "bash" : null,
    startedAt: at(index),
    updatedAt: at(index + 2),
    endedAt: null,
    parentExternalAgentId: index === 0 ? null : "live-running",
  }));
  return rosterArgs(
    agents,
    agents.flatMap((agent, index) =>
      eventsFor(agent.externalAgentId, index + 2, 0)
    )
  );
}

/** A five-level delegation chain, one child per level. */
function deepNestingRoster(): PanelArgs {
  const names = [
    "Session orchestrator",
    "Plan writer lane",
    "Implementation worker lane",
    "Review lane",
    "Review fix lane",
  ];
  const agents: SyncedAgentSessionAgent[] = [];
  let parentId: string | null = null;
  for (const [index, name] of names.entries()) {
    const externalAgentId = `depth-${index}`;
    agents.push({
      externalAgentId,
      name,
      type: index === 0 ? "main" : "subagent",
      subagentType: index === 0 ? null : "implement",
      status: index === 3 ? "failed" : "completed",
      task: `Depth ${index} of the delegation chain.`,
      currentTool: null,
      startedAt: at(index * 2),
      updatedAt: at(index * 2 + 3),
      endedAt: at(index * 2 + 3),
      parentExternalAgentId: parentId,
    });
    parentId = externalAgentId;
  }
  return rosterArgs(
    agents,
    agents.flatMap((agent, index) =>
      eventsFor(agent.externalAgentId, index + 1, index === 3 ? 2 : 0)
    )
  );
}

/** Twelve lanes with counts spanning one digit to four. */
function largeRoster(): PanelArgs {
  const specialities = [
    "schema",
    "api",
    "hooks",
    "table",
    "detail",
    "stories",
    "e2e",
    "docs",
    "telemetry",
    "migration",
    "flags",
    "cleanup",
  ];
  const root: SyncedAgentSessionAgent = {
    externalAgentId: "large-root",
    name: "Session orchestrator",
    type: "main",
    status: "completed",
    task: "Split the slice across twelve lanes.",
    currentTool: null,
    startedAt: at(0),
    updatedAt: at(180),
    endedAt: at(180),
    parentExternalAgentId: null,
  };
  const children = specialities.map((speciality, index) => ({
    externalAgentId: `large-${speciality}`,
    name: `${speciality} lane`,
    type: "subagent",
    subagentType: speciality,
    status: index % 5 === 2 ? "failed" : "completed",
    task: `Own the ${speciality} half of the change.`,
    currentTool: null,
    startedAt: at(index),
    updatedAt: at(index + 12),
    endedAt: at(index + 12),
    parentExternalAgentId: root.externalAgentId,
  }));
  const agents = [root, ...children];
  return rosterArgs(
    agents,
    // Error counts are derived from the lane's own status rather than sprinkled
    // by index, so a row that reads `failed` always carries errors to explain it.
    agents.flatMap((agent, index) =>
      eventsFor(
        agent.externalAgentId,
        index === 0 ? 1284 : (index * 37) % 400,
        AGENT_FAILED_STATUS_PATTERN.test(agent.status) ? index * 3 : 0
      )
    )
  );
}

/** Renders the table inside a fixed-width viewport, so its floor has to scroll. */
function viewportAtWidth(widthPx: number): Decorator {
  return (Story) => (
    <div
      className="overflow-hidden rounded-md border p-3"
      style={{ width: widthPx }}
    >
      <Story />
    </div>
  );
}

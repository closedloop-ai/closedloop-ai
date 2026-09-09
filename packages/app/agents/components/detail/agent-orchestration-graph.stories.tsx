import { AGENT_FAILED_STATUS_PATTERN } from "@repo/api/src/agent-session-status";
import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ComponentProps } from "react";
import { expect, within } from "storybook/test";
import { AgentOrchestrationGraph } from "./agent-orchestration-graph";
import {
  createAgentSessionDetailFixture,
  emptyAgentsAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "./agent-session-detail-fixtures";

/**
 * ISS-5698: the delegation tree, at the shapes a real session produces.
 *
 * `detail-analytics-panels.test.tsx` mounts this panel through one fixture and
 * asserts strings. What it cannot answer is the thing this component IS: nested
 * cards, a connector rail, and a per-status colour vocabulary, all of which are
 * geometry. A five-deep chain that indents past its own card, a fan-out that
 * pushes the "N sub" counter off the row, a status the classifier does not
 * recognise falling to grey next to four that do; each is a render, not an
 * assertion.
 *
 * The panel is pure props (agents in, events in, nothing out), so no story here
 * declares `parameters.appCore`. Custom rosters are routed through the shared
 * `createAgentSessionDetailFixture` rather than hand-built session objects, so
 * every roster on this page is the same canonical agent/event shape the detail
 * screen reads.
 *
 * Titled "Session Detail Orchestration Graph", NOT "Agent Orchestration Graph":
 * that title is already owned by `../orchestration-dag.stories.tsx`, whose
 * `OrchestrationDag` is a different component — a workflow-level layered DAG
 * (sessions -> main agent -> subagent types) rather than this session's own
 * delegation tree. Two `meta.title`s cannot collide: the catalog is GENERATED
 * from them (`buildAppCoreEntries` keys `storyTitle` verbatim), and Storybook
 * folds same-titled files into one sidebar/autodocs identity, so a duplicate
 * silently makes one of the two unreachable.
 */

type GraphArgs = ComponentProps<typeof AgentOrchestrationGraph>;

/** Base instant every generated roster hangs its timestamps off. */
const ROSTER_START_MS = Date.parse("2026-06-10T12:00:00.000Z");

/** The line the graph prints only when nothing in the roster has a parent. */
const FLAT_ROSTER_NOTE =
  "All agents are top-level (no parent/child relationships detected).";

/** A phone-width column, where the node card has to wrap rather than clip. */
const NARROW_COLUMN_PX = 320;

const meta = {
  title: "App Core/Agents/Detail/Session Detail Orchestration Graph",
  component: AgentOrchestrationGraph,
  tags: ["autodocs"],
  argTypes: {
    agents: {
      control: "object",
      description:
        "Synced roster. Parent links drive the tree; drop them all and the flat-roster note appears.",
    },
    events: {
      control: "object",
      description:
        "Synced events, read only for the tool and error counts in each node's hover card.",
    },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof AgentOrchestrationGraph>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shipped shape: one root that delegated twice, one of those children
 * having failed. This is the baseline every other story is read against, and
 * the only one where the parent card carries a "2 sub" counter.
 *
 * The `play` pins the absence of the flat-roster note. That sentence is
 * suppressed by a single `.some()` over `parentExternalAgentId`, so a roster
 * that HAS a hierarchy printing it anyway is a silent contradiction of the tree
 * drawn directly underneath it.
 */
export const Hierarchy: Story = {
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    events: populatedAgentSessionDetailFixture.events,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText("2 sub")).toBeVisible();
    expect(canvas.queryByText(FLAT_ROSTER_NOTE)).not.toBeInTheDocument();
  },
};

/**
 * The same three agents with every parent link dropped, which is what a harness
 * that never reported delegation syncs. Three sibling cards and no rail, so the
 * graph states in words that the flat layout is the data and not a rendering
 * failure. Worth looking at because that line is the only thing separating this
 * from a tree that failed to build.
 */
export const FlatRoster: Story = {
  args: flatRoster(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText(FLAT_ROSTER_NOTE)).toBeVisible();
    expect(canvas.queryByText("2 sub")).not.toBeInTheDocument();
  },
};

/**
 * Every branch of the status colour map on one canvas: emerald for a success
 * term, red for a failure term, blue for a live run, purple for a run blocked
 * on a human, and grey for a producer-native word the classifier claims
 * nothing about.
 *
 * Agent status is free text on the wire, matched by substring
 * (`AGENT_SUCCESS_STATUS_TERMS` / `AGENT_FAILED_STATUS_TERMS`), so grey is a
 * real and reachable state rather than a fallback nobody hits. The dot and the
 * 4px left border are driven by two separate helpers, and this is the one view
 * where a disagreement between them is visible.
 */
export const StatusPalette: Story = {
  args: statusPaletteRoster(),
};

/**
 * Five levels of delegation, which the tree draws by nesting a bordered card
 * inside a bordered card five times over. Each level adds a rail, a 16px
 * indent, and an elbow, so this is where the indentation either stays legible
 * or eats the card. The deepest agent is still running, so its dot has to read
 * against a background that has narrowed four times.
 */
export const DeepChain: Story = {
  args: deepChainRoster(),
};

/**
 * One orchestrator that delegated eight times. The children are a flat stack
 * under a single rail, and the parent's "N sub" counter is `ml-auto` on a
 * wrapping row, so a long name plus two badges can push it onto its own line.
 * That counter is the only place the fan-out is stated as a number.
 */
export const WideFanOut: Story = {
  args: wideFanOutRoster(),
};

/**
 * Names, subagent types, and tasks at lengths a real harness emits. The card
 * wraps on `[overflow-wrap:anywhere]` rather than clipping, which keeps the
 * name readable but grows the row; check that the type badges stay beside the
 * name they describe and that the counter does not end up orphaned.
 */
export const LongNames: Story = {
  args: longNameRoster(),
};

/**
 * The deep chain in a 320px column, which is the desktop detail rail on a
 * phone. Both the indent and the wrap are competing for the same width here,
 * and the tree has no horizontal scroll of its own to fall back on, so this is
 * the width where the nesting either survives or stops communicating depth.
 */
export const NarrowColumn: Story = {
  args: deepChainRoster(),
  decorators: [columnAtWidth(NARROW_COLUMN_PX)],
};

/**
 * No agents synced at all. A distinct state from a session whose agents are all
 * top-level, and from one whose telemetry could not be attributed; this one is
 * an absence of rows, and it says so instead of rendering an empty rail.
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
 * One tool event per agent, plus an error event for any agent whose status the
 * canonical failure pattern matches. The graph itself only reads these counts
 * in its hover card, but they have to agree with the status shown on the card
 * face, so they are derived from the status rather than sprinkled by hand.
 */
function eventsForRoster(
  agents: SyncedAgentSessionAgent[]
): SyncedAgentSessionEvent[] {
  return agents.flatMap((agent, index) => {
    const toolEvent: SyncedAgentSessionEvent = {
      externalEventId: `${agent.externalAgentId}-tool`,
      agentExternalId: agent.externalAgentId,
      eventType: "tool_use",
      toolName: "rg",
      summary: `${agent.name} searched the worktree.`,
      createdAt: at(index),
    };
    if (!AGENT_FAILED_STATUS_PATTERN.test(agent.status)) {
      return [toolEvent];
    }
    const errorEvent: SyncedAgentSessionEvent = {
      externalEventId: `${agent.externalAgentId}-error`,
      agentExternalId: agent.externalAgentId,
      eventType: "tool_error",
      toolName: "vitest",
      summary: `${agent.name} failed a check.`,
      createdAt: at(index + 1),
    };
    return [toolEvent, errorEvent];
  });
}

/**
 * Routes a custom roster through the shared session factory so the arrays these
 * stories hand the panel are the same ones the detail screen reads, rather than
 * a second hand-built session shape drifting beside it.
 */
function rosterArgs(agents: SyncedAgentSessionAgent[]): GraphArgs {
  const session = createAgentSessionDetailFixture({
    agents,
    events: eventsForRoster(agents),
  });
  return { agents: session.agents, events: session.events };
}

/** The shipped roster with every parent link dropped. */
function flatRoster(): GraphArgs {
  return rosterArgs(
    populatedAgentSessionDetailFixture.agents.map((agent) => ({
      ...agent,
      parentExternalAgentId: null,
    }))
  );
}

/** One root per branch of the status colour map. */
function statusPaletteRoster(): GraphArgs {
  const statuses = [
    { status: "completed", task: "Finished and reported a result." },
    { status: "failed", task: "Threw before it could report." },
    { status: "running", task: "Still working." },
    { status: "awaiting_input", task: "Blocked on a human answer." },
    {
      status: "queued",
      task: "A producer word this build classifies as neither.",
    },
  ];
  return rosterArgs(
    statuses.map(({ status, task }, index) => ({
      externalAgentId: `palette-${status}`,
      name: `${status} worker`,
      type: "subagent",
      subagentType: "worker",
      status,
      task,
      startedAt: at(index),
      updatedAt: at(index + 1),
      endedAt: status === "completed" ? at(index + 2) : null,
      parentExternalAgentId: null,
    }))
  );
}

/** A five-level delegation chain, one child per level. */
function deepChainRoster(): GraphArgs {
  const chain: {
    id: string;
    name: string;
    status: string;
    sub: string | null;
  }[] = [
    {
      id: "orchestrator",
      name: "Session orchestrator",
      status: "running",
      sub: null,
    },
    { id: "planner", name: "Plan writer", status: "completed", sub: "plan" },
    {
      id: "implementer",
      name: "Implementation worker",
      status: "completed",
      sub: "implement",
    },
    { id: "reviewer", name: "Review lane", status: "failed", sub: "review" },
    {
      id: "fixer",
      name: "Review fix lane",
      status: "running",
      sub: "implement",
    },
  ];

  const agents: SyncedAgentSessionAgent[] = [];
  let parentId: string | null = null;
  for (const [index, entry] of chain.entries()) {
    agents.push({
      externalAgentId: entry.id,
      name: entry.name,
      type: index === 0 ? "main" : "subagent",
      subagentType: entry.sub,
      status: entry.status,
      task: `Depth ${index} of the delegation chain.`,
      currentTool: entry.status === "running" ? "bash" : null,
      startedAt: at(index * 2),
      updatedAt: at(index * 2 + 1),
      endedAt: entry.status === "running" ? null : at(index * 2 + 2),
      parentExternalAgentId: parentId,
    });
    parentId = entry.id;
  }
  return rosterArgs(agents);
}

/** One orchestrator with eight direct children. */
function wideFanOutRoster(): GraphArgs {
  const specialities = [
    "schema",
    "api",
    "hooks",
    "table",
    "detail",
    "stories",
    "e2e",
    "docs",
  ];
  const root: SyncedAgentSessionAgent = {
    externalAgentId: "fan-out-root",
    name: "Session orchestrator",
    type: "main",
    status: "running",
    task: "Split the slice across eight lanes.",
    currentTool: "task",
    startedAt: at(0),
    updatedAt: at(1),
    endedAt: null,
    parentExternalAgentId: null,
  };
  const children = specialities.map((speciality, index) => ({
    externalAgentId: `fan-out-${speciality}`,
    name: `${speciality} lane`,
    type: "subagent",
    subagentType: speciality,
    status: index === 5 ? "failed" : "completed",
    task: `Own the ${speciality} half of the change.`,
    currentTool: null,
    startedAt: at(index + 1),
    updatedAt: at(index + 3),
    endedAt: at(index + 3),
    parentExternalAgentId: root.externalAgentId,
  }));
  return rosterArgs([root, ...children]);
}

/** Names and tasks at the lengths a real harness emits. */
function longNameRoster(): GraphArgs {
  const root: SyncedAgentSessionAgent = {
    externalAgentId: "long-root",
    name: "Session orchestrator for the shared agent session detail foundation",
    type: "main",
    status: "running",
    task: "Coordinate the whole shared detail foundation across every surface that mounts it.",
    currentTool: "task",
    startedAt: at(0),
    updatedAt: at(1),
    endedAt: null,
    parentExternalAgentId: null,
  };
  const child: SyncedAgentSessionAgent = {
    externalAgentId: "long-child",
    name: "Rendered-UI verification lane with a name long enough to wrap twice in a narrow column",
    type: "subagent",
    subagentType: "storybook-visual-verification",
    status: "failed",
    task: "Capture desktop and mobile screenshots of every state the panel can reach, then reconcile them against the plan.",
    currentTool: null,
    startedAt: at(2),
    updatedAt: at(6),
    endedAt: at(6),
    parentExternalAgentId: root.externalAgentId,
  };
  return rosterArgs([root, child]);
}

/** Renders the tree inside a fixed-width column, the way a rail hands it one. */
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

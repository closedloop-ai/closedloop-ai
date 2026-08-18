import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ComponentProps } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  AgentSessionAnalyticsTab,
  AgentSessionDetailAnalyticsTabs,
} from "./agent-session-detail-analytics-tabs";
import {
  createAgentSessionDetailFixture,
  emptyAgentsAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "./agent-session-detail-fixtures";

/**
 * ISS-5698: the Agent Analytics card, which is four panels sharing one strip and
 * one URL parameter.
 *
 * Each tab has its own story file, so what this one owns is the seam between
 * them: which tab opens, what the card looks like when the tab that opens has
 * nothing to show, whether the strip survives a phone width, and whether a
 * click actually swaps the panel instead of stacking a second one under it.
 *
 * The tab lives in `?view=` through `useTabParam`, not in local state, so these
 * stories drive the navigation port that `.storybook/preview.tsx` mounts for
 * every story. Nothing here declares `parameters.appCore`: the panels are pure
 * props and the port is already there. {@link TabSwitching} is the only story
 * that writes to that shared port, and it clicks back to the default before it
 * ends, which is what removes the parameter again.
 */

type AnalyticsTabsArgs = ComponentProps<typeof AgentSessionDetailAnalyticsTabs>;

/** The card title, and the cheapest proof that the card rendered at all. */
const CARD_TITLE = "Agent Analytics";

/** Unique to the Orchestration panel: the root card's sub-agent counter. */
const ORCHESTRATION_MARKER = "2 sub";

/** Unique to the Error Map panel: its reconciled error total. */
const ERROR_MAP_MARKER = "1 error event total";

/** A phone width, narrower than the four-segment tab strip. */
const NARROW_VIEWPORT_PX = 360;

const meta = {
  title: "App Core/Agents/Agent Session Detail Analytics Tabs",
  component: AgentSessionDetailAnalyticsTabs,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof AgentSessionDetailAnalyticsTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * What a reader gets on arrival: Orchestration selected, because it is the
 * declared default and the default is deliberately omitted from the URL. The
 * Effectiveness tab sits first in the strip while the second one is selected,
 * which is worth a look, the reading order and the default do not match.
 */
export const Default: Story = {
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    events: populatedAgentSessionDetailFixture.events,
  },
};

/**
 * Deep-linked to the Effectiveness tab, which is the only panel that renders a
 * table. It is the widest of the four and the one that changes the card's height
 * most, so it is worth pinning what the card looks like when the tallest panel
 * is the one open.
 */
export const EffectivenessTab: Story = {
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    defaultTab: AgentSessionAnalyticsTab.Effectiveness,
    events: populatedAgentSessionDetailFixture.events,
  },
};

/**
 * Deep-linked to Tool Flow. This panel owns its own horizontal scroll, so inside
 * the card there are now two scroll contexts, the tab strip's and the strip's
 * own. Check that they do not fight at the card's edge.
 */
export const ToolFlowTab: Story = {
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    defaultTab: AgentSessionAnalyticsTab.ToolFlow,
    events: populatedAgentSessionDetailFixture.events,
  },
};

/**
 * Deep-linked to the Error Map, the one panel that can turn the card red. Worth
 * seeing inside the card rather than alone: the red node sits a few pixels from
 * the neutral tab strip, and the footnote under it is the longest body copy any
 * of the four panels prints.
 */
export const ErrorsTab: Story = {
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    defaultTab: AgentSessionAnalyticsTab.Errors,
    events: populatedAgentSessionDetailFixture.events,
  },
};

/**
 * Telemetry arrived, the agent rows did not, which is what a session mid-sync
 * looks like. The card opens because there are tool and error events to analyse,
 * and then the default tab has nothing to draw, so a reader lands on "No agent
 * data available for this session." while two of the other three tabs do have
 * content.
 *
 * That is the honest render of this data and it is also the finding. The card's
 * visibility gate and its default tab disagree about what counts as content, and
 * the only cue that the other tabs are worth opening is the strip itself.
 */
export const TelemetryWithoutAgents: Story = {
  args: telemetryOnlyArgs(),
};

/**
 * Events synced, none of them a tool call or an error, and no agents. The card
 * does not render at all, which is why the `play` asserts an absence: an empty
 * card with four empty tabs would claim a whole analytics surface for a session
 * that has nothing to analyse.
 *
 * Note the gate is on the CONTENT of the events, not on the array being empty.
 * These events exist; they are simply not telemetry this card can read.
 */
export const HiddenWithoutTelemetry: Story = {
  args: noTelemetryArgs(),
  // Deliberately synchronous: the component short-circuits to `null`, so there
  // is no mount to settle and nothing to poll for. An awaited `findBy*` here
  // would only be waiting out its own timeout.
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByText(CARD_TITLE)).not.toBeInTheDocument();
    expect(canvas.queryByRole("tab")).not.toBeInTheDocument();
  },
};

/**
 * The card at 360px. The strip is `w-max` inside a horizontal scroller, so the
 * four segments keep their labels and the row scrolls rather than wrapping or
 * shrinking the text. The trailing tab is the one that goes off the edge, and
 * the only affordance for it is the scroll itself.
 */
export const NarrowViewport: Story = {
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    events: populatedAgentSessionDetailFixture.events,
  },
  decorators: [viewportAtWidth(NARROW_VIEWPORT_PX)],
};

/**
 * The interaction, asserted rather than mimed. Selection is not local state
 * here: the click writes `?view=errors` through the navigation port and the card
 * re-reads it, so a broken port shows up as a strip whose highlight moves while
 * the panel underneath does not.
 *
 * The `play` therefore checks the PANEL, not just `aria-selected`, and checks
 * that the previous panel is gone rather than merely that the new one arrived.
 * It then clicks back to Orchestration, which both proves the round trip and
 * clears `?view=` out of the port that every story in the sweep shares.
 */
export const TabSwitching: Story = {
  args: {
    agents: populatedAgentSessionDetailFixture.agents,
    events: populatedAgentSessionDetailFixture.events,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText(ORCHESTRATION_MARKER)).toBeVisible();

    await userEvent.click(canvas.getByRole("tab", { name: "Error Map" }));

    expect(await canvas.findByText(ERROR_MAP_MARKER)).toBeVisible();
    expect(canvas.queryByText(ORCHESTRATION_MARKER)).not.toBeInTheDocument();
    expect(canvas.getByRole("tab", { name: "Error Map" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    await userEvent.click(canvas.getByRole("tab", { name: "Orchestration" }));

    expect(await canvas.findByText(ORCHESTRATION_MARKER)).toBeVisible();
    expect(canvas.queryByText(ERROR_MAP_MARKER)).not.toBeInTheDocument();
  },
};

/**
 * Routes a custom roster through the shared session factory so the arrays these
 * stories hand the card are the same ones the detail screen reads, rather than
 * a second hand-built session shape drifting beside it.
 */
function rosterArgs(
  agents: SyncedAgentSessionAgent[],
  events: SyncedAgentSessionEvent[]
): AnalyticsTabsArgs {
  const session = createAgentSessionDetailFixture({ agents, events });
  return { agents: session.agents, events: session.events };
}

/** Tool and error telemetry that no synced agent row claims. */
function telemetryOnlyArgs(): AnalyticsTabsArgs {
  return rosterArgs(
    [],
    [
      {
        externalEventId: "unsynced-tool-0",
        agentExternalId: "agent-never-synced",
        eventType: "tool_use",
        toolName: "rg",
        summary: "Searched the worktree before the agent row synced.",
        createdAt: "2026-06-10T12:02:00.000Z",
      },
      {
        externalEventId: "unsynced-tool-1",
        agentExternalId: "agent-never-synced",
        eventType: "tool_error",
        toolName: "vitest",
        summary: "Suite failed while the agent row was still pending.",
        createdAt: "2026-06-10T12:09:00.000Z",
      },
    ]
  );
}

/** Events with no tool call and no error, so the card stays closed. */
function noTelemetryArgs(): AnalyticsTabsArgs {
  return rosterArgs(emptyAgentsAgentSessionDetailFixture.agents, [
    {
      externalEventId: "lifecycle-start",
      agentExternalId: null,
      eventType: "session_started",
      summary: "Session opened.",
      createdAt: "2026-06-10T12:00:00.000Z",
    },
    {
      externalEventId: "lifecycle-end",
      agentExternalId: null,
      eventType: "session_ended",
      summary: "Session closed.",
      createdAt: "2026-06-10T12:20:00.000Z",
    },
  ]);
}

/** Renders the card inside a fixed-width viewport, the way a phone hands it one. */
function viewportAtWidth(widthPx: number): Decorator {
  return (Story) => (
    <div className="overflow-hidden p-3" style={{ width: widthPx }}>
      <Story />
    </div>
  );
}

import type { Meta, StoryObj } from "@storybook/react";
import { ACTIVE_RUN_STALL_TIMEOUT_MS } from "../../lib/active-runs";
import { ActiveRunsPanel } from "./active-runs-panel";
import { createAgentSessionListItemFixture } from "./session-list-fixtures";

/**
 * Fixed "now" for both the fixtures below and the panel itself (ISS-5286).
 *
 * Pinning only the fixtures would not have been enough. The panel reads
 * `Date.now()` at mount and re-reads it every 10s, so with a pinned base every
 * elapsed timer drifted by however long collection-to-render took and then
 * advanced on a timer — and pinning the fixtures to a fixed past date without
 * pinning the panel would classify all three runs as stalled, collapsing the
 * working/awaiting/stalled spread these stories exist to show. So the panel takes
 * the same instant through its `pinnedNowMs` prop, which also stops the ticking.
 *
 * Local date components, not a parsed ISO string: `"2025-06-11"` parses as UTC
 * midnight and would shift the rendered day by timezone.
 */
const NOW = new Date(2025, 5, 11, 12, 0, 0);
const now = NOW.getTime();

const working = createAgentSessionListItemFixture({
  id: "ses-working",
  name: "Implement active-runs panel",
  status: "active",
  harness: "claude",
  endedAt: null,
  startedAt: new Date(now - 4 * 60 * 1000),
  lastActivityAt: new Date(now - 20 * 1000),
  inputTokens: 120_000,
  outputTokens: 38_000,
  phases: [
    {
      key: "stream",
      label: "Streaming turn",
      dur: "2m",
      cost: "$0",
      cIn: 0,
      cOut: 0,
      cCache: 0,
    },
  ],
});

const awaiting = createAgentSessionListItemFixture({
  id: "ses-awaiting",
  name: "Refactor session sync bridge",
  status: "active",
  harness: "codex",
  endedAt: null,
  startedAt: new Date(now - 9 * 60 * 1000),
  awaitingInputSince: new Date(now - 60 * 1000),
  lastActivityAt: new Date(now - 60 * 1000),
});

const stalled = createAgentSessionListItemFixture({
  id: "ses-stalled",
  name: "Backfill telemetry analytics",
  status: "active",
  harness: "cursor",
  endedAt: null,
  startedAt: new Date(now - 22 * 60 * 1000),
  lastActivityAt: new Date(now - ACTIVE_RUN_STALL_TIMEOUT_MS - 2 * 60 * 1000),
});

/**
 * This is the card on the Sessions page showing which agent sessions are
 * running right now, each with a live phase badge (working, waiting for
 * input, or stalled) plus its running time and token count. Use it for a
 * quick read on what is happening this second, as a companion to the full
 * Sessions table, which is better suited to history and filtering. A session
 * is marked stalled after it goes quiet for a set stretch of time, and the
 * whole panel can be frozen at a fixed moment for review instead of ticking
 * forward.
 */
const meta = {
  title: "Composites/Sessions/Listing/Active Runs Panel",
  component: ActiveRunsPanel,
  tags: ["autodocs"],
  argTypes: {
    items: {
      control: "object",
      description:
        "The active session rows. The panel derives phase and stall state from them.",
    },
    isLoading: { control: "boolean" },
    getSessionHref: { control: false, table: { category: "Routing" } },
    pinnedNowMs: {
      control: false,
      description:
        "Freezes the panel: pins the clock to this instant and stops the 10s tick. Stories and tests only.",
    },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    getSessionHref: (run) => `/sessions/${run.id}`,
    isLoading: false,
    items: [working, awaiting, stalled],
    pinnedNowMs: now,
  },
} satisfies Meta<typeof ActiveRunsPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const SingleWorkingRun: Story = {
  args: {
    items: [working],
  },
};

export const Loading: Story = {
  args: {
    isLoading: true,
  },
};

export const Empty: Story = {
  args: {
    items: [],
  },
};

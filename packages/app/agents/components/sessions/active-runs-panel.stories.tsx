import type { Meta, StoryObj } from "@storybook/react";
import { ACTIVE_RUN_STALL_TIMEOUT_MS } from "../../lib/active-runs";
import { ActiveRunsPanel } from "./active-runs-panel";
import { createAgentSessionListItemFixture } from "./session-list-fixtures";

const now = Date.now();

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

const meta = {
  title: "App Core/Agents/Active Runs Panel",
  component: ActiveRunsPanel,
  parameters: {
    layout: "padded",
  },
  args: {
    getSessionHref: (run) => `/sessions/${run.id}`,
    isLoading: false,
    items: [working, awaiting, stalled],
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

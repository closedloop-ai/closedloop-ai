import type { AgentSessionLastSyncTarget } from "@repo/api/src/types/agent-session";
import type { Meta, StoryObj } from "@storybook/react";
import { ContextCards } from "./context-cards";

/**
 * ISS-4828 (wongk review, PR #4256): `ContextCards` came out of
 * `agent-telemetry-analytics.tsx` as a prop-driven component and picked up real
 * visual states in the same change — the two flag states, the two sync
 * watermarks, the `Never` fallback, and online/offline rows. Driving those
 * through the parent analytics story is the only way to see them otherwise, so
 * they are canvassed directly here.
 *
 * Timestamps are FIXED, not relative to now, so each story keeps a stable set of
 * relative labels rather than drifting to "Just now" the day it is opened.
 */
const LAST_SEEN_AT = new Date("2026-07-31T11:59:40.000Z");
const LAST_ACCEPTED_SYNC_AT = new Date("2026-07-31T11:55:00.000Z");
const LAST_INGEST_AT = new Date("2026-07-28T12:00:00.000Z");

const syncingWithNothingNew: AgentSessionLastSyncTarget = {
  computeTargetId: "target-1",
  machineName: "Ada's MacBook Pro",
  isOnline: true,
  lastSeenAt: LAST_SEEN_AT,
  // The ISS-4828 shape: a batch was accepted minutes ago carrying no new
  // sessions, so the LANDED-DATA watermark is days old while the machine is in
  // fact syncing perfectly.
  lastAgentSessionSyncAt: LAST_INGEST_AT,
  lastAgentSessionSyncAttemptAt: LAST_ACCEPTED_SYNC_AT,
  owner: {
    id: "user-1",
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    avatarUrl: null,
  },
};

const offlineTarget: AgentSessionLastSyncTarget = {
  computeTargetId: "target-2",
  machineName: "CI Runner 04",
  isOnline: false,
  lastSeenAt: new Date("2026-07-31T10:00:00.000Z"),
  lastAgentSessionSyncAt: new Date("2026-07-31T09:58:00.000Z"),
  lastAgentSessionSyncAttemptAt: new Date("2026-07-31T09:58:00.000Z"),
  owner: {
    id: "user-2",
    email: "platform@example.com",
    firstName: null,
    lastName: null,
    avatarUrl: null,
  },
};

// Registered but never synced: BOTH watermarks null, so every timestamp column
// must read the honest "Never" rather than blank or a borrowed value.
const neverSyncedTarget: AgentSessionLastSyncTarget = {
  computeTargetId: "target-3",
  machineName: "New Laptop",
  isOnline: true,
  lastSeenAt: LAST_SEEN_AT,
  lastAgentSessionSyncAt: null,
  lastAgentSessionSyncAttemptAt: null,
  owner: {
    id: "user-3",
    email: "grace@example.com",
    firstName: "Grace",
    lastName: "Hopper",
    avatarUrl: null,
  },
};

const meta = {
  title: "Composites/Agents/Context Cards",
  component: ContextCards,
  tags: ["autodocs"],
  argTypes: {
    targets: {
      control: "object",
      description:
        "One row per compute target. `lastAgentSessionSyncAt` is the landed-data watermark; `lastAgentSessionSyncAttemptAt` is the accepted-batch one, and they are shown in separate columns because they answer different questions.",
    },
  },
  parameters: { layout: "padded" },
  args: {
    targets: [syncingWithNothingNew, offlineTarget, neverSyncedTarget],
  },
} satisfies Meta<typeof ContextCards>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The shipped card (ISS-4828, ungated since ISS-5280). "Last Sync" is the
 * ACCEPTED-batch watermark — the online machine at the top reads "5 min ago"
 * even though it had nothing new to send — and the landed-data signal keeps its
 * own "Last Data" column ("3 days ago") rather than leaving the screen. The
 * description says so, so the copy and the value it describes cannot drift.
 */
export const CorrectedSemantics: Story = {};

/** No compute targets at all — the table's empty state inside the card. */
export const NoTargets: Story = {
  args: { targets: [] },
};

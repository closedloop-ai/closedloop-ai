import {
  AgentSessionCloudSyncState,
  agentSessionCloudSyncStateValues,
} from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import type { Meta, StoryObj } from "@storybook/react";
import { CloudSyncStateBadge } from "./cloud-sync-state-badge";

// ISS-5451: the per-row cloud-sync disclosure, isolated.
// Three different gaps all reach `cloudSyncState: pending`, and ISS-4647 exists
// because the original single "Local only" vocabulary described only the first
// of them — telling a user their session was local-only while the row they were
// looking at had been served FROM the cloud. The three pending stories below are
// the correction, and they only make sense read together:
// - {@link PendingLocalOnly} — the session itself is still in the outbox.
// - {@link PendingTranscriptSyncing} — the session is in the cloud, only its
//   transcript is behind.
// - {@link PendingTranscriptFailed} — the session is in the cloud and the last
//   transcript upload FAILED. #4150: the detail panel shows this as a
//   destructive "Transcript upload failed" with a Retry, so the list must not
//   reuse the in-flight "syncs automatically" copy and tell the user to relax.
// {@link Synced} and {@link Absent} render NOTHING, deliberately — a "synced"
// chip on every settled row would make the table a wall of redundant badges. The
// stories are here so that absence is a reviewable, intentional state rather
// than something a reader has to infer.
// Each badge's tooltip carries copy the label alone cannot; the preview supplies
// the `TooltipProvider`.
/**
 * A small muted pill next to a session row whose cloud copy might be behind,
 * like Local only or Transcript still syncing, shown only when that row is
 * genuinely pending.
 */
const meta = {
  title: "Composites/Sessions/Listing/Cloud Sync State Badge",
  component: CloudSyncStateBadge,
  tags: ["autodocs"],
  argTypes: {
    cloudSyncState: {
      control: { type: "radio" },
      options: agentSessionCloudSyncStateValues,
      description:
        "Only pending renders anything. Synced and an omitted value render nothing at all.",
    },
    transcriptDisposition: {
      control: { type: "select" },
      options: Object.values(TranscriptDisposition),
      description:
        "Scopes the pending copy to the transcript. A settled verdict, or none, keeps the broader Local only wording.",
    },
    className: { control: false },
  },
  parameters: { layout: "centered" },
  args: {
    cloudSyncState: AgentSessionCloudSyncState.Pending,
  },
} satisfies Meta<typeof CloudSyncStateBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The whole session is still in the desktop sync outbox — genuinely not in the
 * cloud yet. Also the safe fallback whenever the gap cannot be determined.
 */
export const PendingLocalOnly: Story = {};

/**
 * The session IS in the cloud; only its raw transcript is still uploading. The
 * label matches the detail transcript panel's own title for this state so the
 * list and the detail never read as two different facts.
 */
export const PendingTranscriptSyncing: Story = {
  args: { transcriptDisposition: TranscriptDisposition.Syncing },
};

/**
 * The last transcript upload attempt failed. Admits the failure while noting the
 * automatic retry — it must not say "syncs automatically" while the detail panel
 * shows a destructive error with a Retry button.
 */
export const PendingTranscriptFailed: Story = {
  args: { transcriptDisposition: TranscriptDisposition.FailedTransient },
};

/**
 * A settled transcript verdict on a pending row falls back to the broad
 * "Local only" statement — the session itself is the gap.
 */
export const PendingSettledTranscript: Story = {
  args: { transcriptDisposition: TranscriptDisposition.Synced },
};

/** A synced row renders nothing. The empty frame is the expected result. */
export const Synced: Story = {
  args: { cloudSyncState: AgentSessionCloudSyncState.Synced },
};

/**
 * A version-skewed producer that omits the field renders nothing rather than
 * guessing a disclosure.
 */
export const Absent: Story = {
  args: { cloudSyncState: undefined },
};

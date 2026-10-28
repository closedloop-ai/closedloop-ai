import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SessionSyncStatusBadge } from "@repo/app/agents/components/sessions/session-sync-status-badge";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";

/**
 * ISS-5036 (whitlockk): the states this badge actually reasons about, rendered.
 *
 * This badge returns `null` for a row with no attention verdict, and the row's
 * chip set suppresses it again on an uploading row whose cloud chip already
 * names the verdict (`disclosureNamesTheVerdict` in
 * `useSessionRowQualifiers`). A silent-drop shape with a hover-only tooltip is
 * exactly the kind of affordance nobody sees again until it goes missing in
 * production, and no story we ship reached it: on a folded row the parent
 * suppresses the whole inline cluster anyway.
 *
 * So this file mounts the badge directly, one row per verdict — including the
 * no-verdict case, whose correct rendering is nothing. The badge is
 * unconditional (ISS-5366 retired its gate), so a verdict is now the only thing
 * that decides whether it renders.
 */
const SYNCING = createAgentSessionListItemFixture({
  id: "session-syncing",
  transcriptDisposition: TranscriptDisposition.Syncing,
});
const FAILED_TRANSIENT = createAgentSessionListItemFixture({
  id: "session-failed-transient",
  transcriptDisposition: TranscriptDisposition.FailedTransient,
});
const FAILED_PERMANENT = createAgentSessionListItemFixture({
  id: "session-failed-permanent",
  transcriptDisposition: TranscriptDisposition.FailedPermanent,
});
const UPLOAD_PAUSED = createAgentSessionListItemFixture({
  id: "session-upload-paused",
  transcriptDisposition: TranscriptDisposition.FailedTransient,
  transcriptDispositionReason: TranscriptSkipReason.EnvironmentUnavailable,
});
const STALE = createAgentSessionListItemFixture({
  id: "session-stale",
  transcriptDisposition: TranscriptDisposition.Stale,
});
const SYNCED = createAgentSessionListItemFixture({
  id: "session-synced",
  transcriptDisposition: TranscriptDisposition.Synced,
});

function Row({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-64 text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  );
}

const SessionSyncStatusBadgeGallery = () => (
  <div className="space-y-3">
    {/* Hover this one: ISS-5036 gave the uploading verdict the canonical
        `TranscriptSyncing` disclosure, so the row keeps the specific "in the
        cloud, transcript still uploading" sentence the dropped cloud chip
        used to carry — not just the bare vocabulary word. */}
    <Row label="syncing — carries the disclosure tooltip (hover)">
      <SessionSyncStatusBadge session={SYNCING} />
    </Row>
    <Row label="failedTransient — keeps its own chip, no tooltip">
      <SessionSyncStatusBadge session={FAILED_TRANSIENT} />
    </Row>
    <Row label={'failedPermanent — "Sync failed", danger tone'}>
      <SessionSyncStatusBadge session={FAILED_PERMANENT} />
    </Row>
    {/* ISS-9884: same `failedTransient` disposition as the row above — the
        `environment_unavailable` reason is what resolves it to "Upload
        paused" in warning tone instead of "Sync failed, retrying". */}
    <Row
      label={
        'failedTransient + environmentUnavailable — "Upload paused", warning tone'
      }
    >
      <SessionSyncStatusBadge session={UPLOAD_PAUSED} />
    </Row>
    <Row label="stale — keeps its own chip, no tooltip">
      <SessionSyncStatusBadge session={STALE} />
    </Row>
    {/* A healthy row is the steady state, and a dense list shows the
        exception: `synced` renders nothing here by design — the freshness
        lives on the detail Properties Sync row. */}
    <Row label="synced — renders nothing (steady state)">
      <SessionSyncStatusBadge session={SYNCED} />
    </Row>
  </div>
);

const meta = {
  title: "Composites v1.0/Sessions/Session Sync Status Badge",
  component: SessionSyncStatusBadgeGallery,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof SessionSyncStatusBadgeGallery>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

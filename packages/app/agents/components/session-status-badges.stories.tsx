import {
  AgentStatusBadge,
  HarnessBadge,
  SessionStatusBadge,
} from "@repo/app/agents/components/session-status-badges";
import { SessionSyncPresentation } from "@repo/app/agents/lib/session-sync-presentation";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * ISS-5279: the two renderings of one Active row, by sync state — a pulsing ring
 * while an upload is in flight, and the ordinary pill otherwise. Captioned
 * because a still gallery cannot show the 1.6s beat.
 *
 * Two, not three: PR review removed the third (a warning-toned dot for a
 * transcript that stopped without finishing). At 6px inside a pale fill it was
 * not perceivable at 1x, and that verdict already renders in the Name cell,
 * which this fold never suppresses for a row that is not uploading.
 */
const SYNC_PRESENTATION_CAPTIONS = [
  {
    caption: "Syncing, pulsing ring",
    presentation: SessionSyncPresentation.Syncing,
  },
  { caption: "Not uploading, no mark", presentation: undefined },
] as const;

const SessionStatusBadgesGallery = () => (
  <TooltipProvider>
    <div className="space-y-6">
      {/* ISS-4586: canonical vocabulary — Active / Waiting / Inactive / Error. */}
      <div className="flex flex-wrap gap-2">
        <SessionStatusBadge status="active" />
        <SessionStatusBadge status="waiting" />
        <SessionStatusBadge status="inactive" />
        <SessionStatusBadge status="error" />
      </div>
      {/* ISS-5279: the sync dimension, shipped unconditionally since ISS-5366
        retired the `sessions-status-pill-sync-state` gate. Sync never becomes a
        Status value — a row can be Active AND syncing — so it modulates how the
        lifecycle pill is DRAWN, and all three of these are the SAME status.
        Hover or tab to each for its explanation; switch your OS to reduce-motion
        and the pulsing one holds its ring still instead. */}
      <div className="flex flex-wrap items-end gap-4">
        {SYNC_PRESENTATION_CAPTIONS.map(({ caption, presentation }) => (
          <div className="flex flex-col gap-1.5" key={caption}>
            <SessionStatusBadge
              status="active"
              syncPresentation={presentation}
            />
            <span className="text-muted-foreground text-xs">{caption}</span>
          </div>
        ))}
      </div>
      {/* Legacy values still render (normalized) during the migration window. */}
      <div className="flex flex-wrap gap-2">
        <SessionStatusBadge status="completed" />
        <SessionStatusBadge status="abandoned" />
      </div>
      <div className="flex flex-wrap gap-2">
        <AgentStatusBadge status="working" />
        <AgentStatusBadge status="waiting" />
        <AgentStatusBadge status="completed" />
        <AgentStatusBadge status="error" />
        <AgentStatusBadge status="idle" />
      </div>
      <div className="flex flex-wrap gap-2">
        <HarnessBadge harness="claude" />
        <HarnessBadge harness="codex" />
        <HarnessBadge harness="cursor" />
        <HarnessBadge harness="copilot" />
        <HarnessBadge harness="opencode" />
      </div>
      <div className="flex flex-wrap gap-2">
        <ToneBadge label="Security" tone="danger" />
      </div>
    </div>
  </TooltipProvider>
);

const meta = {
  title: "App Core/Agents/Overview/Session Status Badges",
  component: SessionStatusBadgesGallery,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof SessionStatusBadgesGallery>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

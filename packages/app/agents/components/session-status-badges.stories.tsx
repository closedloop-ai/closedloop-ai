import {
  AgentStatusBadge,
  HarnessBadge,
  SessionStatusBadge,
} from "@repo/app/agents/components/session-status-badges";
import {
  SESSION_STATUS_SYNC_BADGE_TEST_ID,
  SessionSyncPresentation,
} from "@repo/app/agents/lib/session-sync-presentation";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";

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
      {/* ISS-10364: canonical vocabulary — Active / Inactive / Error. */}
      <div className="flex flex-wrap gap-2">
        <SessionStatusBadge status="active" />
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
      {/* Legacy and retired spellings all fold to Active (ISS-10364 retired the
        unknown/stale/waiting words a reader used to see here). */}
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
        {/* An unrecognized `agent.status` — `resolveStatusConfig`'s raw-fallback
          branch, never exercised elsewhere in this gallery. It renders the raw
          string in a danger pill rather than silently defaulting to a known
          state, so an unmapped status still reads as a failure rather than as
          something benign. */}
        <AgentStatusBadge status="planning" />
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
  title: "Composites v1.0/Agents/General/Session Status Badges",
  component: SessionStatusBadgesGallery,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof SessionStatusBadgesGallery>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // ISS-10364 retired the badge's own Unknown/Stale tooltips. The sync
    // disclosure is the only tooltip left on this badge, so this hovers that
    // one instead.
    await userEvent.hover(
      canvas.getByTestId(SESSION_STATUS_SYNC_BADGE_TEST_ID)
    );
    const tooltip = await within(canvasElement.ownerDocument.body).findByRole(
      "tooltip"
    );
    await expect(tooltip).toHaveTextContent(
      "This session is in the cloud, but its transcript is still uploading. It syncs automatically."
    );
  },
};

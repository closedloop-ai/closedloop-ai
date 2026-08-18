"use client";

import { Button } from "@repo/design-system/components/ui/button";

// The arrival CTA body (Card #5), shared by the two anchors it can attach to:
// the sidebar's "Invite your team" footer item on desktop, and the topbar menu
// trigger on mobile (where the sidebar — and its invite item — is offcanvas at
// <768px, so a popover anchored there would never be on screen).
type InviteAnnouncementContentProps = {
  onDismiss: () => void;
  onInvite: () => void;
};

export const InviteAnnouncementContent = ({
  onDismiss,
  onInvite,
}: InviteAnnouncementContentProps) => (
  <div className="space-y-3">
    <div className="space-y-1.5">
      <p className="font-medium text-sm">Share with your team</p>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Invite your team to see their sessions and the agentic components they
        are using on this page.
      </p>
    </div>
    <div className="flex justify-end gap-2">
      <Button onClick={onDismiss} size="sm" variant="ghost">
        Maybe later
      </Button>
      <Button onClick={onInvite} size="sm">
        Invite your team
      </Button>
    </div>
  </div>
);

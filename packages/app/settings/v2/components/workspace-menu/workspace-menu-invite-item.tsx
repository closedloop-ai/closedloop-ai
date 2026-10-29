"use client";

import {
  isWorkspaceMenuEntryRendered,
  WORKSPACE_MENU_ENTRY_LABEL,
  type WorkspaceMenuCapabilities,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import { WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY } from "@repo/api/src/types/workspace-menu-invite-entry-flag";
import { InviteTeamDialog } from "@repo/app/organizations/components/invite-team-dialog";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { DropdownMenuItem } from "@repo/design-system/components/ui/dropdown-menu";
import { useCallback, useEffect, useState } from "react";
import { ITEM_CLASSNAME } from "./workspace-menu-styles";

/**
 * The workspace menu's "Invite members" entry (ISS-10362).
 *
 * ITS OWN FILE, like `workspace-menu-download-item.tsx`: this is the second
 * entry with a decision behind it, and keeping the read here is what lets
 * `workspace-menu.tsx` go on reading no feature flag.
 *
 * INVITE, NOT MANAGE (operator ruling, Marisol 2026-09-17: "so it has invite; not
 * manage"). The row opens the shared {@link InviteTeamDialog} and reaches no
 * roster, no pending-invitation list and no membership administration — which
 * is why it can exist on a host where Members cannot: the dialog posts to
 * `POST /organizations/invitations`, while Members' panel body is Clerk's
 * `<OrganizationProfile>` and the desktop renderer mounts no Clerk provider.
 *
 * `useFeatureFlagEnabledOptional`, not the throwing read: this menu has stories
 * that mount without a flag provider, and an additive gated entry should stay
 * shut there rather than crash the subtree.
 *
 * TWO SLOTS, ONE CONTROLLER. The dialog cannot live inside the dropdown's
 * content — selecting the row closes the menu, which unmounts that subtree and
 * takes the dialog with it before it can open. So the caller renders the ROW
 * inside the menu and the DIALOG as a sibling of it, both driven by
 * {@link useWorkspaceMenuInvite}. That is the shape the create-workspace dialog
 * in `workspace-menu.tsx` already uses.
 */

export type WorkspaceMenuInviteController = {
  /** Whether the entry is offered here at all — host capability AND the flag. */
  rendered: boolean;
  open: boolean;
  setOpen: (next: boolean) => void;
  openDialog: () => void;
};

export function useWorkspaceMenuInvite(
  capabilities: WorkspaceMenuCapabilities
): WorkspaceMenuInviteController {
  const enabled = useFeatureFlagEnabledOptional(
    WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY
  );
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  const rendered =
    enabled &&
    isWorkspaceMenuEntryRendered(capabilities[WorkspaceMenuEntryId.Invite]);

  // Withdrawing the entry has to CLOSE the dialog, not merely unmount it. A
  // PostHog assignment can move under a live session, and `open` outlives the
  // subtree it drove: left standing, the next re-render that turns the entry
  // back on brings the dialog straight back up with nobody having clicked the
  // row. Clearing it here is the whole of the fix — the row is the only opener.
  useEffect(() => {
    if (!rendered) {
      setOpen(false);
    }
  }, [rendered]);

  return {
    rendered,
    open,
    setOpen,
    openDialog,
  };
}

export function WorkspaceMenuInviteItem({
  invite,
}: {
  invite: WorkspaceMenuInviteController;
}) {
  if (!invite.rendered) {
    return null;
  }
  return (
    <DropdownMenuItem
      // Selecting this opens a dialog rather than navigating, and the row is
      // otherwise indistinguishable from the links above it.
      aria-haspopup="dialog"
      className={ITEM_CLASSNAME}
      onSelect={invite.openDialog}
    >
      {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Invite]}
    </DropdownMenuItem>
  );
}

export function WorkspaceMenuInviteDialog({
  invite,
}: {
  invite: WorkspaceMenuInviteController;
}) {
  if (!invite.rendered) {
    return null;
  }
  // Controlled and trigger-less: the row above is the opener, and it lives in a
  // subtree that is gone by the time this is on screen.
  return <InviteTeamDialog onOpenChange={invite.setOpen} open={invite.open} />;
}

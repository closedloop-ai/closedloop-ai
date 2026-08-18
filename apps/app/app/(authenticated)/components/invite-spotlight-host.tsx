"use client";

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { InviteTeamDialog } from "@repo/app/organizations/components/invite-team-dialog";
import { useFeatureFlagGate } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { INVITE_SPOTLIGHT_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { useOrganization } from "@repo/auth/client";
import { useCallback, useEffect, useState } from "react";
import { InviteSpotlight } from "./invite-spotlight";
import { useOnboardingChecklist } from "./use-onboarding-checklist";

/**
 * Per-user, per-org, per-device suppression for "Maybe later".
 *
 * Keyed by user because a browser can be shared and a nudge one person waved off
 * is not one their colleague has seen. Keyed by ORG as well because everything
 * that decides whether the nudge fires is org state — the checklist comes from
 * the active org and the invite row completes on that org's member count — so a
 * user in two orgs who dismissed it in one would otherwise never be asked in the
 * other, which may have no teammates at all.
 *
 * The org half is the ACTIVE organization's immutable id, not its slug: a slug
 * is renameable, and renaming would mint a fresh key and re-nudge a user who
 * already said no. Not `currentUser.organizationId` either — that is the user's
 * own org row, which is the wrong org for anyone viewing a second one.
 *
 * Deliberately NOT the org-level `Organization.settings` blob the checklist's own
 * dismissal uses — that field makes one member's click disappear the checklist
 * for the whole org, tracked as its own defect (ISS-5991). Reproducing that model
 * here would ship the same bug in new code; when ISS-5991 threads a per-user
 * record through the onboarding service, this can move onto it and become
 * cross-device.
 */
function suppressionKey(orgId: string, userId: string): string {
  return `closedloop.invite-spotlight-dismissed.${orgId}.${userId}`;
}

/**
 * Owns everything the invite spotlight needs so the My Tasks page gains one
 * line rather than four pieces of state it does not otherwise care about.
 *
 * The spotlight fires only while there is something to nudge toward: the flag
 * is on, onboarding is finished, the checklist is actually on screen, and the
 * invite row is still incomplete. Inviting someone completes that row, so the
 * nudge retires itself without needing to record that it fired.
 */
export function InviteSpotlightHost() {
  const { data: currentUser } = useCurrentUser();
  const { organization } = useOrganization();
  const checklist = useOnboardingChecklist();
  // Gated on resolution as well as value: an unresolved flag read bare would
  // pop a spotlight over the page at someone the rollout has not reached, then
  // yank it away a tick later.
  const { enabled: spotlightEnabled, isReady: spotlightReady } =
    useFeatureFlagGate(INVITE_SPOTLIGHT_FEATURE_FLAG_KEY);

  const [dialogOpen, setDialogOpen] = useState(false);
  // `null` means "not read yet" — localStorage is unavailable during SSR, and
  // assuming "not dismissed" before the read would flash the spotlight at
  // someone who already waved it off.
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  const userId = currentUser?.id;
  const orgId = organization?.id;
  const scoped = userId !== undefined && orgId !== undefined;

  // Re-reads when the org changes, so switching workspaces asks again rather
  // than inheriting the answer given somewhere else.
  useEffect(() => {
    if (!scoped) {
      return;
    }
    try {
      setDismissed(
        localStorage.getItem(suppressionKey(orgId, userId)) !== null
      );
    } catch {
      // Private browsing or a full quota: treat as not dismissed. A repeated
      // nudge is a smaller failure than a silently broken one.
      setDismissed(false);
    }
  }, [scoped, orgId, userId]);

  const suppress = useCallback(() => {
    setDismissed(true);
    if (!scoped) {
      return;
    }
    try {
      localStorage.setItem(
        suppressionKey(orgId, userId),
        new Date().toISOString()
      );
    } catch {
      // Suppressed for this session regardless; the write is the only part that
      // can fail.
    }
  }, [scoped, orgId, userId]);

  const handleInvite = useCallback(() => {
    setDialogOpen(true);
    // Opening the dialog answers the nudge, so it should not be waiting behind
    // it when the dialog closes.
    suppress();
  }, [suppress]);

  // The anchor lives inside the checklist, so the same source decides whether
  // there is anything to anchor to — rather than this component keeping its own
  // copy of the checklist's render conditions and drifting from them.
  const inviteRowIncomplete = checklist.items.some(
    (item) => item.id === ChecklistItemId.InviteMembers && !item.completed
  );

  const active =
    spotlightEnabled &&
    spotlightReady &&
    checklist.visible &&
    inviteRowIncomplete &&
    dismissed === false;

  return (
    <>
      <InviteSpotlight
        active={active}
        onDismiss={suppress}
        onInvite={handleInvite}
      />
      <InviteTeamDialog onOpenChange={setDialogOpen} open={dialogOpen} />
    </>
  );
}

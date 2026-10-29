import { WorkspaceMenuProjectionStatus } from "@repo/api/src/types/workspace-menu";
import { WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY } from "@repo/api/src/types/workspace-menu-invite-entry-flag";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { useDesktopIdentity } from "../../shared-agent-sessions/use-desktop-identity";
import { desktopWorkspaceMenuProjectionStatus } from "../../workspace-menu-host/desktop-workspace-menu-host-adapter";

/**
 * Whether the workspace menu is actually HOLDING the invite entry right now
 * (ISS-11247).
 *
 * Two things in the desktop shell have to agree about this and used to answer it
 * independently: the sidebar footer, which gives its own invite row up when the
 * menu holds one, and {@link DesktopWorkspaceHeaderSlot}, which points the
 * arrival nudge at the menu trigger for the same reason. Both read the
 * `workspace-menu-invite-entry` key HERE rather than being handed a boolean, so
 * neither can settle at a different moment than the other
 * (`no-threaded-feature-flag`).
 *
 * The key alone is not the answer, which is the whole of ISS-11247:
 * `WorkspaceMenuInviteItem` and its dialog live inside `ReadyWorkspaceMenu`, so
 * a menu in any other standing — a failed `GET /desktop/identity`, which
 * `useDesktopIdentity` settles as `{identity: null, isResolved: true}` for the
 * rest of the session — holds nothing. The standing is asked of the adapter that
 * owns it rather than re-derived, because a second copy of it is how the footer
 * and the menu came to disagree in the first place.
 */
export function useDesktopWorkspaceMenuHoldsInvite(): boolean {
  const inviteInMenu = useFeatureFlagEnabled(
    WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY
  );
  const { state } = useDesktopAuth();
  const identity = useDesktopIdentity(state.status, state.userId);

  if (!inviteInMenu) {
    return false;
  }
  return (
    desktopWorkspaceMenuProjectionStatus({
      authStatus: state.status,
      hasIdentity: identity.identity !== null,
      isResolved: identity.isResolved,
    }) === WorkspaceMenuProjectionStatus.Ready
  );
}

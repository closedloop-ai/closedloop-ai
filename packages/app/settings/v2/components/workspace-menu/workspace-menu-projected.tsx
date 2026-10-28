"use client";

import {
  buildMembersSettingsRoute,
  buildSettingsPanelRoute,
} from "@repo/api/src/types/settings-route-links";
import {
  isWorkspaceMenuEntryRendered,
  WORKSPACE_MENU_ENTRY_LABEL,
  type WorkspaceMenuCapabilities,
  WorkspaceMenuEntryId,
  type WorkspaceMenuProjection,
} from "@repo/api/src/types/workspace-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { ThemeSubmenu } from "@repo/design-system/components/ui/theme-submenu";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import type { ReactNode } from "react";
import type { WorkspaceMenuHostAdapter } from "../../../../shared/workspace-menu-host/workspace-menu-host-adapter";
import { DownloadDesktopItem } from "./workspace-menu-download-item";
import {
  type WorkspaceMenuInviteController,
  WorkspaceMenuInviteItem,
} from "./workspace-menu-invite-item";
import { useSignOut } from "./workspace-menu-sign-out";
import { ITEM_CLASSNAME, PANEL_CLASSNAME } from "./workspace-menu-styles";
import { WorkspaceMenuTrigger } from "./workspace-menu-trigger";

/**
 * The parts of the workspace menu that are NOT specific to a signed-in,
 * fully-resolved workspace: the dropdown shell both bodies wear, the destination
 * rows, the Log out row, and the body every non-`Ready` projection renders.
 *
 * A sibling module rather than more of `workspace-menu.tsx`, on the seam
 * `workspace-menu-styles.ts` already established: `workspace-menu.tsx` owns the
 * Ready body and the mount point and imports these, so nothing here imports back
 * and there is no cycle to manage.
 */

export function WorkspaceMenuShell({
  children,
  onOpenChange,
  open,
  projection,
}: {
  children: ReactNode;
  onOpenChange: (next: boolean) => void;
  open: boolean;
  projection: WorkspaceMenuProjection;
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger asChild>
        <WorkspaceMenuTrigger projection={projection} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={`w-72 ${PANEL_CLASSNAME}`}
        side="bottom"
        sideOffset={6}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DestinationItems({
  adapter,
  capabilities,
  invite,
}: {
  adapter: WorkspaceMenuHostAdapter;
  capabilities: WorkspaceMenuCapabilities;
  /** Absent on every non-`Ready` menu, none of which projects an invite entry. */
  invite?: WorkspaceMenuInviteController;
}) {
  // The canonical org-path join, injected by whichever navigation adapter this
  // host mounted: slug-prefixing on web, the identity function on desktop.
  const buildOrgPath = useOrgPath();
  const diagnosticsHref = adapter.diagnosticsHref;
  const showDiagnostics =
    isWorkspaceMenuEntryRendered(
      capabilities[WorkspaceMenuEntryId.Diagnostics]
    ) && Boolean(diagnosticsHref);

  return (
    <>
      {isWorkspaceMenuEntryRendered(
        capabilities[WorkspaceMenuEntryId.Settings]
      ) ? (
        <DropdownMenuItem asChild className={ITEM_CLASSNAME}>
          <Link href={buildOrgPath(buildSettingsPanelRoute())}>
            {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]}
          </Link>
        </DropdownMenuItem>
      ) : null}

      {showDiagnostics && diagnosticsHref ? (
        <DropdownMenuItem asChild className={ITEM_CLASSNAME}>
          <Link href={diagnosticsHref}>
            {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Diagnostics]}
          </Link>
        </DropdownMenuItem>
      ) : null}

      {isWorkspaceMenuEntryRendered(
        capabilities[WorkspaceMenuEntryId.Members]
      ) ? (
        <DropdownMenuItem asChild className={ITEM_CLASSNAME}>
          {/* Named by contract, never hand-spelled as `?panel=members`. */}
          <Link href={buildOrgPath(buildMembersSettingsRoute())}>
            {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Members]}
          </Link>
        </DropdownMenuItem>
      ) : null}

      {/* THE SAME SLOT, not a second one: exactly one of Members and Invite is
          ever projected, so the two hosts put "bring someone into this
          workspace" in the same place — directly under Settings/Diagnostics and
          ABOVE the theme block, where the prototype and web already have it. */}
      {invite ? <WorkspaceMenuInviteItem invite={invite} /> : null}

      {/* ISS-9889. Unconditional, and deliberately NOT a `WorkspaceMenuEntryId`:
          the theme is a client-side `next-themes` preference that every host
          rendering this menu already serves, so there is no host difference to
          project. A capability that can only ever be `Ready` buys nothing and
          hands a host a way to claim it cannot do something it can.

          `icon={null}` because no other row in this menu carries a glyph; the
          rows take the same `ITEM_CLASSNAME` its sibling submenu uses, trigger
          and flyout options alike, and the flyout the same panel treatment, so
          the theme block is not the one part of this menu wearing the
          primitive defaults. */}
      <ThemeSubmenu
        contentClassName={PANEL_CLASSNAME}
        icon={null}
        itemClassName={ITEM_CLASSNAME}
      />
    </>
  );
}

/**
 * The Log out row and the message a rejected sign-out leaves behind.
 *
 * Shared by both menu bodies rather than restated in each: the copy below is the
 * only thing standing between a user and believing they signed out when they did
 * not, and a second spelling of it is how one of the two comes to drop it.
 */
export function SignOutItem({
  capabilities,
  signOut,
  signOutFailed,
}: {
  capabilities: WorkspaceMenuCapabilities;
  signOut: () => void;
  signOutFailed: boolean;
}) {
  return (
    <>
      {isWorkspaceMenuEntryRendered(
        capabilities[WorkspaceMenuEntryId.LogOut]
      ) ? (
        <DropdownMenuItem
          className={ITEM_CLASSNAME}
          // Keep the menu open on failure, so the message below is readable
          // and the user can retry rather than being told nothing.
          onSelect={(event) => {
            event.preventDefault();
            signOut();
          }}
        >
          {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut]}
        </DropdownMenuItem>
      ) : null}

      {signOutFailed ? (
        <DropdownMenuLabel className="font-normal text-destructive text-xs">
          Could not sign out. You are still signed in — try again.
        </DropdownMenuLabel>
      ) : null}
    </>
  );
}

/**
 * The menu behind every projection that is not `Ready` — Guest, Pending, and
 * Error alike (ISS-11400).
 *
 * ONE BODY FOR THE THREE, because the projection status decides what the TRIGGER
 * says and the capabilities decide what the menu OFFERS, and these three differ
 * only in the first. Settings, Diagnostics and the theme need no workspace
 * identity at all, so a read that has not landed — or one that failed — is not a
 * reason to withhold them. This component was the guest-only body, and its own
 * reason for existing already covered the other two: Settings and Diagnostics
 * are reachable here because this menu is their only link site in the renderer
 * and Settings is the way back in — and a failed read is the case that needs the
 * way back in most. Disabling the trigger for Pending and Error took Settings,
 * Diagnostics, the theme and Log out with it and left a user on "Account
 * unavailable" with nowhere to go.
 *
 * PENDING GETS THE SAME TREATMENT, deliberately. A load that never settles
 * strands a user exactly as a failed one does, which this menu has already
 * shipped once — `useDesktopIdentity` reporting a lapsed session as
 * resolved-with-no-identity sat on "Loading" forever until ISS-10006's provider
 * fix. Every entry whose own read is still in flight already carries its own
 * `Pending` capability and withholds itself; nothing here has to wait for it.
 *
 * THIS MENU CANNOT OPEN ONTO NOTHING: `DestinationItems` renders `ThemeSubmenu`
 * unconditionally — a client-side preference with no identity behind it and no
 * capability to withhold it — so even a host that withholds every projected
 * entry still opens a menu with a working control in it. The "no menu behind the
 * trigger" case that justifies a disabled trigger survives in exactly one place,
 * and it is the one where there are no capabilities to ask: the adapter-less
 * mount in `workspace-menu.tsx`.
 */
export function ProjectedWorkspaceMenu({
  adapter,
  capabilities,
  onOpenChange,
  open,
  projection,
}: {
  adapter: WorkspaceMenuHostAdapter;
  capabilities: WorkspaceMenuCapabilities;
  onOpenChange: (next: boolean) => void;
  open: boolean;
  projection: WorkspaceMenuProjection;
}) {
  const canCreateAccount = isWorkspaceMenuEntryRendered(
    capabilities[WorkspaceMenuEntryId.CreateAccount]
  );
  const canSignIn = isWorkspaceMenuEntryRendered(
    capabilities[WorkspaceMenuEntryId.SignIn]
  );
  const { signOut, signOutFailed } = useSignOut(adapter);

  return (
    <WorkspaceMenuShell
      onOpenChange={onOpenChange}
      open={open}
      projection={projection}
    >
      {canSignIn && adapter.requestSignIn ? (
        <DropdownMenuItem
          className={ITEM_CLASSNAME}
          onSelect={adapter.requestSignIn}
        >
          {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.SignIn]}
        </DropdownMenuItem>
      ) : null}
      {canCreateAccount && adapter.requestAccount ? (
        <DropdownMenuItem
          className={ITEM_CLASSNAME}
          onSelect={adapter.requestAccount}
        >
          {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount]}
        </DropdownMenuItem>
      ) : null}
      {(canSignIn && adapter.requestSignIn) ||
      (canCreateAccount && adapter.requestAccount) ? (
        <DropdownMenuSeparator />
      ) : null}
      {/* Settings and Diagnostics stay reachable signed out: this menu is their
          only link site in the renderer, and Settings is the way back in.
          No invite controller, on any of the three projections: the dialog mints
          invitations against an organization id, and "there is no settled
          organization" is precisely what Guest, Pending and Error have in
          common — the same reason the capability builder withholds it from a
          guest. The HOSTS say so too rather than leaving that to this body:
          `toDesktopWorkspaceMenuCapabilities` narrows the entry to the standing,
          so no host projects Invite `Ready` into a menu that mounts no invite
          controller. */}
      <DestinationItems adapter={adapter} capabilities={capabilities} />

      {/* The download needs no identity — it is a public release URL, and the
          projection carries it on every standing for exactly this reason. A menu
          opened on a failed or unsettled read that dropped a link the host had
          already resolved would be claiming `Ready` and rendering nothing, which
          is the defect class this ticket exists to remove rather than repeat. */}
      <DownloadDesktopItem
        capabilities={capabilities}
        downloadUrl={projection.downloadUrl}
      />

      <SignOutItem
        capabilities={capabilities}
        signOut={signOut}
        signOutFailed={signOutFailed}
      />
    </WorkspaceMenuShell>
  );
}

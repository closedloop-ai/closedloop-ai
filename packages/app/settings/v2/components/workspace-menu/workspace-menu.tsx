"use client";

import {
  WORKSPACE_MENU_ENTRY_LABEL,
  type WorkspaceMenuCapabilities,
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuEntryId,
  type WorkspaceMenuProjection,
  WorkspaceMenuProjectionStatus,
  type WorkspaceMenuWorkspaceSummary,
} from "@repo/api/src/types/workspace-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { DropdownMenuSeparator } from "@repo/design-system/components/ui/dropdown-menu";
import { useCallback, useState } from "react";
import { useWorkspaceMenuHostAdapter } from "../../../../shared/workspace-menu-host/provider";
import type { WorkspaceMenuHostAdapter } from "../../../../shared/workspace-menu-host/workspace-menu-host-adapter";
import { WorkspaceMenuAccountLabel } from "./workspace-menu-account-label";
import { DownloadDesktopItem } from "./workspace-menu-download-item";
import {
  useWorkspaceMenuInvite,
  WorkspaceMenuInviteDialog,
} from "./workspace-menu-invite-item";
import {
  DestinationItems,
  ProjectedWorkspaceMenu,
  SignOutItem,
  WorkspaceMenuShell,
} from "./workspace-menu-projected";
import { useSignOut } from "./workspace-menu-sign-out";
import { WorkspaceMenuTrigger } from "./workspace-menu-trigger";
import {
  hasSwitcherSubmenu,
  WorkspaceSwitcherSubmenu,
} from "./workspace-switcher-submenu";

/**
 * ISS-8363 (PRD-691) — the workspace/account menu.
 *
 * ONE COMPONENT, ONE PRESENTATION, TWO ITEM SETS. The 2026-09-03 operator ruling
 * gives Web and Desktop the same placement and visual treatment and different
 * capabilities: Desktop omits Switch workspace, Create a workspace, and Download
 * desktop app completely, and keeps Diagnostics and the guest door. None of that
 * is decided here — the host adapter projects it and this renders what it is
 * given, so the two surfaces cannot drift into two different menus.
 *
 * It reads no feature flag. Which tree exists at all is chosen once at the
 * program root; a read here could disagree with that choice. The two entries
 * with a decision behind them keep that read in their own modules —
 * `workspace-menu-download-item.tsx` and `workspace-menu-invite-item.tsx` —
 * which is part of why they live there.
 *
 * MOUNT CONTRACT: the trigger is a `SidebarMenuButton`, so this needs a
 * `SidebarProvider` ancestor. The shell header slot already sits inside one, so
 * production is satisfied by construction — but a story, test, or future mount
 * site outside a sidebar must supply one or the render throws.
 */

function useMenuActions(
  adapter: WorkspaceMenuHostAdapter,
  activeWorkspaceId: string
) {
  const { signOut, signOutFailed } = useSignOut(adapter);

  const switchWorkspace = useCallback(
    (workspace: WorkspaceMenuWorkspaceSummary) => {
      // Radix fires `onSelect` for the already-checked radio item too. Without
      // this, re-picking the current workspace no-ops `setActive` and then
      // navigates to the landing route, throwing away wherever the user was.
      if (workspace.id === activeWorkspaceId) {
        return;
      }
      adapter.switchWorkspace?.(workspace).catch(() => undefined);
    },
    [activeWorkspaceId, adapter]
  );

  return { signOut, signOutFailed, switchWorkspace };
}

function ReadyWorkspaceMenu({
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
  projection: Extract<
    WorkspaceMenuProjection,
    { status: typeof WorkspaceMenuProjectionStatus.Ready }
  >;
}) {
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const invite = useWorkspaceMenuInvite(capabilities);
  const { signOut, signOutFailed, switchWorkspace } = useMenuActions(
    adapter,
    projection.activeWorkspace.id
  );

  return (
    <>
      <WorkspaceMenuShell
        onOpenChange={onOpenChange}
        open={open}
        projection={projection}
      >
        <DestinationItems
          adapter={adapter}
          capabilities={capabilities}
          invite={invite}
        />

        <DownloadDesktopItem
          capabilities={capabilities}
          downloadUrl={projection.downloadUrl}
        />

        <DropdownMenuSeparator />

        <WorkspaceSwitcherSubmenu
          activeWorkspaceId={projection.activeWorkspace.id}
          actor={projection.actor}
          capabilities={capabilities}
          onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
          onSwitchWorkspace={switchWorkspace}
          workspaces={projection.workspaces}
        />

        {/* The submenu carries the signed-in address when it renders; when it
            does not, this states it instead. Both branches read the SAME
            capability predicate the submenu uses — deciding this on
            `adapter.switchWorkspace` instead let a host with the method but
            neither capability Ready drop the address from both places. */}
        {hasSwitcherSubmenu(capabilities) ? null : (
          <WorkspaceMenuAccountLabel actor={projection.actor} />
        )}

        <SignOutItem
          capabilities={capabilities}
          signOut={signOut}
          signOutFailed={signOutFailed}
        />
      </WorkspaceMenuShell>

      <WorkspaceMenuInviteDialog invite={invite} />

      {adapter.createWorkspaceSlot ? (
        <Dialog
          onOpenChange={setCreateWorkspaceOpen}
          open={createWorkspaceOpen}
        >
          <DialogContent className="max-w-fit border-none bg-transparent p-0 shadow-none">
            <DialogHeader className="sr-only">
              <DialogTitle>
                {
                  WORKSPACE_MENU_ENTRY_LABEL[
                    WorkspaceMenuEntryId.CreateWorkspace
                  ]
                }
              </DialogTitle>
            </DialogHeader>
            {adapter.createWorkspaceSlot}
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function HostedWorkspaceMenu({
  adapter,
}: {
  adapter: WorkspaceMenuHostAdapter;
}) {
  // The menu owns its disclosure state so the adapter can gate the expensive
  // reads on it. Sitting in the sidebar header, this component renders on every
  // authenticated page load; without the gate, Clerk's membership pagination and
  // the release lookup both run for a dropdown nobody opened.
  const [open, setOpen] = useState(false);
  const projection = adapter.useWorkspaceMenuProjection({ open });
  const capabilities = adapter.useWorkspaceMenuCapabilities({ open });

  if (projection.status === WorkspaceMenuProjectionStatus.Ready) {
    return (
      <ReadyWorkspaceMenu
        adapter={adapter}
        capabilities={capabilities}
        onOpenChange={setOpen}
        open={open}
        projection={projection}
      />
    );
  }

  // Guest, Pending and Error, in one body. See `ProjectedWorkspaceMenu`: the
  // status picks the trigger's word and the capabilities pick the rows, so
  // there is nothing left for a third branch to decide.
  return (
    <ProjectedWorkspaceMenu
      adapter={adapter}
      capabilities={capabilities}
      onOpenChange={setOpen}
      open={open}
      projection={projection}
    />
  );
}

/**
 * The mount point. Renders an explicit unavailable trigger when no host adapter
 * is provided, rather than throwing (which would break every provider-less mount
 * site, Storybook included) or inventing a default identity.
 *
 * THE ONE DISABLED TRIGGER LEFT, and the only case that earns it: with no
 * adapter there is no capability projection to read and no hook to call, so
 * there is genuinely nothing to put behind the trigger. That is a different
 * thing from a MOUNTED host whose identity read failed, which still projects
 * Settings, Diagnostics, the theme and Log out — see `ProjectedWorkspaceMenu`.
 */
export function WorkspaceMenu() {
  const adapter = useWorkspaceMenuHostAdapter();

  if (!adapter) {
    return (
      <WorkspaceMenuTrigger
        disabled
        projection={{
          status: WorkspaceMenuProjectionStatus.Error,
          reason: WorkspaceMenuCapabilityReason.ReadFailed,
          downloadUrl: null,
        }}
      />
    );
  }

  return <HostedWorkspaceMenu adapter={adapter} />;
}

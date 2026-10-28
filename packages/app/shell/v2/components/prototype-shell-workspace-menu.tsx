"use client";

import {
  type WorkspaceMenuCapabilities,
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuEntryId,
  type WorkspaceMenuProjection,
  workspaceMenuCapabilityReady,
  workspaceMenuCapabilityUnavailable,
} from "@repo/api/src/types/workspace-menu";
// Cross-slice on purpose: settings owns the ONE account menu both shells
// render, and mounting the real component is the whole point of ISS-10391 —
// a shell-local copy is what went stale before.
import { WorkspaceMenu } from "@repo/app/settings/v2/components/workspace-menu/workspace-menu";
import { useMemo, useState } from "react";
import { WorkspaceMenuHostAdapterProvider } from "../../../shared/workspace-menu-host/provider";
import { buildWebWorkspaceMenuCapabilities } from "../../../shared/workspace-menu-host/workspace-menu-capabilities";
import type { WorkspaceMenuHostAdapter } from "../../../shared/workspace-menu-host/workspace-menu-host-adapter";
import {
  createWebWorkspaceMenuHostAdapterFixture,
  READY_WORKSPACE_MENU_PROJECTION,
} from "../../../shared/workspace-menu-host/workspace-menu-host-fixtures";

/**
 * The prototype shell's account area (ISS-10391): the REAL `WorkspaceMenu`,
 * fed a host adapter whose every offered entry has mock state behind it.
 *
 * An entry is offered here only when a click changes something the reader can
 * see, because the prototype rule is that mock data is inert but never a lie:
 *
 * - Switch workspace is `Ready` and genuinely stateful — `switchWorkspace`
 *   moves the active workspace, so the trigger's name and the submenu's radio
 *   check both follow the click.
 * - Create a workspace is `Unavailable`: web's slot is Clerk's
 *   `<CreateOrganization>` component, which this package may not import, so
 *   the entry would open an empty dialog. Absent beats inert.
 * - Log out is `Unavailable`: there is no session to end behind a prototype,
 *   and a menu row that resolves to nothing is the affordance lying.
 *
 * Both exclusions ride the canonical capability port — the same mechanism that
 * keeps Desktop's omissions out of this menu — rather than a second, shell-local
 * notion of which rows exist.
 */
const PROTOTYPE_WORKSPACE_MENU_CAPABILITIES: WorkspaceMenuCapabilities = {
  ...buildWebWorkspaceMenuCapabilities({
    download: workspaceMenuCapabilityReady(),
  }),
  [WorkspaceMenuEntryId.CreateWorkspace]: workspaceMenuCapabilityUnavailable(
    WorkspaceMenuCapabilityReason.NotSupportedOnHost
  ),
  [WorkspaceMenuEntryId.LogOut]: workspaceMenuCapabilityUnavailable(
    WorkspaceMenuCapabilityReason.NotSupportedOnHost
  ),
};

const PROTOTYPE_WORKSPACES = READY_WORKSPACE_MENU_PROJECTION.workspaces;

/**
 * The prototype account menu, provider and all. One export so a prototype
 * mounts the account area the way production does — the component, not a
 * hand-drawn copy of it.
 */
export function PrototypeShellWorkspaceMenu() {
  const adapter = usePrototypeWorkspaceMenuAdapter();

  return (
    <WorkspaceMenuHostAdapterProvider adapter={adapter}>
      <WorkspaceMenu />
    </WorkspaceMenuHostAdapterProvider>
  );
}

/**
 * The fixture adapter Storybook already uses, made stateful for the one action
 * this shell offers. `signOut` keeps the fixture's resolved no-op: the Log out
 * entry is `Unavailable` above, so the menu never reaches it.
 */
function usePrototypeWorkspaceMenuAdapter(): WorkspaceMenuHostAdapter {
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(
    READY_WORKSPACE_MENU_PROJECTION.activeWorkspace.id
  );

  return useMemo(() => {
    const projection: WorkspaceMenuProjection = {
      ...READY_WORKSPACE_MENU_PROJECTION,
      activeWorkspace:
        PROTOTYPE_WORKSPACES.find(
          (workspace) => workspace.id === activeWorkspaceId
        ) ?? READY_WORKSPACE_MENU_PROJECTION.activeWorkspace,
    };

    return createWebWorkspaceMenuHostAdapterFixture({
      // The fixture's default is a test-id placeholder, and the entry that
      // opens it is `Unavailable` here anyway.
      createWorkspaceSlot: undefined,
      switchWorkspace: (workspace) => {
        setActiveWorkspaceId(workspace.id);
        return Promise.resolve();
      },
      useWorkspaceMenuCapabilities: () => PROTOTYPE_WORKSPACE_MENU_CAPABILITIES,
      useWorkspaceMenuProjection: () => projection,
    });
  }, [activeWorkspaceId]);
}

"use client";

import { WorkspaceMenu } from "@repo/app/settings/v2/components/workspace-menu/workspace-menu";
import { WebWorkspaceMenuHostProvider } from "@/lib/workspace-menu-host/web-workspace-menu-host-provider";

/**
 * The web shell's workspace-header node (ISS-8370 D7): the workspace/account
 * menu with its host port mounted around it, and nothing else. The provider
 * runs Clerk hooks, so it mounts HERE — inside the v2 branch of the sidebar's
 * v2 workspace tree.
 *
 * Exported as one node so the v2 `ShellSidebar` can take the identical
 * component as its `workspaceHeader` slot when the shell track mounts it: one
 * component, two hosts, no fork.
 */
export function WorkspaceHeader() {
  return (
    <WebWorkspaceMenuHostProvider>
      <WorkspaceMenu />
    </WebWorkspaceMenuHostProvider>
  );
}

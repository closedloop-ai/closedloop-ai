import { WorkspaceMenu } from "@repo/app/settings/v2/components/workspace-menu/workspace-menu";
import { DesktopWorkspaceMenuHostProvider } from "../../workspace-menu-host/desktop-workspace-menu-host-provider";

/**
 * The desktop shell's workspace-header node (ISS-8370 D7): the workspace/account
 * menu with its host port mounted around it, and nothing else. The provider
 * composes the identity, guest and sign-out reads, so it mounts HERE — inside
 * the sidebar's workspace chrome,
 * which renders none of this.
 *
 * Exported as one node so the v2 `ShellSidebar` can take the identical
 * component as its `workspaceHeader` slot when the shell track mounts it
 * (ISS-9734): one component, two hosts, no fork.
 */
export function WorkspaceHeader() {
  return (
    <DesktopWorkspaceMenuHostProvider>
      <WorkspaceMenu />
    </DesktopWorkspaceMenuHostProvider>
  );
}

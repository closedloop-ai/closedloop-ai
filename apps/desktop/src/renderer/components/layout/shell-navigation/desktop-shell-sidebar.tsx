import { ShellSidebar } from "@repo/app/shell/v2/components/shell-sidebar";
import type { NavId } from "../../../navigation/route-table";
import { DESKTOP_SHELL_V2_SECTION_PERSISTENCE_KEY_PREFIX } from "../sidebar-persistence";
import { SidebarMacDragStrip } from "../sidebar-shared-items";
import { DesktopWorkspaceHeaderSlot } from "../workspace-header-slot";
import { useDesktopShellNavigation } from "./use-desktop-shell-navigation";

type DesktopShellSidebarProps = {
  readonly activeNav: NavId;
  readonly hiddenNavIds?: readonly NavId[];
};

/**
 * The desktop mount of the shared v2 sidebar (ISS-9734, PLN-2016 M3).
 *
 * Renders `ShellSidebar` — which brings its own sidebar ROOT — so this component
 * replaces the host's `<SidebarRoot>` rather than rendering inside it. Nesting
 * one sidebar root in another also nests a Sheet in a Sheet below the `md`
 * breakpoint, which is why the branch above it is at the root and not deeper.
 *
 * Collapse is unchanged: `collapsible="offcanvas"` is the design-system default
 * the legacy tree sets explicitly, so the composite's bare `Sidebar` inherits
 * the same behaviour.
 *
 * The workspace menu is passed as the inner header node, not pre-wrapped: the
 * composite applies the `SidebarHeader` wrapping itself, and the node it lands
 * in is the `SidebarMenuItem` ISS-10362's spotlight anchor has to sit inside.
 */
export function DesktopShellSidebar({
  activeNav,
  hiddenNavIds,
}: DesktopShellSidebarProps) {
  const { activePath, footer, renderControl, renderIcon, sections } =
    useDesktopShellNavigation({ activeNav, hiddenNavIds });

  return (
    <ShellSidebar
      activePath={activePath}
      footer={footer}
      leading={<SidebarMacDragStrip />}
      renderControl={renderControl}
      renderIcon={renderIcon}
      sectionPersistenceKeyPrefix={
        DESKTOP_SHELL_V2_SECTION_PERSISTENCE_KEY_PREFIX
      }
      sections={sections}
      workspaceHeader={<DesktopWorkspaceHeaderSlot />}
    />
  );
}

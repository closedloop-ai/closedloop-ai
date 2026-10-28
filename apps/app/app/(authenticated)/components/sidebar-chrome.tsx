"use client";

import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@repo/design-system/components/ui/sidebar";
import type { ReactNode } from "react";
import { WorkspaceHeader } from "./workspace-header";

type SidebarChromeProps = {
  readonly children: ReactNode;
  readonly envBadge: string | null;
  /** Footer content that is not a menu row, rendered above shared footer rows. */
  readonly footerLead?: ReactNode;
  /** Header content above the navigation; null renders no header at all. */
  readonly header: ReactNode;
  /** Footer rows after the env badge. */
  readonly footerEntries: ReactNode;
};

/**
 * The parts of the sidebar around the navigation: header, then the nav the
 * caller passes as children, then the footer. Both trees the sidebar's root
 * selector chooses between compose this with a different header and a
 * different footer tail, so the two cannot drift on the rows they share.
 */
export function SidebarChrome({
  children,
  envBadge,
  footerLead = null,
  header,
  footerEntries,
}: SidebarChromeProps) {
  return (
    <>
      {header}
      {children}
      <SidebarFooter>
        {footerLead}
        <SidebarMenu>
          <SidebarEnvBadge envBadge={envBadge} />
          {footerEntries}
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

/**
 * The local-dev environment badge row, or nothing when there is no badge.
 *
 * Extracted from the footer above (PLN-2016 M2) because both sidebar arms are
 * live at once while `shell-sidebar-v2` rolls out, and the v2 footer has to
 * render this exact node rather than a second copy of the markup. The badge
 * names which API origin the shell is talking to, so two copies free to drift
 * is two answers to that question.
 */
export function SidebarEnvBadge({
  envBadge,
}: {
  readonly envBadge: string | null;
}) {
  if (!envBadge) {
    return null;
  }
  return (
    <SidebarMenuItem data-testid={SIDEBAR_ENV_BADGE_TEST_ID}>
      <div className="w-full rounded border border-warning/30 bg-warning/12 px-2 py-1.5">
        <div className="mb-0.5 flex items-center gap-1.5">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-warning" />
          <span className="font-bold font-mono text-[9px] text-warning-foreground uppercase tracking-wider">
            local
          </span>
        </div>
        <p
          className="truncate font-mono text-[9px] text-warning-foreground/60 leading-tight"
          title={envBadge}
        >
          {envBadge}
        </p>
      </div>
    </SidebarMenuItem>
  );
}

/**
 * The v2 header (ISS-8370 D7): the workspace menu at the top of navigation,
 * wrapped the way `packages/app/shell/v2/components/shell-sidebar.tsx` wraps
 * its `workspaceHeader` slot, so the node lands in the same place when the
 * shell track mounts that sidebar.
 *
 * Kept for the `shell-sidebar-v2` OFF arm. The on arm passes the inner
 * `WorkspaceHeader` node into `ShellSidebar`'s `workspaceHeader` slot, which
 * applies this same wrapping itself — one mount of the menu, never two.
 */
export function WorkspaceSidebarHeader() {
  return (
    <SidebarHeader className="pb-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <WorkspaceHeader />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
  );
}

/** The badge's e2e hook: the web route matrix leaves this dev-only row out of its sidebar sweep. */
const SIDEBAR_ENV_BADGE_TEST_ID = "sidebar-env-badge";

"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@repo/design-system/components/ui/sidebar";
import { cn } from "@repo/design-system/lib/utils";
import { PanelLeftClose, PanelLeftOpen, RefreshCwIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { DesktopSidebar } from "./desktop-sidebar";

export type Crumb = {
  label: string;
  isCurrent?: boolean;
};

type DesktopShellProps = {
  readonly breadcrumbs: readonly Crumb[];
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  /** Show the blue "New version available" update strip. Defaults to true. */
  readonly showUpdateBanner?: boolean;
};

/**
 * Desktop counterpart to the Web UI Kit's AppShell. Fills the viewport like the
 * Electron window itself — the `inset` sidebar (stoplights + drag strip live in
 * it), the topbar breadcrumb, and the auto-update banner frame a single flush
 * content area. Drop any web-prototype content in as children to get its
 * desktop equivalent. No outer window chrome: the browser tab IS the window, so
 * it never reads as an app nested inside another app.
 */
export const DesktopShell = ({
  breadcrumbs,
  actions,
  children,
  showUpdateBanner = true,
}: DesktopShellProps) => (
  <SidebarProvider className="h-svh overflow-hidden bg-sidebar">
    <DesktopSidebar />
    <SidebarInset className="min-w-0 overflow-hidden">
      <DesktopTopbar actions={actions} breadcrumbs={breadcrumbs} />
      {showUpdateBanner ? <UpdateBanner /> : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </SidebarInset>
  </SidebarProvider>
);

const DesktopTopbar = ({
  breadcrumbs,
  actions,
}: {
  breadcrumbs: readonly Crumb[];
  actions?: ReactNode;
}) => {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <header className="flex h-[42px] shrink-0 items-center justify-between gap-3 border-border border-b px-3">
      <div className="flex min-w-0 items-center gap-3">
        <Button
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="text-muted-foreground"
          onClick={toggleSidebar}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </Button>
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-2 text-sm"
        >
          {breadcrumbs.map((crumb, index) => (
            <Fragment key={crumb.label}>
              {index > 0 ? (
                <span className="shrink-0 text-muted-foreground">/</span>
              ) : null}
              <span
                aria-current={crumb.isCurrent ? "page" : undefined}
                className={cn(
                  "truncate",
                  crumb.isCurrent
                    ? "font-medium text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {crumb.label}
              </span>
            </Fragment>
          ))}
        </nav>
      </div>
      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
};

// Static mirror of the desktop auto-update banner's "ready to relaunch" state.
// ISS-5367: a tinted status strip with a discrete Relaunch button on a centered
// line, NOT a full-bleed solid-primary slab that is itself the click target —
// this file is a design reference, so mirroring the shape production dropped
// would keep handing the defect back to whoever reads it next.
const UpdateBanner = () => (
  <div
    className="flex shrink-0 items-center justify-center gap-3 border-b bg-primary/10 px-4 py-2 text-foreground text-sm"
    role="status"
  >
    <span className="min-w-0 truncate font-medium">
      A new version is available.
    </span>
    <Button size="sm" type="button">
      <RefreshCwIcon aria-hidden="true" />
      Relaunch
    </Button>
  </div>
);

"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@repo/design-system/components/ui/breadcrumb";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import type { ReactNode } from "react";
import { AppSidebar } from "./app-sidebar";

type AppShellProps = {
  readonly actions?: ReactNode;
  readonly children: ReactNode;
};

// The /search results page sits under a single "Search" breadcrumb, matching
// the production Header. There is no nested crumb - the query bar is the
// navigation within this surface.
export const AppShell = ({ actions, children }: AppShellProps) => (
  <SidebarProvider className="h-svh">
    <AppSidebar />
    <SidebarInset>
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-border border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="-ml-1 text-muted-foreground" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Search</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        {actions ? (
          <div className="flex items-center gap-2">{actions}</div>
        ) : null}
      </header>
      {/* SidebarInset already renders the page's single <main> landmark, so the
          content region is a plain <div> to avoid a nested-main a11y violation. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </SidebarInset>
  </SidebarProvider>
);

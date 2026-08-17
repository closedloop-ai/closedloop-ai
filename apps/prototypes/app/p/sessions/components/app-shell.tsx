"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import { Fragment, type ReactNode } from "react";
import { AppSidebar } from "./app-sidebar";

export type Crumb = {
  label: string;
  isCurrent?: boolean;
  onSelect?: () => void;
};

type AppShellProps = {
  readonly breadcrumbs: readonly Crumb[];
  /** Control rendered left-aligned, immediately after the breadcrumb. */
  readonly leadingAction?: ReactNode;
  /** Controls rendered at the far right of the top application bar. */
  readonly actions?: ReactNode;
  readonly topBanner?: ReactNode;
  readonly children: ReactNode;
};

export const AppShell = ({
  breadcrumbs,
  leadingAction,
  actions,
  topBanner,
  children,
}: AppShellProps) => (
  <SidebarProvider className="h-svh">
    <AppSidebar />
    <SidebarInset>
      {topBanner ? (
        <div className="shrink-0 border-b p-3">{topBanner}</div>
      ) : null}
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-border border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="-ml-1 text-muted-foreground" />
          <Breadcrumb>
            <BreadcrumbList>
              {breadcrumbs.map((crumb, index) => (
                <Fragment key={crumb.label}>
                  <BreadcrumbItem>
                    {crumb.isCurrent || !crumb.onSelect ? (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <button
                          className="cursor-pointer"
                          onClick={crumb.onSelect}
                          type="button"
                        >
                          {crumb.label}
                        </button>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                  {index < breadcrumbs.length - 1 ? (
                    <BreadcrumbSeparator />
                  ) : null}
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          {leadingAction ? (
            <div className="flex shrink-0 items-center">{leadingAction}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center">{actions}</div>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </SidebarInset>
  </SidebarProvider>
);

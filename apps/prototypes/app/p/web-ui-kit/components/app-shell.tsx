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
};

type AppShellProps = {
  readonly breadcrumbs: readonly Crumb[];
  readonly actions?: ReactNode;
  readonly children: ReactNode;
};

export const AppShell = ({ breadcrumbs, actions, children }: AppShellProps) => (
  <SidebarProvider className="h-svh">
    <AppSidebar />
    <SidebarInset>
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-border border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="-ml-1 text-muted-foreground" />
          <Breadcrumb>
            <BreadcrumbList>
              {breadcrumbs.map((crumb, index) => (
                <Fragment key={crumb.label}>
                  <BreadcrumbItem>
                    {crumb.isCurrent ? (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink>{crumb.label}</BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                  {index < breadcrumbs.length - 1 ? (
                    <BreadcrumbSeparator />
                  ) : null}
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        {actions ? (
          <div className="flex items-center gap-2">{actions}</div>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </SidebarInset>
  </SidebarProvider>
);

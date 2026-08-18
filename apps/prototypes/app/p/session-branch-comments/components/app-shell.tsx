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
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly navigation?: ReactNode;
};

export const AppShell = ({
  breadcrumbs,
  actions,
  children,
  navigation,
}: AppShellProps) => (
  <SidebarProvider className="h-svh">
    <AppSidebar />
    <SidebarInset>
      <header
        className={`flex h-12 shrink-0 items-center justify-between gap-4 px-4 ${
          navigation ? "" : "border-border border-b"
        }`}
      >
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
        </div>
        {actions ? (
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        ) : null}
      </header>
      {navigation}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </SidebarInset>
  </SidebarProvider>
);

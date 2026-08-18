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
  onClick?: () => void;
};

const CrumbContent = ({ crumb }: { crumb: Crumb }) => {
  if (crumb.isCurrent) {
    return <BreadcrumbPage>{crumb.label}</BreadcrumbPage>;
  }
  // A clickable crumb renders as a real button so it stays keyboard-operable,
  // matching the accessible pattern used for the sidebar's Packs nav item.
  if (crumb.onClick) {
    return (
      <BreadcrumbLink asChild className="cursor-pointer">
        <button onClick={crumb.onClick} type="button">
          {crumb.label}
        </button>
      </BreadcrumbLink>
    );
  }
  return <BreadcrumbLink>{crumb.label}</BreadcrumbLink>;
};

type AppShellProps = {
  readonly breadcrumbs: readonly Crumb[];
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly onNavigatePacks?: () => void;
};

export const AppShell = ({
  breadcrumbs,
  actions,
  children,
  onNavigatePacks,
}: AppShellProps) => (
  <SidebarProvider className="h-svh">
    <AppSidebar onNavigatePacks={onNavigatePacks} />
    <SidebarInset>
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-border border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="-ml-1 text-muted-foreground" />
          <Breadcrumb>
            <BreadcrumbList>
              {breadcrumbs.map((crumb, index) => (
                <Fragment key={crumb.label}>
                  <BreadcrumbItem>
                    <CrumbContent crumb={crumb} />
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
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </SidebarInset>
  </SidebarProvider>
);

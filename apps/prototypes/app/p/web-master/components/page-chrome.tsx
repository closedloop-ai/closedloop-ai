"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import { Fragment, type ReactNode } from "react";

// Per-page header + content frame rendered inside the master layout's
// SidebarInset. Union of the blessed Sessions and Branches AppShell headers:
// Sessions contributes leadingAction, Branches contributes the navigation
// slot (underline tabs row that takes over the bottom border). This is a
// copy, not an import — if a blessed AppShell header changes, this file has
// to be updated by hand to stay faithful.

export type Crumb = {
  label: string;
  isCurrent?: boolean;
  onSelect?: () => void;
};

type PageChromeProps = {
  readonly breadcrumbs: readonly Crumb[];
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  /** Control rendered left-aligned, immediately after the breadcrumb. */
  readonly leadingAction?: ReactNode;
  readonly navigation?: ReactNode;
};

export const PageChrome = ({
  breadcrumbs,
  actions,
  children,
  leadingAction,
  navigation,
}: PageChromeProps) => (
  <>
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
        {leadingAction ? (
          <div className="flex shrink-0 items-center">{leadingAction}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </header>
    {navigation}
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {children}
    </div>
  </>
);

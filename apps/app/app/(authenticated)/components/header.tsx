import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import { cn } from "@repo/design-system/lib/utils";
import { Fragment, type ReactNode } from "react";

export type BreadcrumbEntry = {
  label: string;
  href?: string;
};

type HeaderProps = {
  breadcrumbs: BreadcrumbEntry[];
  afterBreadcrumbs?: ReactNode;
  /**
   * Ellipsis / "more" menu pinned to the left cluster, immediately after the
   * favorite button (`afterBreadcrumbs`) — or directly after the breadcrumb
   * when there is no favorite. Page-level overflow actions go here, not in
   * `children` (which stays on the right for primary actions).
   */
  moreMenu?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export const Header = ({
  breadcrumbs,
  afterBreadcrumbs,
  moreMenu,
  children,
  className,
}: HeaderProps) => (
  <header
    className={cn(
      "flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2",
      className
    )}
  >
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <SidebarTrigger className="-ml-1 shrink-0" />
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          {breadcrumbs.map((entry, index) => {
            const isLast = index === breadcrumbs.length - 1;
            return (
              <Fragment key={entry.href ?? entry.label}>
                {index > 0 && (
                  <BreadcrumbSeparator className="hidden shrink-0 md:block" />
                )}
                <BreadcrumbItem
                  className={
                    isLast ? "min-w-0 flex-1" : "hidden shrink-0 md:block"
                  }
                >
                  {isLast || !entry.href ? (
                    <BreadcrumbPage
                      className={isLast ? "block truncate" : undefined}
                      title={isLast ? entry.label : undefined}
                    >
                      {entry.label}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink href={entry.href}>
                      {entry.label}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      {afterBreadcrumbs || moreMenu ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {afterBreadcrumbs}
          {moreMenu}
        </div>
      ) : null}
    </div>
    {children ? (
      <div className="flex items-center gap-2">{children}</div>
    ) : null}
  </header>
);

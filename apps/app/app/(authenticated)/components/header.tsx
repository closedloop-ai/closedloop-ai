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

type BreadcrumbEntry = {
  label: string;
  href?: string;
};

type HeaderProps = {
  breadcrumbs: BreadcrumbEntry[];
  afterBreadcrumbs?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export const Header = ({
  breadcrumbs,
  afterBreadcrumbs,
  children,
  className,
}: HeaderProps) => (
  <header
    className={cn(
      "flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2",
      className
    )}
  >
    <div className="flex items-center gap-2">
      <SidebarTrigger className="-ml-1" />
      <Breadcrumb>
        <BreadcrumbList>
          {breadcrumbs.map((entry, index) => {
            const isLast = index === breadcrumbs.length - 1;
            return (
              <Fragment key={`${entry.label}-${index}`}>
                {index > 0 && (
                  <BreadcrumbSeparator className="hidden md:block" />
                )}
                <BreadcrumbItem
                  className={isLast ? undefined : "hidden md:block"}
                >
                  {isLast || !entry.href ? (
                    <BreadcrumbPage>{entry.label}</BreadcrumbPage>
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
      {afterBreadcrumbs}
    </div>
    {children ? (
      <div className="flex items-center gap-2">{children}</div>
    ) : null}
  </header>
);

export type { BreadcrumbEntry };

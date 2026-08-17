"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";

// A local, self-contained shell for the my-machines prototype. Each prototype
// stays inside its own app/p/<slug> folder, so this does NOT reach into the packs
// slug's AppShell. My Machines is a pack-detail sub-view; a breadcrumb header is
// the only chrome it needs, so this shell is deliberately sidebar-free.

export type Crumb = {
  label: string;
  // Destination for a non-current crumb. Omit it for a crumb whose parent screen
  // isn't part of this prototype sandbox — that crumb renders as plain, inert
  // text (not a styled link that goes nowhere and isn't keyboard-reachable).
  href?: string;
  isCurrent?: boolean;
};

const CrumbContent = ({ crumb }: { crumb: Crumb }) => {
  if (crumb.isCurrent) {
    return <BreadcrumbPage>{crumb.label}</BreadcrumbPage>;
  }
  if (crumb.href) {
    return (
      <BreadcrumbLink asChild>
        <Link href={crumb.href}>{crumb.label}</Link>
      </BreadcrumbLink>
    );
  }
  return <span className="text-muted-foreground">{crumb.label}</span>;
};

type MachinesShellProps = {
  readonly breadcrumbs: readonly Crumb[];
  readonly actions?: ReactNode;
  readonly children: ReactNode;
};

export const MachinesShell = ({
  breadcrumbs,
  actions,
  children,
}: MachinesShellProps) => (
  <div className="flex h-svh flex-col bg-background">
    <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-border border-b px-4">
      <Breadcrumb>
        <BreadcrumbList>
          {breadcrumbs.map((crumb, index) => (
            <Fragment key={crumb.label}>
              <BreadcrumbItem>
                <CrumbContent crumb={crumb} />
              </BreadcrumbItem>
              {index < breadcrumbs.length - 1 ? <BreadcrumbSeparator /> : null}
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
  </div>
);

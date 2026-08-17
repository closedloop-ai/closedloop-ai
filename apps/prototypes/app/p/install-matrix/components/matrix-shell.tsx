"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { Fragment, type ReactNode } from "react";

// A local, self-contained shell for the install-matrix prototype. Each prototype
// stays inside its own app/p/<slug> folder (see apps/prototypes/README.md), so
// this does NOT reach into the packs slug's AppShell/AppSidebar. The install
// matrix is a component-detail view; the breadcrumb header is the only chrome it
// needs, so this shell is deliberately sidebar-free rather than dragging an
// unrelated slug's navigation in.

export type Crumb = {
  label: string;
  isCurrent?: boolean;
};

const CrumbContent = ({ crumb }: { crumb: Crumb }) => {
  if (crumb.isCurrent) {
    return <BreadcrumbPage>{crumb.label}</BreadcrumbPage>;
  }
  return <BreadcrumbLink>{crumb.label}</BreadcrumbLink>;
};

type MatrixShellProps = {
  readonly breadcrumbs: readonly Crumb[];
  readonly actions?: ReactNode;
  readonly children: ReactNode;
};

export const MatrixShell = ({
  breadcrumbs,
  actions,
  children,
}: MatrixShellProps) => (
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

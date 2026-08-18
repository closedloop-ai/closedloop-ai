"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@repo/design-system/components/ui/breadcrumb";
import type { ReactNode } from "react";

// Minimal page chrome for the prototype: a header with the current-page
// breadcrumb and a slot for the viewer/state controls, then the page's
// `<main>`. The full product sidebar is out of scope for this screen's design
// question (admin manage-first vs member by-source), so it's intentionally
// omitted to keep the two treatments the focus of the review.
type AppShellProps = {
  readonly title: string;
  readonly controls?: ReactNode;
  readonly children: ReactNode;
};

export const AppShell = ({ title, controls, children }: AppShellProps) => (
  <div className="flex h-svh flex-col bg-background">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-border border-b px-6 py-3">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage className="font-medium text-base">
              {title}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      {controls ? (
        <div className="flex flex-wrap items-center gap-3">{controls}</div>
      ) : null}
    </header>
    <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
  </div>
);

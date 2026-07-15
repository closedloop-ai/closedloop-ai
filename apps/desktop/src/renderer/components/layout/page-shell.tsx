import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import type { ReactNode } from "react";

// Shared styling for every desktop metric/KPI card — the dashboard stats row
// plus the Sessions/Branches/Analytics/PRs/CoreFeatures summary cards. The one
// deliberate tweak is bumping the headline value to `text-3xl`; applied here so
// every card matches.
//
// NOTE: `@repo/app/insights/components/overview/dashboard-card` holds the
// canonical copy of this primitive for the shared web dashboard + row renderer.
// We deliberately keep a local copy here rather than re-exporting it: this file
// is loaded by desktop node `--test` suites (e.g. catalog-card-keyboard) whose
// loader can't statically re-export named bindings across the `@repo/app`
// package boundary (CJS interop). Keeping page-shell free of `@repo/app` imports
// keeps those tests green. The two copies are intentionally identical.
export const DASHBOARD_METRIC_CARD_CLASS_NAME =
  "h-full [&_[data-slot='card-title']]:text-3xl";

export const DASHBOARD_GRID_CLASS_NAME =
  "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4";

export const DASHBOARD_TABLE_CLASS_NAME =
  "w-full border-separate border-spacing-0 text-sm";

export function cx(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

export function PageShell({
  title,
  description,
  children,
  fullWidth = false,
  actions,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  /**
   * Span the full content area instead of the centered `max-w-[1500px]`
   * column, and use a 16px horizontal gutter (`px-4`) rather than `p-6`. Used
   * by the table-led Sessions/Branches views so their cards sit at a 16px
   * gutter while a child table can break out (`-mx-4`) to touch the edges —
   * matching the web `/sessions` and `/branches` pages.
   */
  fullWidth?: boolean;
  /**
   * Optional header content rendered on the same row as the title, aligned to
   * the right (e.g. status chips, a Tour button). Wraps below on narrow widths.
   */
  actions?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex w-full flex-col gap-6",
        fullWidth ? "px-4 py-6" : "mx-auto max-w-[1500px] p-6"
      )}
    >
      {title || description || actions ? (
        <section className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            {title ? (
              <h1 className="font-semibold text-[1.75rem] text-[var(--foreground)] tracking-tight">
                {title}
              </h1>
            ) : null}
            {description ? (
              <p className="text-[var(--muted-foreground)] text-sm">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center gap-3">{actions}</div>
          ) : null}
        </section>
      ) : null}
      {children}
    </div>
  );
}

// Canonical copy lives in @repo/app/insights/components/overview/dashboard-card;
// kept local here on purpose — see the note on DASHBOARD_METRIC_CARD_CLASS_NAME.
export function DashboardCard({
  title,
  description,
  children,
  className,
  contentClassName,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card
      className={cx(
        "min-w-0 rounded-[1.25rem] border-border bg-card",
        className
      )}
    >
      {title ? (
        <CardHeader className="px-4 sm:px-6">
          <CardTitle className="min-w-0 font-semibold text-xl tracking-tight">
            {title}
          </CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </CardHeader>
      ) : null}
      <CardContent className={cx("min-w-0 px-4 sm:px-6", contentClassName)}>
        {children}
      </CardContent>
    </Card>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-[var(--muted-foreground)] text-sm">
        Loading {label}...
      </p>
    </div>
  );
}

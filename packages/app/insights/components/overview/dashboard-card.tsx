import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

// Shared styling for every overview metric/KPI card — the dashboard stats row
// plus the Sessions/Branches/Analytics/PRs/CoreFeatures summary cards. Built on
// the design-system `MetricCard`'s native metric-on-top spacing. The one
// deliberate tweak is bumping the headline value to `text-3xl`; applied here so
// every card matches.
export const DASHBOARD_METRIC_CARD_CLASS_NAME =
  "h-full [&_[data-slot='card-title']]:text-3xl";

/**
 * The framed card used by the overview dashboard's chart rows (Event Activity,
 * Model Usage, Autonomy, …) and the Recent Sessions panel. A thin wrapper over
 * the design-system `Card` with rounded corners, a consistent 24px gutter, and
 * an optional title/description header.
 */
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
      className={cn(
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
      <CardContent className={cn("min-w-0 px-4 sm:px-6", contentClassName)}>
        {children}
      </CardContent>
    </Card>
  );
}

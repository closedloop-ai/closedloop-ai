import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

// A framed chart/panel widget for the profile page. Mirrors the Insights overview
// `DashboardCard` header rhythm (text-xl title, text-sm description, 24px
// gutter) on the plain design-system Card. The production DashboardCard also
// wires an expand-to-fullscreen modal via the insights ExpandableWidget; that
// lives in @repo/app (off-limits to a prototype), so this presentational stand-in
// carries only the visual treatment the design review needs to sign off on.

export function WidgetCard({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("min-w-0 border-border bg-card", className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 px-4 sm:px-6">
        <div className="min-w-0 space-y-2">
          <CardTitle className="min-w-0 font-semibold text-xl tracking-tight">
            {title}
          </CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </CardHeader>
      <CardContent className="min-w-0 px-4 sm:px-6">{children}</CardContent>
    </Card>
  );
}

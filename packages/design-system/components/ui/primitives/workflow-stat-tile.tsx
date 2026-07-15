import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { formatMetricValue } from "@closedloop-ai/design-system/components/ui/primitives/format-metric-value";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";

type WorkflowStatTileProps = {
  label: string;
  value: string | number;
  description?: string;
  eyebrow?: string;
  meta?: ReactNode;
  className?: string;
};

export function WorkflowStatTile({
  label,
  value,
  description,
  eyebrow,
  meta,
  className,
}: WorkflowStatTileProps) {
  return (
    <Card className={cn("border-border/80 bg-card/95 shadow-sm", className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div className="space-y-1">
          {eyebrow ? (
            <Badge
              className="rounded-md px-1.5 py-0.5 text-[10px]"
              variant="muted"
            >
              {eyebrow}
            </Badge>
          ) : null}
          <CardDescription className="font-semibold text-[11px] uppercase tracking-[0.12em]">
            {label}
          </CardDescription>
          <CardTitle className="font-semibold text-2xl tracking-tight">
            {formatMetricValue(value)}
          </CardTitle>
        </div>
      </CardHeader>
      {description || meta ? (
        <CardContent className="flex items-end justify-between gap-3 pt-0">
          {description ? (
            <p className="text-muted-foreground text-sm">{description}</p>
          ) : (
            <span />
          )}
          {meta}
        </CardContent>
      ) : null}
    </Card>
  );
}

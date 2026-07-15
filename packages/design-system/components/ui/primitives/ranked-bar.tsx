import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Progress } from "@closedloop-ai/design-system/components/ui/progress";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";

type RankedBarProps = {
  label: ReactNode;
  value: string | number;
  percent: number;
  description?: ReactNode;
  badge?: ReactNode;
  className?: string;
};

export function RankedBar({
  label,
  value,
  percent,
  description,
  badge,
  className,
}: RankedBarProps) {
  return (
    <div
      className={cn(
        "space-y-2 rounded-xl border border-border/80 bg-muted/25 p-3",
        className
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{label}</span>
            {badge}
          </div>
          {description ? (
            <div className="text-muted-foreground text-xs">{description}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-right">
          <span className="font-semibold text-sm">{value}</span>
          <Badge variant="muted">
            {percent.toFixed(percent >= 10 ? 0 : 1)}%
          </Badge>
        </div>
      </div>
      <Progress value={percent} />
    </div>
  );
}

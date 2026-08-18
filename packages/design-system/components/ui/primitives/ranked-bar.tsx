import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";

type RankedBarProps = {
  label: ReactNode;
  value: string | number;
  percent: number;
  description?: ReactNode;
  badge?: ReactNode;
  className?: string;
  presentation?: RankedBarPresentation;
  showPercent?: boolean;
};

export function RankedBar({
  label,
  value,
  percent,
  description,
  badge,
  className,
  presentation = RankedBarPresentation.Framed,
  showPercent = true,
}: RankedBarProps) {
  const normalizedPercent = clampPercent(percent);

  return (
    <div
      className={cn(
        "space-y-2",
        rankedBarPresentationClassNames[presentation],
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
          <span className="whitespace-nowrap font-semibold text-sm tabular-nums">
            {value}
          </span>
          {showPercent ? (
            <Badge variant="muted">
              {formatPercent(normalizedPercent)}%
            </Badge>
          ) : null}
        </div>
      </div>
      <div
        aria-hidden="true"
        className="h-2 w-full overflow-hidden rounded-full bg-primary/20"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${normalizedPercent}%` }}
        />
      </div>
    </div>
  );
}

export const RankedBarPresentation = {
  Framed: "framed",
  Flat: "flat",
} as const;

export type RankedBarPresentation =
  (typeof RankedBarPresentation)[keyof typeof RankedBarPresentation];

const rankedBarPresentationClassNames: Record<RankedBarPresentation, string> = {
  [RankedBarPresentation.Framed]:
    "rounded-xl border border-border/80 bg-muted/25 p-3",
  [RankedBarPresentation.Flat]: "",
};

function clampPercent(percent: number) {
  if (!Number.isFinite(percent)) {
    return 0;
  }

  return Math.min(100, Math.max(0, percent));
}

function formatPercent(percent: number) {
  return percent.toFixed(percent >= 10 ? 0 : 1);
}

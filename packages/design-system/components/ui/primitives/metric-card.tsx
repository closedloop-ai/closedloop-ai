import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { formatMetricValue } from "@repo/design-system/components/ui/primitives/format-metric-value";
import { Sparkline } from "@repo/design-system/components/ui/primitives/sparkline";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import type { LucideIcon } from "lucide-react";
import {
  InfoIcon,
  MinusIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

type MetricCardProps = {
  label: string;
  value: string | number;
  detail?: ReactNode;
  trend?: ReactNode;
  icon?: LucideIcon;
  className?: string;
  /** Short explainer rendered in a tooltip beside the label. */
  info?: { what: string; how?: string };
  /**
   * Period-over-period change. A number renders a signed up/down chip; pass
   * `"unknown"` to render a neutral placeholder chip when no comparison data
   * is available yet.
   */
  delta?: number | "unknown";
  /** Caption beside the delta chip (e.g. "vs. prior 90 days"). */
  deltaLabel?: ReactNode;
  /**
   * Recent values for the metric. When provided (and the delta is a number),
   * the delta chip renders a real sparkline of the trend instead of a static
   * up/down icon. Falls back to the icon when fewer than two points exist.
   */
  sparkline?: Array<number | null | undefined>;
  /**
   * Renders the card at reduced opacity with a "Sample" badge to flag that its
   * value is placeholder data pending real backend wiring.
   */
  placeholder?: boolean;
} & ComponentProps<typeof Card>;

export function MetricCard({
  label,
  value,
  detail,
  trend,
  icon: Icon,
  className,
  info,
  delta,
  deltaLabel,
  sparkline,
  placeholder = false,
  ...props
}: MetricCardProps) {
  // Hide the delta chip entirely when the trend is unknown (no baseline) instead
  // of rendering a "— Unknown" placeholder beside it.
  const showDelta = delta !== undefined && delta !== "unknown";
  const hasFooter = Boolean(detail) || Boolean(trend) || showDelta;

  return (
    <Card
      className={cn(
        "border-border bg-card",
        placeholder && "opacity-50",
        className
      )}
      {...props}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div className="space-y-1">
          <CardDescription className="flex items-center gap-1.5 font-semibold text-[11px] uppercase tracking-[0.12em]">
            {label}
            {info ? <MetricInfoTooltip info={info} label={label} /> : null}
          </CardDescription>
          <CardTitle className="font-semibold text-2xl tracking-tight">
            {formatMetricValue(value)}
          </CardTitle>
        </div>
        {placeholder ? (
          <Badge
            className="shrink-0 font-medium text-[10px] uppercase tracking-wide"
            variant="outline"
          >
            Sample
          </Badge>
        ) : Icon ? (
          <span className="flex size-9 items-center justify-center rounded-xl border border-primary/10 bg-primary/10 text-primary">
            <Icon className="size-4" />
          </span>
        ) : null}
      </CardHeader>
      {hasFooter ? (
        <CardContent className="flex flex-col gap-2 pt-0">
          {showDelta ? (
            <div className="flex items-center gap-2">
              <MetricDeltaChip delta={delta} sparkline={sparkline} />
              {deltaLabel ? (
                <span className="text-muted-foreground text-xs">
                  {deltaLabel}
                </span>
              ) : null}
            </div>
          ) : null}
          {detail || trend ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground text-sm">{detail}</span>
              {trend ? (
                <span className="font-semibold text-primary text-xs">
                  {trend}
                </span>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

function MetricInfoTooltip({
  info,
  label,
}: {
  info: { what: string; how?: string };
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`About ${label}`}
          className="text-muted-foreground/60 transition-colors hover:text-foreground"
          type="button"
        >
          <InfoIcon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[240px] space-y-1 normal-case">
        <p className="font-medium text-xs">{info.what}</p>
        {info.how ? (
          <p className="text-muted-foreground text-xs">{info.how}</p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

function MetricDeltaChip({
  delta,
  sparkline,
}: {
  delta: number | "unknown";
  sparkline?: Array<number | null | undefined>;
}) {
  if (delta === "unknown") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
        <MinusIcon className="size-3" />
        Unknown
      </span>
    );
  }

  const positive = delta >= 0;
  // Render a real sparkline of the metric's trend when we have enough points;
  // otherwise fall back to the directional icon.
  const finitePoints = sparkline
    ? sparkline.filter(
        (value) => typeof value === "number" && Number.isFinite(value)
      ).length
    : 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[11px]",
        positive
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
      )}
    >
      {finitePoints >= 2 && sparkline ? (
        <Sparkline
          className="shrink-0"
          height={11}
          values={sparkline}
          width={26}
        />
      ) : positive ? (
        <TrendingUpIcon className="size-3" />
      ) : (
        <TrendingDownIcon className="size-3" />
      )}
      {positive ? "+" : ""}
      {delta}%
    </span>
  );
}

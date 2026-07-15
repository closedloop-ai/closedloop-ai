"use client";

import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@closedloop-ai/design-system/components/ui/popover";
import { formatMetricValue } from "@closedloop-ai/design-system/components/ui/primitives/format-metric-value";
import { Sparkline } from "@closedloop-ai/design-system/components/ui/primitives/sparkline";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  InfoIcon,
  MinusIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ComponentProps, FocusEvent, PointerEvent, ReactNode } from "react";

type MetricCardProps = {
  label: string;
  value: string | number;
  /** Optional unit suffix rendered beside the formatted metric value. */
  unitLabel?: ReactNode;
  detail?: ReactNode;
  trend?: ReactNode;
  className?: string;
  /** Short explainer rendered in an info popover beside the label. */
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
  unitLabel,
  detail,
  trend,
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
      <CardHeader className="flex min-w-0 flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div className="min-w-0 space-y-1">
          <CardDescription className="flex items-center gap-1.5 font-semibold text-[11px] uppercase tracking-[0.12em]">
            {label}
            {info ? <MetricInfoPopover info={info} label={label} /> : null}
          </CardDescription>
          <CardTitle className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 font-semibold text-2xl tracking-tight">
            <span className="min-w-0 break-words">{formatMetricValue(value)}</span>
            {unitLabel ? (
              <span className="font-medium text-muted-foreground text-xs">
                {unitLabel}
              </span>
            ) : null}
          </CardTitle>
        </div>
        {placeholder ? (
          <Badge
            className="shrink-0 font-medium text-[10px] uppercase tracking-wide"
            variant="outline"
          >
            Sample
          </Badge>
        ) : null}
      </CardHeader>
      {hasFooter ? (
        <CardContent className="flex flex-col gap-2 pt-0">
          {showDelta ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <MetricDeltaChip delta={delta} sparkline={sparkline} />
              {deltaLabel ? (
                <span className="min-w-0 text-muted-foreground text-xs">
                  {deltaLabel}
                </span>
              ) : null}
            </div>
          ) : null}
          {detail || trend ? (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 text-muted-foreground text-sm">
                {detail}
              </span>
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

function MetricInfoPopover({
  info,
  label,
}: {
  info: { what: string; how?: string };
  label: string;
}) {
  const contentId = useId();
  const [openState, setOpenState] = useState({
    focus: false,
    hover: false,
    pinned: false,
  });
  const triggerClickShouldCloseRef = useRef(false);
  const open = openState.focus || openState.hover || openState.pinned;

  const showTransientInfo = (reason: "focus" | "hover") => {
    setOpenState((currentState) => ({ ...currentState, [reason]: true }));
  };
  const hideTransientInfo = (reason: "focus" | "hover") => {
    setOpenState((currentState) => ({ ...currentState, [reason]: false }));
  };
  const togglePinnedInfo = (forceClose = false) =>
    setOpenState((currentState) => {
      if (forceClose || currentState.pinned) {
        return { focus: false, hover: false, pinned: false };
      }

      return { ...currentState, pinned: true };
    });
  const hideInfo = () =>
    setOpenState({ focus: false, hover: false, pinned: false });

  const handleTriggerClick = () => {
    const shouldClosePinnedInfo = triggerClickShouldCloseRef.current;
    triggerClickShouldCloseRef.current = false;
    togglePinnedInfo(shouldClosePinnedInfo);
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch") {
      event.preventDefault();
      togglePinnedInfo();
      return;
    }

    // Radix may close anchored content as an outside interaction before click.
    triggerClickShouldCloseRef.current = openState.pinned;
  };

  const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    const relatedTarget = event.relatedTarget;
    const nextTargetIsInside =
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget);

    if (!nextTargetIsInside) {
      hideTransientInfo("focus");
    }
  };

  return (
    <Popover onOpenChange={(nextOpen) => !nextOpen && hideInfo()} open={open}>
      <PopoverAnchor asChild>
        <button
          aria-controls={open ? contentId : undefined}
          aria-expanded={open}
          aria-label={`About ${label}`}
          aria-haspopup="dialog"
          className="text-muted-foreground/60 transition-colors hover:text-foreground"
          onBlur={handleBlur}
          onClick={handleTriggerClick}
          onFocus={() => showTransientInfo("focus")}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") {
              showTransientInfo("hover");
            }
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== "touch") {
              hideTransientInfo("hover");
            }
          }}
          onPointerDown={handlePointerDown}
          type="button"
        >
          <InfoIcon className="size-3.5" />
        </button>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        aria-label={`About ${label}`}
        className="w-60 space-y-1 p-3 text-xs"
        id={contentId}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={hideInfo}
        onMouseEnter={() => showTransientInfo("hover")}
        onMouseLeave={() => hideTransientInfo("hover")}
        onOpenAutoFocus={(event) => event.preventDefault()}
        role="dialog"
        side="bottom"
        sideOffset={0}
      >
        <p className="font-medium text-xs">{info.what}</p>
        {info.how ? (
          <p className="text-muted-foreground text-xs">{info.how}</p>
        ) : null}
      </PopoverContent>
    </Popover>
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

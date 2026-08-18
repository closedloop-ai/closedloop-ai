// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Preserve the reviewed prototype behavior in this isolated copy.
// biome-ignore-all lint/style/noNestedTernary: Preserve the reviewed prototype render branches in this isolated copy.
"use client";

// Experimental variant scoped to Generic Artifact pending explicit promotion review.

import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@repo/design-system/components/ui/popover";
import { Sparkline } from "@repo/design-system/components/ui/primitives/sparkline";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { InfoIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import type {
  ComponentProps,
  FocusEvent,
  PointerEvent,
  ReactNode,
} from "react";
import { useId, useRef, useState } from "react";

const MAX_DELTA_PCT = 999;

type MetricCardProps = {
  label: string;
  /**
   * The metric value. Pass `null`/`undefined` for a genuine no-data state — the
   * card then renders the muted "No data" glyph (see `valueUnavailable`) instead
   * of a value, so there is never a dead value to keep in sync beside the flag
   * (FEA-4236). A caller may also set `valueUnavailable` explicitly to force the
   * no-data slot for a non-null placeholder value.
   */
  value: string | number | null | undefined;
  /** Optional unit suffix rendered beside the formatted metric value. */
  unitLabel?: ReactNode;
  detail?: ReactNode;
  trend?: ReactNode;
  className?: string;
  /** Short explainer rendered in an info popover beside the label. */
  info?: { what: string; how?: string };
  /**
   * Period-over-period change. A number renders a signed up/down chip. When
   * omitted, `deltaPlaceholder` (if provided) fills the same delta slot so the
   * footer layout stays stable across ranges with and without a comparison.
   */
  delta?: number;
  /**
   * "No comparison" affordance rendered in the delta slot (the SAME position the
   * numeric chip occupies) when `delta` is omitted, so a card without a prior
   * period keeps the delta info in a stable slot rather than dropping it to a
   * different corner. Ignored when `delta` is a number.
   */
  deltaPlaceholder?: ReactNode;
  /**
   * Marks a numeric `delta` as clamped to a display ceiling by the caller, so
   * the chip renders the capped ">999%" / "<-999%" affordance instead of
   * implying the exact figure is meaningful. Ignored when `delta` is not a
   * number.
   */
  deltaCapped?: boolean;
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
  /**
   * Renders the card at reduced opacity WITHOUT the "Sample" badge, for a value
   * that is genuinely unavailable (a failed read) rather than demo data pending
   * wiring. Use with a caption such as `detail="Unavailable"` so the dimmed card
   * reads as "couldn't load this", never as a misleading "Sample". Ignored when
   * `placeholder` is set (the badge path wins).
   */
  muted?: boolean;
  /**
   * Renders the card frame — label, info popover, and footer/detail — intact but
   * skeletons ONLY the value slot, for a metric whose value is still hydrating.
   * Keeps the card's own height and chrome (never a bare grey slab that drops the
   * label and info while its siblings keep theirs), matching the partial-load
   * pattern the Insights tiles use. Use with a `detail` reason (e.g. "Importing
   * your history") so the card says why it's blank instead of only shimmering.
   */
  loading?: boolean;
  /**
   * The metric has no value to show (a genuine no-data state, not a failed read
   * or hydrating value). Renders a muted, smaller "No data" glyph in the value
   * slot INSTEAD of the passed `value`, so an absent metric never renders as a
   * bold 2xl em-dash — which reads like a struck/rule value rather than "nothing
   * to show" (FEA-4236). Pair with a `detail` caption that says WHY the value is
   * absent. Unlike `muted` (which dims the whole card for a failed read), this
   * keeps the card frame at full opacity and only softens the value itself.
   */
  valueUnavailable?: boolean;
  /** Copy for the no-data value slot when `valueUnavailable` is set. */
  valueUnavailableLabel?: ReactNode;
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
  deltaPlaceholder,
  deltaCapped = false,
  deltaLabel,
  sparkline,
  placeholder = false,
  muted = false,
  loading = false,
  valueUnavailable = false,
  valueUnavailableLabel = "No data",
  ...props
}: MetricCardProps) {
  // A nullish value IS a no-data state — derive it so callers never keep a dead
  // `value` in sync beside the flag (FEA-4236). An explicit `valueUnavailable`
  // still forces the slot for a non-null placeholder value.
  const noData = valueUnavailable || value == null;
  const showDelta = delta !== undefined;
  // When there's no numeric delta, the "no comparison" placeholder fills the
  // SAME delta slot (not a different footer corner) so the layout stays stable.
  const showDeltaPlaceholder = !showDelta && Boolean(deltaPlaceholder);
  const hasFooter =
    Boolean(detail) || Boolean(trend) || showDelta || showDeltaPlaceholder;

  return (
    <Card
      className={cn(
        "gap-3 border-border bg-card py-4",
        (placeholder || muted) && "opacity-50",
        className
      )}
      {...props}
    >
      <CardHeader className="flex min-w-0 flex-row items-start justify-between gap-4 space-y-0 px-4 pb-0">
        <div className="min-w-0 space-y-1">
          <CardDescription className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap font-semibold text-[11px] uppercase tracking-[0.12em]">
            <span className="min-w-0 truncate" title={label}>
              {label}
            </span>
            {info ? <MetricInfoPopover info={info} label={label} /> : null}
          </CardDescription>
          <CardTitle
            className={cn(
              "flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-2xl tracking-tight",
              // An absent metric keeps the 2xl value slot — so the card doesn't
              // reflow, stays baseline-aligned with a sibling that has a value,
              // and never collapses into its own caption's size/colour — but
              // softens to the muted colour and a normal weight so it reads as
              // "nothing to show" rather than a bold value/rule (FEA-4236).
              noData && !loading
                ? "font-normal text-muted-foreground"
                : "font-semibold"
            )}
          >
            {renderMetricValue({
              loading,
              noData,
              unitLabel,
              value,
              valueUnavailableLabel,
            })}
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
        <CardContent className="flex flex-col gap-1.5 px-4 pt-0">
          {showDelta ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <MetricDeltaChip
                capped={deltaCapped}
                delta={delta}
                sparkline={sparkline}
              />
              {deltaLabel ? (
                <span className="min-w-0 text-muted-foreground text-xs">
                  {deltaLabel}
                </span>
              ) : null}
            </div>
          ) : null}
          {showDeltaPlaceholder ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {deltaPlaceholder}
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

function renderMetricValue({
  loading,
  noData,
  unitLabel,
  value,
  valueUnavailableLabel,
}: {
  loading: boolean;
  noData: boolean;
  unitLabel: ReactNode;
  value: string | number | null | undefined;
  valueUnavailableLabel: ReactNode;
}) {
  if (loading) {
    // Skeleton ONLY the value, keeping the card's label/info/footer chrome —
    // never a bare grey slab beside fully-formed siblings. The height matches the
    // 2xl value line so the card doesn't reflow when the real value lands.
    return <Skeleton className="h-8 w-16 rounded" />;
  }
  if (noData) {
    // No unit is shown for an absent value — a "LOC/$" suffix beside "No data"
    // would imply a (missing) number it can't qualify.
    return <span className="min-w-0 break-words">{valueUnavailableLabel}</span>;
  }
  return (
    <>
      {/* `noData` above already returned for a nullish value, so this branch
          always has a real value; `?? ""` only satisfies the type narrowing. */}
      <span className="min-w-0 break-words">
        {formatMetricValue(value ?? "")}
      </span>
      {unitLabel ? (
        <span className="font-medium text-muted-foreground text-xs">
          {unitLabel}
        </span>
      ) : null}
    </>
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
          aria-haspopup="dialog"
          aria-label={`About ${label}`}
          className="text-muted-foreground/60 transition-colors hover:text-foreground"
          onBlur={handleBlur}
          onClick={handleTriggerClick}
          onFocus={() => showTransientInfo("focus")}
          onPointerDown={handlePointerDown}
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
  capped = false,
}: {
  delta: number;
  sparkline?: Array<number | null | undefined>;
  capped?: boolean;
}) {
  const positive = delta >= 0;
  // Render a real sparkline of the metric's trend when we have enough points;
  // otherwise fall back to the directional icon.
  const finitePoints = sparkline
    ? sparkline.filter(
        (value) => typeof value === "number" && Number.isFinite(value)
      ).length
    : 0;
  // Delegate the display string to the shared `formatDeltaPct` SSOT so a capped
  // magnitude reads as ">999%" / "<-999%" identically here and in the Insights
  // `TrendBadge` (FEA-3959/3960). `capped` from the caller marks a pre-clamped
  // value whose raw number is no longer meaningful; when set, the ceiling
  // treatment is applied even if the passed `delta` was already the ceiling.
  const label = capped
    ? formatDeltaPct(positive ? MAX_DELTA_PCT : -MAX_DELTA_PCT)
    : formatDeltaPct(delta);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[11px]",
        positive
          ? "bg-success/10 text-success"
          : "bg-destructive/10 text-destructive"
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
      {label}
    </span>
  );
}

function formatDeltaPct(deltaPct: number): string {
  if (Math.abs(deltaPct) >= MAX_DELTA_PCT) {
    return deltaPct >= 0 ? `>${MAX_DELTA_PCT}%` : `<-${MAX_DELTA_PCT}%`;
  }
  const sign = deltaPct > 0 ? "+" : "";
  return `${sign}${deltaPct}%`;
}

function formatMetricValue(value: string | number): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : value;
}

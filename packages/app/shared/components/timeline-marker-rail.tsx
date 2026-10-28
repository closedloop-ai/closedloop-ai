"use client";

import { useContainerWidth } from "@repo/design-system/hooks/use-container-width";
import { cn } from "@repo/design-system/lib/utils";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { forwardRef, useMemo } from "react";
import {
  type PackedTimelineCluster,
  type PackedTimelineMarker,
  packTimelineMarkers,
  type TimelineMarkerGeometry,
  type TimelineMarkerInput,
} from "../lib/timeline-marker-packing";

export type TimelineMarkerBucketColumn<TMarker> = {
  id: string;
  markers: readonly TMarker[];
};

type TimelineMarkerRailProps<TBucketMarker, TPackedPayload> =
  | {
      className?: string;
      columns: readonly TimelineMarkerBucketColumn<TBucketMarker>[];
      layout: "bucketed";
      renderColumn: (
        column: TimelineMarkerBucketColumn<TBucketMarker>,
        children: ReactNode
      ) => ReactNode;
      renderMarker: (marker: TBucketMarker) => ReactNode;
    }
  | {
      className?: string;
      geometry?: Partial<TimelineMarkerGeometry>;
      items: readonly TimelineMarkerInput<TPackedPayload>[];
      layout: "packed";
      renderCluster: (
        cluster: PackedTimelineCluster<TPackedPayload>
      ) => ReactNode;
      renderMarker: (marker: PackedTimelineMarker<TPackedPayload>) => ReactNode;
    };

export function TimelineMarkerRail<TBucketMarker, TPackedPayload>(
  props: Readonly<TimelineMarkerRailProps<TBucketMarker, TPackedPayload>>
) {
  if (props.layout === "bucketed") {
    return (
      <div className={props.className}>
        {props.columns.map((column) =>
          props.renderColumn(
            column,
            column.markers.map((marker) => props.renderMarker(marker))
          )
        )}
      </div>
    );
  }
  return <PackedTimelineMarkerRail {...props} />;
}

type TimelineMarkerTriggerProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-disabled" | "aria-label"
> & {
  ariaDisabled?: boolean;
  ariaLabel: string;
};

export const TimelineMarkerTrigger = forwardRef<
  HTMLButtonElement,
  TimelineMarkerTriggerProps
>(function TimelineMarkerTrigger(
  { ariaDisabled, ariaLabel, children, type = "button", ...buttonProps },
  ref
) {
  return (
    <button
      aria-disabled={ariaDisabled}
      aria-label={ariaLabel}
      ref={ref}
      type={type}
      {...buttonProps}
    >
      {children}
    </button>
  );
});

type TimelineMarkerStaticTargetProps = {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

export const TimelineMarkerStaticTarget = forwardRef<
  HTMLSpanElement,
  TimelineMarkerStaticTargetProps
>(function TimelineMarkerStaticTarget({ children, className, style }, ref) {
  return (
    <span className={className} ref={ref} style={style}>
      {children}
    </span>
  );
});

function PackedTimelineMarkerRail<TPackedPayload>({
  className,
  geometry,
  items,
  renderCluster,
  renderMarker,
}: Readonly<
  Extract<TimelineMarkerRailProps<never, TPackedPayload>, { layout: "packed" }>
>) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const packed = useMemo(
    () => packTimelineMarkers(items, { geometry, railWidthPx: width }),
    [geometry, items, width]
  );
  return (
    <div
      className={cn("relative", className)}
      data-timeline-marker-rail=""
      ref={ref}
      style={{ height: `${packed.railHeightPx}px` }}
    >
      {packed.entries.map((entry) =>
        entry.kind === "cluster" ? renderCluster(entry) : renderMarker(entry)
      )}
    </div>
  );
}

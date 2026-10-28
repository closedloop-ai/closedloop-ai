"use client";

/**
 * @file preview-trace-primitives.tsx
 * @description The composites this sandbox's trace surfaces are built from.
 *
 * WHY THESE EXIST. The stat block, the eyebrow heading and the label/value row
 * had each been hand-rolled four times across the summary, the inspector, the
 * component panel and the error list — four copies with four slightly different
 * type sizes, which is how `text-[9px]`, `text-[10px]`, `text-[11px]` and
 * `text-[12px]` all ended up in one component. One definition each, on the type
 * scale, composed from design-system primitives.
 *
 * `PreviewTraceDetailRow` also settles an alignment rule the copies disagreed on:
 * NUMBERS right-align so digits line up in a column, PROSE stays left, because
 * right-aligning "Bracketed around this call" against a left-aligned label puts
 * a ragged gap down the middle of the panel.
 */

import { Separator } from "@repo/design-system/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { type ReactNode, useId } from "react";

export type PreviewTraceStatProps = {
  label: string;
  value: string;
  /** Secondary line, for the coverage or population a value is true of. */
  detail?: string;
  /**
   * What the figure counts, one sentence. A reader read "Turn spend" as an
   * average of the turns rather than the sum of them, which is the same class
   * of defect as a bar that does not say how its width was known.
   */
  description?: string;
};

/** One labelled figure. Used by the trace summary and the component drill-in. */
export function PreviewTraceStat({
  label,
  value,
  detail,
  description,
}: PreviewTraceStatProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs uppercase tracking-wide">
        {description === undefined ? (
          label
        ) : (
          <PreviewTraceStatDescription
            description={description}
            label={label}
          />
        )}
      </dt>
      <dd className="m-0 font-mono text-foreground text-sm tabular-nums">
        {value}
      </dd>
      {detail === undefined ? null : (
        <dd className="m-0 text-muted-foreground text-xs">{detail}</dd>
      )}
    </div>
  );
}

/** A responsive row of {@link PreviewTraceStat}. */
export function PreviewTraceStatRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "m-0 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4",
        className
      )}
    >
      {children}
    </dl>
  );
}

/**
 * The eyebrow heading above a region. `count` is folded in rather than
 * concatenated by each call site, so "Failed (2)" and "Not placed (1)" cannot
 * drift into two different shapes.
 */
export function PreviewTraceSectionHeading({
  title,
  count,
  className,
}: {
  title: string;
  count?: number;
  className?: string;
}) {
  return (
    <h4
      className={cn(
        "m-0 font-medium text-muted-foreground text-xs uppercase tracking-wide",
        className
      )}
    >
      {count === undefined ? title : `${title} (${count})`}
    </h4>
  );
}

/** A label/value pair. Numbers align right; prose stays left and readable. */
export function PreviewTraceDetailRow({
  label,
  value,
  numeric = true,
}: {
  label: string;
  value: string;
  numeric?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 break-words text-foreground",
          numeric
            ? "text-right font-mono tabular-nums"
            : "text-left text-muted-foreground"
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The label of a stat that carries an explanation.
 *
 * REACHABLE THREE WAYS ON PURPOSE. Pointer opens it on hover, the keyboard opens
 * it on focus (Radix does both from one trigger), and the description is ALSO
 * wired to the trigger permanently through `aria-describedby`, so a screen
 * reader gets the sentence whether or not the tooltip is open. A tooltip that
 * only a mouse can reach is decoration, not an explanation.
 *
 * The trigger is a real button because a focusable element has to be one; it
 * carries no chrome, since ten outlined buttons across a stat grid would look
 * like ten controls.
 */
function PreviewTraceStatDescription({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  const descriptionId = useId();

  return (
    <Tooltip>
      <TooltipTrigger
        aria-describedby={descriptionId}
        className="cursor-help text-left underline decoration-muted-foreground/60 decoration-dotted underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        type="button"
      >
        {label}
      </TooltipTrigger>
      <span className="sr-only" id={descriptionId}>
        {description}
      </span>
      <TooltipContent className="max-w-64 normal-case tracking-normal">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

/** A titled block inside the inspector or the component panel. */
export function PreviewTraceSection({
  title,
  children,
  withSeparator = false,
}: {
  title: string;
  children: ReactNode;
  withSeparator?: boolean;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      {withSeparator ? <Separator /> : null}
      <PreviewTraceSectionHeading title={title} />
      {children}
    </section>
  );
}

"use client";

/**
 * @file session-trace-chart.tsx
 * @description The span canvas: a name tree on the left, a time axis on the right.
 *
 * WHY MEASURED AND INFERRED BARS DO NOT LOOK ALIKE. A bar whose width is latency
 * and a bar whose width is "had not yet given way to its sibling" are different
 * claims, and a chart that draws them identically invites the reader to treat
 * the second as the first. Measured bars are solid; inferred bars are hatched,
 * and the hatch is a FILL difference rather than a hue difference so it survives
 * both themes and every colour-vision deficiency (WCAG 1.4.1). Every bar's
 * accessible name carries the word as well.
 *
 * WHY THE ROW DOES NOT SPELL THE KIND. By the explicit operator decision in
 * DOC-37 section 5, kind is carried in the rows by colour alone: a marker, then
 * the component name. The word did not disappear — it is on the toolbar filter
 * chip, in the inspector, and leading this row's `sr-only` name. The relaxation
 * stops at failure, which always states the word.
 *
 * A TELEMETRY COLUMN WITH NO SOURCE STATES THAT ONCE, IN ITS HEADER, rather than
 * drawing five hundred identical dashes. A dash per row reads as "each of these
 * happens to be blank"; the header reads as "this column is unsourced", which is
 * the true statement and the one PRD-753 R9 asks for. Where SOME rows report the
 * population, the column is numeric and an individual gap says "not recorded".
 */

import { cn } from "@repo/design-system/lib/utils";
import { CircleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  formatSessionTraceCount,
  formatSessionTraceDuration,
} from "../../../lib/session-trace/session-trace-format";
import {
  SESSION_TRACE_EXTENT_LABEL,
  SESSION_TRACE_KIND_LABEL,
  SESSION_TRACE_KIND_TOKEN,
  SessionTraceExtentSource,
  type SessionTraceSpan,
  sessionTraceHatchFill,
  sessionTraceKindSwatchStyle,
} from "../../../lib/session-trace/session-trace-node";

const ROW_HEIGHT_PX = 26;
const DEPTH_INDENT_PX = 12;
const MIN_BAR_PERCENT = 0.35;
/** A failed span must stay visible however short it was. */
const FAILED_BAR_FLOOR_PERCENT = 1.2;
/**
 * Narrower than this per segment and two timestamps collide into one smear, so
 * the ruler drops ticks rather than printing an unreadable one.
 */
const RULER_MIN_SEGMENT_PX = 76;
const RULER_MAX_SEGMENTS = 6;
const RULER_MIN_SEGMENTS = 1;

/** Which telemetry columns this session actually has a producer for. */
export type SessionTraceColumns = {
  footprintSourced: boolean;
  turnTokensSourced: boolean;
};

const CELL_NOT_RECORDED = "not recorded";

export type SessionTraceChartRowsProps = {
  /**
   * Exactly the rows to draw. Narrowing happens in `selectDrawnSpans`
   * (`build-session-trace.ts`), upstream, so the header can be summarised over
   * the SAME list rather than re-deriving it from a filter this component kept
   * to itself.
   */
  spans: readonly SessionTraceSpan[];
  selectedId: string | null;
  onSelect: (span: SessionTraceSpan) => void;
  columns: SessionTraceColumns;
  /** Visible window, in ms from the trace origin. */
  windowFromMs: number;
  windowToMs: number;
};

export function SessionTraceChartRows({
  spans,
  selectedId,
  onSelect,
  columns,
  windowFromMs,
  windowToMs,
}: SessionTraceChartRowsProps) {
  const windowMs = Math.max(1, windowToMs - windowFromMs);

  if (spans.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-muted-foreground text-sm">
        No spans fall inside this window. Widen the range or clear the filters.
      </p>
    );
  }

  return (
    <ul
      aria-label="Session spans, outermost first"
      className="m-0 list-none p-0"
    >
      {spans.map((span) => (
        <SessionTraceRow
          columns={columns}
          isSelected={span.invocation.externalInvocationId === selectedId}
          key={span.invocation.externalInvocationId}
          onSelect={onSelect}
          span={span}
          windowFromMs={windowFromMs}
          windowMs={windowMs}
        />
      ))}
    </ul>
  );
}

type SessionTraceRowProps = {
  span: SessionTraceSpan;
  isSelected: boolean;
  onSelect: (span: SessionTraceSpan) => void;
  columns: SessionTraceColumns;
  windowFromMs: number;
  windowMs: number;
};

function SessionTraceRow({
  span,
  isSelected,
  onSelect,
  columns,
  windowFromMs,
  windowMs,
}: SessionTraceRowProps) {
  const { invocation } = span;
  // THE BAR IS THE INTERSECTION OF THE SPAN AND THE WINDOW, never the whole
  // span clamped at its left edge. A row is kept whenever it OVERLAPS the
  // window, so zooming to a span keeps its ancestors — and an ancestor's full
  // subtree width against a narrow window is far past 100%, which (the bar
  // container is not overflow-clipped) draws across the later columns and the
  // inspector while stating a duration the window does not show.
  const windowToMs = windowFromMs + windowMs;
  const visibleStartMs = Math.min(
    Math.max(span.startMs, windowFromMs),
    windowToMs
  );
  const visibleEndMs = Math.max(
    Math.min(span.endMs, windowToMs),
    visibleStartMs
  );
  const leftPercent = ((visibleStartMs - windowFromMs) / windowMs) * 100;
  const widthPercent = ((visibleEndMs - visibleStartMs) / windowMs) * 100;
  const isInferred = span.extentSource === SessionTraceExtentSource.Inferred;
  const failed = invocation.succeeded === false;
  // Failure outranks kind in the fill. The kind is still stated, in the word on
  // the chip and in the accessible name, so nothing is lost by the bar saying
  // the more urgent thing.
  const fill = failed
    ? "var(--destructive)"
    : SESSION_TRACE_KIND_TOKEN[invocation.kind];

  return (
    <li className="contents">
      <button
        aria-pressed={isSelected}
        className={cn(
          "group relative flex w-full items-stretch gap-2 border-border/40 border-b px-2 text-left",
          "hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2",
          isSelected && "bg-muted"
        )}
        onClick={() => onSelect(span)}
        style={{ height: `${ROW_HEIGHT_PX}px` }}
        type="button"
      >
        {/* The critical path marks the ROW, not the bar: an outline around the
            bar restated the widths, since in a nested trace the critical path IS
            the deepest chain of longest bars. A spine at a fixed left edge joins
            up down the rows, so the chain is findable by shape. The word is
            still in the row's accessible name. */}
        {span.onCriticalPath ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-0.5 bg-foreground/55"
          />
        ) : null}
        <SessionTraceRowLabel span={span} />
        <span className="relative min-w-0 flex-1 self-center">
          {/* A failed bar also gets a floor width, because a 64ms hook inside an
              82s session is a third of a pixel and the whole point of the row is
              that it failed. */}
          <span
            aria-hidden="true"
            className="absolute inset-y-0 my-auto block h-3.5 rounded-xs"
            style={{
              left: `${leftPercent}%`,
              // The floor still applies — a 64ms hook must stay visible — but it
              // can never push the bar past the window's right edge.
              width: `${Math.min(
                100 - leftPercent,
                Math.max(
                  failed ? FAILED_BAR_FLOOR_PERCENT : MIN_BAR_PERCENT,
                  widthPercent
                )
              )}%`,
              background: isInferred ? sessionTraceHatchFill(fill) : fill,
            }}
          />
        </span>
        {columns.footprintSourced ? (
          <SessionTraceNumberCell
            className="w-14 max-md:hidden"
            value={invocation.footprintTokens}
          />
        ) : null}
        {columns.turnTokensSourced ? (
          <SessionTraceNumberCell
            className="w-16 max-lg:hidden"
            value={invocation.inputTokens}
          />
        ) : null}
        <span className="w-16 shrink-0 self-center text-right font-mono text-muted-foreground text-xs tabular-nums">
          {formatSessionTraceDuration(span.subtreeMs)}
        </span>
        <span className="sr-only">
          {sessionTraceRowAccessibleName(span, columns)}
        </span>
      </button>
    </li>
  );
}

function SessionTraceNumberCell({
  value,
  className,
}: {
  value: number | undefined;
  className: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 self-center text-right font-mono text-muted-foreground text-xs tabular-nums",
        className
      )}
    >
      {value === undefined ? CELL_NOT_RECORDED : formatSessionTraceCount(value)}
    </span>
  );
}

function SessionTraceRowLabel({ span }: { span: SessionTraceSpan }) {
  const { invocation } = span;
  const failed = invocation.succeeded === false;

  return (
    <span
      className="flex w-60 shrink-0 items-center gap-1.5 self-center overflow-hidden max-sm:w-36"
      style={{ paddingLeft: `${span.depth * DEPTH_INDENT_PX}px` }}
    >
      {/* The kind, in one 10px marker: the same solid token the bar is filled
          with and the same one the toolbar's filter chip wears, so the reader
          learns the mapping from the control and then reads the rows by it. */}
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-xs"
        style={sessionTraceKindSwatchStyle(invocation.kind)}
      />
      {failed ? (
        <CircleAlertIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-destructive"
        />
      ) : null}
      <span className="truncate text-foreground text-xs">
        {invocation.componentKey}
      </span>
    </span>
  );
}

export type SessionTraceChartRulerProps = {
  totalMs: number;
  columns: SessionTraceColumns;
  windowFromMs: number;
  windowToMs: number;
};

/** The time axis. Pinning it is the CALLER's job, so it can pin the toolbar too. */
export function SessionTraceChartRuler({
  totalMs,
  columns,
  windowFromMs,
  windowToMs,
}: SessionTraceChartRulerProps) {
  const [axisRef, axisWidth] = useMeasuredWidth<HTMLSpanElement>();
  const windowMs = Math.max(1, windowToMs - windowFromMs);
  const segments = Math.min(
    RULER_MAX_SEGMENTS,
    Math.max(RULER_MIN_SEGMENTS, Math.floor(axisWidth / RULER_MIN_SEGMENT_PX))
  );
  const ticks = Array.from({ length: segments + 1 }, (_, index) => {
    const fraction = index / segments;
    return { fraction, atMs: windowFromMs + windowMs * fraction };
  });

  return (
    <div className="flex items-end gap-2 border-border border-b bg-background px-2 pb-1">
      <span className="flex w-60 shrink-0 items-center gap-1.5 text-muted-foreground text-xs uppercase tracking-wide max-sm:w-36">
        <span className="max-sm:hidden">{`Span · ${formatSessionTraceDuration(totalMs)} total`}</span>
        {/* The one encoding with no control in the toolbar, so it is stated
            here, drawn from the same helper the bars use. */}
        <span className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="h-2.5 w-5 shrink-0 rounded-xs"
            style={{
              background: sessionTraceHatchFill("var(--muted-foreground)"),
            }}
          />
          {SESSION_TRACE_EXTENT_LABEL[SessionTraceExtentSource.Inferred]}
        </span>
      </span>
      <span className="relative h-4 min-w-0 flex-1" ref={axisRef}>
        {ticks.map((tick) => (
          <span
            // `whitespace-nowrap` is load-bearing: the last tick sits at
            // left:100%, so its shrink-to-fit width is zero and `30m 59s` wraps
            // into a two-line stack over the toolbar without it.
            className="absolute bottom-0 whitespace-nowrap font-mono text-muted-foreground text-xs tabular-nums"
            key={tick.fraction}
            style={{
              left: `${tick.fraction * 100}%`,
              transform:
                tick.fraction === 1 ? "translateX(-100%)" : "translateX(0)",
            }}
          >
            {formatSessionTraceDuration(tick.atMs)}
          </span>
        ))}
      </span>
      {columns.footprintSourced ? (
        <span className="w-14 shrink-0 text-right text-muted-foreground text-xs uppercase tracking-wide max-md:hidden">
          Footprint
        </span>
      ) : null}
      {columns.turnTokensSourced ? (
        <span className="w-16 shrink-0 text-right text-muted-foreground text-xs uppercase tracking-wide max-lg:hidden">
          Tokens in
        </span>
      ) : null}
      <span className="w-16 shrink-0 text-right text-muted-foreground text-xs uppercase tracking-wide">
        Extent
      </span>
    </div>
  );
}

/**
 * The row's whole statement for assistive tech. Kind LEADS it, because the row
 * carries kind by colour alone; failure states the word; and the extent carries
 * the provenance word beside the number so an inferred width is never heard as
 * latency.
 */
export function sessionTraceRowAccessibleName(
  span: SessionTraceSpan,
  columns: SessionTraceColumns
): string {
  const { invocation } = span;
  const failed = invocation.succeeded === false;
  const parts = [
    `${SESSION_TRACE_KIND_LABEL[invocation.kind]} ${invocation.componentKey}`,
    `depth ${span.depth + 1}`,
    `${SESSION_TRACE_EXTENT_LABEL[span.extentSource].toLowerCase()} extent ${formatSessionTraceDuration(span.subtreeMs)}`,
  ];
  if (columns.footprintSourced) {
    parts.push(
      invocation.footprintTokens === undefined
        ? `footprint tokens ${CELL_NOT_RECORDED}`
        : `${formatSessionTraceCount(invocation.footprintTokens)} footprint tokens`
    );
  }
  if (columns.turnTokensSourced) {
    parts.push(
      invocation.inputTokens === undefined
        ? `turn input tokens ${CELL_NOT_RECORDED}`
        : `${formatSessionTraceCount(invocation.inputTokens)} turn input tokens`
    );
  }
  if (span.onCriticalPath) {
    parts.push("on the critical path");
  }
  if (failed) {
    parts.push("failed");
  }
  if (!failed && span.subtreeErrorCount > 0) {
    parts.push(`${span.subtreeErrorCount} failed below it`);
  }
  return parts.join(", ");
}

/**
 * The axis' own width, not the viewport's. A media query cannot see this one:
 * the axis is squeezed by the inspector rail opening at an unchanged viewport
 * width, and that is exactly when the ticks overprint.
 */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (node === null) {
      return;
    }
    setWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

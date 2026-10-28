"use client";

/**
 * @file session-trace-toolbar.tsx
 * @description Kind filters, the critical-path lens, the failure chip, and the
 * keyboard-reachable equivalents of every zoom gesture.
 *
 * THE TOOLBAR IS THE KEY. Every encoding the chart uses is stated by a control
 * the reader is already operating: the kind filters carry their own kind's
 * colour, so a blue Subagent chip beside blue bars teaches "blue is a subagent"
 * with nothing to look up; the critical-path lens carries the same spine the
 * rows draw; the Errors chip carries the red a failed bar is filled with. A
 * separate seven-swatch legend would restate all of that in a block nobody
 * operates, and the vocabulary would then have two places to drift apart in.
 *
 * A FILTERED-OFF KIND KEEPS ITS COLOUR. The marker is identical in both states,
 * because it is the key, and a key that empties out as you hide kinds stops
 * being one. What carries the state is the chip around it: tinted and outlined
 * is showing, hollow and dashed is not.
 *
 * THE FAILURE COUNT IS NEVER DISMISSABLE (DOC-37 section 6), and when it has no
 * source it is not a zero either: with `succeeded` unread on this row the chip
 * says so in words instead of showing "Errors 0", which would be a measurement
 * nothing made.
 */

import type { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  MaximizeIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import {
  SESSION_TRACE_KIND_LABEL,
  SESSION_TRACE_KIND_ORDER,
  SESSION_TRACE_KIND_TOKEN,
  type SessionTraceSpan,
  sessionTraceKindSwatchStyle,
} from "../../../lib/session-trace/session-trace-node";

export type SessionTraceToolbarProps = {
  activeKinds: readonly AgentComponentInvocationKind[];
  criticalPathOnly: boolean;
  errorsOnly: boolean;
  errorCount: number;
  /**
   * Whether ANY row on this session reports success or failure. `false` means
   * the failure population is unknown, not empty — see the file header.
   */
  failureStateSourced: boolean;
  canZoomToSpan: boolean;
  isZoomed: boolean;
  onToggleKind: (kind: AgentComponentInvocationKind) => void;
  onToggleErrorsOnly: () => void;
  onToggleCriticalPath: () => void;
  onZoomToSpan: () => void;
  onZoomOut: () => void;
  onFit: () => void;
};

export function SessionTraceToolbar({
  activeKinds,
  criticalPathOnly,
  errorsOnly,
  errorCount,
  failureStateSourced,
  canZoomToSpan,
  isZoomed,
  onToggleKind,
  onToggleErrorsOnly,
  onToggleCriticalPath,
  onZoomToSpan,
  onZoomOut,
  onFit,
}: SessionTraceToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-border border-b px-4 py-2">
      {/* The toolbar is pinned inside the scrolling pane, so at 390px every line
          it wraps to is a line of chart the reader does not get. The zoom
          controls drop to their icons while keeping their full names on
          `aria-label` (WCAG 4.1.2). */}
      <span className="text-muted-foreground text-xs uppercase tracking-wide max-sm:hidden">
        Show
      </span>
      {SESSION_TRACE_KIND_ORDER.map((kind) => (
        <SessionTraceFilterChip
          accent={SESSION_TRACE_KIND_TOKEN[kind]}
          active={activeKinds.includes(kind)}
          key={kind}
          marker={
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-xs"
              style={sessionTraceKindSwatchStyle(kind)}
            />
          }
          onToggle={() => onToggleKind(kind)}
        >
          {SESSION_TRACE_KIND_LABEL[kind]}
        </SessionTraceFilterChip>
      ))}
      <span className="ml-auto flex flex-wrap items-center gap-1">
        {renderFailureChip({
          errorCount,
          errorsOnly,
          failureStateSourced,
          onToggleErrorsOnly,
        })}
        <SessionTraceFilterChip
          accent="var(--foreground)"
          active={criticalPathOnly}
          ariaLabel="Critical path only"
          // The row's own spine, at the chip's left edge: same width, same
          // token, so the chain the lens narrows to is recognisable by shape
          // before it is read.
          marker={
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 w-0.5 bg-foreground/55"
            />
          }
          onToggle={onToggleCriticalPath}
        >
          Critical path<span className="max-sm:hidden"> only</span>
        </SessionTraceFilterChip>
        <Button
          aria-label="Zoom to span"
          disabled={!canZoomToSpan}
          onClick={onZoomToSpan}
          size="sm"
          variant="ghost"
        >
          <ZoomInIcon />
          <span className="max-sm:hidden">Zoom to span</span>
        </Button>
        <Button
          aria-label="Zoom out"
          onClick={onZoomOut}
          size="sm"
          variant="ghost"
        >
          <ZoomOutIcon />
          <span className="max-sm:hidden">Zoom out</span>
        </Button>
        <Button
          aria-label="Fit the whole session"
          disabled={!isZoomed}
          onClick={onFit}
          size="sm"
          variant="ghost"
        >
          <MaximizeIcon />
          <span className="max-sm:hidden">Fit</span>
        </Button>
      </span>
    </div>
  );
}

/**
 * The failure chip has three states and they are three different sentences.
 *
 * Unsourced comes FIRST, because "Errors 0" over a session whose rows carry no
 * `succeeded` is the exact "quietly low number" DOC-37 section 10 warns about:
 * it reads as a measurement and gets acted on. The unsourced chip is inert
 * rather than a filter, because there is nothing to filter to.
 */
function renderFailureChip({
  errorCount,
  errorsOnly,
  failureStateSourced,
  onToggleErrorsOnly,
}: {
  errorCount: number;
  errorsOnly: boolean;
  failureStateSourced: boolean;
  onToggleErrorsOnly: () => void;
}): ReactNode {
  if (!failureStateSourced) {
    return (
      <span className="flex items-center gap-1.5 rounded-md border border-border border-dashed px-2 py-1 text-muted-foreground text-xs">
        <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
        Failures not recorded
      </span>
    );
  }
  if (errorCount === 0) {
    return null;
  }
  return (
    <SessionTraceFilterChip
      // The fill a failed bar takes, so the chip is the key for it.
      accent="var(--destructive)"
      active={errorsOnly}
      ariaExpanded={errorsOnly}
      marker={
        <CircleAlertIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-destructive"
        />
      }
      onToggle={onToggleErrorsOnly}
    >
      {`Errors ${errorCount}`}
    </SessionTraceFilterChip>
  );
}

type SessionTraceFilterChipProps = {
  active: boolean;
  onToggle: () => void;
  /** The encoding this chip is the key for: a kind swatch, a spine, an icon. */
  marker: ReactNode;
  /** The colour the chip tints itself with while it is on. */
  accent: string;
  children: ReactNode;
  ariaLabel?: string;
  ariaExpanded?: boolean;
};

/**
 * One filter, wearing the encoding it filters on.
 *
 * ON AND OFF ARE NOT TWO BRIGHTNESSES. These decide what the chart is hiding, so
 * an off chip has to read as off and not as a dimmer on: it loses its fill and
 * takes a dashed edge, which survives greyscale and does not lean on the accent
 * it is keying. The marker stays put across both states.
 */
function SessionTraceFilterChip({
  active,
  onToggle,
  marker,
  accent,
  children,
  ariaLabel,
  ariaExpanded,
}: SessionTraceFilterChipProps) {
  // A tint rather than the accent itself: these chips sit in a row of seven, and
  // seven saturated fills would out-shout the chart they are a key to.
  const activeStyle: CSSProperties = {
    backgroundColor: `color-mix(in oklab, ${accent} 20%, transparent)`,
    borderColor: `color-mix(in oklab, ${accent} 50%, transparent)`,
  };

  return (
    <Button
      aria-expanded={ariaExpanded}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={cn(
        "relative gap-1.5 overflow-hidden border px-2 font-normal",
        active
          ? "border-solid text-foreground hover:opacity-85"
          : "border-border border-dashed text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
      onClick={onToggle}
      size="sm"
      style={active ? activeStyle : undefined}
      variant="ghost"
    >
      {marker}
      <span>{children}</span>
    </Button>
  );
}

export type SessionTraceFocusTrailProps = {
  trail: readonly SessionTraceSpan[];
  focused: SessionTraceSpan;
  onClearFocus: () => void;
  onFocusSpan: (span: SessionTraceSpan) => void;
};

/** The way back out of a subtree: every ancestor is a live step, not a label. */
export function SessionTraceFocusTrail({
  trail,
  focused,
  onClearFocus,
  onFocusSpan,
}: SessionTraceFocusTrailProps) {
  return (
    <nav
      aria-label="Focused subtree"
      className="flex flex-wrap items-center gap-0.5 border-border border-b bg-muted/40 px-3 py-1.5"
    >
      <Button
        className="h-6 px-2"
        onClick={onClearFocus}
        size="sm"
        variant="ghost"
      >
        Whole session
      </Button>
      {trail.map((span) => (
        <span
          className="flex items-center gap-0.5"
          key={span.invocation.externalInvocationId}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3 text-muted-foreground"
          />
          <Button
            className="h-6 px-2"
            onClick={() => onFocusSpan(span)}
            size="sm"
            variant="ghost"
          >
            {span.invocation.componentKey}
          </Button>
        </span>
      ))}
      <ChevronRightIcon
        aria-hidden="true"
        className="size-3 text-muted-foreground"
      />
      <span
        aria-current="page"
        className="px-2 font-medium text-foreground text-xs"
      >
        {focused.invocation.componentKey}
      </span>
    </nav>
  );
}

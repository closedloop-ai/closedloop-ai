"use client";

/**
 * @file session-trace-preview-panel.tsx
 * @description The Trace tab: the whole session as one tree on a time axis,
 * with two drill-ins and a way back out of each.
 *
 * WHAT THIS VIEW HAS THAT A FLAT STREAM CANNOT. A metric stream can say the
 * traced session cost $10.86 across 159 invocations and that `review-soul` ran.
 * It cannot say that `review-soul` was reached through `/design` -> `design` ->
 * `Agent` -> `design-critic` -> `local-ci` -> `Agent` -> `test-engineer` ->
 * `frankenstein` -> `Agent`, nor that the critical path diverges from that
 * chain at `local-ci` and ends on a `dagger call check` whose 690 seconds are
 * most of why the session ran 62 minutes, nor that a blocking hook beside that
 * call denied the run before it and forced the retry. Ancestry, hooks as
 * first-class rows, and the critical path are the three things that are
 * structurally unavailable without a tree.
 *
 * NAVIGATION IS TWO AXES, AND BOTH ARE REVERSIBLE.
 *  - FOCUS goes DOWN the tree: re-root on a span so its subtree owns the whole
 *    axis. The ancestor trail stays on screen, so every step back up is one
 *    click rather than a guess.
 *  - OPEN COMPONENT goes SIDEWAYS, out of the tree: every invocation of that
 *    component anywhere in the session, what they cost, which agents reached
 *    them, whether they all ran the same definition. Back returns to the span
 *    you left, named.
 *
 * Every one of those states is in the URL, so any view of this session is a link
 * somebody else can open. A finding nobody else can reach is not evidence.
 */

import type { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildSessionTrace,
  collectFailedSpans,
  findSpanById,
  flattenSpans,
  selectDrawnSpans,
  summariseSessionTraceSpans,
} from "../../../../lib/session-trace/build-session-trace";
import { resolveFocusView } from "../../../../lib/session-trace/session-trace-drilldown";
import {
  formatSessionTraceCost,
  formatSessionTraceCount,
  formatSessionTraceDuration,
} from "../../../../lib/session-trace/session-trace-format";
import {
  SESSION_TRACE_KIND_ORDER,
  type SessionTraceInvocation,
  type SessionTraceSpan,
} from "../../../../lib/session-trace/session-trace-node";
import {
  SessionTraceChartRows,
  SessionTraceChartRuler,
  type SessionTraceColumns,
} from "../session-trace-chart";
import {
  SessionTraceFocusTrail,
  SessionTraceToolbar,
} from "../session-trace-toolbar";
import {
  buildComponentDrilldown,
  decodeComponentRef,
  encodeComponentRef,
} from "./preview-trace-component-drilldown";
import { PreviewTraceComponentPanel } from "./preview-trace-component-panel";
import { PreviewTraceInspector } from "./preview-trace-inspector";
import {
  emptyPreviewTraceRouteState,
  type PreviewTraceRouteState,
  readPreviewTraceRouteState,
  writePreviewTraceRouteState,
} from "./preview-trace-route-state";
import { PreviewTraceScrubber } from "./preview-trace-scrubber";
import {
  PreviewTraceErrorList,
  PreviewTraceSummary,
  PreviewTraceUnplacedStrip,
} from "./preview-trace-summary";
import {
  indexSpanExtras,
  previewTracedSessionContext,
  previewTraceInvocations,
} from "./preview-traced-session";

const ZOOM_OUT_FACTOR = 2;

export type SessionTracePreviewPanelProps = {
  invocations?: readonly SessionTraceInvocation[];
};

export function SessionTracePreviewPanel({
  invocations = previewTraceInvocations,
}: SessionTracePreviewPanelProps) {
  const [routeState, setRouteState] = useState<PreviewTraceRouteState>(
    emptyPreviewTraceRouteState
  );
  // The URL owns the state until it has been read into React. Writing before
  // that serializes the empty initial state over a pasted link, and under
  // StrictMode's replayed mount effects — which is what `next dev` does — the
  // replayed read then picks the cleared query back up, so the link's span,
  // focus, window and lenses are lost. The write effect waits for this.
  // Found by whitlockk on #8303.
  const [hasReadRouteState, setHasReadRouteState] = useState(false);

  // Read once on mount: a pasted link restores the span, focus, drill-in,
  // window and lens. Later changes replace rather than push, so zooming does
  // not bury the Back button under a hundred history entries.
  useEffect(() => {
    setRouteState(
      readPreviewTraceRouteState(globalThis.window.location.search)
    );
    setHasReadRouteState(true);
  }, []);

  useEffect(() => {
    if (!hasReadRouteState) {
      return;
    }
    const query = writePreviewTraceRouteState(
      routeState,
      globalThis.window.location.search
    );
    globalThis.window.history.replaceState(
      globalThis.window.history.state,
      "",
      `${globalThis.window.location.pathname}${query}`
    );
  }, [routeState, hasReadRouteState]);

  const trace = useMemo(() => buildSessionTrace(invocations), [invocations]);
  /*
   * The presumed fields are indexed from the rows THIS panel was handed, not
   * from the default fixture: a caller that injects its own invocations must
   * get its own `detail` and `parentAgentId` back, and a module-level index
   * would hand it the fixture's instead — silently, since a miss degrades to
   * "not reported" rather than throwing.
   */
  const spanExtras = useMemo(() => indexSpanExtras(invocations), [invocations]);
  const extrasFor = useCallback(
    (externalInvocationId: string) =>
      spanExtras.get(externalInvocationId) ?? {},
    [spanExtras]
  );
  const focusView = useMemo(
    () => resolveFocusView(trace.roots, routeState.focusId, trace.totalMs),
    [trace.roots, trace.totalMs, routeState.focusId]
  );

  const windowFromMs = routeState.windowFromMs ?? focusView.windowFromMs;
  const windowToMs = routeState.windowToMs ?? focusView.windowToMs;
  const activeKinds = routeState.kinds ?? SESSION_TRACE_KIND_ORDER;

  const visibleSpans = useMemo(
    () =>
      flattenSpans(focusView.roots).filter(
        (span) =>
          activeKinds.includes(span.invocation.kind) &&
          // `subtreeErrorCount > 0` keeps the failure AND every ancestor that
          // reached it, so the lens narrows to the path rather than to a bare
          // leaf with its hand-off and fan-out stripped off.
          (!routeState.errorsOnly || span.subtreeErrorCount > 0)
      ),
    [focusView.roots, activeKinds, routeState.errorsOnly]
  );

  // Failures come from the WHOLE trace, never the focused subtree: arriving here
  // from a cross-session error pattern, the question is where in this session it
  // happened, and a focus that hid the answer would defeat the drill-down.
  const failures = useMemo(
    () => collectFailedSpans(trace.roots),
    [trace.roots]
  );

  // The last narrowing before the rows are drawn: the window and the critical
  // path. Computed HERE rather than inside the chart so the header can be
  // summarised over the identical list.
  const drawnSpans = useMemo(
    () =>
      selectDrawnSpans(visibleSpans, {
        showCriticalPathOnly: routeState.criticalPathOnly,
        windowFromMs,
        windowToMs,
      }),
    [visibleSpans, routeState.criticalPathOnly, windowFromMs, windowToMs]
  );

  // The header describes what the chart is DRAWING — every lens, not only the
  // focus. Totals over a population the reader has just filtered away are the
  // header contradicting the rows underneath it, and the kind chips, the Errors
  // lens, the critical-path toggle and the window all remove rows.
  const summary = useMemo(
    () => summariseSessionTraceSpans(drawnSpans),
    [drawnSpans]
  );
  // Depth is a COUNT OF LEVELS, so a draw with no rows in it has none. The
  // lenses can now empty the chart, and `maxDepth + 1` would report one level
  // of a tree that is not on screen.
  const depthLevels = drawnSpans.length === 0 ? 0 : summary.maxDepth + 1;
  // Unplaced rows belong to the session, not to any subtree, so they count only
  // while the whole session is on screen.
  const unplacedInScope =
    focusView.focused === null ? trace.unplaced.length : 0;

  const selected = useMemo(
    () =>
      routeState.spanId === null
        ? null
        : (findSpanById(trace.roots, routeState.spanId) ?? null),
    [trace.roots, routeState.spanId]
  );

  // Memoized so the drilldown below can depend on the ref itself: decoding
  // inline would mint a new object every render and defeat its memo.
  const componentRef = useMemo(
    () => decodeComponentRef(routeState.componentRef),
    [routeState.componentRef]
  );
  const drilldown = useMemo(
    () =>
      componentRef === null
        ? null
        : buildComponentDrilldown(
            trace.roots,
            componentRef.kind,
            componentRef.componentKey
          ),
    [trace.roots, componentRef]
  );

  /*
   * The canonical chart states which telemetry columns this session actually
   * has a producer for, so a column with no source reads "not recorded" rather
   * than a zero. The deleted sandbox chart drew both unconditionally; taking the
   * canonical component means taking its honesty about absent operands too.
   */
  const columns: SessionTraceColumns = {
    footprintSourced: trace.footprintReportedCount > 0,
    turnTokensSourced: trace.turnTokenReportedCount > 0,
  };

  const patch = useCallback((next: Partial<PreviewTraceRouteState>) => {
    setRouteState((current) => ({ ...current, ...next }));
  }, []);

  const handleSelect = useCallback(
    (span: SessionTraceSpan) =>
      patch({ spanId: span.invocation.externalInvocationId }),
    [patch]
  );

  const handleFocusSubtree = useCallback(
    (span: SessionTraceSpan) =>
      // The focused subtree carries its own window, so an explicit one from a
      // previous zoom is cleared rather than left pointing somewhere else.
      patch({
        focusId: span.invocation.externalInvocationId,
        windowFromMs: null,
        windowToMs: null,
      }),
    [patch]
  );

  const handleOpenComponent = useCallback(
    (span: SessionTraceSpan) =>
      patch({
        componentRef: encodeComponentRef(
          span.invocation.kind,
          span.invocation.componentKey
        ),
        spanId: span.invocation.externalInvocationId,
      }),
    [patch]
  );

  const handleToggleKind = useCallback((kind: AgentComponentInvocationKind) => {
    setRouteState((current) => {
      const present = current.kinds ?? SESSION_TRACE_KIND_ORDER;
      const next = present.includes(kind)
        ? present.filter((value) => value !== kind)
        : [...present, kind];
      // The last kind standing is not removable: emptying the chart would leave
      // no control on screen to put anything back.
      return { ...current, kinds: next.length === 0 ? present : next };
    });
  }, []);

  const handleZoomOut = useCallback(() => {
    const span = windowToMs - windowFromMs;
    const centre = windowFromMs + span / 2;
    const half = (span * ZOOM_OUT_FACTOR) / 2;
    patch({
      windowFromMs: Math.max(0, centre - half),
      windowToMs: Math.min(trace.totalMs, centre + half),
    });
  }, [patch, windowFromMs, windowToMs, trace.totalMs]);

  if (drilldown !== null) {
    return (
      <PreviewTraceComponentPanel
        backLabel={
          selected === null
            ? "Back to the trace"
            : `Back to ${selected.invocation.componentKey}`
        }
        drilldown={drilldown}
        onBack={() => patch({ componentRef: null })}
        onOpenSpan={(span) =>
          patch({
            componentRef: null,
            spanId: span.invocation.externalInvocationId,
          })
        }
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* ONE scrolling pane for the whole left column. The summary is
            reference material and is allowed to scroll away; the toolbar and the
            ruler are pinned inside the pane, because a filter you have to scroll
            back up to reach is a filter you stop using, and a bar's width means
            nothing once its axis has left the screen. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <PreviewTraceSummary
            scopeLabel={
              focusView.focused === null
                ? null
                : focusView.focused.invocation.componentKey
            }
            // Session-grain context is not scoped to a subtree, so it is withheld
            // rather than shown beside numbers that no longer describe it.
            session={
              focusView.focused === null ? previewTracedSessionContext : null
            }
            stats={[
              {
                label: "Spans",
                // Unplaced rows are part of the session, so the count that sits
                // above the unplaced strip has to include them or it contradicts
                // the strip it is introducing.
                value: String(summary.spanCount + unplacedInScope),
              },
              { label: "Depth", value: String(depthLevels) },
              { label: "Agents", value: String(summary.agentCount) },
              {
                label: "Wall clock",
                value: formatSessionTraceDuration(summary.wallClockMs),
              },
              {
                label: "Turn spend",
                value: formatSessionTraceCost(summary.costUsd),
              },
              // Two token populations, two stats, never one sum. Footprint is what
              // components injected into context; turn tokens are what the turns
              // billed, and the first is already inside the second.
              {
                label: "Footprint tokens",
                value: formatSessionTraceCount(summary.footprintTokens),
              },
              {
                label: "Turn tokens in / out",
                value: `${formatSessionTraceCount(summary.inputTokens)} / ${formatSessionTraceCount(summary.outputTokens)}`,
              },
              {
                label: "Cache read",
                value: formatSessionTraceCount(summary.cacheReadTokens),
              },
              {
                label: "Measured extents",
                value: `${summary.measuredSpanCount} of ${summary.spanCount}`,
              },
              { label: "Failed", value: String(summary.errorCount) },
            ]}
          />
          {/* The count is always visible on the Errors chip, so a failure is
              never dismissable. The LIST is disclosed by that chip, because a
              few failures are routine in any long-running session and a
              permanently open block would spend the top of the screen on them.
              It earns that space only once something marks it as anomalous or
              part of a trend, which is a cross-session feature that does not
              exist yet. */}
          {routeState.errorsOnly ? (
            <PreviewTraceErrorList
              errorFor={(span) =>
                extrasFor(span.invocation.externalInvocationId).detail?.error
              }
              failures={failures}
              onSelect={handleSelect}
            />
          ) : null}
          {focusView.focused === null ? null : (
            <SessionTraceFocusTrail
              focused={focusView.focused}
              onClearFocus={() =>
                patch({ focusId: null, windowFromMs: null, windowToMs: null })
              }
              onFocusSpan={handleFocusSubtree}
              trail={focusView.trail}
            />
          )}
          <div className="sticky top-0 z-10 bg-background">
            <SessionTraceToolbar
              activeKinds={activeKinds}
              canZoomToSpan={selected !== null}
              criticalPathOnly={routeState.criticalPathOnly}
              errorCount={trace.errorCount}
              errorsOnly={routeState.errorsOnly}
              failureStateSourced={trace.succeededReportedCount > 0}
              isZoomed={routeState.windowFromMs !== null}
              onFit={() => patch({ windowFromMs: null, windowToMs: null })}
              onToggleCriticalPath={() =>
                patch({ criticalPathOnly: !routeState.criticalPathOnly })
              }
              onToggleErrorsOnly={() =>
                patch({ errorsOnly: !routeState.errorsOnly })
              }
              onToggleKind={handleToggleKind}
              onZoomOut={handleZoomOut}
              onZoomToSpan={() => {
                if (selected === null) {
                  return;
                }
                patch({
                  windowFromMs: selected.startMs,
                  windowToMs: Math.max(selected.endMs, selected.startMs + 1),
                });
              }}
            />
            <SessionTraceChartRuler
              columns={columns}
              totalMs={trace.totalMs}
              windowFromMs={windowFromMs}
              windowToMs={windowToMs}
            />
          </div>
          <SessionTraceChartRows
            columns={columns}
            onSelect={handleSelect}
            selectedId={routeState.spanId}
            spans={drawnSpans}
            windowFromMs={windowFromMs}
            windowToMs={windowToMs}
          />
          <PreviewTraceUnplacedStrip unplaced={trace.unplaced} />
        </div>
        {/* The scrubber stays out of the scroll: it is the only pointer way to
            cut a window, and it describes the WHOLE session rather than the
            rows currently under the cursor. */}
        <PreviewTraceScrubber
          onReset={() => patch({ windowFromMs: null, windowToMs: null })}
          onWindowChange={(fromMs, toMs) =>
            patch({ windowFromMs: fromMs, windowToMs: toMs })
          }
          spans={flattenSpans(trace.roots)}
          totalMs={trace.totalMs}
          windowFromMs={windowFromMs}
          windowToMs={windowToMs}
        />
      </div>
      <aside
        aria-label="Span detail"
        className="w-full shrink-0 overflow-auto border-border border-t max-lg:max-h-2/5 lg:w-88 lg:border-t-0 lg:border-l"
      >
        <PreviewTraceInspector
          canFocusSubtree={selected !== null && selected.children.length > 0}
          extras={
            selected === null
              ? undefined
              : extrasFor(selected.invocation.externalInvocationId)
          }
          onFocusSubtree={handleFocusSubtree}
          onOpenComponent={handleOpenComponent}
          span={selected}
        />
      </aside>
    </div>
  );
}

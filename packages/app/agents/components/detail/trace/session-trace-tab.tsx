"use client";

/**
 * @file session-trace-tab.tsx
 * @description ISS-10737: the production session Trace tab — the leaf of a
 * root-cause drill-down (DOC-37 section 1), built from the prototype that is
 * now `apps/prototypes/app/p/session-trace-tab` — a route of its own since
 * ISS-11819, which also deleted the second copy of this chart it used to
 * carry. The sandbox renders THESE components over mock rows.
 *
 * You do not arrive here to admire a session. You arrive having seen an error
 * pattern across many sessions, and the question is not "did this session fail"
 * but WHERE — at the hand-off between agents, inside one shard of a fan-out, or
 * in a leaf tool ten levels down. Everything below follows from that: ancestry
 * is a first-class field, the critical path descends by DURATION rather than by
 * finish order, and every width says how it was known.
 *
 * THIS COMPONENT IS MOUNTED ONLY ON THE FLAG-ON BRANCH of the single read site
 * in `SessionDetailWorkspace`. That is the whole of the gate: the tab, the
 * `?tab=trace` deep link and the query behind it are all gated by this subtree
 * not existing when the flag is off, rather than by a boolean threaded into
 * each of them (`no-threaded-feature-flag`).
 */

import type { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { useMemo } from "react";
import { useSessionInvocationTree } from "../../../hooks/use-session-invocation-tree";
import { useSessionTraceRouteState } from "../../../hooks/use-session-trace-route-state";
import {
  buildSessionTrace,
  findSpanById,
  flattenSpans,
  selectDrawnSpans,
  summariseSessionTraceSpans,
} from "../../../lib/session-trace/build-session-trace";
import { buildSessionTraceDisclosure } from "../../../lib/session-trace/session-trace-disclosure";
import { resolveFocusView } from "../../../lib/session-trace/session-trace-drilldown";
import { formatSessionTraceDuration } from "../../../lib/session-trace/session-trace-format";
import {
  SESSION_TRACE_KIND_LABEL,
  SESSION_TRACE_KIND_ORDER,
  type SessionTraceSpan,
  toSessionTraceInvocation,
} from "../../../lib/session-trace/session-trace-node";
import {
  SessionTraceChartRows,
  SessionTraceChartRuler,
  type SessionTraceColumns,
} from "./session-trace-chart";
import { SessionTraceInspector } from "./session-trace-inspector";
import {
  SessionTraceFocusTrail,
  SessionTraceToolbar,
} from "./session-trace-toolbar";

export type SessionTraceTabProps = {
  sessionId: string;
};

export function SessionTraceTab({ sessionId }: SessionTraceTabProps) {
  const { data, isLoading, isError, isUnsupported } =
    useSessionInvocationTree(sessionId);
  const { routeState, setRouteState } = useSessionTraceRouteState();

  const trace = useMemo(
    () =>
      buildSessionTrace(
        (data?.items ?? []).map((row) => toSessionTraceInvocation(row))
      ),
    [data]
  );
  const disclosure = useMemo(
    () =>
      data === undefined
        ? null
        : buildSessionTraceDisclosure(trace, data.bound),
    [data, trace]
  );

  const focusView = resolveFocusView(
    trace.roots,
    routeState.focusId,
    trace.totalMs
  );
  const activeKinds = routeState.kinds ?? SESSION_TRACE_KIND_ORDER;
  const windowFromMs = routeState.windowFromMs ?? focusView.windowFromMs;
  const windowToMs = routeState.windowToMs ?? focusView.windowToMs;

  const lensedSpans = useMemo(
    () =>
      applyLenses(flattenSpans(focusView.roots), {
        activeKinds,
        errorsOnly: routeState.errorsOnly,
      }),
    [focusView.roots, activeKinds, routeState.errorsOnly]
  );
  const drawnSpans = selectDrawnSpans(lensedSpans, {
    windowFromMs,
    windowToMs,
    showCriticalPathOnly: routeState.criticalPathOnly,
  });
  const summary = summariseSessionTraceSpans(drawnSpans);
  const selectedSpan =
    routeState.spanId === null
      ? null
      : (findSpanById(trace.roots, routeState.spanId) ?? null);

  if (isUnsupported) {
    return (
      <SessionTraceNotice>
        This data source does not serve an invocation tree, so the trace cannot
        be drawn here. That is a statement about the source, not about the
        session — open this session in the web app to read its trace.
      </SessionTraceNotice>
    );
  }
  if (isLoading) {
    return (
      <div aria-busy="true" className="flex flex-col gap-2 p-4">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || data === undefined || disclosure === null) {
    return (
      <SessionTraceNotice>
        The invocation tree for this session could not be loaded. Nothing below
        is a claim about the session — reload to try again.
      </SessionTraceNotice>
    );
  }
  if (data.total === 0) {
    return (
      <SessionTraceNotice>
        No agent components were recorded for this session, so there is no tree
        to draw. This is a measured zero, not a missing read.
      </SessionTraceNotice>
    );
  }

  const columns: SessionTraceColumns = {
    footprintSourced: trace.footprintReportedCount > 0,
    turnTokensSourced: trace.turnTokenReportedCount > 0,
  };

  return (
    <div className="flex min-w-0 flex-col">
      {/* The clip sentence leads, because a clipped tree's ancestry is WRONG
          rather than short and every number below inherits that. */}
      {disclosure.truncation === null ? null : (
        <p className="border-destructive/40 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
          {disclosure.truncation}
        </p>
      )}
      <SessionTraceToolbar
        activeKinds={activeKinds}
        canZoomToSpan={selectedSpan !== null}
        criticalPathOnly={routeState.criticalPathOnly}
        errorCount={trace.errorCount}
        errorsOnly={routeState.errorsOnly}
        failureStateSourced={trace.succeededReportedCount > 0}
        isZoomed={
          routeState.windowFromMs !== null || routeState.focusId !== null
        }
        onFit={() =>
          setRouteState({
            ...routeState,
            windowFromMs: null,
            windowToMs: null,
            focusId: null,
          })
        }
        onToggleCriticalPath={() =>
          setRouteState({
            ...routeState,
            criticalPathOnly: !routeState.criticalPathOnly,
          })
        }
        onToggleErrorsOnly={() =>
          setRouteState({ ...routeState, errorsOnly: !routeState.errorsOnly })
        }
        onToggleKind={(kind) =>
          setRouteState({ ...routeState, kinds: toggleKind(activeKinds, kind) })
        }
        onZoomOut={() =>
          setRouteState({
            ...routeState,
            windowFromMs: null,
            windowToMs: null,
          })
        }
        onZoomToSpan={() =>
          setRouteState({
            ...routeState,
            windowFromMs: selectedSpan?.startMs ?? null,
            windowToMs:
              selectedSpan === null
                ? null
                : Math.max(selectedSpan.endMs, selectedSpan.startMs + 1),
          })
        }
      />
      {focusView.focused === null ? null : (
        <SessionTraceFocusTrail
          focused={focusView.focused}
          onClearFocus={() =>
            setRouteState({
              ...routeState,
              focusId: null,
              windowFromMs: null,
              windowToMs: null,
            })
          }
          onFocusSpan={(span) =>
            setRouteState({
              ...routeState,
              focusId: span.invocation.externalInvocationId,
              windowFromMs: null,
              windowToMs: null,
            })
          }
          trail={focusView.trail}
        />
      )}
      {/* The coverage sentence sits directly above the ruler it qualifies: it is
          about every bar's WIDTH, and a reader must meet it before the axis. */}
      <p className="px-4 py-2 text-muted-foreground text-xs">
        {disclosure.extentCoverage}
      </p>
      <SessionTraceChartRuler
        columns={columns}
        totalMs={trace.totalMs}
        windowFromMs={windowFromMs}
        windowToMs={windowToMs}
      />
      <div className="flex min-w-0 items-start gap-2 max-lg:flex-col">
        <div className="min-w-0 flex-1">
          <SessionTraceChartRows
            columns={columns}
            onSelect={(span) =>
              setRouteState({
                ...routeState,
                spanId: span.invocation.externalInvocationId,
              })
            }
            selectedId={routeState.spanId}
            spans={drawnSpans}
            windowFromMs={windowFromMs}
            windowToMs={windowToMs}
          />
          <p className="px-4 py-2 text-muted-foreground text-xs">
            {`${summary.spanCount} of ${trace.spanCount} placed spans drawn · ${formatSessionTraceDuration(summary.wallClockMs)} wall clock across ${summary.agentCount} agent${summary.agentCount === 1 ? "" : "s"}.`}
          </p>
          {trace.unplaced.length === 0 ? null : (
            <section
              aria-label="Invocations with no timestamp"
              className="border-border border-t px-4 py-2 text-muted-foreground text-xs"
            >
              {`${trace.unplaced.length} invocation${trace.unplaced.length === 1 ? "" : "s"} carry no readable timestamp and cannot be placed on the axis. They are listed by position in the session: `}
              {trace.unplaced
                .map(
                  (invocation) =>
                    `#${invocation.sequence} ${SESSION_TRACE_KIND_LABEL[invocation.kind]} ${invocation.componentKey}`
                )
                .join(", ")}
            </section>
          )}
          {disclosure.missing.length === 0 ? null : (
            <section
              aria-label="Values this surface cannot compute yet"
              className="border-border border-t px-4 py-2"
            >
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {disclosure.missing.map((operand) => (
                  <li
                    className="text-muted-foreground text-xs"
                    key={operand.operand}
                  >
                    <span className="font-medium text-foreground">
                      {operand.label}
                    </span>
                    {` — ${operand.note}`}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        {selectedSpan === null ? null : (
          <div className="w-80 shrink-0 border-border border-l max-lg:w-full max-lg:border-t max-lg:border-l-0">
            <SessionTraceInspector
              onFocusSubtree={(span) =>
                setRouteState({
                  ...routeState,
                  focusId: span.invocation.externalInvocationId,
                  windowFromMs: null,
                  windowToMs: null,
                })
              }
              span={selectedSpan}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function SessionTraceNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-8 text-center text-muted-foreground text-sm">
      {children}
    </p>
  );
}

function toggleKind(
  activeKinds: readonly AgentComponentInvocationKind[],
  kind: AgentComponentInvocationKind
): readonly AgentComponentInvocationKind[] {
  const next = activeKinds.includes(kind)
    ? activeKinds.filter((candidate) => candidate !== kind)
    : [...activeKinds, kind];
  // An empty lens would draw nothing and offer no way back except the chips the
  // reader just emptied, so the last kind cannot be turned off.
  return next.length === 0 ? activeKinds : next;
}

/**
 * The kind and failure lenses, applied before the window lens.
 *
 * ERRORS-ONLY KEEPS EACH FAILURE'S ANCESTORS. A list of bare failed leaves would
 * drop the hand-off and the fan-out that the drill-down came to find, which is
 * the one question a flat telemetry stream cannot answer at all.
 */
export function applyLenses(
  spans: readonly SessionTraceSpan[],
  lens: {
    activeKinds: readonly AgentComponentInvocationKind[];
    errorsOnly: boolean;
  }
): readonly SessionTraceSpan[] {
  const byKind = spans.filter((span) =>
    lens.activeKinds.includes(span.invocation.kind)
  );
  if (!lens.errorsOnly) {
    return byKind;
  }
  // ANCESTORS ARE KEPT BY IDENTITY, never by name. `span.ancestry` holds
  // COMPONENT KEYS, so matching it against invocation ids keeps every OTHER
  // invocation of a component that merely shares a name with an ancestor — a
  // `Bash` that never failed, in a branch that never failed, presented as part
  // of the failing call's hand-off chain. The parent chain is walked instead,
  // which is the only edge that says "this call reached that one".
  const byId = new Map<string, SessionTraceSpan>();
  for (const span of spans) {
    byId.set(span.invocation.externalInvocationId, span);
  }
  const keep = new Set<string>();
  for (const span of spans) {
    if (span.invocation.succeeded !== false) {
      continue;
    }
    let cursor: SessionTraceSpan | undefined = span;
    // A corrupt parent cycle must not spin here: a node already kept has had
    // its whole chain walked, so meeting one ends the walk.
    while (cursor !== undefined) {
      const id = cursor.invocation.externalInvocationId;
      if (keep.has(id)) {
        break;
      }
      keep.add(id);
      // Annotated: without it `cursor` is inferred from an initializer that
      // references `cursor` itself (TS7022).
      const parentId: string | undefined =
        cursor.invocation.parentExternalInvocationId;
      cursor = parentId === undefined ? undefined : byId.get(parentId);
    }
  }
  return byKind.filter((span) =>
    keep.has(span.invocation.externalInvocationId)
  );
}

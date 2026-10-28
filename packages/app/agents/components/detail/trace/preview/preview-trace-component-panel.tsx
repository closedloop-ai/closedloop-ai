"use client";

/**
 * @file preview-trace-component-panel.tsx
 * @description The component drill-in: one agentic component's whole footprint
 * in this session, and the way back to the span you came from.
 *
 * WHY MEASURED TIME CARRIES ITS OWN DENOMINATOR HERE. A component that ran
 * eleven times but was bracketed only twice has a real measured total and a real
 * shortfall, and both have to travel together — "4.2s across 2 of 11 measured"
 * is a usable number, "4.2s" alone is a wrong one. The figure is published with
 * the coverage beside it rather than withheld for being partial.
 */

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { ArrowLeftIcon, CornerDownRightIcon } from "lucide-react";
import {
  formatSessionTraceCost,
  formatSessionTraceCount,
  formatSessionTraceDuration,
} from "../../../../lib/session-trace/session-trace-format";
import {
  SESSION_TRACE_KIND_LABEL,
  type SessionTraceSpan,
} from "../../../../lib/session-trace/session-trace-node";
import type { PreviewTraceComponentDrilldown } from "./preview-trace-component-drilldown";
import {
  PreviewTraceStat,
  PreviewTraceStatRow,
} from "./preview-trace-primitives";

export type PreviewTraceComponentPanelProps = {
  drilldown: PreviewTraceComponentDrilldown;
  onBack: () => void;
  onOpenSpan: (span: SessionTraceSpan) => void;
  /** Where Back returns to, named so the control is not a mystery. */
  backLabel: string;
};

export function PreviewTraceComponentPanel({
  drilldown,
  onBack,
  onOpenSpan,
  backLabel,
}: PreviewTraceComponentPanelProps) {
  const partiallyMeasured =
    drilldown.measuredOccurrenceCount < drilldown.invocationCount;
  const changedMidSession = drilldown.definitionHashes.length > 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="flex flex-col gap-2 border-border border-b px-4 py-3">
        <Button
          className="-ml-2 w-fit"
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          <ArrowLeftIcon />
          {backLabel}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            {SESSION_TRACE_KIND_LABEL[drilldown.kind]}
          </Badge>
          {drilldown.failureCount > 0 ? (
            <Badge variant="destructive">
              {`${drilldown.failureCount} failed`}
            </Badge>
          ) : null}
          {changedMidSession ? (
            <Badge variant="outline">Definition changed mid-session</Badge>
          ) : null}
        </div>
        <h3 className="m-0 break-all font-medium text-base text-foreground">
          {drilldown.componentKey}
        </h3>
      </header>

      <PreviewTraceStatRow className="border-border border-b px-4 py-3">
        <PreviewTraceStat
          description="How many times this component ran in the session."
          label="Invocations"
          value={String(drilldown.invocationCount)}
        />
        <PreviewTraceStat
          description="How many distinct agents called it, the main one included."
          label="Reached by"
          value={
            drilldown.agentIds.length === 0
              ? "—"
              : `${drilldown.agentIds.length} agent${drilldown.agentIds.length === 1 ? "" : "s"}`
          }
        />
        <PreviewTraceStat
          detail={
            partiallyMeasured
              ? `${drilldown.measuredOccurrenceCount} of ${drilldown.invocationCount} measured`
              : undefined
          }
          label="Measured time"
          value={formatSessionTraceDuration(drilldown.measuredMs)}
        />
        <PreviewTraceStat
          detail="already inside the session total"
          label="Turn spend"
          value={formatSessionTraceCost(drilldown.ownCostUsd)}
        />
      </PreviewTraceStatRow>

      {drilldown.footprintTokens === undefined ? null : (
        <p className="border-border border-b px-4 py-2 text-muted-foreground text-xs leading-relaxed">
          {`Context footprint ${formatSessionTraceCount(drilldown.footprintTokens)} tokens — a different population from turn spend, already counted inside the consuming turns' input.`}
        </p>
      )}

      <section className="flex min-h-0 flex-1 flex-col">
        <h4 className="m-0 px-4 py-2 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          Every time it ran, and what reached it
        </h4>
        <ul className="m-0 list-none p-0">
          {drilldown.occurrences.map((span) => (
            <li key={span.invocation.externalInvocationId}>
              <button
                className="flex w-full flex-col gap-1 border-border/40 border-b px-4 py-2 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2"
                onClick={() => onOpenSpan(span)}
                type="button"
              >
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-foreground text-xs tabular-nums">
                    {`#${span.invocation.sequence}`}
                  </span>
                  <span className="text-foreground text-xs">
                    {`${formatSessionTraceDuration(span.startMs)} in · ${formatSessionTraceDuration(span.subtreeMs)}`}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {span.extentSource === "measured" ? "measured" : "inferred"}
                  </span>
                  {span.onCriticalPath ? (
                    <span className="text-[11px] text-foreground">
                      critical path
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <CornerDownRightIcon aria-hidden="true" className="size-3" />
                  <span className="truncate">
                    {span.ancestry.length === 0
                      ? "session root"
                      : span.ancestry.join(" › ")}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

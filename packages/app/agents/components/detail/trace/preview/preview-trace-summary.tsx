"use client";

/**
 * @file preview-trace-summary.tsx
 * @description The header the chart is read through, and the rows the chart
 * could not place.
 *
 * The coverage sentence is stated ABOVE the chart, not under it. A session whose
 * spans are mostly inferred is a session whose bar widths are upper bounds, and
 * a reader who learns that afterwards has already read the widest bar as the
 * slowest call.
 */

import type { TracedSessionContext } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures/session/traced-session-model";
import { Badge } from "@repo/design-system/components/ui/badge";
import { CircleAlertIcon, CornerDownRightIcon } from "lucide-react";
import { formatSessionTraceCost } from "../../../../lib/session-trace/session-trace-format";
import {
  SESSION_TRACE_EXTENT_NOTE,
  SESSION_TRACE_KIND_LABEL,
  SessionTraceExtentSource,
  type SessionTraceInvocation,
  type SessionTraceSpan,
} from "../../../../lib/session-trace/session-trace-node";
import {
  PreviewTraceSectionHeading,
  PreviewTraceStat,
  PreviewTraceStatRow,
} from "./preview-trace-primitives";

export type PreviewTraceSummaryStat = { label: string; value: string };

export type PreviewTraceSummaryProps = {
  stats: readonly PreviewTraceSummaryStat[];
  /** The focused component, when the numbers describe a subtree and not the session. */
  scopeLabel: string | null;
  /** Session-grain context; null while a subtree is focused, since it is not scoped. */
  session: TracedSessionContext | null;
};

export function PreviewTraceSummary({
  stats,
  scopeLabel,
  session,
}: PreviewTraceSummaryProps) {
  return (
    <header className="flex flex-col gap-3 border-border border-b px-4 py-3">
      {scopeLabel === null ? null : (
        <p className="m-0 text-muted-foreground text-xs">
          Measuring{" "}
          <span className="font-medium text-foreground">{scopeLabel}</span> and
          everything under it, not the whole session.
        </p>
      )}
      <PreviewTraceStatRow>
        {stats.map((stat) => (
          <PreviewTraceStat
            description={PREVIEW_TRACE_STAT_DESCRIPTION[stat.label]}
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </PreviewTraceStatRow>
      {/* Session-grain signals that sit around the tree. Every one of these is
          already persisted and simply unread — the spend split by attribution
          confidence, the phase tiling's coverage, and whether the evidence
          behind this whole view reached the cloud. */}
      {session === null ? null : (
        <p className="m-0 text-muted-foreground text-xs leading-relaxed">
          <span className="text-foreground">{session.autonomyBand}</span> ·{" "}
          {`spend ${formatSessionTraceCost(session.spendHighConfidenceUsd + session.spendMediumConfidenceUsd)} attributed, ${formatSessionTraceCost(session.spendLowConfidenceUsd)} low confidence`}{" "}
          ·{" "}
          {`${session.segments.length} phases covering ${Math.round(session.segmentCoverage * 100)}%`}{" "}
          · {`transcript ${session.transcriptSyncStatus}`}
        </p>
      )}
    </header>
  );
}

/**
 * Every failure in the session, with the chain that reached it.
 *
 * This is the entry point the drill-down actually lands on: you arrive from an
 * error pattern seen across many sessions, and the question is not "did this
 * session fail" but WHERE — at the hand-off, inside one fan-out shard, or in a
 * leaf tool. So each row leads with the ancestry and the depth, not the message.
 *
 * Failure is never carried by colour alone (WCAG 1.4.1): the row states the word
 * and the exit status, and the icon is redundant to both.
 */
export function PreviewTraceErrorList({
  failures,
  onSelect,
  errorFor,
}: {
  failures: readonly SessionTraceSpan[];
  onSelect: (span: SessionTraceSpan) => void;
  /**
   * The failure message for one span, from the presumed-field side table. Not on
   * `SessionTraceInvocation`: no producer emits it, so absent renders nothing
   * rather than an empty line (ISS-11819).
   */
  errorFor: (span: SessionTraceSpan) => string | undefined;
}) {
  if (failures.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Failures in this session"
      className="border-border border-b"
    >
      <PreviewTraceSectionHeading
        className="px-4 pt-3 pb-1"
        count={failures.length}
        title="Failed"
      />
      <ul className="m-0 list-none p-0">
        {failures.map((span) => (
          <li key={span.invocation.externalInvocationId}>
            <button
              className="flex w-full flex-col gap-0.5 border-border/40 border-b px-4 py-2 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2"
              onClick={() => onSelect(span)}
              type="button"
            >
              <span className="flex flex-wrap items-center gap-1.5">
                <CircleAlertIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-destructive"
                />
                <span className="font-medium text-destructive text-xs">
                  Failed
                </span>
                <span className="text-foreground text-xs">
                  {`${SESSION_TRACE_KIND_LABEL[span.invocation.kind]} · ${span.invocation.componentKey}`}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {`depth ${span.depth + 1}`}
                </span>
              </span>
              {errorFor(span) === undefined ? null : (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {errorFor(span)}
                </span>
              )}
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
  );
}

/**
 * Invocations with no timestamp. Listed rather than dropped: the call happened,
 * and a chart that silently omits it reports a smaller session than the one that
 * ran.
 */
export function PreviewTraceUnplacedStrip({
  unplaced,
}: {
  unplaced: readonly SessionTraceInvocation[];
}) {
  if (unplaced.length === 0) {
    return null;
  }

  return (
    <section className="border-border border-t px-4 py-3">
      <PreviewTraceSectionHeading
        count={unplaced.length}
        title="Not placed on the axis"
      />
      <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
        {SESSION_TRACE_EXTENT_NOTE[SessionTraceExtentSource.Unresolved]}
      </p>
      <ul className="m-0 mt-2 flex list-none flex-wrap gap-2 p-0">
        {unplaced.map((invocation) => (
          <li key={invocation.externalInvocationId}>
            <Badge variant="outline">
              {`#${invocation.sequence} · ${SESSION_TRACE_KIND_LABEL[invocation.kind]} · ${invocation.componentKey}`}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What each stat COUNTS, one sentence, shown on the label's tooltip.
 *
 * Every figure in the grid is a sum or a count over a population, and letting a
 * reader guess wrong is the same defect as a bar that does not say how its width
 * was known. So the sums say "sum" and the counts say what population they
 * count. None of them says "this session": when a subtree is focused these
 * describe the subtree, and the scope line above the grid is what says so.
 */
export const PREVIEW_TRACE_STAT_DESCRIPTION: Readonly<Record<string, string>> =
  {
    Spans:
      "Every invocation in scope, including the ones with no timestamp that sit in the unplaced strip. More than the chart drew.",
    Depth:
      "The deepest nesting level in scope, counting the outermost row shown as 1.",
    Agents: "How many distinct agents took part, the main one included.",
    "Wall clock":
      "First start to last close. Not the sum of the spans, which overlap.",
    "Turn spend":
      "The sum of what every call in scope billed, not an average. Already inside the session's own total, so it is what this branch cost and never something to add to the session figure.",
    "Footprint tokens":
      "The sum of tokens components injected into context. A different population from turn tokens: this text is already counted inside the consuming turn's input, so the two are never added together.",
    "Turn tokens in / out":
      "The sum of input tokens and the sum of output tokens across every call in scope.",
    "Cache read":
      "The sum of cache-read tokens. Additive with input, not a subset of it.",
    "Measured extents":
      "How many bars have a width that is a real elapsed span. The rest are inferred: their width runs to the next sibling or the parent's close, which is an upper bound on latency, not latency.",
    Failed:
      "Invocations that reported a failure. A call that reported neither success nor failure is not counted either way.",
  };

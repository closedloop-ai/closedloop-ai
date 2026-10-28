"use client";

/**
 * @file session-trace-inspector.tsx
 * @description The selected span, in full.
 *
 * A FAILED SPAN LEADS WITH THE ERROR (DOC-37 section 6): if you selected a
 * failed span, the failure is what you came for, not something to reach by
 * scrolling past the token sections.
 *
 * THE TWO TOKEN POPULATIONS ARE NEVER SUMMED (DOC-37 section 4). Turn tokens and
 * context footprint sit in separate sections with separate headings, because a
 * component's injected text is already inside the consuming turn's input count:
 * one number is an ATTRIBUTION of the other, not an addition to it.
 *
 * AND AN UNSOURCED FIELD NAMES ITSELF. Every row below goes through
 * {@link SessionTraceField}, which renders the missing-operand sentence rather
 * than a dash or a zero when the value has no producer.
 */

import { Badge } from "@repo/design-system/components/ui/badge";
import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  formatSessionTraceAgentLineage,
  formatSessionTraceCost,
  formatSessionTraceCount,
  formatSessionTraceDuration,
} from "../../../lib/session-trace/session-trace-format";
import {
  SESSION_TRACE_EXTENT_LABEL,
  SESSION_TRACE_EXTENT_NOTE,
  SESSION_TRACE_KIND_LABEL,
  type SessionTraceSpan,
  sessionTraceKindSwatchStyle,
} from "../../../lib/session-trace/session-trace-node";

/**
 * User-facing, so it names neither the field nor the ticket that will supply it
 * (ISS-10718 widens the read row). What the reader needs is that this is
 * unknown rather than zero.
 */
const NOT_RECORDED = "Not recorded for this session";

export type SessionTraceInspectorProps = {
  span: SessionTraceSpan;
  onFocusSubtree: (span: SessionTraceSpan) => void;
};

export function SessionTraceInspector({
  span,
  onFocusSubtree,
}: SessionTraceInspectorProps) {
  const { invocation } = span;
  const failed = invocation.succeeded === false;

  return (
    <section
      aria-label={`Span detail: ${invocation.componentKey}`}
      className="flex min-w-0 flex-col gap-3 p-3"
    >
      {failed ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive text-xs">
          <CircleAlertIcon
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span>
            This call reported a failure. Its ancestry above is the hand-off
            chain that reached it.
          </span>
        </p>
      ) : null}

      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-xs"
          style={sessionTraceKindSwatchStyle(invocation.kind)}
        />
        <Badge variant="secondary">
          {SESSION_TRACE_KIND_LABEL[invocation.kind]}
        </Badge>
        <span className="min-w-0 truncate font-medium text-foreground text-sm">
          {invocation.componentKey}
        </span>
      </header>

      <SessionTraceField label="Ancestry">
        {span.ancestry.length === 0
          ? "A root of this session — nothing above it was recorded."
          : span.ancestry.join(" › ")}
      </SessionTraceField>

      <SessionTraceField
        label={`Extent · ${SESSION_TRACE_EXTENT_LABEL[span.extentSource]}`}
      >
        {`${formatSessionTraceDuration(span.subtreeMs)} — ${SESSION_TRACE_EXTENT_NOTE[span.extentSource]}`}
      </SessionTraceField>

      <SessionTraceField label="Agent">
        {formatSessionTraceAgentLineage(invocation.externalAgentId, undefined)}
      </SessionTraceField>

      <SessionTraceField label="Turn spend (this subtree)">
        {invocation.estimatedCost === undefined
          ? NOT_RECORDED
          : `${formatSessionTraceCost(span.subtreeCostUsd)} — already inside the session's own total, so it is what this branch cost and never something to add to the session figure.`}
      </SessionTraceField>

      <SessionTraceField label="Turn tokens in / out">
        {invocation.inputTokens === undefined &&
        invocation.outputTokens === undefined
          ? NOT_RECORDED
          : `${formatSessionTraceCount(span.subtreeInputTokens)} / ${formatSessionTraceCount(span.subtreeOutputTokens)}`}
      </SessionTraceField>

      <SessionTraceField label="Context footprint (a different population)">
        {invocation.footprintTokens === undefined
          ? NOT_RECORDED
          : `${formatSessionTraceCount(span.subtreeFootprintTokens)} tokens this component injected into turns that already counted them — never added to the turn tokens above.`}
      </SessionTraceField>

      <SessionTraceField label="Evidence class">
        {invocation.evidenceClass}
      </SessionTraceField>

      {invocation.definitionHash === undefined ? null : (
        <SessionTraceField label="Definition">
          {invocation.definitionHash}
        </SessionTraceField>
      )}

      <button
        className="self-start rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        onClick={() => onFocusSubtree(span)}
        type="button"
      >
        Focus this subtree
      </button>
    </section>
  );
}

function SessionTraceField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </span>
      <span className="break-words text-foreground text-xs">{children}</span>
    </div>
  );
}

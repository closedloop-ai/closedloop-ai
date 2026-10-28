"use client";

/**
 * @file preview-trace-inspector.tsx
 * @description Everything one span asserts, and how it knows each of it.
 *
 * TWO TOKEN POPULATIONS, NEVER FOLDED. The turn usage on an invocation is the
 * spend that call billed, and it is ALREADY inside the session total — so a
 * subtree roll-up of it answers "what did this branch cost", never "add this to
 * the session". `footprintTokens` is a different population again: tokens a
 * component injected into a turn whose own `inputTokens` already counted them.
 * The source type states both rules; this panel keeps them in separate blocks
 * with separate headings rather than summing them into one honest-looking total.
 */

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { CircleAlertIcon, ScanSearchIcon } from "lucide-react";
import {
  formatSessionTraceAgentLineage,
  formatSessionTraceCost,
  formatSessionTraceCount,
  formatSessionTraceDuration,
} from "../../../../lib/session-trace/session-trace-format";
import {
  SESSION_TRACE_EXTENT_LABEL,
  SESSION_TRACE_EXTENT_NOTE,
  SESSION_TRACE_KIND_LABEL,
  SessionTraceExtentSource,
  type SessionTraceInvocation,
  type SessionTraceSpan,
} from "../../../../lib/session-trace/session-trace-node";
import {
  formatPreviewConfirmationRate,
  formatPreviewFindingsCounts,
  previewFindingsFor,
  rollUpPreviewFindings,
  totalPreviewFindings,
} from "./preview-trace-findings";
import {
  PreviewTraceDetailRow,
  PreviewTraceSection,
} from "./preview-trace-primitives";
import {
  PREVIEW_EVIDENCE_LABEL,
  type PreviewSpanExtras,
} from "./preview-traced-session";

export type PreviewTraceInspectorProps = {
  span: SessionTraceSpan | null;
  /**
   * The two fields this sandbox presumes, from the side table keyed by
   * `externalInvocationId`. They are NOT on `SessionTraceInvocation` because no
   * producer emits them, and widening the production model to serve a sandbox is
   * the drift ISS-11819 removed. Absent means "not reported", never empty.
   */
  extras?: PreviewSpanExtras;
  onFocusSubtree: (span: SessionTraceSpan) => void;
  onOpenComponent: (span: SessionTraceSpan) => void;
  /** False when the span has no children, so focusing would show only itself. */
  canFocusSubtree: boolean;
};

export function PreviewTraceInspector({
  span,
  extras = {},
  onFocusSubtree,
  onOpenComponent,
  canFocusSubtree,
}: PreviewTraceInspectorProps) {
  if (span === null) {
    return (
      <div className="p-4">
        <p className="text-muted-foreground text-sm">
          Select a span to see its ancestry, its extent provenance, and the
          spend underneath it.
        </p>
      </div>
    );
  }

  const { invocation } = span;
  const hasTurnUsage =
    invocation.inputTokens !== undefined ||
    invocation.outputTokens !== undefined ||
    invocation.estimatedCost !== undefined;
  const failed = invocation.succeeded === false;
  // The failure block owns every key that describes the failure, so "What it
  // did" keeps only what the call was doing. No key is stated in both places.
  const activityDetail = Object.entries(extras.detail ?? {}).filter(
    ([key]) => !(failed && PREVIEW_FAILURE_DETAIL_KEYS.includes(key))
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            {SESSION_TRACE_KIND_LABEL[invocation.kind]}
          </Badge>
          {span.onCriticalPath ? <Badge>Critical path</Badge> : null}
          {/* No `Failed` badge here. On a failure the block below states the
              word, the exit code and the message at the top of the panel, and
              a badge saying it a second time is the one-fact-twice defect. */}
        </div>
        {/* The name IS the link. A component's name should navigate to that
            component wherever it appears, rather than a separate "Open X"
            button restating what the name already identifies. In production
            this is an href to the agentic-component detail route; here it
            opens the in-tab drill-in that stands in for it. */}
        <h3 className="break-all font-medium text-base">
          <button
            className="text-left text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2"
            onClick={() => onOpenComponent(span)}
            type="button"
          >
            {invocation.componentKey}
          </button>
        </h3>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Button
            disabled={!canFocusSubtree}
            onClick={() => onFocusSubtree(span)}
            size="sm"
            variant="ghost"
          >
            <ScanSearchIcon />
            Focus subtree
          </Button>
        </div>
      </header>

      <PreviewTraceSpanFailure detail={extras.detail} invocation={invocation} />

      <PreviewTraceSection title="Which call reached this one">
        <ol className="m-0 flex list-none flex-wrap items-center gap-x-1 gap-y-1 p-0 text-xs">
          <li className="text-muted-foreground">session root</li>
          {span.ancestry.map((step, index) => (
            <li
              className="flex items-center gap-1 text-muted-foreground"
              // Ancestry is a path, and the same component key legitimately
              // appears twice at different depths, so the key is the path
              // PREFIX that reached this step rather than the step alone.
              key={span.ancestry.slice(0, index + 1).join(">")}
            >
              <span aria-hidden="true">›</span>
              <span className="text-foreground">{step}</span>
            </li>
          ))}
        </ol>
        <PreviewTraceDetailRow label="Depth" value={String(span.depth + 1)} />
        <PreviewTraceDetailRow
          label="Agent"
          numeric={false}
          value={formatSessionTraceAgentLineage(
            invocation.externalAgentId,
            extras.parentAgentId
          )}
        />
        <PreviewTraceDetailRow
          label="Order in session"
          value={`#${invocation.sequence}`}
        />
      </PreviewTraceSection>

      <PreviewTraceSection title="Extent">
        <div className="flex items-center gap-2">
          <Badge
            className={cn(
              span.extentSource === SessionTraceExtentSource.Measured
                ? undefined
                : "border-dashed"
            )}
            variant="outline"
          >
            {SESSION_TRACE_EXTENT_LABEL[span.extentSource]}
          </Badge>
          <span className="font-mono text-foreground text-sm tabular-nums">
            {formatSessionTraceDuration(span.subtreeMs)}
          </span>
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {SESSION_TRACE_EXTENT_NOTE[span.extentSource]}
        </p>
        <PreviewTraceDetailRow
          label="Own time"
          numeric={false}
          value={`${formatSessionTraceDuration(span.selfMs)} not covered by a child`}
        />
        <PreviewTraceDetailRow
          label="Starts"
          numeric={false}
          value={`${formatSessionTraceDuration(span.startMs)} into the session`}
        />
      </PreviewTraceSection>

      {hasTurnUsage ? (
        <PreviewTraceSection title="Turn spend (already inside the session total)">
          <PreviewTraceDetailRow
            label="Model"
            numeric={false}
            value={invocation.model ?? "—"}
          />
          <PreviewTraceDetailRow
            label="Input"
            value={formatSessionTraceCount(invocation.inputTokens)}
          />
          <PreviewTraceDetailRow
            label="Output"
            value={formatSessionTraceCount(invocation.outputTokens)}
          />
          <PreviewTraceDetailRow
            label="Cache read"
            value={formatSessionTraceCount(invocation.cacheReadTokens)}
          />
          <PreviewTraceDetailRow
            label="This call"
            value={formatSessionTraceCost(invocation.estimatedCost)}
          />
          <PreviewTraceDetailRow
            label="This call and everything under it"
            value={formatSessionTraceCost(span.subtreeCostUsd)}
          />
          {invocation.usageMeasurement === undefined ? null : (
            <PreviewTraceDetailRow
              label="Counted"
              numeric={false}
              value={
                invocation.usageMeasurement === "measured"
                  ? "Bracketed around this call"
                  : "Derived from a session-wide average"
              }
            />
          )}
        </PreviewTraceSection>
      ) : null}

      <PreviewTraceSpanFindings span={span} />

      {invocation.footprintTokens === undefined ? null : (
        <PreviewTraceSection title="Context footprint (a different population)">
          <PreviewTraceDetailRow
            label="Injected into context"
            value={`${formatSessionTraceCount(invocation.footprintTokens)} tokens`}
          />
          <p className="text-muted-foreground text-xs leading-relaxed">
            These tokens are already inside the consuming turn's input count.
            They attribute that input to this component; they do not add to it.
          </p>
        </PreviewTraceSection>
      )}

      {activityDetail.length === 0 ? null : (
        <PreviewTraceSection title="What it did">
          {activityDetail.map(([label, value]) => (
            <PreviewTraceDetailRow key={label} label={label} value={value} />
          ))}
        </PreviewTraceSection>
      )}

      <PreviewTraceSection title="Evidence">
        <PreviewTraceDetailRow
          label="Attribution"
          numeric={false}
          value={invocation.attributionStatus}
        />
        {/* Which source won, per invocation. A flat stream has no per-record
            provenance to report here at all. */}
        <PreviewTraceDetailRow
          label="Attributed from"
          numeric={false}
          value={
            invocation.evidenceClass === undefined
              ? "—"
              : PREVIEW_EVIDENCE_LABEL[invocation.evidenceClass]
          }
        />
        <PreviewTraceDetailRow
          label="Definition hash"
          value={invocation.definitionHash ?? "—"}
        />
        <PreviewTraceDetailRow
          label="Component version"
          value={invocation.definitionVersionId ?? "—"}
        />
        <PreviewTraceDetailRow label="Pack" value={invocation.packId ?? "—"} />
        <PreviewTraceDetailRow
          label="Ran against"
          numeric={false}
          value={
            invocation.repositoryCommit === undefined
              ? "—"
              : `${invocation.repositoryFullName ?? "?"} @ ${invocation.repositoryCommit}`
          }
        />
        <PreviewTraceDetailRow
          label="Invocation id"
          value={invocation.externalInvocationId}
        />
      </PreviewTraceSection>
    </div>
  );
}

/**
 * The detail keys that describe the FAILURE rather than the work.
 *
 * `error` is not in the list because it is the block's headline rather than one
 * of its rows, but it is hoisted the same way: on a failed span none of these
 * four appear under "What it did".
 */
const PREVIEW_FAILURE_DETAIL_KEYS: readonly string[] = [
  "error",
  "exit code",
  "decision",
  "blocking",
];

/**
 * What went wrong, at the top of the panel.
 *
 * WHY IT LEADS. The error used to be the third label/value row of a "What it
 * did" table four sections down, so reading a failed `Bash` at depth 10 meant
 * scrolling past healthy-looking metadata to reach the one fact the panel was
 * opened for. Ancestry still matters on a failure, arguably more, it just does
 * not go first.
 *
 * FAILURE IS NOT CARRIED BY COLOUR (WCAG 1.4.1). The block says the word and
 * the exit code in text, and `Alert` gives it `role="alert"`. The tint and the
 * icon are reinforcement, not the signal.
 */
function PreviewTraceSpanFailure({
  invocation,
  detail: reported,
}: {
  invocation: SessionTraceInvocation;
  detail: Readonly<Record<string, string>> | undefined;
}) {
  if (invocation.succeeded !== true && invocation.succeeded !== false) {
    return null;
  }
  if (invocation.succeeded) {
    return null;
  }

  const detail = reported ?? {};
  const exitCode = detail["exit code"];
  const rows = PREVIEW_FAILURE_DETAIL_KEYS.filter(
    (key) => key !== "error" && key !== "exit code" && detail[key] !== undefined
  );

  return (
    <Alert variant="error">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle className="line-clamp-none flex flex-col gap-1">
        <span className="font-medium text-xs uppercase tracking-wide">
          {exitCode === undefined ? "Failed" : `Failed · exit ${exitCode}`}
        </span>
        <span className="font-normal text-base leading-snug">
          {detail.error ?? "No error message was recorded for this call."}
        </span>
      </AlertTitle>
      {rows.length === 0 ? null : (
        <AlertDescription>
          <div className="flex w-full flex-col gap-1">
            {rows.map((key) => (
              <PreviewTraceDetailRow
                key={key}
                label={key}
                value={detail[key]}
              />
            ))}
          </div>
        </AlertDescription>
      )}
    </Alert>
  );
}

/**
 * What this call FOUND, read beside what it cost.
 *
 * SPEND AND COUNTS SIT TOGETHER AND ARE NOT DIVIDED. The headline is
 * `$0.4820 · 11 findings, 4 invalidated` and the reader makes the judgement. A
 * dollars-per-finding figure would look precise and be fabricated, because the
 * tokens behind one finding are not separable from the rest of the turn.
 *
 * UNKNOWN IS NOT ZERO. A span with no ledger entry and nothing reporting
 * underneath renders no section at all, rather than a row of zeroes. "Looked
 * and found nothing" and "does not report findings" are different facts.
 */
function PreviewTraceSpanFindings({ span }: { span: SessionTraceSpan }) {
  const subtree = rollUpPreviewFindings(span);
  if (subtree === undefined) {
    return null;
  }

  const own = previewFindingsFor(span.invocation);
  const ownTotals = own === undefined ? undefined : totalPreviewFindings([own]);
  const fanOutLabel =
    ownTotals === undefined
      ? "Under this call"
      : "This call and everything under it";
  const showsFanOut =
    ownTotals === undefined || subtree.reportingInvocationCount > 1;

  return (
    <PreviewTraceSection title="Findings">
      {ownTotals === undefined ? null : (
        <>
          <p className="m-0 font-mono text-foreground text-sm tabular-nums">
            {span.invocation.estimatedCost === undefined
              ? formatPreviewFindingsCounts(ownTotals)
              : `${formatSessionTraceCost(span.invocation.estimatedCost)} · ${formatPreviewFindingsCounts(ownTotals)}`}
          </p>
          <PreviewTraceDetailRow
            label="Confirmed"
            value={String(ownTotals.findingsConfirmed)}
          />
          <PreviewTraceDetailRow
            label="Confirmation rate"
            value={formatPreviewConfirmationRate(ownTotals)}
          />
        </>
      )}
      {showsFanOut ? (
        <PreviewTraceDetailRow
          label={fanOutLabel}
          value={`${formatPreviewFindingsCounts(subtree)} · ${formatPreviewConfirmationRate(subtree)}`}
        />
      ) : null}
      <p className="text-muted-foreground text-xs leading-relaxed">
        Spend and findings are stated side by side, never divided into each
        other. Confirmed is emitted minus invalidated, derived here rather than
        stored, so the three cannot drift.
      </p>
    </PreviewTraceSection>
  );
}

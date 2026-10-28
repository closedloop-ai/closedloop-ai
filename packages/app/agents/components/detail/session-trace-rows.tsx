"use client";

import type { AgentComponentInvocationAnchor } from "@repo/api/src/types/agent-component-invocation";
import type { TurnItem } from "@repo/api/src/types/agent-session";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { cn } from "@repo/design-system/lib/utils";
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { memo, useState } from "react";
import { transcriptIdentityMatchesInvocationAnchor } from "../../lib/transcript-turn-items";
import {
  buildTraceToolRows,
  computeGroupCostLabel,
  type TraceGroup,
  type TraceToolItem,
} from "./session-trace-groups";
import type { SessionTraceRowRendererProps } from "./session-trace-row-contract";
import { getTraceTextHighlight } from "./session-trace-selection";
import { SessionTraceSubagent } from "./session-trace-subagent";
import { SessionTraceToolRowDetail } from "./session-trace-tool-row-detail";
import { TraceMarkBullet } from "./trace-mark-bullet";
import { TraceMessageBody } from "./trace-message-body";
import { formatTraceClock, invocationAnchorTarget } from "./trace-row-utils";

// Memoized so a scroll-driven `activeRow` change (which flips only the ≤2 rows
// entering/leaving the fold) doesn't re-render — and re-render the markdown body
// of — every mounted row. `active` is a plain boolean resolved by the caller
// (`renderTraceGroup`), and every other prop is referentially stable across a
// scroll, so unaffected rows bail out. See `renderTraceGroup`'s note.
export const TraceMessageRow = memo(function TraceMessageRow({
  active,
  group,
  highlightAnchor,
  invocationAnchor,
  onJump,
  renderGutterActor,
  selectionEnabled,
}: Readonly<
  SessionTraceRowRendererProps<Extract<TraceGroup, { kind: "msg" }>>
>) {
  const human = group.side === "human";
  const tone = getBubbleTone(human);
  // Show how long the coalesced AGENT turn took (last item − first item) under
  // the start time, rather than a second wall-clock stamp. Human groups have no
  // execution duration, so they keep just the timestamp. Sub-second spans (e.g.
  // a lone text bubble) are omitted so single-item rows show one timestamp only.
  const durationMs =
    !human && group.startMs != null && group.endMs != null
      ? group.endMs - group.startMs
      : null;
  const durationLabel =
    durationMs != null && durationMs >= 1000
      ? formatDurationMs(durationMs)
      : null;
  const startLabel =
    group.startMs == null ? group.startLabel : formatTraceClock(group.startMs);
  const { cost, cumulativeTitle } = computeGroupCostLabel(human, group);

  return (
    <div
      className={cn("st-msg", human ? "right" : "left")}
      data-active={active ? "true" : undefined}
      data-row={group.row}
    >
      <div
        className={cn(
          "st-bubble",
          group.flagReason && "st-flagged",
          tone.className
        )}
      >
        {group.flagReason ? (
          <div className="st-flag-tag">{group.flagReason}</div>
        ) : null}
        {group.segments.map((segment) => {
          if (segment.type === "tools") {
            return (
              <SessionTraceTools
                invocationAnchor={invocationAnchor}
                item={segment.item}
                key={`tools-${segment.item._row}`}
              />
            );
          }
          if (segment.type === "subagent") {
            return (
              <SessionTraceSubagent
                invocationAnchor={invocationAnchor}
                item={segment.item}
                key={`subagent-${segment.item._row}`}
              />
            );
          }
          return (
            <div
              data-invocation-anchor-target={invocationAnchorTarget(
                segment.transcriptIdentity,
                invocationAnchor
              )}
              key={`text-${segment.row}`}
            >
              <TraceMessageBody
                onJump={onJump}
                text={segment.text}
                traceActor={group.actor}
                traceHighlight={getTraceTextHighlight(
                  highlightAnchor,
                  segment.row,
                  segment.text,
                  segment.traceId,
                  segment.turnId
                )}
                traceId={segment.traceId}
                traceRow={segment.row}
                traceSelectionEnabled={selectionEnabled}
                traceSessionId={group.sessionId}
                traceText={segment.text}
                traceTurnId={segment.turnId}
              />
            </div>
          );
        })}
        {!human && group.model ? (
          <div className="st-model mono">{group.model}</div>
        ) : null}
      </div>
      <div className="st-gut">
        {renderGutterActor?.(group.actor)}
        <span className="st-gut-line">{startLabel ?? ""}</span>
        <span className="st-gut-bot">
          {durationLabel ? (
            <span className="st-gut-line">{durationLabel}</span>
          ) : null}
          {cost ? (
            <span className="st-gut-line cost" title={cumulativeTitle}>
              {cost}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
});

export const TraceReasonRow = memo(function TraceReasonRow({
  active,
  group,
  highlightAnchor,
  invocationAnchor,
  onJump,
  renderGutterActor,
  selectionEnabled,
}: Readonly<
  SessionTraceRowRendererProps<Extract<TraceGroup, { kind: "reason" }>>
>) {
  const [open, setOpen] = useState(true);
  const startLabel =
    group.startMs == null ? group.startLabel : formatTraceClock(group.startMs);

  return (
    <div
      className="st-msg left"
      data-active={active ? "true" : undefined}
      data-invocation-anchor-target={invocationAnchorTarget(
        group.transcriptIdentity,
        invocationAnchor
      )}
      data-row={group.row}
    >
      <div className="st-bubble st-reason p-agent">
        <button
          aria-expanded={open}
          className="st-reason-head"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <BrainIcon aria-hidden className="size-3.5" />
          <span className="st-reason-label">Reasoning</span>
          {open ? (
            <ChevronDownIcon aria-hidden className="st-reason-chev size-3.5" />
          ) : (
            <ChevronRightIcon aria-hidden className="st-reason-chev size-3.5" />
          )}
        </button>
        {open ? (
          <TraceMessageBody
            onJump={onJump}
            text={group.text}
            traceActor={group.actor}
            traceHighlight={getTraceTextHighlight(
              highlightAnchor,
              group.row,
              group.text,
              group.traceId,
              group.turnId
            )}
            traceId={group.traceId}
            traceRow={group.row}
            traceSelectionEnabled={selectionEnabled}
            traceSessionId={group.sessionId}
            traceText={group.text}
            traceTurnId={group.turnId}
          />
        ) : null}
        {group.model ? (
          <div className="st-model mono">{group.model}</div>
        ) : null}
      </div>
      <div className="st-gut">
        {renderGutterActor?.(group.actor)}
        <span className="st-gut-line">{startLabel ?? ""}</span>
      </div>
    </div>
  );
});

function SessionTraceTools({
  item,
  invocationAnchor,
}: Readonly<{
  item: Extract<TurnItem, { type: "tools" }>;
  invocationAnchor?: AgentComponentInvocationAnchor | null;
}>) {
  // A card with no per-tool rows (degraded trace) renders as a static summary,
  // never a dropdown that opens to nothing. Derive expandability from the raw
  // item so the per-row keys are built only when the body is actually shown.
  const expandable = item.items.length > 0;
  const anchored = item.items.some((tool) =>
    transcriptIdentityMatchesInvocationAnchor(
      tool.transcriptIdentity,
      invocationAnchor
    )
  );
  const [userOpen, setUserOpen] = useState(
    Boolean(item.defaultOpen || item.hasFail)
  );
  const open = anchored || userOpen;
  const ToolsChevron = open ? ChevronDownIcon : ChevronRightIcon;

  const summary = (
    <>
      {item.hasFail ? <TraceMarkBullet color="r" /> : null}
      <span className="st-tools-summary">{item.summary}</span>
      {item.hasFail ? (
        <span className="st-fail-pill">
          <TriangleAlertIcon aria-hidden className="size-2.5" />
          {item.failN || 1} failed
        </span>
      ) : null}
      {/* Only the expandable variant carries a chevron — a card with no per-tool
          rows (degraded trace) renders as a static summary, never a dropdown
          that opens to nothing. */}
      {expandable ? (
        <ToolsChevron aria-hidden className="st-tools-chev size-3.5" />
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "st-tools",
        expandable && open && "open",
        item.hasFail && "has-fail"
      )}
      data-row={item._row}
    >
      {expandable ? (
        <button
          aria-expanded={open}
          className="st-tools-head"
          onClick={() => setUserOpen((value) => !value)}
          type="button"
        >
          {summary}
        </button>
      ) : (
        <div className="st-tools-head st-tools-head-static">{summary}</div>
      )}
      {expandable && open ? (
        <div className="st-tools-body">
          {buildTraceToolRows(item.items).map(({ key, tool }) => (
            <SessionTraceToolRow
              invocationAnchor={invocationAnchor}
              key={key}
              tool={tool}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * FEA-3547: one per-call row inside an expanded `Ran N tools` card. The row is a
 * button that toggles a detail panel revealing that call's command/input,
 * output, duration, and status — matching the group-expand pattern above. When
 * the producer captured no detail (transcript missing — cloud DB events strip
 * `data`), the row still expands and shows an explicit empty state instead of a
 * dead chevron.
 */
function SessionTraceToolRow({
  tool,
  invocationAnchor,
}: Readonly<{
  tool: TraceToolItem;
  invocationAnchor?: AgentComponentInvocationAnchor | null;
}>) {
  const [open, setOpen] = useState(false);
  const RowChevron = open ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div
      className={cn("st-toolrow-wrap", open && "open")}
      data-invocation-anchor-target={invocationAnchorTarget(
        tool.transcriptIdentity,
        invocationAnchor
      )}
    >
      <button
        aria-expanded={open}
        className={cn("st-toolrow", tool.err && "err")}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className={cn("st-tool-label mono")}>{tool.label}</span>
        {tool.detail ? (
          <span className="st-tool-detail">{tool.detail}</span>
        ) : null}
        <RowChevron aria-hidden className="st-toolrow-chev size-3" />
      </button>
      {open ? <SessionTraceToolRowDetail tool={tool} /> : null}
    </div>
  );
}

function getBubbleTone(human: boolean): { className: string } {
  return {
    className: human ? "p-human" : "p-agent",
  };
}

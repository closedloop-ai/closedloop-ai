"use client";

import type { AgentComponentInvocationAnchor } from "@repo/api/src/types/agent-component-invocation";
import type { TurnItem } from "@repo/api/src/types/agent-session";
import { cn } from "@repo/design-system/lib/utils";
import { memo } from "react";
import {
  containsHarnessTag,
  renderTraceEventContent,
} from "./trace-harness-tags";
import {
  formatTraceTimestamp,
  getEventDotClassName,
  invocationAnchorTarget,
} from "./trace-row-utils";

/**
 * A coalesced system/event line in the Session Trace. Owned by `session-trace.tsx`,
 * which builds it in `buildTraceGroups`.
 */
export type TraceEventGroup = {
  kind: "event";
  item: Extract<TurnItem, { type: "event" }>;
  row: number;
};

/**
 * Renders one event/system row.
 *
 * Extracted from `session-trace.tsx` (ISS-4767): the row's shell is chosen by a
 * three-way rule (chip block / plain separator / clickable separator) that has
 * its own reasons to change, and the trace shell was already over the file-size
 * ceiling.
 */
export const TraceEventRow = memo(function TraceEventRow({
  active,
  group,
  invocationAnchor,
  onJump,
}: Readonly<{
  active?: boolean;
  group: TraceEventGroup;
  invocationAnchor?: AgentComponentInvocationAnchor | null;
  onJump?: (row: number) => void;
}>) {
  const dotClassName = getEventDotClassName(group.item.dot);
  // A folded harness tag renders as a chip whose head is a `<button>`. Never wrap
  // such a row in the clickable separator `<button>` below: it would be a button
  // inside a button (invalid DOM) and expanding the chip would bubble a timeline
  // jump. It also renders left-aligned rather than as a centered separator row,
  // so the tall expanded body is not crammed between the separator's two dashes.
  const hasTag = containsHarnessTag(group.item.text);
  const clickable = Boolean(onJump) && !hasTag;
  const anchorTarget = invocationAnchorTarget(
    group.item.transcriptIdentity,
    invocationAnchor
  );
  const content = (
    <>
      {dotClassName ? (
        <span aria-hidden className={cn("st-sys-dot", dotClassName)} />
      ) : null}
      <span className="st-sysline-text">
        {renderTraceEventContent(group.item.text, onJump)}
      </span>
      <span className="st-time">{formatTraceTimestamp(group.item.t)}</span>
    </>
  );

  if (hasTag) {
    return (
      <div
        className="st-sysline st-sysline-tag"
        data-active={active ? "true" : undefined}
        data-invocation-anchor-target={anchorTarget}
        data-row={group.row}
      >
        {content}
      </div>
    );
  }

  if (!clickable) {
    return (
      <div
        className="st-sysline"
        data-active={active ? "true" : undefined}
        data-invocation-anchor-target={anchorTarget}
        data-row={group.row}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      className="st-sysline w-full border-0 bg-transparent"
      data-active={active ? "true" : undefined}
      data-invocation-anchor-target={anchorTarget}
      data-row={group.row}
      onClick={() => onJump?.(group.row)}
      type="button"
    >
      {content}
    </button>
  );
});

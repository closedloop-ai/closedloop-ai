"use client";

import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { SessionTrace } from "@repo/app/agents/components/detail/session-trace";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MessageSquareIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { BranchActorColorDomain } from "../lib/branch-actor-domain";
import { mergedTraceToSessionTraceItems } from "../lib/branch-merged-trace-adapter";

/**
 * Combined cross-session merged-trace (D2, deferred from Epic D) — REUSES the
 * shared, design-matching agents `SessionTrace` rather than a bespoke renderer.
 * The contract's lean `MergedTraceItem[]` is adapted to `SessionTrace`'s
 * `TurnItem` shape (`branch-merged-trace-adapter`), so the branch trace gets the
 * same quiet bubbles / tool + subagent rows / gutter timings as the Session
 * detail page. Shares the `activeRow` / `onJump` contract with `SessionTrace`, so
 * the composition wires it to the shared E2 playhead controller; the actor color
 * domain (shared with E1/E4) tints the avatars so a given actor is one color
 * across the whole page.
 */
export type BranchMergedTraceProps = {
  traceItems: readonly MergedTraceItem[];
  /** Shared actor domain so trace-avatar colors match E1/E4; else derived. */
  actorDomain?: BranchActorColorDomain;
  activeRow?: number | null;
  onJump?: (row: number) => void;
  /**
   * Subscribe to timeline-driven scrubs (the E2 controller's `registerTraceScroll`)
   * so a bar/playhead scrub scrolls the trace to the matching row. Trace-internal
   * clicks don't fire this, so the trace never yanks itself on its own clicks.
   */
  registerScroll?: (onActive: (row: number) => void) => () => void;
  className?: string;
};

/**
 * Scroll the trace so the row nearest to `row` is centered. The notified row is a
 * source `_row`; rows are coalesced into groups, so target the rendered element
 * with the greatest `data-row` that is ≤ `row` (its containing group/segment),
 * falling back to the first row when the scrub lands before any rendered row.
 *
 * Scrolls ONLY the bounded `container` (its own `scrollTop`) — never
 * `scrollIntoView`, which walks up and scrolls the nearest scrollable ancestor.
 * On the branch detail page that ancestor is the whole-page scroll container, so
 * a scrub would yank the entire page (the reported bug). Scrolling the trace
 * viewport in place mirrors the Session detail page's `.sd3-scroll` behavior.
 */
function scrollTraceToRow(container: HTMLElement | null, row: number): void {
  if (!container) {
    return;
  }
  let target: HTMLElement | null = null;
  let targetRow = Number.NEGATIVE_INFINITY;
  let firstNode: HTMLElement | null = null;
  let firstRow = Number.POSITIVE_INFINITY;
  for (const node of container.querySelectorAll<HTMLElement>("[data-row]")) {
    const value = Number(node.getAttribute("data-row"));
    if (Number.isNaN(value)) {
      continue;
    }
    if (value < firstRow) {
      firstRow = value;
      firstNode = node;
    }
    if (value <= row && value > targetRow) {
      targetRow = value;
      target = node;
    }
  }
  const node = target ?? firstNode;
  if (!node) {
    return;
  }
  const containerRect = container.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  // Offset that centers the node within the viewport (the `block: "center"`
  // equivalent), clamped by the browser to the container's scroll range.
  const center = (container.clientHeight - nodeRect.height) / 2;
  container.scrollTo({
    top: container.scrollTop + (nodeRect.top - containerRect.top - center),
    behavior: "smooth",
  });
}

export function BranchMergedTrace({
  traceItems,
  actorDomain,
  activeRow,
  onJump,
  registerScroll,
  className,
}: BranchMergedTraceProps) {
  const items = useMemo(
    () => mergedTraceToSessionTraceItems(traceItems, actorDomain),
    [traceItems, actorDomain]
  );
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!registerScroll) {
      return;
    }
    return registerScroll((row) => scrollTraceToRow(containerRef.current, row));
  }, [registerScroll]);

  if (traceItems.length === 0) {
    return (
      <EmptyState
        className={className}
        description="No trace captured for this branch yet."
        icon={MessageSquareIcon}
        title="No merged trace"
      />
    );
  }

  return (
    // Bounded scroll viewport: a timeline scrub scrolls the trace in place here,
    // never the whole branch page (see `scrollTraceToRow`).
    <div className="bq-trace-scroll" ref={containerRef}>
      <SessionTrace
        activeRow={activeRow}
        className={className}
        items={items}
        onJump={onJump}
      />
    </div>
  );
}

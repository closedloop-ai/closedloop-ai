"use client";

import type { TraceTextAnchor } from "@repo/api/src/types/comment";
import type { RefObject } from "react";
import { useEffect } from "react";

/**
 * PLN-2162 M6: what the Session shell hands the trace when the unified comments
 * pane, not the legacy rail, hosts the Session's comments. The trace reports
 * its selection and publishes its row jump; the legacy rail and its reads stay
 * off.
 */
export type SessionTraceCommentsHost = {
  highlightAnchor: TraceTextAnchor | null;
  /** Holds the trace's row jump while the trace is mounted. */
  jumpToRowRef: RefObject<((row: number) => void) | null>;
  onTraceSelectionChange: (anchor: TraceTextAnchor | null) => void;
};

/** Publishes the trace's row jump to the host for as long as the trace is mounted. */
export function usePublishTraceJump(
  host: SessionTraceCommentsHost | undefined,
  jumpToRow: (row: number) => unknown
) {
  const jumpToRowRef = host?.jumpToRowRef;
  useEffect(() => {
    if (!jumpToRowRef) {
      return;
    }
    const jump = (row: number) => {
      jumpToRow(row);
    };
    jumpToRowRef.current = jump;
    return () => {
      if (jumpToRowRef.current === jump) {
        jumpToRowRef.current = null;
      }
    };
  }, [jumpToRow, jumpToRowRef]);
}

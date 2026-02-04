"use client";

import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import { useState } from "react";

type UseExecutionLogDialogReturn = {
  /**
   * Whether the dialog is open
   */
  dialogOpen: boolean;
  /**
   * The trace to display in the dialog
   */
  dialogTrace: ExecutionTrace | undefined;
  /**
   * The selected session ID for the trace
   */
  selectedSessionId: string | undefined;
  /**
   * Handler to open the dialog with a specific trace
   */
  handleViewFullTrace: (trace: ExecutionTrace, sessionId?: string) => void;
  /**
   * Handler to set the dialog open state
   */
  setDialogOpen: (open: boolean) => void;
};

/**
 * Custom hook to manage execution log dialog state.
 * Extracts common state management pattern used across all metadata panels.
 */
export function useExecutionLogDialog(): UseExecutionLogDialogReturn {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTrace, setDialogTrace] = useState<ExecutionTrace>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();

  function handleViewFullTrace(
    trace: ExecutionTrace,
    sessionId?: string
  ): void {
    setDialogTrace(trace);
    setSelectedSessionId(sessionId);
    setDialogOpen(true);
  }

  return {
    dialogOpen,
    dialogTrace,
    selectedSessionId,
    handleViewFullTrace,
    setDialogOpen,
  };
}

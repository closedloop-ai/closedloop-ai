/**
 * @file use-audit-file.ts
 * @description FEA-3849 (PRD-556 M3) — the "File to ClosedLoop" controller hook.
 *
 * Owns the renderer side of filing the user's SELECTED findings. It NEVER files
 * automatically — `file()` is only invoked by an explicit user action (select +
 * confirm) in the view. It drives `window.desktopApi.audit.file`, stores the
 * settled result (per-finding outcomes + counts) as a phase, and keys each call
 * by a monotonic token so a superseded file call resolves with `null` (the view
 * correlates outcomes to rows by request position — see `audit-file-model`).
 */

import { useCallback, useRef, useState } from "react";
import type {
  AuditFileRequest,
  AuditFileResult,
} from "../../../shared/audit-contract";

/** The lifecycle phase of one file-to-ClosedLoop action. */
export const AuditFilePhase = {
  Idle: "idle",
  Filing: "filing",
  Complete: "complete",
} as const;
export type AuditFilePhase =
  (typeof AuditFilePhase)[keyof typeof AuditFilePhase];

export type AuditFileState = {
  phase: AuditFilePhase;
  /** The settled result (per-finding outcomes + counts + refusal), or null. */
  result: AuditFileResult | null;
};

const IDLE_STATE: AuditFileState = {
  phase: AuditFilePhase.Idle,
  result: null,
};

export type UseAuditFile = AuditFileState & {
  /** File the given request. Resolves with the result (also stored in state). */
  file: (request: AuditFileRequest) => Promise<AuditFileResult | null>;
  /** Reset back to idle (e.g. after the user dismisses the outcome banner). */
  reset: () => void;
};

/** Controller for a single "File to ClosedLoop" action over selected findings. */
export function useAuditFile(): UseAuditFile {
  const [state, setState] = useState<AuditFileState>(IDLE_STATE);
  // Monotonic token: only the latest file call's result is applied.
  const fileTokenRef = useRef(0);

  const file = useCallback(async (request: AuditFileRequest) => {
    const audit = window.desktopApi?.audit;
    if (!audit?.file) {
      return null;
    }
    const token = fileTokenRef.current + 1;
    fileTokenRef.current = token;
    setState({ phase: AuditFilePhase.Filing, result: null });
    const result = await audit.file(request);
    // A newer file call (or a reset from a fresh audit run) superseded this one
    // — drop the stale result entirely: do not update state AND signal
    // supersession to the caller with null, so a late continuation can never
    // clear findings from a run it no longer belongs to.
    if (fileTokenRef.current !== token) {
      return null;
    }
    setState({ phase: AuditFilePhase.Complete, result });
    return result;
  }, []);

  const reset = useCallback(() => {
    // Bump the token so any in-flight call's late result is ignored after reset.
    fileTokenRef.current += 1;
    setState(IDLE_STATE);
  }, []);

  return { ...state, file, reset };
}

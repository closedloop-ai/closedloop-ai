/**
 * @file use-audit-run.ts
 * @description FEA-3848 (PRD-556 M2) — the audit-run controller hook.
 *
 * Owns the renderer side of one on-demand audit: subscribes to the streamed
 * cascade progress (`audit.onProgress`), drives `audit.run`, and reduces both
 * into a single state the view renders — the cascade order + landed attempts
 * while running, then the findings / refusal / error when it settles. A run is
 * keyed by a monotonic token so a superseded run's late progress/result is
 * ignored (the user can re-run before the previous finishes). The `onProgress`
 * subscription is set up once and torn down on unmount.
 */

import type { CascadeAttempt, HarnessName } from "@repo/crewd/model";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AuditProgressPayload,
  AuditRunRequest,
  AuditRunResult,
} from "../../../shared/audit-contract";

/** The lifecycle phase of the audit surface. */
export const AuditRunPhase = {
  Idle: "idle",
  Running: "running",
  Complete: "complete",
} as const;
export type AuditRunPhase = (typeof AuditRunPhase)[keyof typeof AuditRunPhase];

export type AuditRunState = {
  phase: AuditRunPhase;
  /** The cascade order for the in-flight run (from the `start` event). */
  cascade: readonly HarnessName[];
  /** Attempts that have landed so far, in cascade order. */
  attempts: readonly CascadeAttempt[];
  /** The settled result (findings / refusal / error), or null until complete. */
  result: AuditRunResult | null;
};

const IDLE_STATE: AuditRunState = {
  phase: AuditRunPhase.Idle,
  cascade: [],
  attempts: [],
  result: null,
};

export type UseAuditRun = AuditRunState & {
  run: (request: AuditRunRequest) => Promise<void>;
};

/** Controller for a single on-demand audit run with live cascade progress. */
export function useAuditRun(): UseAuditRun {
  const [state, setState] = useState<AuditRunState>(IDLE_STATE);
  // Monotonic run token: only the latest run's progress/result is applied.
  const runTokenRef = useRef(0);

  useEffect(() => {
    const audit = window.desktopApi?.audit;
    if (!audit) {
      return;
    }
    const unsubscribe = audit.onProgress((payload) => {
      applyProgress(setState, payload);
    });
    return unsubscribe;
  }, []);

  const run = useCallback(async (request: AuditRunRequest) => {
    const audit = window.desktopApi?.audit;
    if (!audit) {
      return;
    }
    const token = runTokenRef.current + 1;
    runTokenRef.current = token;
    setState({
      phase: AuditRunPhase.Running,
      cascade: [],
      attempts: [],
      result: null,
    });
    const result = await audit.run(request);
    // A newer run superseded this one — drop the stale result.
    if (runTokenRef.current !== token) {
      return;
    }
    setState((prev) => ({
      ...prev,
      phase: AuditRunPhase.Complete,
      result,
    }));
  }, []);

  return { ...state, run };
}

/**
 * Fold one streamed progress event into the run state. `output` chunks carry no
 * displayed state here (the cascade trail is attempt-driven), so they are a
 * no-op; `start` seeds the cascade order, `attempt` appends, `done` is a marker
 * the settled `run` result supersedes.
 */
function applyProgress(
  setState: (updater: (prev: AuditRunState) => AuditRunState) => void,
  payload: AuditProgressPayload
): void {
  if (payload.phase === "start") {
    setState((prev) =>
      prev.phase === AuditRunPhase.Running
        ? { ...prev, cascade: payload.cascade }
        : prev
    );
    return;
  }
  if (payload.phase === "attempt") {
    setState((prev) =>
      prev.phase === AuditRunPhase.Running
        ? { ...prev, attempts: [...prev.attempts, payload.attempt] }
        : prev
    );
  }
}

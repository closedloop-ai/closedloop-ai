"use client";

import { ListEmptyReason } from "@repo/api/src/list-empty-state";
import {
  BranchesListStateKind,
  type BranchesListStateSignals,
  resolveBranchesListState,
} from "@repo/app/branches/lib/branch-list-state";
import { readApiErrorStatus } from "@repo/app/shared/api/read-api-error-status";
import { useEffect, useRef } from "react";
import {
  type ClientEventProperties,
  captureClientEvent,
} from "@/lib/analytics/client-event-sink";

/**
 * ISS-9725 — a failed Branches list read, reported through the client
 * monitoring path.
 *
 * The ticket assumed web needed a NEW instrumentation primitive because
 * `reportNextjsError` is reachable only from the route error boundaries and the
 * Branches query never throws (plain `useQuery`, no `throwOnError`, no
 * `useSuspenseQuery` anywhere in the repo). Both halves of that are true; the
 * conclusion is not. `captureClientEvent` already exists for exactly this case
 * and says so in its own words — "analytics IS the client monitoring path" —
 * and `reportDroppedHealthCheckFields` is the standing precedent for routing a
 * data fault through it from an ordinary client module rather than a boundary.
 *
 * What this adds is the APP-LEVEL fact. RUM's `trackResources` already sees the
 * failed request, but a resource error carries no notion of which surface it
 * blanked; it cannot answer "how often does a reader open Branches and get the
 * Unavailable treatment", which is the question the desktop dead-end records
 * answer for their runtime.
 *
 * The two runtimes share the DECISION, not the transport: both ask
 * {@link resolveBranchesListState}, the one resolver the v1 body and the v2
 * surface branch on, so neither can report a screen other than the one drawn.
 * Desktop then maps that into its `desktop:dead-end-telemetry` OTel contract and
 * web into this event, because the sinks are genuinely different — the
 * collector routes `dead_end.*` to the Datadog ops leg only.
 */
export const BRANCHES_LIST_UNAVAILABLE_EVENT =
  "branches_list_unavailable_client";

export type BranchesListUnavailableMonitorInputs = BranchesListStateSignals & {
  /** The list read's rejection, or null/undefined when it resolved. */
  listError: unknown;
};

/**
 * Emits once per distinct failure rather than once per commit. React re-renders
 * freely, and a naive effect turns one failed read into dozens of records; the
 * effect below therefore carries NO dependency array — it runs on every commit,
 * and the key comparison is the only thing that stops it emitting on each one.
 * That is the arrangement `useDeadEndTelemetry` uses on desktop, and it is what
 * makes the guard load-bearing rather than incidentally satisfied by a dep list
 * that happens not to change. A 404 becoming a 503 IS a second failure, so the
 * status is part of the identity; the ref (not state) is what survives
 * StrictMode's doubled effect.
 */
export function useBranchesListUnavailableMonitor({
  listError,
  ...signals
}: BranchesListUnavailableMonitorInputs): void {
  const state = resolveBranchesListState(signals);
  const isUnavailable =
    state.kind === BranchesListStateKind.Empty &&
    state.reason === ListEmptyReason.Unavailable;
  const httpStatus = readApiErrorStatus(listError);
  const emittedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = isUnavailable ? String(httpStatus ?? "") : null;
    if (key === emittedKeyRef.current) {
      return;
    }
    emittedKeyRef.current = key;
    if (key === null) {
      return;
    }
    const properties: ClientEventProperties = {
      reason: ListEmptyReason.Unavailable,
      ...(httpStatus === null ? {} : { httpStatus }),
    };
    captureClientEvent(BRANCHES_LIST_UNAVAILABLE_EVENT, properties);
  });
}

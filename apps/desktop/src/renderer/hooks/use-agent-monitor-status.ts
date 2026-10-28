import { useEffect, useRef, useState } from "react";
import {
  type AgentMonitorRuntimeStatus,
  AgentMonitorRuntimeStatusKind,
} from "../../shared/agent-monitor-status";
import {
  readRuntimeStatus,
  useRuntimeStatusValue,
} from "./use-runtime-status-poll";

/**
 * ISS-4714: narrow one unknown runtime-status `kind` string to the closed set of
 * Agent Monitor status kinds. A version-skewed/future value falls through to
 * null in the parser rather than surfacing an unknown state.
 */
function toAgentMonitorStatusKind(
  kind: string
): AgentMonitorRuntimeStatusKind | null {
  for (const known of Object.values(AgentMonitorRuntimeStatusKind)) {
    if (known === kind) {
      return known;
    }
  }
  return null;
}

/**
 * ISS-4714: project the Agent Monitor runtime status out of the runtime-status
 * payload. Returns null when the field is absent (an older main process → no
 * degraded state shown, matching the additive-optional degrade of the sibling
 * projections). The `kind` is validated against the closed set, and `dbAhead` is
 * only ever honored on a `Failed` status, so a malformed or version-skewed
 * payload can never make the renderer claim "update required" while the runtime
 * is actually healthy — nor crash the banner on a partial entry.
 */
export function parseAgentMonitorStatus(
  status: unknown
): AgentMonitorRuntimeStatus | null {
  const value = readRuntimeStatus(status).agentMonitor;
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return null;
  }
  const rawKind = value.kind;
  if (typeof rawKind !== "string") {
    return null;
  }
  const kind = toAgentMonitorStatusKind(rawKind);
  if (kind === null) {
    return null;
  }
  const failed = kind === AgentMonitorRuntimeStatusKind.Failed;
  // dbAhead is meaningful only for a failed runtime; never let a truthy flag on
  // a ready/starting payload surface the degraded UI.
  const dbAhead =
    failed &&
    "dbAhead" in value &&
    typeof value.dbAhead === "boolean" &&
    value.dbAhead;
  const reason =
    failed && "reason" in value && typeof value.reason === "string"
      ? value.reason
      : null;
  return { kind, dbAhead, reason };
}

/**
 * Polls the main-process Agent Monitor runtime status while `active`, subscribing
 * to the same shared 1s runtime-status poll as the ingest/maintenance hooks (no
 * extra IPC round-trip per interval). Returns null until the first response and
 * whenever the field is absent.
 */
export function useAgentMonitorStatus(
  active: boolean
): AgentMonitorRuntimeStatus | null {
  return useRuntimeStatusValue(active, parseAgentMonitorStatus);
}

/**
 * ISS-4714 (whitlockk review): the Agent Monitor runtime status reaches a TERMINAL
 * verdict at boot — `Ready` (the DB opened) or `Failed` (it did not, e.g. the
 * DB-ahead refusal). Neither transitions again within a process lifetime, so a
 * banner reading this status has nothing left to observe after the first
 * verdict. This BOUNDED wrapper mirrors `useSessionsImportProgress`: it polls
 * the shared 1s runtime-status poll only
 * until the first `Ready`/`Failed` snapshot, then latches a stop so the shared
 * interval tears down (when no other subscriber holds it) instead of polling
 * main every second for the whole session. The last terminal snapshot is
 * returned unchanged after the latch — a `Failed` verdict (which the banner
 * renders) stays visible; a `Ready` verdict keeps the banner hidden.
 */
export function useTerminalAgentMonitorStatus(): AgentMonitorRuntimeStatus | null {
  const [terminal, setTerminal] = useState(false);
  const lastStatusRef = useRef<AgentMonitorRuntimeStatus | null>(null);
  const polled = useAgentMonitorStatus(!terminal);

  useEffect(() => {
    if (polled === null) {
      return;
    }
    lastStatusRef.current = polled;
    if (polled.kind !== AgentMonitorRuntimeStatusKind.Starting) {
      // Ready or Failed — the verdict is terminal for this process; stop polling.
      setTerminal(true);
    }
  }, [polled]);

  // While polling, the live snapshot; after the latch, the last terminal one.
  return terminal ? lastStatusRef.current : polled;
}

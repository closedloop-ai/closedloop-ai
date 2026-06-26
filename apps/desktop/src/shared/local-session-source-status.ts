export const LOCAL_SESSION_SOURCE_STATUSES = {
  starting: "starting",
  ready: "ready",
  disabled: "disabled",
  unavailable: "unavailable",
} as const;

export type LocalSessionSourceStatus =
  (typeof LOCAL_SESSION_SOURCE_STATUSES)[keyof typeof LOCAL_SESSION_SOURCE_STATUSES];

export type AgentMonitorLocalSessionSourcePayload = {
  ready?: boolean;
  enabled?: boolean;
  localSessionSourceStatus?: unknown;
};

/**
 * Normalizes the additive Agent Monitor readiness status while preserving
 * compatibility with older preload/test fixtures that only expose booleans.
 */
export function normalizeAgentMonitorLocalSessionSourceStatus(
  payload: AgentMonitorLocalSessionSourcePayload | null | undefined
): LocalSessionSourceStatus {
  if (isLocalSessionSourceStatus(payload?.localSessionSourceStatus)) {
    return payload.localSessionSourceStatus;
  }
  if (
    payload !== null &&
    payload !== undefined &&
    "localSessionSourceStatus" in payload
  ) {
    return LOCAL_SESSION_SOURCE_STATUSES.starting;
  }
  if (payload?.ready === true) {
    return LOCAL_SESSION_SOURCE_STATUSES.ready;
  }
  if (payload?.enabled === false) {
    return LOCAL_SESSION_SOURCE_STATUSES.disabled;
  }
  return LOCAL_SESSION_SOURCE_STATUSES.starting;
}

function isLocalSessionSourceStatus(
  value: unknown
): value is LocalSessionSourceStatus {
  return (
    value === LOCAL_SESSION_SOURCE_STATUSES.starting ||
    value === LOCAL_SESSION_SOURCE_STATUSES.ready ||
    value === LOCAL_SESSION_SOURCE_STATUSES.disabled ||
    value === LOCAL_SESSION_SOURCE_STATUSES.unavailable
  );
}

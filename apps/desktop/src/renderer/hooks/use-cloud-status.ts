import {
  CloudSocketDegradedReason,
  CloudSocketState,
} from "../../shared/cloud-socket-error";
import {
  readRuntimeStatus,
  useRuntimeStatusValue,
} from "./use-runtime-status-poll";

export const CloudStatusKind = {
  ...CloudSocketState,
  Unknown: "unknown",
} as const;

export type CloudStatusKind =
  (typeof CloudStatusKind)[keyof typeof CloudStatusKind];

export type CloudStatus =
  | {
      kind: typeof CloudStatusKind.Degraded;
      error: string;
      reason?: CloudSocketDegradedReason;
    }
  | { kind: typeof CloudStatusKind.Disabled; reason: string }
  | { kind: typeof CloudStatusKind.Idle }
  | { kind: typeof CloudStatusKind.Online }
  | { kind: typeof CloudStatusKind.Unknown };

const IDLE_CLOUD_STATUS: CloudStatus = { kind: CloudStatusKind.Idle };
const ONLINE_CLOUD_STATUS: CloudStatus = { kind: CloudStatusKind.Online };
const UNKNOWN_CLOUD_STATUS: CloudStatus = { kind: CloudStatusKind.Unknown };
const DEFAULT_CLOUD_CONNECTION_ERROR = "Cloud connection failed";
const DEFAULT_CLOUD_DISABLED_REASON = "Cloud connection is off";

/**
 * Project the cloud socket state from runtime status. A missing field returns
 * null so an older preload/main-process pair remains compatible, while a
 * present but malformed or future state becomes `unknown` instead of being
 * mistaken for idle, online, or degraded.
 */
export function parseCloudStatus(status: unknown): CloudStatus | null {
  const cloudStatus = readRuntimeStatus(status).cloudStatus;
  if (cloudStatus === undefined || cloudStatus === null) {
    return null;
  }
  if (
    typeof cloudStatus !== "object" ||
    !("state" in cloudStatus) ||
    typeof cloudStatus.state !== "string"
  ) {
    return UNKNOWN_CLOUD_STATUS;
  }
  if (cloudStatus.state === CloudStatusKind.Disabled) {
    // A main process too old to send this never reaches here, and an unknown
    // state already folds to `unknown` rather than to a fault — so a skewed
    // pair degrades to "we cannot say", never to "something is wrong".
    const reason =
      "reason" in cloudStatus &&
      typeof cloudStatus.reason === "string" &&
      cloudStatus.reason.trim().length > 0
        ? cloudStatus.reason
        : DEFAULT_CLOUD_DISABLED_REASON;
    return { kind: CloudStatusKind.Disabled, reason };
  }
  if (cloudStatus.state === CloudStatusKind.Idle) {
    return IDLE_CLOUD_STATUS;
  }
  if (cloudStatus.state === CloudStatusKind.Online) {
    return ONLINE_CLOUD_STATUS;
  }
  if (cloudStatus.state === CloudStatusKind.Degraded) {
    const error =
      "error" in cloudStatus &&
      typeof cloudStatus.error === "string" &&
      cloudStatus.error.trim().length > 0
        ? cloudStatus.error
        : DEFAULT_CLOUD_CONNECTION_ERROR;
    // ISS-11843: optional and closed. An absent or unknown reason (an older or
    // newer main process) reads as an ordinary degraded connection.
    const reason = readDegradedReason(cloudStatus);
    return reason
      ? { kind: CloudStatusKind.Degraded, error, reason }
      : { kind: CloudStatusKind.Degraded, error };
  }
  return UNKNOWN_CLOUD_STATUS;
}

/**
 * Polls the main-process cloud socket state while `active`. This subscribes to
 * the existing shared one-second runtime-status poll, so Settings can update
 * after mount without adding another IPC round-trip per interval.
 */
export function useCloudStatus(active: boolean): CloudStatus | null {
  return useRuntimeStatusValue(active, parseCloudStatus);
}

function readDegradedReason(
  cloudStatus: object
): CloudSocketDegradedReason | null {
  if (!("reason" in cloudStatus)) {
    return null;
  }
  return (
    Object.values(CloudSocketDegradedReason).find(
      (known) => known === cloudStatus.reason
    ) ?? null
  );
}

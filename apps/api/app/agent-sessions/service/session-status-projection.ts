import {
  type DisplayedSessionStatus,
  resolveDisplayedSessionStatus,
} from "@repo/api/src/types/session-status";

/**
 * Project a persisted cloud status onto the three-value displayed vocabulary.
 * ISS-10364 retired Waiting, Stale, and Unknown as rendered states; the raw
 * string remains separately available to the DTO for version-skew evidence.
 * The sort and filter read the persisted value, not this projection.
 */
export function projectDisplayedSessionStatus(
  record: {
    status: string;
    awaitingInputSince: Date | null;
    sessionEndedAt: Date | null;
    lastActivityAt?: Date | null;
    sessionStartedAt?: Date | null;
    endsWithError?: boolean | null;
  },
  now: Date = new Date()
): DisplayedSessionStatus {
  return resolveDisplayedSessionStatus({
    status: record.status,
    lastActivityAt: record.lastActivityAt,
    startedAt: record.sessionStartedAt,
    now,
  });
}

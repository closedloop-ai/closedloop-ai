import {
  type TranscriptAccessResponse,
  TranscriptAvailability,
} from "@repo/api/src/types/desktop-transcripts";

/**
 * ISS-12276 (PRD-792): when to re-read a session's transcript descriptor, and
 * when to stop polling for one that is still `missing`. The values here are
 * implementation choices the ticket delegated, not product rules.
 */

/**
 * Reuse a descriptor only while its signed URL keeps at least this much life,
 * so the parse that follows never starts on a URL about to expire. Matches the
 * server's own reuse margin for cached signatures
 * (`TRANSCRIPT_SIGNED_URL_CACHE_SAFETY_MARGIN_MS`).
 */
export const TRANSCRIPT_URL_REUSE_MARGIN_MS = 60 * 1000;

/**
 * Base poll cadence while a file is `uploadPending` or `missing` (FEA-3481 G5).
 * `uploadPending` keeps this cadence for as long as it lasts.
 */
export const TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS = 4000;

/** ISS-12276: the longest gap between two polls of a `missing` transcript. */
export const TRANSCRIPT_MISSING_REFETCH_MAX_INTERVAL_MS = 60 * 1000;

/**
 * ISS-12276: stop polling a transcript that has stayed `missing` this long.
 * A never-uploaded transcript used to re-poll every 4 s for as long as the page
 * stayed open. A later focus or remount still re-reads the descriptor.
 */
export const TRANSCRIPT_MISSING_REFETCH_CAP_MS = 5 * 60 * 1000;

const AMZ_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const AMZ_EXPIRES_PATTERN = /^\d+$/;

/**
 * When a SigV4 presigned URL stops working, read from its own `X-Amz-Date` and
 * `X-Amz-Expires` query parameters. `null` when the URL carries no parseable
 * expiry, which callers treat as "already stale" (the pre-ISS-12276 behavior).
 */
export function signedUrlExpiresAtMs(url: string | null): number | null {
  if (!url) {
    return null;
  }
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  const date = AMZ_DATE_PATTERN.exec(params.get("X-Amz-Date") ?? "");
  const expires = params.get("X-Amz-Expires") ?? "";
  if (!(date && AMZ_EXPIRES_PATTERN.test(expires))) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = date.map(Number);
  const signedAtMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const expiresAtMs = signedAtMs + Number(expires) * 1000;
  return Number.isFinite(expiresAtMs) ? expiresAtMs : null;
}

/**
 * How long a descriptor response stays fresh for `fileKey`: until its signed
 * URL is within {@link TRANSCRIPT_URL_REUSE_MARGIN_MS} of expiring. Zero when
 * the file has no URL (pending, missing, failed) or an unparseable one, so
 * those states keep refetching on mount and focus as before.
 *
 * Measured from `fetchedAtMs` (the query's `dataUpdatedAt`), because TanStack
 * Query adds `staleTime` to `dataUpdatedAt`; measuring from "now" would count
 * the time since the fetch twice.
 */
export function transcriptAccessStaleTimeMs(
  data: TranscriptAccessResponse | undefined,
  fileKey: string,
  fetchedAtMs: number
): number {
  const file = data?.files?.find((entry) => entry.fileKey === fileKey);
  const expiresAtMs = signedUrlExpiresAtMs(file?.url ?? null);
  if (expiresAtMs === null) {
    return 0;
  }
  return Math.max(
    0,
    expiresAtMs - TRANSCRIPT_URL_REUSE_MARGIN_MS - fetchedAtMs
  );
}

/** What the descriptor poll is waiting on, if anything. */
export const TranscriptPollState = {
  Missing: "missing",
  None: "none",
  Pending: "pending",
} as const;
export type TranscriptPollState =
  (typeof TranscriptPollState)[keyof typeof TranscriptPollState];

/**
 * `Pending` when any file is `uploadPending` (it wins, so its cadence is
 * unchanged), `Missing` when any file is `missing`, else `None`.
 */
export function transcriptPollState(
  data: TranscriptAccessResponse | undefined
): TranscriptPollState {
  const files = data?.files ?? [];
  if (
    files.some(
      (file) => file.availability === TranscriptAvailability.UploadPending
    )
  ) {
    return TranscriptPollState.Pending;
  }
  if (
    files.some((file) => file.availability === TranscriptAvailability.Missing)
  ) {
    return TranscriptPollState.Missing;
  }
  return TranscriptPollState.None;
}

/**
 * ISS-12276: the next poll delay for a transcript that has been `missing` for
 * `elapsedMs`. The delay grows with the wait (4 s, 4 s, 8 s, 16 s, ...) up to
 * {@link TRANSCRIPT_MISSING_REFETCH_MAX_INTERVAL_MS}, and polling stops
 * (`false`) once the wait reaches {@link TRANSCRIPT_MISSING_REFETCH_CAP_MS}.
 */
export function missingTranscriptRefetchIntervalMs(
  elapsedMs: number
): number | false {
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs >= TRANSCRIPT_MISSING_REFETCH_CAP_MS
  ) {
    return false;
  }
  return Math.min(
    Math.max(TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS, elapsedMs),
    TRANSCRIPT_MISSING_REFETCH_MAX_INTERVAL_MS
  );
}

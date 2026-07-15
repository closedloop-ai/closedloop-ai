import {
  TranscriptAvailability,
  type TranscriptAvailabilitySummary,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import type { Prisma, SessionTranscript } from "@repo/database";

/**
 * FR8 availability-state derivation + shared session-transcript lookup helpers
 * (PLN-1289). The derivation is pure over stored `SessionTranscript` state and
 * is shared by the read route (which mints URLs) and the session-detail
 * enrichment (which does not). The `missing` state has no row to derive from,
 * so it is synthesized here (`missingMainSummary`) or by the read route.
 */

/** `SessionTranscript.fileKey` value for the always-expected main transcript. */
export const MAIN_FILE_KEY = "main";

/**
 * Prisma filter selecting a session's transcript rows by session identity
 * `(organizationId, computeTargetId, externalSessionId)` — the
 * `SessionTranscript` unique key minus `fileKey` — rather than the nullable
 * `sessionDetailId` FK, so a row uploaded before the metadata lane resolved the
 * link is still matched. Single source of the lookup decision, shared by the
 * read route and the session-detail enrichment.
 */
export function sessionTranscriptIdentityWhere(identity: {
  organizationId: string;
  computeTargetId: string;
  externalSessionId: string;
}): Prisma.SessionTranscriptWhereInput {
  return {
    organizationId: identity.organizationId,
    computeTargetId: identity.computeTargetId,
    externalSessionId: identity.externalSessionId,
  };
}

/** True when the rows already include the always-expected main transcript. */
export function hasMainTranscript(
  rows: Pick<SessionTranscript, "fileKey">[]
): boolean {
  return rows.some((row) => row.fileKey === MAIN_FILE_KEY);
}

/**
 * Synthetic detail summary for the main transcript when the session has no main
 * row yet, so every surface agrees that main is always expected (PRD AC6). The
 * read route builds its own richer `missing` descriptor for the same case.
 */
export function missingMainSummary(): TranscriptAvailabilitySummary {
  return {
    fileKey: MAIN_FILE_KEY,
    availability: TranscriptAvailability.Missing,
    uploadedAt: null,
  };
}

/** The fields the derivation reads — a structural subset of `SessionTranscript`. */
export type TranscriptAvailabilityInput = Pick<
  SessionTranscript,
  "uploadStatus" | "uploadedAt" | "lastObservedAt"
>;

/**
 * Availability of a transcript file that has a `SessionTranscript` row.
 *
 * - `uploaded` + a newer desktop fingerprint (`lastObservedAt > uploadedAt`) →
 *   `stale`; the current archived bytes are still readable, so a URL is issued.
 * - `uploaded` with no newer observation → `available`.
 * - `pending`/`uploading` → `uploadPending`.
 * - `failed` → `uploadFailed`.
 *
 * An unrecognized status defaults to `uploadPending` (in flight) rather than
 * implying readable bytes exist.
 */
export function deriveTranscriptAvailability(
  row: TranscriptAvailabilityInput
): TranscriptAvailability {
  switch (row.uploadStatus) {
    case TranscriptUploadStatus.Uploaded:
      if (row.uploadedAt === null) {
        // Defensive: uploadedAt should always be set when status=Uploaded, but
        // guard against any future write-path inconsistency.
        return TranscriptAvailability.UploadPending;
      }
      return row.lastObservedAt.getTime() > row.uploadedAt.getTime()
        ? TranscriptAvailability.Stale
        : TranscriptAvailability.Available;
    case TranscriptUploadStatus.Failed:
      return TranscriptAvailability.UploadFailed;
    default:
      return TranscriptAvailability.UploadPending;
  }
}

/**
 * Whether a signed GET URL should be minted: only when the file's current
 * archived bytes are readable (`available` or `stale`). Never mints for
 * pending/failed/missing (PLN-1289 AC1/AC3).
 */
export function isTranscriptReadable(
  availability: TranscriptAvailability
): boolean {
  return (
    availability === TranscriptAvailability.Available ||
    availability === TranscriptAvailability.Stale
  );
}

/**
 * Lightweight availability summary embedded in the session-detail response
 * (no URL is minted here — that stays on the explicit read route).
 */
export function toTranscriptAvailabilitySummary(
  row: Pick<SessionTranscript, "fileKey"> & TranscriptAvailabilityInput
): TranscriptAvailabilitySummary {
  return {
    fileKey: row.fileKey,
    availability: deriveTranscriptAvailability(row),
    uploadedAt: row.uploadedAt?.toISOString() ?? null,
  };
}

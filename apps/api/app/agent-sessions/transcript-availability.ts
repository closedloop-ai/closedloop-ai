import {
  isRecoverableTranscriptSkipReason,
  TranscriptAvailability,
  type TranscriptAvailabilitySummary,
  type TranscriptSkipReason,
  TranscriptUploadStatus,
  toKnownTranscriptSkipReason,
} from "@repo/api/src/types/desktop-transcripts";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
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
    permanentFailureReason: null,
  };
}

/** The fields the derivation reads — a structural subset of `SessionTranscript`. */
export type TranscriptAvailabilityInput = Pick<
  SessionTranscript,
  "uploadStatus" | "uploadedAt" | "lastObservedAt"
>;

/**
 * Narrow the free-text `SessionTranscript.permanentFailureReason` TEXT column to
 * a known {@link TranscriptSkipReason}, else null. Keeps the wire contract enum
 * honest even if the DB ever holds a value the current build does not recognize.
 *
 * ISS-4820 (wongk review): the membership test itself is NOT restated here — it
 * delegates to {@link toKnownTranscriptSkipReason}, the wire contract's own
 * narrower, which is the same value set this file used to rebuild locally.
 */
export function normalizeSkipReason(
  value: string | null
): TranscriptSkipReason | null {
  return toKnownTranscriptSkipReason(value);
}

/**
 * Availability of a transcript file that has a `SessionTranscript` row.
 *
 * - `uploaded` + a newer desktop fingerprint (`lastObservedAt > uploadedAt`) →
 *   `stale`; the current archived bytes are still readable, so a URL is issued.
 * - `uploaded` with no newer observation → `available`.
 * - `pending`/`uploading` → `uploadPending`.
 * - `failed` → `uploadFailed`.
 * - `skipped` → `permanentlyUnavailable` (FEA-3476: terminal, non-retryable).
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
    case TranscriptUploadStatus.Skipped:
      // FEA-3476: the desktop terminally skipped this file (e.g. oversized) and
      // will never upload it. Distinct from `failed` (retryable) so the read
      // path derives `failedPermanent`, not `failedTransient`.
      return TranscriptAvailability.PermanentlyUnavailable;
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
  row: Pick<SessionTranscript, "fileKey" | "permanentFailureReason"> &
    TranscriptAvailabilityInput
): TranscriptAvailabilitySummary {
  return {
    fileKey: row.fileKey,
    availability: deriveTranscriptAvailability(row),
    uploadedAt: row.uploadedAt?.toISOString() ?? null,
    permanentFailureReason: normalizeSkipReason(row.permanentFailureReason),
  };
}

/**
 * FEA-3479 (PRD-536 G1): collapse the per-file availability summaries into one
 * session-level {@link TranscriptDisposition} for a lag-aware UI. The main
 * transcript drives the verdict (a session always expects a `main` file per
 * PRD AC6; the enrichment synthesizes a `missing` main summary when absent), so
 * this reads the `main` entry and maps its availability:
 *
 * - `available`   → `synced`   (uploaded and current)
 * - `stale`       → `stale`    (the archived bytes are still READABLE, so this is
 *   accepted as settled rather than mapped to `syncing`/`pending`, even though a
 *   newer desktop fingerprint was observed — `lastObservedAt > uploadedAt`. It is
 *   NOT "caught up"; it is "readable but possibly behind", surfaced honestly as
 *   its own `stale` verdict.)
 * - `uploadPending` / `missing` → `syncing` (upload in flight or not yet
 *   started — the NORMAL "transcript uploading" case, not an error)
 * - `uploadFailed`→ `failedTransient` (a retryable attempt failure; the desktop
 *   re-queues with backoff).
 * - `permanentlyUnavailable` → `failedPermanent` for a HARD terminal skip
 *   (FEA-3476: `too_large`, `source_gone`, `retries_exhausted` — the transcript
 *   is never coming, no retry affordance), BUT `syncing` for a RECOVERABLE
 *   terminal skip (ISS-4695 item 3: `materialized_source_unavailable` — a
 *   batch-materialized OpenCode source that was absent this sweep but
 *   re-materializes on a later one). The reason is what disambiguates these two
 *   `permanentlyUnavailable` cases, so the main summary's
 *   {@link TranscriptAvailabilitySummary.permanentFailureReason} drives the
 *   verdict — a hard `failedPermanent` on a regenerable source would hide that
 *   redrive/recovery is still possible.
 *
 * `neverExpected` is returned when the session has no transcript summaries at
 * all — i.e. the caller decided the session is not expected to have one and
 * omitted the synthesized `missing` main. The session-detail enrichment always
 * includes a main summary, so cloud detail responses never hit that branch
 * today; the value exists so a future non-transcript session surface can signal
 * "absence is normal" without a separate flag.
 *
 * An exhaustive switch keeps this honest: adding a `TranscriptAvailability`
 * variant fails typecheck here until it is intentionally mapped.
 */
export function deriveTranscriptDisposition(
  summaries: TranscriptAvailabilitySummary[]
): TranscriptDisposition {
  const main = summaries.find((summary) => summary.fileKey === MAIN_FILE_KEY);
  if (!main) {
    return TranscriptDisposition.NeverExpected;
  }
  return dispositionForAvailability(
    main.availability,
    main.permanentFailureReason
  );
}

function dispositionForAvailability(
  availability: TranscriptAvailability,
  permanentFailureReason: TranscriptSkipReason | null
): TranscriptDisposition {
  switch (availability) {
    case TranscriptAvailability.Available:
      return TranscriptDisposition.Synced;
    case TranscriptAvailability.Stale:
      return TranscriptDisposition.Stale;
    case TranscriptAvailability.UploadPending:
    case TranscriptAvailability.Missing:
      return TranscriptDisposition.Syncing;
    case TranscriptAvailability.UploadFailed:
      // A retryable attempt failure — the desktop will re-queue with backoff.
      // Kept transient so the UI does not present a hiccup as a dead end.
      return TranscriptDisposition.FailedTransient;
    case TranscriptAvailability.PermanentlyUnavailable:
      // FEA-3476: the desktop reported a terminal, non-retryable skip
      // (`uploadStatus = skipped`). Whether that is a HARD dead end or a
      // RECOVERABLE one depends on WHY it was skipped (ISS-4695 item 3).
      return dispositionForTerminalSkipReason(permanentFailureReason);
    default: {
      const exhaustive: never = availability;
      return exhaustive;
    }
  }
}

/**
 * ISS-4695 item 3 (Option A): resolve a `permanentlyUnavailable` file's
 * session-level verdict from WHY it was terminally skipped.
 *
 * - `materialized_source_unavailable` → `syncing`: a batch-materialized OpenCode
 *   source (`main.jsonl` re-derived from `opencode.db` every sweep) that was
 *   absent at sync time is RECOVERABLE — it re-materializes on a later sweep, so
 *   the cloud must NOT show a hard `failedPermanent` that hides that recovery.
 *   `syncing` keeps the aggregate honest as "still coming": it maps through
 *   {@link reconcileCloudSyncState} to a still-uploading `pending` disclosure
 *   rather than a settled one. (That mapping is display-only — it does not itself
 *   drive recovery. The actual redrive is `redriveOnStart` in
 *   `apps/desktop/src/main/app.ts`, matching the shared dead-letter prefix; this
 *   verdict only keeps the cloud from LYING that the row is settled while that
 *   desktop-side redrive can still re-materialize the source.)
 * - every other reason (`too_large`, `source_gone`, `retries_exhausted`) is a
 *   HARD terminal → `failedPermanent`: the transcript is never coming.
 * - `null` (an unknown/legacy reason the current build does not recognize, e.g.
 *   an older API row, degraded to `null` by `normalizeSkipReason`) defaults to
 *   the conservative HARD `failedPermanent` — the prior FEA-3476 behavior — so a
 *   value we cannot classify never LIES as recoverable.
 *
 * ISS-4820 (wongk review): the hard/recoverable SPLIT itself is not re-decided
 * here — it is read from {@link isRecoverableTranscriptSkipReason}, the shared
 * SSOT in the wire contract, which carries the exhaustive switch (a newly added
 * reason fails typecheck there until someone classifies it deliberately). This
 * function owns only the mapping from that split to a
 * {@link TranscriptDisposition}, plus the `null` default. Previously the split
 * was re-stated here, in the renderer, and in the server's write precedence —
 * three places to wire the next recoverable reason into, which is how the
 * classification drifted in the first place.
 */
function dispositionForTerminalSkipReason(
  reason: TranscriptSkipReason | null
): TranscriptDisposition {
  if (reason === null) {
    return TranscriptDisposition.FailedPermanent;
  }
  return isRecoverableTranscriptSkipReason(reason)
    ? TranscriptDisposition.Syncing
    : TranscriptDisposition.FailedPermanent;
}

/**
 * Stable per-session key for grouping `SessionTranscript` rows by their session
 * identity `(computeTargetId, externalSessionId)` — the identity the list-row
 * transcript-disposition batch groups on. `organizationId` is already fixed for
 * the whole page query, so it is not part of the key. Single source of the key
 * shape so the batch group and the per-row lookup can never drift.
 */
export function sessionTranscriptGroupKey(identity: {
  computeTargetId: string;
  externalSessionId: string;
}): string {
  return `${identity.computeTargetId}\u0000${identity.externalSessionId}`;
}

/**
 * PRD-536 G1 (Phase 3): derive the session-level {@link TranscriptDisposition}
 * for every session on a Sessions LIST page in ONE pass, so the list row can
 * render the same freshness affordance the detail Properties panel does without
 * a per-row detail fetch.
 *
 * `rows` is the flat set of `SessionTranscript` rows for the page's sessions
 * (one batched `findMany`, filtered by `organizationId` + `externalSessionId IN
 * [...]`). Rows are grouped by session identity via {@link sessionTranscriptGroupKey}
 * and each group is folded with the SAME {@link deriveTranscriptDisposition} the
 * detail path uses (SSOT). A session with no rows in the batch is simply absent
 * from the returned map — the projection then omits `transcriptDisposition` for
 * that row (honest "no verdict yet" rather than a fabricated one). The main
 * transcript is synthesized as `missing` per group when absent, matching the
 * detail enrichment (PRD AC6), so a session that has synced a subagent file but
 * not `main` still folds to `syncing` rather than `neverExpected`.
 */
export function deriveTranscriptDispositionsBySession(
  rows: (Pick<
    SessionTranscript,
    | "fileKey"
    | "permanentFailureReason"
    | "computeTargetId"
    | "externalSessionId"
  > &
    TranscriptAvailabilityInput)[]
): Map<string, TranscriptDisposition> {
  const rowsByKey = new Map<string, TranscriptAvailabilitySummary[]>();
  const hasMainByKey = new Map<string, boolean>();
  for (const row of rows) {
    const key = sessionTranscriptGroupKey(row);
    const summaries = rowsByKey.get(key) ?? [];
    summaries.push(toTranscriptAvailabilitySummary(row));
    rowsByKey.set(key, summaries);
    if (row.fileKey === MAIN_FILE_KEY) {
      hasMainByKey.set(key, true);
    }
  }

  const dispositionByKey = new Map<string, TranscriptDisposition>();
  for (const [key, summaries] of rowsByKey) {
    // Mirror the detail enrichment: a session always expects a `main` file, so
    // synthesize a `missing` main when the batch caught only subagent rows — the
    // fold then yields `syncing`, not `neverExpected`.
    if (!hasMainByKey.get(key)) {
      summaries.unshift(missingMainSummary());
    }
    dispositionByKey.set(key, deriveTranscriptDisposition(summaries));
  }
  return dispositionByKey;
}

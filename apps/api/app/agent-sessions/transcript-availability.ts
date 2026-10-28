import {
  TranscriptAvailability,
  type TranscriptAvailabilitySummary,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import {
  type TranscriptSkipReason,
  toKnownTranscriptSkipReason,
} from "@repo/api/src/types/transcript-skip-reason-constants";
import {
  dispositionForTerminalSkipReason,
  type SessionTranscriptVerdict,
} from "@repo/api/src/types/transcript-terminal-skip-disposition";
import type { Prisma, SessionTranscript } from "@repo/database";
import type { TranscriptArchiveProgressInput } from "./transcript-archive-progress";

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

/**
 * The plural {@link sessionTranscriptIdentityWhere}: a set of composite identity
 * predicates rather than a bare `externalSessionId IN (...)`, so Postgres can use
 * the `(computeTargetId, externalSessionId, fileKey)` unique index and the scan
 * is bounded by the requested identities rather than the org's entire transcript
 * history. `computeTargetId` rides the predicate so a rare cross-target
 * `externalSessionId` collision cannot pull in another session's rows.
 */
export function sessionTranscriptIdentitiesWhere(
  organizationId: string,
  identities: readonly {
    computeTargetId: string;
    externalSessionId: string;
  }[]
): Prisma.SessionTranscriptWhereInput {
  return {
    organizationId,
    OR: identities.map((identity) => ({
      computeTargetId: identity.computeTargetId,
      externalSessionId: identity.externalSessionId,
    })),
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

/** One stored transcript row as the session-detail enrichment reads it. */
export type TranscriptAvailabilityRow = TranscriptAvailabilityInput &
  TranscriptArchiveProgressInput &
  Pick<
    SessionTranscript,
    | "computeTargetId"
    | "externalSessionId"
    | "fileKey"
    | "permanentFailureReason"
  >;

/**
 * Narrow the free-text `SessionTranscript.permanentFailureReason` TEXT column to
 * a known {@link TranscriptSkipReason}, else null. Keeps the wire contract enum
 * honest even if the DB ever holds a value the current build does not recognize.
 *
 * ISS-4820 (whitlockk review): the membership test itself is NOT restated here — it
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
 * - `permanentlyUnavailable` → one of THREE verdicts, chosen by the reason
 *   (ISS-9884 made this no longer a binary): `failedPermanent` for a HARD
 *   terminal skip (FEA-3476: `too_large`, `source_gone`, `retries_exhausted` —
 *   the transcript is never coming, no retry affordance); `syncing` for a
 *   RECOVERABLE skip whose source regenerates on its own (ISS-4695 item 3:
 *   `materialized_source_unavailable` — a batch-materialized OpenCode source
 *   that was absent this sweep but re-materializes on a later one); and
 *   `failedTransient` for a RECOVERABLE skip the lane has STOPPED attempting
 *   (ISS-9884: `environment_unavailable`). The reason is what disambiguates
 *   those cases, so the main summary's
 *   {@link TranscriptAvailabilitySummary.permanentFailureReason} drives the
 *   verdict — a hard `failedPermanent` on a recoverable source would hide that
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
  return deriveTranscriptVerdict(summaries).disposition;
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
 * PRD-536 G1 (Phase 3): derive the session-level
 * {@link SessionTranscriptVerdict} for every session on a Sessions LIST page in
 * ONE pass, so the list row can render the same freshness affordance the detail
 * Properties panel does without a per-row detail fetch.
 *
 * ISS-9884 widened the value from the bare disposition to the verdict PAIR. The
 * pass is unchanged and there is still no second query — the reason was always
 * in hand on the main summary; nothing carried it out.
 *
 * `rows` is the flat set of `SessionTranscript` rows for the page's sessions
 * (one batched `findMany`, filtered by `organizationId` + `externalSessionId IN
 * [...]`). Rows are grouped by session identity via {@link sessionTranscriptGroupKey}
 * and each group is folded with the SAME {@link deriveTranscriptVerdict} the
 * detail path uses (SSOT). A session with no rows in the batch is simply absent
 * from the returned map — the projection then omits `transcriptDisposition` for
 * that row (honest "no verdict yet" rather than a fabricated one). The main
 * transcript is synthesized as `missing` per group when absent, matching the
 * detail enrichment (PRD AC6), so a session that has synced a subagent file but
 * not `main` still folds to `syncing` rather than `neverExpected`.
 */
export function deriveTranscriptVerdictsBySession(
  rows: (Pick<
    SessionTranscript,
    | "fileKey"
    | "permanentFailureReason"
    | "computeTargetId"
    | "externalSessionId"
  > &
    TranscriptAvailabilityInput)[]
): Map<string, SessionTranscriptVerdict> {
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

  const verdictByKey = new Map<string, SessionTranscriptVerdict>();
  for (const [key, summaries] of rowsByKey) {
    // Mirror the detail enrichment: a session always expects a `main` file, so
    // synthesize a `missing` main when the batch caught only subagent rows — the
    // fold then yields `syncing`, not `neverExpected`.
    if (!hasMainByKey.get(key)) {
      summaries.unshift(missingMainSummary());
    }
    verdictByKey.set(key, deriveTranscriptVerdict(summaries));
  }
  return verdictByKey;
}

/**
 * ISS-9884: {@link deriveTranscriptDisposition} plus the reason behind it, from
 * the same single pass over the same main summary. The disposition-only export
 * is now a projection of THIS function rather than a parallel implementation,
 * so the verdict a list row renders and the verdict the detail path derives
 * cannot disagree about which reason produced which state.
 */
export function deriveTranscriptVerdict(
  summaries: TranscriptAvailabilitySummary[]
): SessionTranscriptVerdict {
  const main = summaries.find((summary) => summary.fileKey === MAIN_FILE_KEY);
  if (!main) {
    return {
      disposition: TranscriptDisposition.NeverExpected,
      reason: null,
    };
  }
  return {
    disposition: dispositionForAvailability(
      main.availability,
      main.permanentFailureReason
    ),
    reason:
      main.availability === TranscriptAvailability.PermanentlyUnavailable
        ? main.permanentFailureReason
        : null,
  };
}

/**
 * ISS-11089: whether this row's bytes are PERMANENTLY unrecoverable — the
 * desktop terminally skipped the file AND the reason it gave is a hard one, so
 * no retry, re-materialization or returning transport can ever produce it.
 *
 * This is the row-level twin of the `Skipped` arm of
 * {@link deriveTranscriptAvailability} narrowed by
 * {@link dispositionForTerminalSkipReason}, and it deliberately does NOT route
 * through the former: that function reads `uploadedAt`/`lastObservedAt` and
 * calls `.getTime()` on one of them, which is correct where a full row is in
 * hand and a `TypeError` where a narrower persisted-row `select` is. The byte
 * fold that consumes this must degrade rather than 500 a whole session-detail
 * read, so it asks the two fields it can actually rely on. The two are held
 * together by a test, not by prose — `transcript-availability.test.ts` asserts
 * that every status/reason pair this returns `true` for also derives
 * `permanentlyUnavailable` and `failedPermanent`.
 *
 * `skipped` alone is NOT enough and must not be substituted for this (ISS-9884
 * / ISS-4695 item 3): `materialized_source_unavailable` re-materializes on a
 * later sweep and `environment_unavailable` uploads once the transport is back,
 * so counting either as unrecoverable would tell a reader a transcript is gone
 * while it is still coming. An unknown or absent reason degrades to hard, which
 * is {@link dispositionForTerminalSkipReason}'s own conservative default.
 */
export function isPermanentlyUnrecoverableTranscript(
  row: Pick<SessionTranscript, "uploadStatus" | "permanentFailureReason">
): boolean {
  if (row.uploadStatus !== TranscriptUploadStatus.Skipped) {
    return false;
  }
  return (
    dispositionForTerminalSkipReason(
      normalizeSkipReason(row.permanentFailureReason)
    ) === TranscriptDisposition.FailedPermanent
  );
}

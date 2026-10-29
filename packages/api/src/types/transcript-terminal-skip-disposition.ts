import { TranscriptDisposition } from "./transcript-disposition-constants.ts";
import { TranscriptSkipReason } from "./transcript-skip-reason-constants.ts";

/**
 * ISS-4695 item 3 / ISS-9884 — the session-level verdict a terminally-skipped
 * transcript earns, resolved from WHY it was skipped.
 *
 * It lives in `packages/api/src/types` because BOTH producers of a session's
 * transcript verdict have to answer this question identically and one of them
 * cannot reach the other: the cloud projection is `apps/api`
 * (`transcript-availability.ts`), the desktop LOCAL Sessions producer is
 * `apps/desktop` (`local-transcript-cloud-sync.ts`). Leaving the map in
 * `apps/api` is what guaranteed they would drift — and they did: the desktop
 * mapped every `dead` row to `failedPermanent` unconditionally, so on the
 * default bucket-unset developer path its own list said "permanently failed"
 * about a transcript the cloud reported as merely paused. Same reasoning, and
 * the same home, as {@link ./agent-session-cloud-sync-reconcile.ts}. Pure over
 * two Zod-free contract enums, so a bundle-sensitive client can read it
 * without pulling `zod`.
 *
 * - `too_large`, `source_gone`, `retries_exhausted` are HARD terminals →
 *   `failedPermanent`: the transcript is never coming. `retries_exhausted` in
 *   particular is load-bearing and unchanged — every installed desktop that
 *   never upgrades keeps sending it for an environmental give-up and must keep
 *   getting exactly today's verdict.
 * - `materialized_source_unavailable` → `syncing`: a batch-materialized source
 *   re-materializes on a later sweep, so it is still coming AND still being
 *   attempted.
 * - `environment_unavailable` → `failedTransient`: the lane hit its 24h
 *   environmental wall clock while every attempt was refused LANE-WIDE.
 *   Recoverable like the row above — but deliberately NOT `syncing`, because
 *   `isSessionRowUploading` (`session-status-fold.ts`) keys on that value and
 *   would give a lane that has STOPPED attempting a pulsing "Syncing" pill
 *   claiming it is still uploading. `failedTransient` says the true thing: it
 *   is not settled, and it is not being attempted right now.
 *
 * ISS-9884: this is no longer a binary over
 * {@link isRecoverableTranscriptSkipReason}. That boolean keeps its other two
 * jobs (write precedence, the desktop's 400-skew fallback) and is still the
 * SSOT for recoverable-vs-hard, but a two-valued predicate cannot address
 * three dispositions. An exhaustive `Record` is a STRONGER guard than what it
 * replaced: under the binary a newly added reason silently inherited a verdict
 * from its recoverable flag, and now it fails `tsc` here until someone
 * decides. What the `Record` CANNOT catch is a disagreeing key — an entry
 * whose verdict contradicts the boolean compiles fine — so the two are held
 * together by a test instead (`transcript-availability.test.ts`, "agrees with
 * isRecoverableTranscriptSkipReason for EVERY reason").
 */
const TERMINAL_SKIP_DISPOSITIONS: Record<
  TranscriptSkipReason,
  TranscriptDisposition
> = {
  [TranscriptSkipReason.TooLarge]: TranscriptDisposition.FailedPermanent,
  [TranscriptSkipReason.SourceGone]: TranscriptDisposition.FailedPermanent,
  [TranscriptSkipReason.RetriesExhausted]:
    TranscriptDisposition.FailedPermanent,
  [TranscriptSkipReason.MaterializedSourceUnavailable]:
    TranscriptDisposition.Syncing,
  [TranscriptSkipReason.EnvironmentUnavailable]:
    TranscriptDisposition.FailedTransient,
};

/**
 * The verdict for a terminally-skipped transcript, or the conservative HARD
 * `failedPermanent` for a `null` reason.
 *
 * `null` stays OUTSIDE the Record because it is not a member of the enum — it
 * is the unknown/legacy label {@link toKnownTranscriptSkipReason} degraded, or
 * (on the desktop) a row that died before migration 0090 recorded one. Either
 * way it must never LIE as recoverable.
 */
export function dispositionForTerminalSkipReason(
  reason: TranscriptSkipReason | null
): TranscriptDisposition {
  if (reason === null) {
    return TranscriptDisposition.FailedPermanent;
  }
  return TERMINAL_SKIP_DISPOSITIONS[reason];
}

/**
 * ISS-9884: the session-level verdict PLUS the terminal skip reason that
 * produced it, when one did.
 *
 * The disposition alone stopped being enough the moment a third reason mapped
 * onto `failedTransient`: `environment_unavailable` (the lane gave up on a
 * presumed-present file) and an ordinary retryable upload failure (the desktop
 * is re-queueing it with backoff) reach the SAME verdict and are two different
 * things to tell a user — "Upload paused" versus "Sync failed, retrying". Every
 * renderer that keys on the disposition alone therefore has to be given the
 * reason as well, or it states the wrong one of the two.
 *
 * `reason` is non-null ONLY when it actually drove the verdict — that is, when
 * the main file is `permanentlyUnavailable`. A row that is merely `uploadFailed`
 * can still carry a stale `permanentFailureReason` from an earlier terminal that
 * a later re-queue superseded, and publishing that alongside a verdict it did
 * not produce would let a consumer narrate a retrying row with a give-up's copy.
 */
export type SessionTranscriptVerdict = {
  disposition: TranscriptDisposition;
  reason: TranscriptSkipReason | null;
};

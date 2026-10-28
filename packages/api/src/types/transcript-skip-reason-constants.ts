/**
 * ISS-9884 — the terminal-skip reason vocabulary, the Zod-FREE constants half.
 *
 * Split out of the sibling `desktop-transcripts` module for exactly the reason
 * {@link ../transcript-disposition-constants} was (ISS-4848): that module opens
 * with `import { z } from "zod"` and builds its schemas at module scope, so it
 * is not tree-shakeable — any RUNTIME reference to the enum drags Zod into the
 * importing bundle. The Sessions LIST surfaces now have to compare against a
 * reason to tell an environmental give-up from an ordinary retrying failure
 * (`session-sync-status.ts`, `CloudSyncStateBadge`, and the dashboard /
 * insights / telemetry embeds that mount `SyncedSessionsTable`), and those are
 * precisely the bundle-sensitive consumers the disposition split exists to
 * protect. So the enum and its two pure narrowers live here, with no
 * dependencies at all, and the ~28 existing importers were repointed at this
 * specifier. There is deliberately no re-export shim on `desktop-transcripts`
 * — Biome's `noBarrelFile` rejects one, and a shim would hand every consumer
 * back the Zod import this split exists to shed.
 *
 * Why the desktop permanently skipped a transcript (FEA-3476 / PRD-536 D7).
 * Persisted on `SessionTranscript.permanentFailureReason` and surfaced to the
 * UI so a permanently-unavailable transcript explains *why* (not just "failed").
 *
 * - `too_large`: the file exceeds the desktop `TRANSCRIPT_SYNC_MAX_FILE_BYTES`
 *   cap, or one JSONL line exceeds the redacted transcript line cap, and is
 *   dead-lettered rather than synced. Raising those caps is a separate product
 *   decision; until then the archive will never contain this file.
 * - `source_gone` (FEA-3555): the local transcript source (a `~/.codex` rollout
 *   or `~/.claude` transcript) that this row was fingerprinted from is no longer
 *   on disk and nothing was ever uploaded (`syncedByteOffset === 0`), after a
 *   bounded number of consecutive missing-source observations. This is the
 *   old-session case: the file was rotated/deleted before the sweep could sync
 *   any bytes, so re-deriving from point-in-time local FS state can never
 *   recover it. Terminal so the cloud stops representing it as `syncing` forever
 *   and the read path derives `failedPermanent` (parity with `too_large`).
 * - `retries_exhausted` (ISS-4621): the desktop dead-lettered the file after the
 *   bounded consecutive-upload-failure LADDER was exhausted (transport/S3/plan
 *   errors — the source file itself may still exist). Before ISS-4621 this
 *   generic dead-letter never told the cloud, so the transcript read as
 *   `syncing` forever with no failure reason. Terminal for the AUTOMATIC lane
 *   only: a later change to the source file re-queues it locally (one more
 *   chance), and a successful upload then supersedes the skip server-side.
 *   ISS-9884 narrowed which bound produces it: the LADDER, and no longer the
 *   lane-wide wall clock, which now has its own reason below.
 * - `materialized_source_unavailable` (ISS-4695 item 3, Option A): the local
 *   source is a BATCH-MATERIALIZED harness projection (OpenCode: `main.jsonl` /
 *   `subagent:<id>.jsonl` re-derived from the foreign `opencode.db` every sweep)
 *   that was absent at sync time and crossed the missing-source attempt cap.
 *   Unlike `source_gone` — a genuinely-vanished raw Claude/Codex rollout that can
 *   never be recovered — a materialized source CAN be regenerated on a later
 *   sweep, so this is a RECOVERABLE terminal: the cloud maps it to a non-permanent
 *   disposition (see `dispositionForAvailability` in
 *   `apps/api/app/agent-sessions/transcript-availability.ts`) so redrive/recovery
 *   stays possible rather than a hard `failedPermanent` that would hide that the
 *   transcript can still come back. Grow-only + version-skew safe: the WRITE-side
 *   enum accepts it server-side BEFORE the desktop starts emitting it (the server
 *   leads the deploy), and an older client reading it back degrades it to `null`
 *   via {@link toKnownTranscriptSkipReason}.
 * - `environment_unavailable` (ISS-9884): the desktop reached the 24h
 *   environmental wall clock while every attempt was refused by a LANE-WIDE
 *   condition (`isLaneWideTranscriptFailure`) — the transcripts bucket unset,
 *   the org's sync policy off, the cloud or S3 unreachable. The source file is
 *   unverified but presumed present; the transport was never available to prove
 *   otherwise, so nothing was ever established to be wrong with this file.
 *   RECOVERABLE for the same reason `materialized_source_unavailable` is — the
 *   transport comes back, the lane re-arms, the row uploads — but it maps to a
 *   THIRD disposition, `failedTransient`, not to `syncing`: the lane has
 *   STOPPED attempting, and `syncing` drives a "still uploading" pill that
 *   would be its own lie (`isSessionRowUploading`). Harness-agnostic, unlike
 *   `materialized_source_unavailable`: an environmental give-up says nothing
 *   about the shape of the source, so it is legal for raw Claude and Codex rows
 *   too. Grow-only + version-skew safe on the same terms as its predecessor —
 *   the server leads the deploy. An older server that rejects it gets
 *   `retries_exhausted` instead, NOT `source_gone`: see
 *   `SKEW_FALLBACK_SKIP_REASON` in
 *   `apps/desktop/src/main/transcript-sync/transcript-sync-executor.ts`.
 */
export const TranscriptSkipReason = {
  TooLarge: "too_large",
  SourceGone: "source_gone",
  RetriesExhausted: "retries_exhausted",
  MaterializedSourceUnavailable: "materialized_source_unavailable",
  EnvironmentUnavailable: "environment_unavailable",
} as const;
export type TranscriptSkipReason =
  (typeof TranscriptSkipReason)[keyof typeof TranscriptSkipReason];

const TRANSCRIPT_SKIP_REASON_VALUES = new Set<string>(
  Object.values(TranscriptSkipReason)
);

/**
 * Narrow a wire value to a known {@link TranscriptSkipReason}, else `null`.
 * READ-side version-skew guard (ISS-4621 review): skip reasons are grow-only
 * (`retries_exhausted` was added after `too_large`/`source_gone` shipped), so a
 * client parsing a response from a NEWER server can meet a reason its bundled
 * enum does not know. A closed `z.enum` there rejects the whole descriptor —
 * and with it the entire `files` array — turning one unknown label into a
 * broken transcript panel. Reasons are display detail, so the safe degrade is
 * `null` (the UI's generic "not archived" copy), never a parse failure. The
 * WRITE-side schema (`transcriptSkipRequestSchema`) intentionally stays a
 * closed enum: the server must not persist labels it cannot serve back.
 */
export function toKnownTranscriptSkipReason(
  value: string | null | undefined
): TranscriptSkipReason | null {
  return value != null && TRANSCRIPT_SKIP_REASON_VALUES.has(value)
    ? (value as TranscriptSkipReason)
    : null;
}

/**
 * ISS-4820 — whether a terminal skip reason is RECOVERABLE (the source can be
 * regenerated, or the transport can come back, so the row may yet sync) or HARD
 * (the bytes are gone for good).
 *
 * This is the single source of truth for that split. It previously existed only
 * as an inline arm of the API's private `dispositionForTerminalSkipReason` and
 * a literal comparison in the renderer, which is how a recoverable reason came
 * to be able to overwrite a hard one server-side: nothing shared a notion of
 * which reasons outrank which.
 *
 * It is NOT the disposition. ISS-9884 gave `environment_unavailable` a third
 * verdict (`failedTransient`), which a two-valued predicate cannot express —
 * `TERMINAL_SKIP_DISPOSITIONS` owns that mapping. This boolean keeps its other
 * two jobs: write precedence (`skip-reason-precedence.ts`) and the desktop's
 * 400-skew fallback.
 *
 * Exhaustive on purpose — a newly added reason fails `tsc` here until someone
 * decides, deliberately, which side of the line it falls on.
 */
export function isRecoverableTranscriptSkipReason(
  reason: TranscriptSkipReason
): boolean {
  switch (reason) {
    case TranscriptSkipReason.MaterializedSourceUnavailable:
    case TranscriptSkipReason.EnvironmentUnavailable:
      return true;
    case TranscriptSkipReason.TooLarge:
    case TranscriptSkipReason.SourceGone:
    case TranscriptSkipReason.RetriesExhausted:
      return false;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

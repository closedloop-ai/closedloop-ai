import { z } from "zod";

/**
 * Shared wire contract for the desktop transcript control plane (FEA-2714,
 * architecture PLN-1285). Consumed by the apps/api routes (`sync-plan`,
 * `complete`) and the desktop TranscriptSyncService (FEA-2715). Transcript
 * bytes never transit apps/api — these routes only authorize, orchestrate S3
 * multipart copy-append, and mint presigned URLs.
 *
 * A logical session owns one `main` transcript file plus zero or more
 * `subagent:{fileId}` sidechain files; every request identifies exactly one
 * file by `(externalSessionId, fileKey)`.
 */

/** Upload lifecycle recorded on `SessionTranscript.uploadStatus`. */
export const TranscriptUploadStatus = {
  Pending: "pending",
  Uploading: "uploading",
  Uploaded: "uploaded",
  Failed: "failed",
  /**
   * Terminal, non-retryable skip (FEA-3476 / PRD-536 D7): the desktop
   * deterministically will not upload this file (e.g. it exceeds the local
   * size cap and would just re-skip on every observation). Distinct from
   * `failed` — which is a *retryable* attempt failure — so the read path can
   * derive `failedPermanent` instead of a misleading `syncing`/`failedTransient`
   * for a transcript that is never coming. The reason is carried on
   * `SessionTranscript.permanentFailureReason`.
   */
  Skipped: "skipped",
} as const;
export type TranscriptUploadStatus =
  (typeof TranscriptUploadStatus)[keyof typeof TranscriptUploadStatus];

/**
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
 *   bounded consecutive-upload-failure ladder was exhausted (transport/S3/plan
 *   errors — the source file itself may still exist). Before ISS-4621 this
 *   generic dead-letter never told the cloud, so the transcript read as
 *   `syncing` forever with no failure reason. Terminal for the AUTOMATIC lane
 *   only: a later change to the source file re-queues it locally (one more
 *   chance), and a successful upload then supersedes the skip server-side.
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
 */
export const TranscriptSkipReason = {
  TooLarge: "too_large",
  SourceGone: "source_gone",
  RetriesExhausted: "retries_exhausted",
  MaterializedSourceUnavailable: "materialized_source_unavailable",
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
 * regenerated, so the row may yet sync) or HARD (the bytes are gone for good).
 *
 * This is the single source of truth for that split. It previously existed only
 * as an inline arm of the API's private `dispositionForTerminalSkipReason` and
 * a literal comparison in the renderer, which is how a recoverable reason came
 * to be able to overwrite a hard one server-side: nothing shared a notion of
 * which reasons outrank which.
 *
 * Exhaustive on purpose — a newly added reason fails `tsc` here until someone
 * decides, deliberately, which side of the line it falls on.
 */
export function isRecoverableTranscriptSkipReason(
  reason: TranscriptSkipReason
): boolean {
  switch (reason) {
    case TranscriptSkipReason.MaterializedSourceUnavailable:
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

/**
 * ISS-4820 — harnesses whose transcript source is a desktop-MATERIALIZED
 * projection of a foreign store (regenerated every sweep) rather than the
 * agent's own raw on-disk transcript.
 *
 * Lives in the wire contract because the SERVER now has to reason about it:
 * only a materialized harness may legitimately pair with the recoverable
 * `materialized_source_unavailable` reason, and the write boundary rejects the
 * mismatch. The desktop's `isBatchMaterializedHarness` reads this same set, so
 * the two sides cannot drift.
 */
export const MATERIALIZED_TRANSCRIPT_HARNESSES = new Set<string>(["opencode"]);

/**
 * ISS-4820 — true when `sourceHarness` names a desktop-materialized projection.
 * Accepts an unconstrained string so a cross-repo / persisted value narrows
 * safely (an unknown harness is treated as NOT materialized, the conservative
 * side: it cannot claim a recoverable disposition).
 */
export function isMaterializedTranscriptHarness(
  sourceHarness: string
): boolean {
  return MATERIALIZED_TRANSCRIPT_HARNESSES.has(sourceHarness);
}

/**
 * Multipart part size: 5.1 MiB (owner-chosen, just above the S3 5 MiB floor).
 * Defined in MiB on purpose — a decimal "5.1 MB" (5,100,000 bytes) would sit
 * below the 5,242,880-byte S3 minimum and fail with `EntityTooSmall`
 * (PLN-1287 v4). Server-configurable; both the desktop (which splits its local
 * delta) and apps/api (which presigns) must agree on this value.
 */
export const TRANSCRIPT_UPLOAD_PART_BYTES = Math.ceil(5.1 * 1024 * 1024); // 5,347,738

/** S3's hard minimum for a non-final multipart part (5 MiB). */
export const S3_MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024; // 5,242,880

/**
 * Upper bound on a sync window (`planEndOffset`). Equals the natural S3 ceiling
 * — part size × 10,000 max parts (~53.5 GB) — so a single request can never
 * drive an unbounded parts-array allocation in `decideSyncPlan`.
 */
export const MAX_TRANSCRIPT_BYTES = TRANSCRIPT_UPLOAD_PART_BYTES * 10_000;

const SHA256_HEX = /^[a-f0-9]{64}$/i;
// Reject the S3 path separator in dynamic key segments so a slash-bearing id
// can't collide across the main/subagent key namespaces or reshape the key.
const PATH_SAFE_SEGMENT = /^[^/]+$/;

/**
 * `main` for the session transcript, `subagent:{fileId}` for sidechain files
 * (v3). The `fileId` segment is opaque and harness-defined but must be
 * path-safe (it becomes an S3 key segment).
 */
export const transcriptFileKeySchema = z
  .string()
  .min(1)
  .regex(
    /^(main|subagent:[^/]+)$/,
    "fileKey must be 'main' or 'subagent:{path-safe id}'"
  );

/**
 * Fields identifying one transcript file. `externalSessionId` is a harness
 * session id (not necessarily a UUID); ownership is enforced by the DB lookup
 * on top of the `computeTargetId` UUID check.
 */
const transcriptFileIdentitySchema = z.object({
  computeTargetId: z.uuid(),
  externalSessionId: z
    .string()
    .min(1)
    .regex(PATH_SAFE_SEGMENT, "externalSessionId must be a path-safe segment"),
  fileKey: transcriptFileKeySchema,
});

/**
 * `POST /desktop/transcripts/sync-plan` request. The client cuts the sync
 * window at a newline boundary (only it sees the bytes) and reports the
 * checksums of exactly that window `[0, planEndOffset)`. The server owns the
 * synced offset and returns the authoritative value in the response (recovery
 * invariant 2); `prefixSha256` lets the server detect a compaction/rewrite.
 */
export const transcriptSyncPlanRequestSchema =
  transcriptFileIdentitySchema.extend({
    sourceHarness: z.string().min(1),
    // Hash of the local file path — no raw local paths in cloud (PRD security).
    sourcePathHash: z.string().min(1),
    // End of the archive object byte window to sync. Current desktop clients
    // derive this from redacted complete-line JSONL bytes, so it can differ
    // from the raw local file offset used to find the complete-line boundary.
    // The stored object is exactly [0, planEndOffset).
    planEndOffset: z.number().int().nonnegative().max(MAX_TRANSCRIPT_BYTES),
    // Checksums of the archive object window [0, planEndOffset): sha256 is the
    // archive identity (idempotency), crc64nvme (base64, as S3 reports it) is
    // the integrity check.
    sha256: z
      .string()
      .regex(SHA256_HEX, "sha256 must be 64 lowercase hex chars"),
    crc64nvme: z.string().min(1),
    // Source file mtime as an ISO-8601 string.
    sourceMtime: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), {
        message: "sourceMtime must be an ISO-8601 date string",
      }),
    // sha256 of the client's archive object prefix [0, serverSyncedOffset),
    // compared to the stored object hash to detect compaction/rewrite. Omit
    // when the client does not know the server offset (e.g. after losing local
    // state) — the server then falls back to a full re-upload.
    prefixSha256: z.string().regex(SHA256_HEX).optional(),
  });
export type TranscriptSyncPlanRequest = z.infer<
  typeof transcriptSyncPlanRequestSchema
>;

/** One presigned upload part in a `multipart` plan. */
export const transcriptUploadPartSchema = z.object({
  partNumber: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  byteLength: z.number().int().positive(),
  url: z.string().min(1),
});
export type TranscriptUploadPart = z.infer<typeof transcriptUploadPartSchema>;

/**
 * `sync-plan` response — a tagged union on `mode`. Every variant carries the
 * authoritative `syncedByteOffset` and `storedEtag` so the client recomputes
 * its delta from server truth (recovery invariant 2).
 *
 * - `noop`: stored checksum already matches an `uploaded` object (PRD FR5).
 * - `fullPut`: payload fits one part (or a small-file prefix mismatch forces a
 *   full rewrite) — one presigned PutObject; `syncedByteOffset` is 0.
 * - `multipart`: full or append upload. For appends, part 1 is the server-side
 *   copy of the current object (`copiedPartEtag`) and `parts` are the delta
 *   parts 2..N; for a large full upload, `parts` are all parts 1..N.
 */
export const transcriptSyncPlanResponseSchema = z.union([
  z.object({
    mode: z.literal("noop"),
    syncedByteOffset: z.number().int().nonnegative(),
    storedEtag: z.string().nullable(),
  }),
  z.object({
    mode: z.literal("fullPut"),
    url: z.string().min(1),
    planEndOffset: z.number().int().nonnegative(),
    syncedByteOffset: z.number().int().nonnegative(),
    storedEtag: z.string().nullable(),
  }),
  z.object({
    mode: z.literal("multipart"),
    uploadId: z.string().min(1),
    // Server-copied part 1 ETag on appends; absent for a from-scratch upload.
    copiedPartEtag: z.string().optional(),
    parts: z.array(transcriptUploadPartSchema),
    planEndOffset: z.number().int().nonnegative(),
    syncedByteOffset: z.number().int().nonnegative(),
    storedEtag: z.string().nullable(),
  }),
]);
export type TranscriptSyncPlanResponse = z.infer<
  typeof transcriptSyncPlanResponseSchema
>;

/**
 * `POST /desktop/transcripts/complete` request. The server finalizes the
 * upload and verifies against S3; it re-derives multipart part ETags via
 * `ListParts` rather than trusting the client, so only the window end and the
 * checksums are reported here.
 */
export const transcriptCompleteRequestSchema = transcriptFileIdentitySchema
  .extend({
    mode: z.enum(["fullPut", "multipart"]),
    // Present for multipart; absent for a single presigned PutObject.
    uploadId: z.string().min(1).optional(),
    // Archive object byte-window end captured at plan time; server verifies
    // HeadObject size.
    planEndOffset: z.number().int().nonnegative().max(MAX_TRANSCRIPT_BYTES),
    // Full-file archive identity + full-object checksum to verify against S3.
    sha256: z
      .string()
      .regex(SHA256_HEX, "sha256 must be 64 lowercase hex chars"),
    crc64nvme: z.string().min(1),
  })
  .refine((value) => value.mode === "fullPut" || Boolean(value.uploadId), {
    message: "uploadId is required for multipart completion",
    path: ["uploadId"],
  });
export type TranscriptCompleteRequest = z.infer<
  typeof transcriptCompleteRequestSchema
>;

/**
 * `complete` response — the verified server state after a successful upload.
 * Carries the authoritative offset + ETag; `sessionDetailId` is populated once
 * the metadata lane's `SessionDetail` row is resolvable.
 */
export const transcriptCompleteResponseSchema = z.object({
  status: z.enum(TranscriptUploadStatus),
  syncedByteOffset: z.number().int().nonnegative(),
  storedEtag: z.string().nullable(),
  sessionDetailId: z.string().nullable(),
});
export type TranscriptCompleteResponse = z.infer<
  typeof transcriptCompleteResponseSchema
>;

/**
 * `POST /desktop/transcripts/skip` request (FEA-3476 / PRD-536 D7). The desktop
 * calls this exactly once when a transcript file transitions to a terminal,
 * deterministic dead state that no retry can clear (e.g. it exceeds the local
 * size cap). It carries no bytes and no checksums — it records that the file is
 * permanently absent so the cloud stops representing it as "syncing" and the
 * read path can derive `failedPermanent`. Idempotent: re-sending the same skip
 * is a no-op on an already-skipped row.
 */
export const transcriptSkipRequestSchema = transcriptFileIdentitySchema
  .extend({
    sourceHarness: z.string().min(1),
    reason: z.enum(TranscriptSkipReason),
  })
  // ISS-4820 item 5: the two fields were validated independently, so a
  // malformed or version-skewed desktop could pair the RECOVERABLE
  // `materialized_source_unavailable` with a raw Claude/Codex harness. The
  // reason-only read branch would then report `Syncing` forever for a source
  // that can never regenerate — a row stuck "still uploading" with nothing on
  // any queue. A recoverable reason is only meaningful for a materialized
  // projection, so reject the pairing at the write boundary rather than
  // persisting a state the read path cannot honestly serve.
  .refine(
    (value) =>
      value.reason !== TranscriptSkipReason.MaterializedSourceUnavailable ||
      isMaterializedTranscriptHarness(value.sourceHarness),
    {
      path: ["reason"],
      error:
        "materialized_source_unavailable is only valid for a batch-materialized sourceHarness",
    }
  );
export type TranscriptSkipRequest = z.infer<typeof transcriptSkipRequestSchema>;

/** `skip` response — the recorded terminal state after the row is marked. */
export const transcriptSkipResponseSchema = z.object({
  status: z.enum(TranscriptUploadStatus),
  // ISS-4820 (codex review): the server echoes what it PERSISTED, and precedence
  // can preserve a reason this client does not recognize (an API rolled back
  // behind a desktop that wrote a newer label — the enum is grow-only). Read it
  // the same way the descriptor/availability schemas already read theirs:
  // degrade an unknown label to `null` instead of rejecting the whole response,
  // which would make an acknowledged terminal skip look unacked and put the row
  // back on the retry ladder forever. Callers key off `status`, not this field.
  permanentFailureReason: z
    .string()
    .nullish()
    .transform(toKnownTranscriptSkipReason),
  sessionDetailId: z.string().nullable(),
});
export type TranscriptSkipResponse = z.infer<
  typeof transcriptSkipResponseSchema
>;

// ---------------------------------------------------------------------------
// Read path + availability states (FEA-2716 / PLN-1289)
//
// The read route authorizes org/session scope, derives the FR8 availability
// state per transcript file, and mints a short-lived signed S3 GET URL for the
// files a caller may read. Consumed by the session-detail UI (FEA-2717) and the
// authenticated desktop renderer. No public URLs; the URL is minted per request
// post-authorization and never stored.
// ---------------------------------------------------------------------------

/**
 * Availability state the API derives per transcript file (PRD-512 FR8). These
 * are the *server-observable* states only; the desktop client composes the
 * remaining FR8 states (`local-only`, `signed-out`, `changed-locally-pending`)
 * from its local IPC status — they are not representable from cloud state.
 *
 * - `available`: uploaded and current — a signed GET URL is issued.
 * - `stale`: uploaded, but the desktop has since reported a newer fingerprint
 *   (`lastObservedAt > uploadedAt`); the current archived bytes are still
 *   readable, so a URL is issued.
 * - `uploadPending`: an upload is queued or in flight (`pending`/`uploading`);
 *   no URL yet.
 * - `uploadFailed`: the last upload attempt failed; no URL. Distinct from
 *   `missing` so the UI can tell a data bug from an availability gap (AC6).
 * - `missing`: no `SessionTranscript` row exists for a file the metadata lane
 *   knows the session should have (e.g. the main transcript before first
 *   upload, or after a source file was deleted pre-upload).
 */
export const TranscriptAvailability = {
  Available: "available",
  Stale: "stale",
  UploadPending: "uploadPending",
  UploadFailed: "uploadFailed",
  /**
   * `permanentlyUnavailable` (FEA-3476 / PRD-536 D7): the desktop reported a
   * terminal, non-retryable skip (`uploadStatus = skipped`, e.g. oversized), so
   * the archive will never contain this file. No URL, and — unlike
   * `uploadFailed` — no retry can ever recover it, so the UI shows a distinct
   * terminal state rather than a retry affordance.
   */
  PermanentlyUnavailable: "permanentlyUnavailable",
  Missing: "missing",
} as const;
export type TranscriptAvailability =
  (typeof TranscriptAvailability)[keyof typeof TranscriptAvailability];

/** Signed GET URL TTL for transcript reads (PLN-1289: short-lived, ~5 min). */
export const TRANSCRIPT_DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * FEA-3479 (PRD-536 G1) — session-level transcript disposition.
 *
 * ISS-4848: the enum, its union type, and its values tuple moved to the Zod-FREE
 * `transcript-disposition-constants` leaf module — this module imports `zod` on
 * its first line, so every client that only needed the enum for a comparison was
 * pulling Zod into bundle-sensitive embeds. Import it from that module directly;
 * it is deliberately NOT re-exported here (Biome `noBarrelFile`), matching the
 * split already made for `agent-session-cloud-sync-state-constants`.
 */

/**
 * One transcript file in a read-access response. `url` is a short-lived signed
 * S3 GET, non-null only when `availability` is `available` or `stale`. The
 * remaining fields are `null` for a `missing` file (no row) and until an upload
 * has completed.
 */
export const transcriptFileDescriptorSchema = z.object({
  // `main` or `subagent:{fileId}` — reuses the upload contract's key schema so
  // the read and write surfaces stay on the same namespace.
  fileKey: transcriptFileKeySchema,
  availability: z.enum(TranscriptAvailability),
  // Signed GET URL, minted per request; null unless available/stale.
  url: z.string().nullable(),
  // Verified archive byte size; null until an upload has completed.
  byteSize: z.number().int().nonnegative().nullable(),
  // Archive identity (client-computed sha256); null until uploaded.
  rawSha256: z.string().nullable(),
  // ISO-8601; null until an upload has completed.
  uploadedAt: z.string().nullable(),
  // ISO-8601 fingerprint-observation time; null for a missing file.
  lastObservedAt: z.string().nullable(),
  // FEA-3476: reason a `permanentlyUnavailable` file was terminally skipped
  // (e.g. `too_large`); null for every other availability state. Read as
  // `nullish` (not strictly `nullable`) and normalized to `null` so an updated
  // Desktop reading an older API that predates this additive field does not
  // reject every otherwise-valid descriptor as malformed and fail cloud reads.
  // ISS-4621: an UNKNOWN reason string (older client, newer server — the enum
  // is grow-only) likewise degrades to `null` instead of rejecting the whole
  // `files` array; see {@link toKnownTranscriptSkipReason}.
  permanentFailureReason: z
    .string()
    .nullish()
    .transform(toKnownTranscriptSkipReason),
});
export type TranscriptFileDescriptor = z.infer<
  typeof transcriptFileDescriptorSchema
>;

/**
 * `GET /agent-sessions/{id}/transcript` response: one descriptor per transcript
 * file of the session (the main file plus any subagent sidechain files).
 */
export const transcriptAccessResponseSchema = z.object({
  // The session's artifact id (echoes the route `[id]`).
  sessionId: z.string(),
  files: z.array(transcriptFileDescriptorSchema),
});
export type TranscriptAccessResponse = z.infer<
  typeof transcriptAccessResponseSchema
>;

/**
 * Lightweight per-file availability summary embedded in the session detail
 * response so list/detail UIs can show availability without minting a URL. The
 * signed-URL route stays separate — URLs are only issued on explicit access.
 */
export const transcriptAvailabilitySummarySchema = z.object({
  fileKey: transcriptFileKeySchema,
  availability: z.enum(TranscriptAvailability),
  uploadedAt: z.string().nullable(),
  // FEA-3476: reason a `permanentlyUnavailable` file was terminally skipped
  // (e.g. `too_large`); null for every other availability state. Read as
  // `nullish` and normalized to `null` so a client reading an older API that
  // predates this additive field treats it as absent rather than malformed.
  // ISS-4621: unknown reason strings from a newer server degrade to `null`
  // too; see {@link toKnownTranscriptSkipReason}.
  permanentFailureReason: z
    .string()
    .nullish()
    .transform(toKnownTranscriptSkipReason),
});
export type TranscriptAvailabilitySummary = z.infer<
  typeof transcriptAvailabilitySummarySchema
>;

/**
 * Canonical result of a user-initiated force-archive of ONE oversized transcript
 * (FEA-3489 / PRD-536) — the SINGLE source of truth for the shape, imported by
 * every side of the bridge so the desktop wire type and the shared-UI transport
 * cannot drift: the desktop IPC contract
 * (`apps/desktop/src/shared/transcript-read-contract.ts` re-exports it), the
 * desktop main process (`transcript-sync-service.ts`,
 * `transcript-force-archive-ipc.ts`), and the shared renderer transport/panel
 * (`@repo/app`) all reference this type.
 *
 * Discriminated so the renderer can render an honest state:
 *  - `uploaded`: the forced upload settled; the cloud disposition flips to
 *    available once caught up. `caughtUp: false` means more chunks remain and the
 *    durable resume lane (which bypasses the whole-file size cap for a
 *    partially-synced row — `syncedByteOffset > 0`) continues them, so the file
 *    is NOT stranded.
 *  - `noop`: the server already held the bytes; nothing to upload.
 *  - `notFound`: no eligible dead row to force (already synced, never tracked, or
 *    the dead reason is one the size-cap bypass cannot fix — see `permanent`).
 *  - `unavailable`: the sync lane is off / offline / consent not granted —
 *    retryable once the lane is available.
 *  - `failed`: a RETRYABLE upload failure; `reason` carries a human-readable
 *    message. Distinct from `permanent`.
 *  - `permanent`: a NON-retryable terminal outcome the size-cap bypass cannot fix
 *    (a single redacted JSONL line exceeds the per-line wire limit, or the local
 *    source is gone). The renderer renders terminal copy WITHOUT a retry
 *    invitation. (FEA-3489 review: terminal skips must not be surfaced as
 *    retryable `failed`.)
 */
export type TranscriptForceArchiveResult =
  | { kind: "uploaded"; caughtUp: boolean }
  | { kind: "noop" }
  | { kind: "notFound" }
  | { kind: "unavailable" }
  | { kind: "failed"; reason: string }
  | { kind: "permanent"; reason: string };

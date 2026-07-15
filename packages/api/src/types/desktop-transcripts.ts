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
} as const;
export type TranscriptUploadStatus =
  (typeof TranscriptUploadStatus)[keyof typeof TranscriptUploadStatus];

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
    // End of the byte window to sync, cut at the last complete newline
    // (<= the current file size). The stored object is exactly [0, planEndOffset).
    planEndOffset: z.number().int().nonnegative().max(MAX_TRANSCRIPT_BYTES),
    // Checksums of the window [0, planEndOffset): sha256 is the archive identity
    // (idempotency), crc64nvme (base64, as S3 reports it) is the integrity check.
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
    // sha256 of the client's local prefix [0, serverSyncedOffset), compared to
    // the stored object hash to detect compaction/rewrite. Omit when the client
    // does not know the server offset (e.g. after losing local state) — the
    // server then falls back to a full re-upload.
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
    // Byte-window end captured at plan time; server verifies HeadObject size.
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
  Missing: "missing",
} as const;
export type TranscriptAvailability =
  (typeof TranscriptAvailability)[keyof typeof TranscriptAvailability];

/** Signed GET URL TTL for transcript reads (PLN-1289: short-lived, ~5 min). */
export const TRANSCRIPT_DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

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
});
export type TranscriptAvailabilitySummary = z.infer<
  typeof transcriptAvailabilitySummarySchema
>;

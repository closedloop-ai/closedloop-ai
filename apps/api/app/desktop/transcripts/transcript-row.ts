import {
  type TranscriptSyncPlanRequest,
  type TranscriptSyncPlanResponse,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { Result } from "@repo/api/src/types/result";
import type { TransactionClient } from "@repo/database";
import { projectedIdentityColumns } from "./transcript-index-keys";
import { identityWhere } from "./transcript-request-context";
import type { TranscriptS3Port } from "./transcript-s3-port";
import type { TranscriptSyncErrorReason } from "./transcript-sync-error-reason";

/**
 * The `session_transcripts` row as the sync control plane reads and writes it.
 *
 * Extracted from `service.ts` so the projection rule — which columns a plan,
 * complete, or skip actually needs — sits next to the writes that produce them,
 * leaving the service an orchestration surface. Same split as
 * `desktop-command-mappers.ts` next to `desktop-command-store.ts`.
 */

/**
 * The columns the plan/complete/skip flows read. Deliberately excludes the
 * identity, provenance, and verified-object columns (`organizationId`,
 * `computeTargetId`, `externalSessionId`, `fileKey`, `objectStorageKey`,
 * `sourceHarness`, `crc64nvme`, `rawByteSize`, `sourceMtime`, `sourcePathHash`,
 * and the five lifecycle timestamps `firstSeenAt`, `lastObservedAt`,
 * `uploadedAt`, `createdAt`, `updatedAt`): every one of them is either supplied
 * by the request or written but never read back on these paths.
 */
export type TranscriptSyncRow = {
  id: string;
  uploadStatus: string;
  permanentFailureReason: string | null;
  rawSha256: string | null;
  storedEtag: string | null;
  syncedByteOffset: bigint;
  sessionDetailId: string | null;
  pendingUploadId: string | null;
  pendingUploadStartedAt: Date | null;
};

/**
 * The RETURNING list every `session_transcripts` read in the service uses.
 *
 * Exactly `keyof TranscriptSyncRow`, enforced by the `satisfies` below so a
 * column added to the row type fails `tsc` here instead of arriving `undefined`
 * in a helper. That guard is the only backstop on these paths: the rows reach
 * helpers through declared parameter types, and a structural check would accept
 * a too-narrow row wherever the value is cast or widened.
 */
export const TRANSCRIPT_SYNC_ROW_SELECT = {
  id: true,
  uploadStatus: true,
  permanentFailureReason: true,
  rawSha256: true,
  storedEtag: true,
  syncedByteOffset: true,
  sessionDetailId: true,
  pendingUploadId: true,
  pendingUploadStartedAt: true,
} as const satisfies Record<keyof TranscriptSyncRow, true>;

export type TranscriptPlanRowData = {
  organizationId: string;
  sourceHarness: string;
  objectStorageKey: string;
  uploadStatus: TranscriptUploadStatus;
  sourcePathHash: string;
  sourceMtime: Date | null;
  lastObservedAt: Date;
  sessionDetailId: string | null;
  pendingUploadId: string | null;
  pendingUploadStartedAt: Date | null;
};

export function isUploadedMatch(
  row: TranscriptSyncRow,
  sha256: string
): boolean {
  return (
    row.uploadStatus === TranscriptUploadStatus.Uploaded &&
    row.rawSha256 === sha256
  );
}

export function noopResult(
  row: TranscriptSyncRow
): Result<TranscriptSyncPlanResponse, TranscriptSyncErrorReason> {
  return Result.ok({
    mode: "noop",
    syncedByteOffset: Number(row.syncedByteOffset),
    storedEtag: row.storedEtag,
  });
}

/** Upsert the in-flight row: create with lifecycle timestamps, or update the
 * mutable planning columns without touching verified state. */
export function upsertPlanRow(
  tx: TransactionClient,
  request: TranscriptSyncPlanRequest,
  data: TranscriptPlanRowData
): Promise<unknown> {
  return tx.sessionTranscript.upsert({
    where: identityWhere(request),
    create: {
      organizationId: data.organizationId,
      computeTargetId: request.computeTargetId,
      // ISS-8125: the same projected identity `identityWhere` above matched on.
      ...projectedIdentityColumns(request),
      sourceHarness: data.sourceHarness,
      objectStorageKey: data.objectStorageKey,
      uploadStatus: data.uploadStatus,
      sourcePathHash: data.sourcePathHash,
      sourceMtime: data.sourceMtime,
      lastObservedAt: data.lastObservedAt,
      sessionDetailId: data.sessionDetailId,
      pendingUploadId: data.pendingUploadId,
      pendingUploadStartedAt: data.pendingUploadStartedAt,
    },
    update: {
      sourceHarness: data.sourceHarness,
      objectStorageKey: data.objectStorageKey,
      uploadStatus: data.uploadStatus,
      sourcePathHash: data.sourcePathHash,
      // A degraded (out-of-range) mtime on a retry must not null out a
      // previously stored good mtime — omit the key rather than write null.
      ...(data.sourceMtime === null ? {} : { sourceMtime: data.sourceMtime }),
      lastObservedAt: data.lastObservedAt,
      pendingUploadId: data.pendingUploadId,
      pendingUploadStartedAt: data.pendingUploadStartedAt,
      // FEA-3489 (review): a `plan` request re-opens a previously `skipped` row
      // for upload (the desktop force-archive override reuses this same lane).
      // Clear any prior `permanentFailureReason` (`too_large`) here so a row
      // moving back into `uploading` can never carry a stale terminal reason —
      // otherwise a subsequent `complete` would leave the descriptor
      // `available` WITH `permanentFailureReason: too_large`, violating the
      // availability contract. Idempotent: null-to-null for a fresh row.
      permanentFailureReason: null,
      ...(data.sessionDetailId
        ? { sessionDetailId: data.sessionDetailId }
        : {}),
    },
    select: { id: true },
  });
}

export function markFailed(
  tx: TransactionClient,
  id: string
): Promise<unknown> {
  return tx.sessionTranscript.update({
    where: { id },
    data: {
      uploadStatus: TranscriptUploadStatus.Failed,
      pendingUploadId: null,
      pendingUploadStartedAt: null,
    },
    select: { id: true },
  });
}

export async function failAndAbort(
  tx: TransactionClient,
  id: string,
  s3: TranscriptS3Port,
  objectKey: string,
  uploadId: string | undefined
): Promise<void> {
  await markFailed(tx, id);
  if (uploadId) {
    await s3
      .abortMultipartUpload({ key: objectKey, uploadId })
      .catch(() => undefined);
  }
}

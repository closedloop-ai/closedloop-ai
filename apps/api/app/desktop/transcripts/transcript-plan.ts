import {
  S3_MIN_MULTIPART_PART_BYTES,
  TRANSCRIPT_UPLOAD_PART_BYTES,
} from "@repo/api/src/types/desktop-transcripts";

/**
 * Pure planning helpers for the transcript control plane (FEA-2714). No S3 or
 * DB access — the service layer turns these descriptors into presigned URLs and
 * server-side copies. Kept pure so the part-boundary logic is unit-testable.
 */

const SUBAGENT_FILE_KEY_PREFIX = "subagent:";

/**
 * S3 object key for a transcript file (PLN-1285 object-key scheme):
 *   main:     {org}/{ct}/{sessionId}.jsonl
 *   subagent: {org}/{ct}/{sessionId}/subagent/{fileId}.jsonl
 */
export function resolveTranscriptObjectKey(params: {
  organizationId: string;
  computeTargetId: string;
  externalSessionId: string;
  fileKey: string;
}): string {
  const base = `${params.organizationId}/${params.computeTargetId}/${params.externalSessionId}`;
  if (params.fileKey === "main") {
    return `${base}.jsonl`;
  }
  const fileId = params.fileKey.slice(SUBAGENT_FILE_KEY_PREFIX.length);
  return `${base}/subagent/${fileId}.jsonl`;
}

/** A part the client must upload directly (presigned PUT). */
export type PlannedPutPart = {
  partNumber: number;
  offset: number;
  byteLength: number;
};

/**
 * The decided shape of a sync window `[0, planEndOffset)`:
 * - `fullPut`: single presigned PutObject (payload fits one part).
 * - `multipartFresh`: from-scratch multipart, all parts client-uploaded.
 * - `multipartAppend`: part 1 is a server-side copy of the current object
 *   (`copyByteLength` = the existing verified size), parts 2..N are the delta.
 */
export type SyncPlanDecision =
  | { mode: "fullPut" }
  | { mode: "multipartFresh"; parts: PlannedPutPart[] }
  | {
      mode: "multipartAppend";
      copyByteLength: number;
      parts: PlannedPutPart[];
    };

/** Split `[start, end)` into `partSize` chunks (last chunk may be smaller). */
function splitRange(
  start: number,
  end: number,
  partSize: number,
  firstPartNumber: number
): PlannedPutPart[] {
  const parts: PlannedPutPart[] = [];
  let offset = start;
  let partNumber = firstPartNumber;
  while (offset < end) {
    const byteLength = Math.min(partSize, end - offset);
    parts.push({ partNumber, offset, byteLength });
    offset += byteLength;
    partNumber += 1;
  }
  return parts;
}

/**
 * Decide how to upload the window `[0, planEndOffset)` given the current
 * verified object size (`syncedOffset`) and whether the stored prefix is still
 * consistent with the client's file.
 *
 * Copy-append is used ONLY when the prefix is consistent AND the existing
 * object is at least the S3 5 MiB minimum (so the copied part 1 is a legal
 * non-final part) AND there is new data. Otherwise the whole window is
 * re-uploaded — as a single PutObject when it fits one part, else a
 * from-scratch multipart (PLN-1287 §Chunked upload).
 */
export function decideSyncPlan(params: {
  planEndOffset: number;
  syncedOffset: number;
  prefixConsistent: boolean;
  partSize?: number;
}): SyncPlanDecision {
  const partSize = params.partSize ?? TRANSCRIPT_UPLOAD_PART_BYTES;
  const canAppend =
    params.prefixConsistent &&
    params.syncedOffset >= S3_MIN_MULTIPART_PART_BYTES &&
    params.planEndOffset > params.syncedOffset;

  if (canAppend) {
    return {
      mode: "multipartAppend",
      copyByteLength: params.syncedOffset,
      parts: splitRange(params.syncedOffset, params.planEndOffset, partSize, 2),
    };
  }

  if (params.planEndOffset <= partSize) {
    return { mode: "fullPut" };
  }
  return {
    mode: "multipartFresh",
    parts: splitRange(0, params.planEndOffset, partSize, 1),
  };
}

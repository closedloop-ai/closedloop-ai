/**
 * @file transcript-s3-rejection.ts
 * @description Classify a caught error in the transcript sync lane into the
 * families the lane has to answer differently. Two independent classifiers
 * live here: {@link isUpstreamS3Rejection} (ISS-7097) reads an error S3 itself
 * threw back at a request; {@link isStorageNotConfiguredError} (ISS-8689,
 * PRD-699 Appendix A) reads the app's OWN bucket-resolver error, thrown before
 * any request reaches S3 when `TRANSCRIPTS_BUCKET` is unset — an environmental
 * failure, not a judgment S3 made about the caller's request.
 *
 * Its own module rather than a helper inside `service.ts` for the same reason
 * `transcript-sync-error-reason.ts` is: these are small, pure, independently
 * testable decisions, and `service.ts` sits on the repo's 1,000-line ceiling.
 */
import { z } from "zod";

/**
 * The slice of an AWS SDK error that says whether S3 answered, and how. Read
 * through Zod rather than a cast: this is an `unknown` caught value whose shape
 * is the SDK's to change, and a bad read here would silently classify every S3
 * rejection as row-attributable.
 */
const s3RejectionSchema = z.object({
  $metadata: z.object({ httpStatusCode: z.number().optional() }).optional(),
});

/**
 * Did S3 fail to answer, rather than judge the request?
 *
 * 5xx and 429 are S3 being unavailable or throttling (`SlowDown` is a 503) —
 * lane-wide, and true of every concurrent upload. A 4xx is S3 judging THIS
 * request: `PreconditionFailed` on the `If-Match` etag, `BadDigest` on the
 * checksum, `NoSuchUpload` on an aborted id. Those are genuinely stale plans
 * and keep their 409.
 *
 * An error carrying no status at all — a client-side throw before the request
 * left, an SDK shape this build does not know — is NOT assumed lane-wide.
 * Defaulting to the pre-existing 409 keeps an unrecognised failure on the
 * behaviour it already had rather than silently freezing retry budget on it.
 */
export function isUpstreamS3Rejection(error: unknown): boolean {
  const parsed = s3RejectionSchema.safeParse(error);
  if (!parsed.success) {
    return false;
  }
  const status = parsed.data.$metadata?.httpStatusCode;
  if (status === undefined) {
    return false;
  }
  return status === 429 || status >= 500;
}

/**
 * The slice of {@link TranscriptStorageNotConfiguredError} this classifier
 * needs. Read through Zod rather than `instanceof` for the same reason as
 * {@link s3RejectionSchema}: this is an `unknown` caught value, and matching
 * the discriminant field (not `error.message`, which is free to reword) keeps
 * the classifier a contract rather than a string-matching accident.
 */
const storageNotConfiguredSchema = z.object({
  transcriptStorageNotConfigured: z.literal(true),
});

/**
 * Did the caller fail before ever reaching S3, because `TRANSCRIPTS_BUCKET` is
 * unset? PRD-699 Appendix A classifies this as ENVIRONMENTAL: an admin setting
 * the variable is the only fix, so it must never be answered like a
 * row-attributable failure, and it needs a far longer Retry-After than a
 * transient S3 outage.
 */
export function isStorageNotConfiguredError(error: unknown): boolean {
  return storageNotConfiguredSchema.safeParse(error).success;
}

/**
 * @file transcript-s3-put-classification.ts
 * @description ISS-8608 (PRD-699 Appendix A, fourth named exception / fix F6):
 * what an S3 presigned-PUT rejection means, and what the monitored lane calls
 * it. Split out of `transcript-sync-types.ts` (ISS-8614) as that file came down
 * under the shared classification module.
 *
 * A SEPARATE ARM, not a second opinion. The CONTROL plane's classification is
 * `shared/sync-failure-classification.ts`, reached through
 * `transcript-sync-types.ts`'s `isLaneWideHttpStatus`, and nothing here can move
 * a control-plane verdict. {@link classifyS3PutFailure} answers `undefined`
 * outside the 400/403 Appendix A scopes it to, so the two compose with OR at
 * their one call site (`transcript-failure-classification.ts`) and this arm can
 * only ever ADD an environmental verdict, never remove one.
 *
 * The class and the reason live together for the same reason the control-plane
 * trio does: they read ONE error and must never disagree about it. An expired
 * presign frozen as environmental for the retry budget while the telemetry pages
 * `target_not_owned` is the collapse that split removed.
 */

import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { SyncFailureClass } from "../../shared/sync-failure-classification.js";

/**
 * ISS-8608 (PRD-699 Appendix A, fourth named exception / fix F6): the two
 * behaviour classes an S3 presigned-PUT rejection can land in.
 *
 * A NARROWING of {@link SyncFailureClass}, never a second spelling of it
 * (ISS-8614): the members are Appendix A's own, so a rename there must reach
 * here, and the two-member type still says what this arm cannot produce — an S3
 * PUT is never PROTOCOL-ABSENT.
 */
export const S3PutFailureClass = {
  Environmental: SyncFailureClass.Environmental,
  Item: SyncFailureClass.Item,
} as const;
export type S3PutFailureClass =
  (typeof S3PutFailureClass)[keyof typeof S3PutFailureClass];

/**
 * The S3 error codes whose cause is a property of THESE bytes or THIS key, so a
 * re-send cannot change the answer and the row keeps its terminal door.
 *
 * Held to two on purpose. Two codes the triage brief nominated are deliberately
 * NOT here, and both would have re-created the loss this ticket removes:
 * - `InvalidArgument` is S3's broadest 400 and on this arm is dominated by
 *   UNIFORM request-construction skew. `packages/aws/transcript-storage.ts`
 *   signs a CONCRETE `ChecksumCRC64NVME` and hoists `StorageClass` into the
 *   signed query, while the client sends one constant header set for every row —
 *   so a presigner/desktop skew makes S3 answer identically for every queued
 *   transcript, and charging it to the item would dead-letter the whole queue
 *   in five attempts.
 *
 *   **The environmental side POSTPONES that, it does not avoid it.** With
 *   `retryCount` frozen at 0, `laneStalledSince` opens on the first failure and
 *   24h later every row is `deadEligible` and takes the same acked
 *   `retries_exhausted` skip. What the environmental side actually buys is the
 *   WINDOW: a presigner fix that ships inside a day recovers every queued row,
 *   where the ladder would have burned them out in minutes. That is the whole
 *   claim — do not read this entry as saying the loss cannot happen on this
 *   side.
 * - `InvalidDigest` is S3's error for a malformed `Content-MD5`, a header this
 *   client never sends, so the entry would be unreachable — and it would point
 *   the opposite way from `BadDigest` for the same phenomenon.
 * Both therefore take the environmental default below, which is the side
 * Appendix A's uniformity test ("every item would fail identically → charge
 * nothing to the item") requires.
 */
const S3ItemErrorCode = {
  EntityTooLarge: "EntityTooLarge",
  KeyTooLongError: "KeyTooLongError",
} as const;
type S3ItemErrorCode = (typeof S3ItemErrorCode)[keyof typeof S3ItemErrorCode];

/**
 * Appendix A's fourth exception is scoped to "S3 PUT **403/400**", and the scope
 * is load-bearing rather than tidiness: 409 and 413 are on the row ladder for
 * reasons this refinement has no evidence about, so it must decline them rather
 * than answer them. See {@link classifyS3PutFailure}.
 */
const S3_CODE_REFINABLE_STATUSES: ReadonlySet<number> = new Set([400, 403]);

/**
 * The ITEM side, and the reason each member reports.
 *
 * MEMBERSHIP is the class — nothing here stores one. A stored `class` field
 * would be a second oracle inside the one table: every entry in an ITEM table is
 * ITEM by construction, so a future entry marked otherwise would silently
 * reclassify with nothing to catch it. The `Record<S3ItemErrorCode, …>`
 * annotation sits on this LITERAL so adding a union member without deciding its
 * reason fails `tsc` (TS2741) rather than inheriting the environmental default.
 */
const S3_ITEM_REASONS: Record<S3ItemErrorCode, SyncReason> = {
  [S3ItemErrorCode.EntityTooLarge]: SyncReason.LocallyOversized,
  [S3ItemErrorCode.KeyTooLongError]: SyncReason.ValidationFailed,
};

/**
 * A `Map`, not the literal: the key is parsed out of S3's response body, and a
 * plain-object lookup would answer `__proto__` with `Object.prototype`. Same
 * hazard and same answer as `HTTP_STATUS_SYNC_REASON` in
 * `sync-lane-cloud-health.ts`, which states the rule for the identical reason.
 */
const S3_ITEM_LOOKUP: ReadonlyMap<string, SyncReason> = new Map(
  Object.entries(S3_ITEM_REASONS)
);

/**
 * Better REPORTED names for environmental codes worth telling apart on the
 * monitored lane. PARTIAL and label-only by construction: it is never consulted
 * for the class, so it cannot move a code between behaviours — a property
 * `transcript-lane-wide-failure.test.ts` asserts directly. Without it a real S3
 * credential outage would read as an offline blip, which is exactly what
 * `transcriptFailureSyncReason`'s neighbouring comment warns against.
 */
const S3_ENVIRONMENTAL_REASONS: ReadonlyMap<string, SyncReason> = new Map([
  ["AccessDenied", SyncReason.Unauthenticated],
  ["ExpiredToken", SyncReason.Unauthenticated],
  ["InvalidAccessKeyId", SyncReason.Unauthenticated],
  ["RequestTimeTooSkewed", SyncReason.Unauthenticated],
  ["SignatureDoesNotMatch", SyncReason.Unauthenticated],
  ["IncompleteBody", SyncReason.TransportTimeout],
  ["RequestTimeout", SyncReason.TransportTimeout],
]);

function isS3CodeRefinable(status: number | undefined): boolean {
  return status !== undefined && S3_CODE_REFINABLE_STATUSES.has(status);
}

/**
 * ISS-8608: is this presigned-PUT rejection the OBJECT's fault, or the
 * environment's?
 *
 * `undefined` means the question does not belong to this arm — the status is
 * outside 400/403, or absent — and the caller's existing status decision stands
 * untouched. That is what keeps a 409 `StaleUpload` and a 413 on the row ladder
 * they are already on: this function declines them, it does not answer them.
 *
 * Only the ITEM side is enumerated. An unknown, absent or unparseable code at
 * 400/403 is ENVIRONMENTAL, so a code this build has never seen takes the safe
 * answer without anybody editing a set — the same hardwired ENVIRONMENTAL tail
 * the shared classification module reaches by OMISSION (ISS-9695). Naming the
 * environmental codes instead would put that default on the wrong side.
 *
 * Environmental by this default — as a CLASS; what each is CALLED is
 * {@link s3PutSyncReason}'s question, and only some are named there —
 * `RequestTimeout`, `IncompleteBody`, `ExpiredToken`, `AccessDenied`,
 * `SignatureDoesNotMatch`, `RequestTimeTooSkewed`, `InvalidAccessKeyId`,
 * `BadDigest`, `XAmzContentSHA256Mismatch`. The last two report the generic
 * `TransportError`, which is correct: neither is a credential failure nor a
 * timeout, and inventing a label for them would enumerate the environmental
 * side by the back door. `SlowDown`, `ServiceUnavailable`, `InternalError`
 * and `NoSuchUpload` are absent for a different reason — their statuses are
 * outside the gate, so the control plane's own classification already answers
 * them and a second table would be a duplicate oracle for one question.
 *
 * **`BadDigest` here is not the `BadDigest` the SERVER classifies.**
 * `apps/api/app/desktop/transcripts/transcript-s3-rejection.ts` reads errors
 * from the API's OWN SDK calls — multipart completion, where the server verifies
 * the assembled object — and folds a request-judged 4xx into a 409 the desktop
 * then walks on the `StaleUpload` ladder WITH a re-plan. This reads what S3 told
 * the DESKTOP about its direct PUT, where a checksum mismatch on a streamed
 * multi-MB body is in-transit corruption a re-read fixes. Different arm,
 * different remedy, and neither classifier can see the other's errors.
 */
export function classifyS3PutFailure(
  status: number | undefined,
  code: string | undefined
): S3PutFailureClass | undefined {
  if (!isS3CodeRefinable(status)) {
    return undefined;
  }
  return code !== undefined && S3_ITEM_LOOKUP.has(code)
    ? S3PutFailureClass.Item
    : S3PutFailureClass.Environmental;
}

/**
 * ISS-8608: the batch-health reason for the same rejection.
 *
 * Reads the ITEM side from the same table {@link classifyS3PutFailure} does, so
 * the retry budget and the monitored lane can never name different causes for
 * one failure — the collapse `transcriptFailureSyncReason` exists to prevent.
 * `undefined` carries the same meaning it has there.
 */
export function s3PutSyncReason(
  status: number | undefined,
  code: string | undefined
): SyncReason | undefined {
  if (!isS3CodeRefinable(status)) {
    return undefined;
  }
  if (code === undefined) {
    return SyncReason.TransportError;
  }
  return (
    S3_ITEM_LOOKUP.get(code) ??
    S3_ENVIRONMENTAL_REASONS.get(code) ??
    SyncReason.TransportError
  );
}

/**
 * ISS-9464 — the per-item result contract for the `/v2` batch mutation routes.
 *
 * A v2 route answers a valid, authorized request with HTTP 200 and one result
 * per distinct requested id, even when some items fail. The envelope is non-2xx
 * only for an auth failure, a malformed body, or a problem with a field every
 * item shares. Each result carries its own HTTP-style status; a failed result
 * also carries a code from the closed union below.
 *
 * The codes reuse the literals the v1 batch routes already answer with,
 * imported rather than re-spelled, so a client parsing a v1 error envelope
 * branches on the same strings here.
 */

import { z } from "zod";
import { ArtifactPriorityMutationErrorCode } from "./artifact-priority-mutation.ts";
import type { JsonObject } from "./common.ts";
import { DocumentStatusMutationErrorCode } from "./document-status-mutation.ts";
import { Status } from "./result.ts";

export const BatchItemFailureCode = {
  ArtifactsNotFound: DocumentStatusMutationErrorCode.ArtifactsNotFound,
  InvalidStatusForSubtype:
    DocumentStatusMutationErrorCode.InvalidStatusForSubtype,
  StaleStatus: DocumentStatusMutationErrorCode.StaleStatus,
  StalePriority: ArtifactPriorityMutationErrorCode.StalePriority,
  /**
   * The item itself was valid, but its all-or-nothing batch was refused because
   * another item failed (bulk-assign, ISS-8649).
   */
  BatchRefused: "batch_refused",
  /**
   * The batch ran, but the server produced no result for this item, so it
   * cannot say whether the item was applied. A server bug, reported per item so
   * the items that did commit stay visible instead of one 500 hiding them.
   */
  OutcomeUnknown: "outcome_unknown",
} as const;
export type BatchItemFailureCode =
  (typeof BatchItemFailureCode)[keyof typeof BatchItemFailureCode];

/**
 * The statuses a failed item can carry. They follow the single-document route
 * (a missing id is 404), not the whole-batch v1 route (which answers 400).
 *
 * `FailedDependency` lives here and NOT in the shared `Status` const: it only
 * ever describes one item inside a 200 envelope, never a response.
 */
export const BatchItemFailureStatus = {
  BadRequest: Status.BadRequest,
  NotFound: Status.NotFound,
  Conflict: Status.Conflict,
  FailedDependency: 424,
  ServerError: Status.Error,
} as const;
export type BatchItemFailureStatus =
  (typeof BatchItemFailureStatus)[keyof typeof BatchItemFailureStatus];

export const BATCH_ITEM_APPLIED_STATUS = 200;

/**
 * Optional success detail for mutations where the requested post-state may
 * already hold. Batch tag removal uses this to distinguish a deleted
 * membership from an idempotent no-op without turning the no-op into a failure.
 */
export const BatchItemAppliedOutcome = {
  Removed: "removed",
  NotPresent: "not_present",
} as const;
export type BatchItemAppliedOutcome =
  (typeof BatchItemAppliedOutcome)[keyof typeof BatchItemAppliedOutcome];

/** Exhaustive, so a code added without a status fails `tsc`. */
export const BATCH_ITEM_FAILURE_STATUS: Readonly<
  Record<BatchItemFailureCode, BatchItemFailureStatus>
> = {
  [BatchItemFailureCode.ArtifactsNotFound]: BatchItemFailureStatus.NotFound,
  [BatchItemFailureCode.InvalidStatusForSubtype]:
    BatchItemFailureStatus.BadRequest,
  [BatchItemFailureCode.StaleStatus]: BatchItemFailureStatus.Conflict,
  [BatchItemFailureCode.StalePriority]: BatchItemFailureStatus.Conflict,
  [BatchItemFailureCode.BatchRefused]: BatchItemFailureStatus.FailedDependency,
  [BatchItemFailureCode.OutcomeUnknown]: BatchItemFailureStatus.ServerError,
};

/** Exhaustive, so a code added without a message fails `tsc`. */
export const BATCH_ITEM_FAILURE_MESSAGE: Readonly<
  Record<BatchItemFailureCode, string>
> = {
  [BatchItemFailureCode.ArtifactsNotFound]: "This artifact was not found.",
  [BatchItemFailureCode.InvalidStatusForSubtype]:
    "This artifact's type does not allow that status.",
  [BatchItemFailureCode.StaleStatus]:
    "This artifact's status changed before the update.",
  [BatchItemFailureCode.StalePriority]:
    "This artifact's priority changed before the update.",
  [BatchItemFailureCode.BatchRefused]:
    "This item was not applied because another item in the batch failed.",
  [BatchItemFailureCode.OutcomeUnknown]:
    "The server could not confirm whether this item was applied.",
};

export type BatchItemApplied = {
  id: string;
  status: typeof BATCH_ITEM_APPLIED_STATUS;
  outcome?: BatchItemAppliedOutcome;
};

export type BatchItemFailed = {
  id: string;
  status: BatchItemFailureStatus;
  code: BatchItemFailureCode;
  message: string;
  details?: JsonObject;
};

export type BatchItemResult = BatchItemApplied | BatchItemFailed;

/**
 * `data` of a v2 batch response. An object rather than a bare array so a later
 * field (the ISS-9578 invalidation hint) is additive.
 *
 * `transactionId` is the id every receipt this one mutation produced carries —
 * its activity rows and its audit entries (ISS-9465) — so a client holding the
 * response can name the group the server wrote. OPTIONAL and OMITTED when
 * absent, never `null`: a build that predates it must read the response
 * unchanged, and a client that does not know the field ignores it.
 */
export type BatchMutationResponse = {
  results: BatchItemResult[];
  transactionId?: string;
};

export function batchItemApplied(id: string): BatchItemApplied {
  return { id, status: BATCH_ITEM_APPLIED_STATUS };
}

/** Applied result with a required operation-specific success distinction. */
export function batchItemAppliedWithOutcome(
  id: string,
  outcome: BatchItemAppliedOutcome
): BatchItemApplied {
  return {
    id,
    status: BATCH_ITEM_APPLIED_STATUS,
    outcome,
  };
}

/**
 * Status and message both come from the exhaustive maps, so no caller can pair
 * a code with the wrong status. `details` is omitted, never `undefined`, when
 * absent.
 */
export function batchItemFailed(
  id: string,
  code: BatchItemFailureCode,
  details?: JsonObject
): BatchItemFailed {
  return {
    id,
    status: BATCH_ITEM_FAILURE_STATUS[code],
    code,
    message: BATCH_ITEM_FAILURE_MESSAGE[code],
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * An applied item never carries a `code`. One that does contradicts itself, so
 * it must fall through to the failed branch: accepted here, zod would strip the
 * code and a client would read a failure as a success.
 */
const batchItemAppliedSchema = z.object({
  id: z.string(),
  status: z.literal(BATCH_ITEM_APPLIED_STATUS),
  code: z.undefined().optional(),
  // A newer server may add another success detail. Dropping it is safer than
  // reading an unknown value as a confirmed no-op or removal.
  outcome: z.enum(BatchItemAppliedOutcome).optional().catch(undefined),
});

const batchItemFailedSchema = z.object({
  id: z.string(),
  status: z.number().int(),
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The client-side parser for a v2 batch response, for the web and Desktop
 * callers that move to v2 once per-item failure UI exists (ISS-9464 excludes
 * that switch). Deliberately looser than {@link BatchMutationResponse}: `code`
 * and a failed `status` accept values this build has never seen, so a newer
 * server adding a code does not fail the whole response, and objects are not
 * strict, so a later field on `data` is ignored rather than rejected. Narrow a
 * parsed code with {@link resolveBatchItemFailureCode}.
 */
export const batchMutationResponseSchema = z.object({
  results: z.array(z.union([batchItemAppliedSchema, batchItemFailedSchema])),
  // Optional on the READ side too, and for the opposite reason it is optional
  // on the write side: a client on this build may be talking to a server that
  // predates the field.
  transactionId: z.string().optional(),
});

const KNOWN_BATCH_ITEM_FAILURE_CODES: ReadonlySet<string> = new Set(
  Object.values(BatchItemFailureCode)
);

/**
 * Narrow a wire code to a known {@link BatchItemFailureCode}.
 *
 * `null` means this build does not know the code: show a generic failure for
 * THAT ITEM. It never means the request failed, since the envelope already
 * succeeded and a newer server may add codes.
 */
export function resolveBatchItemFailureCode(
  raw: string
): BatchItemFailureCode | null {
  return isBatchItemFailureCode(raw) ? raw : null;
}

function isBatchItemFailureCode(raw: string): raw is BatchItemFailureCode {
  return KNOWN_BATCH_ITEM_FAILURE_CODES.has(raw);
}

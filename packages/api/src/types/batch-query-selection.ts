/**
 * ISS-9579 — the REFUSALS a batch route answers when its set is defined by a
 * server-resolved QUERY instead of a client-sent id list.
 *
 * NOT the request shape (tamsinb review). That is `BatchDocumentSelection` in
 * `apps/api/app/documents/validators.ts`, derived from the list endpoint's own
 * schema rather than respelled, and deliberately not re-exported here: no client
 * sends a selection yet, and the shared request types still require
 * `documentIds` (`document-status-mutation.ts`, `artifact-priority-mutation.ts`).
 * ISS-9579 Excludes what select-all means on a surface, so the typed client half
 * lands with its first consumer instead of ahead of it.
 *
 * ISS-9575 (Cosimo Corrigan, 2026-09-16) ruled that select-all means the whole
 * matching set rather than the loaded page, that "the filter IS the selection",
 * and that deselecting a row makes the selection "all except N" rather than a
 * materialised id list. `excludedIds` is that last arm; everything else the
 * selection needs is the list predicate itself.
 *
 * The ceiling is {@link BATCH_MUTATION_ENTITY_LIMIT}, the same one the id arm
 * enforces. A resolved set is handed to the identical service functions the id
 * arm feeds, so it meets the identical write bound; a second number here would
 * be a second inventory able to drift from the one that actually constrains the
 * write. The other ceiling ISS-9579 cites, `BULK_RANK_MAX_ARTIFACTS`, governs
 * `projects/:id/artifacts/rank`, which DOC-36 puts outside bulk actions.
 */

import { BATCH_MUTATION_ENTITY_LIMIT } from "./batch-mutation-limits.ts";
import type { JsonObject } from "./common.ts";
import { Status, type StatusCode } from "./result.ts";

export const BatchQuerySelectionErrorCode = {
  /**
   * The predicate resolved to more artifacts than one batch may carry. The
   * batch is REFUSED rather than cut down to the ceiling: a truncated apply
   * reports success for a set the caller never asked for and leaves no record
   * of which rows were dropped. Same posture as the custom-field population
   * bound in `custom-field-scoped-population.ts`.
   */
  SelectionTooLarge: "selection_too_large",
  /**
   * The predicate resolved to no artifacts. Refused rather than applied as a
   * zero-row success, so the id arm's `.min(1)` and the query arm agree on what
   * an empty batch means.
   */
  SelectionEmpty: "selection_empty",
  /** The selection named a project that does not resolve in this organization. */
  SelectionProjectNotFound: "selection_project_not_found",
  /**
   * The selection's custom-field facets could not be resolved — the same
   * refusal `GET /documents` answers for the same filter set, carried here so
   * one filter cannot mean one population on the list and another on the write.
   */
  SelectionFilterRejected: "selection_filter_rejected",
} as const;
export type BatchQuerySelectionErrorCode =
  (typeof BatchQuerySelectionErrorCode)[keyof typeof BatchQuerySelectionErrorCode];

/** Exhaustive, so a code added without a status fails `tsc`. */
export const BATCH_QUERY_SELECTION_ERROR_STATUS: Readonly<
  Record<BatchQuerySelectionErrorCode, StatusCode>
> = {
  [BatchQuerySelectionErrorCode.SelectionTooLarge]: Status.BadRequest,
  [BatchQuerySelectionErrorCode.SelectionEmpty]: Status.BadRequest,
  [BatchQuerySelectionErrorCode.SelectionProjectNotFound]: Status.NotFound,
  [BatchQuerySelectionErrorCode.SelectionFilterRejected]: Status.BadRequest,
};

/** Exhaustive, so a code added without a message fails `tsc`. */
export const BATCH_QUERY_SELECTION_ERROR_MESSAGE: Readonly<
  Record<BatchQuerySelectionErrorCode, string>
> = {
  [BatchQuerySelectionErrorCode.SelectionTooLarge]:
    "The selected query matches more artifacts than one batch can carry",
  [BatchQuerySelectionErrorCode.SelectionEmpty]:
    "The selected query matches no artifacts",
  [BatchQuerySelectionErrorCode.SelectionProjectNotFound]:
    "The selected query names a project that was not found",
  [BatchQuerySelectionErrorCode.SelectionFilterRejected]:
    "The selected query could not be resolved",
};

/**
 * `resolvedTotal` is the size of the set the SERVER measured, never a number
 * the caller sent, and `limit` is the ceiling it was measured against. Both are
 * stated so a refusal is a first-class outcome a surface can render against its
 * own approved copy instead of parsing a sentence.
 *
 * `resolvedTotal` is omitted rather than guessed where the refusal happened
 * before a population was measured at all.
 */
export type BatchQuerySelectionErrorDetails = JsonObject & {
  limit: number;
  resolvedTotal?: number;
  reason?: string;
};

export type BatchQuerySelectionError = {
  status: StatusCode;
  code: BatchQuerySelectionErrorCode;
  message: string;
  details: BatchQuerySelectionErrorDetails;
};

/**
 * Status and message both come from the exhaustive maps above, so no caller can
 * pair a code with the wrong status — the same construction
 * `batchItemFailed` uses for per-item results.
 */
export function batchQuerySelectionError(
  code: BatchQuerySelectionErrorCode,
  details: Omit<BatchQuerySelectionErrorDetails, "limit">
): BatchQuerySelectionError {
  return {
    status: BATCH_QUERY_SELECTION_ERROR_STATUS[code],
    code,
    message: BATCH_QUERY_SELECTION_ERROR_MESSAGE[code],
    details: { ...details, limit: BATCH_MUTATION_ENTITY_LIMIT },
  };
}

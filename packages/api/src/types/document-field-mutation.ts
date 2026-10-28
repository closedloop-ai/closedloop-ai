/**
 * ISS-11198 — the conflict contract for the title and assignee guards on
 * `PUT /documents/{id}`: `expectedTitle` and `expectedAssigneeId`, the
 * siblings of `expectedStatus` (`./document-status-mutation`) and
 * `expectedPriority` (`./artifact-priority-mutation`) on the same body.
 *
 * Same rules as ISS-9486: each guard is valid only beside its own field, an
 * omitted guard is unguarded last-write-wins, `null` asserts no assignee, and a
 * value the document already holds is never refused.
 */

import type { JsonObject } from "./common.ts";
import { Status } from "./result.ts";

export const DocumentFieldMutationErrorCode = {
  StaleTitle: "stale_title",
  StaleAssigneeId: "stale_assignee_id",
} as const;
export type DocumentFieldMutationErrorCode =
  (typeof DocumentFieldMutationErrorCode)[keyof typeof DocumentFieldMutationErrorCode];

/** Compared untrimmed: the title a client read is the stored one. */
export type DocumentStaleTitle = JsonObject & {
  documentId: string;
  currentTitle: string;
  expectedTitle: string;
};

/** `null` on either side is a real value: the document has no assignee. */
export type DocumentStaleAssigneeId = JsonObject & {
  documentId: string;
  currentAssigneeId: string | null;
  expectedAssigneeId: string | null;
};

export type DocumentFieldMutationErrorDetails = JsonObject & {
  staleTitles?: DocumentStaleTitle[];
  staleAssigneeIds?: DocumentStaleAssigneeId[];
};

export type DocumentFieldMutationError = {
  status: typeof Status.Conflict;
  code: DocumentFieldMutationErrorCode;
  message: string;
  details: DocumentFieldMutationErrorDetails;
};

export function staleDocumentTitleConflict(
  staleTitle: DocumentStaleTitle
): DocumentFieldMutationError {
  return {
    status: Status.Conflict,
    code: DocumentFieldMutationErrorCode.StaleTitle,
    message: "One or more documents changed before the title update",
    details: { staleTitles: [staleTitle] },
  };
}

export function staleDocumentAssigneeConflict(
  staleAssigneeId: DocumentStaleAssigneeId
): DocumentFieldMutationError {
  return {
    status: Status.Conflict,
    code: DocumentFieldMutationErrorCode.StaleAssigneeId,
    message: "One or more documents changed before the assignee update",
    details: { staleAssigneeIds: [staleAssigneeId] },
  };
}

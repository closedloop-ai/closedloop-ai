/**
 * ISS-9440 — the error and precondition contract for artifact PRIORITY writes,
 * the sibling of `./document-status-mutation` for the other mutable field on
 * the same row.
 *
 * It is a separate module rather than more members on that one because the two
 * fields have different shapes, not different names: a status is a non-null
 * string from a subtype-scoped vocabulary, while a priority is a member of ONE
 * vocabulary or genuinely absent. Only the pieces that are the same are shared
 * — `ArtifactsNotFound` below is the status module's literal, imported, and
 * `missingDocuments` reuses its entry type, so a caller parsing one route's
 * error envelope parses the other's.
 *
 * The VALUE vocabulary is `./priority-contract`; nothing here re-folds an
 * untrusted string into a member.
 */

import type { JsonObject, Priority } from "./common.ts";
import {
  DocumentStatusMutationErrorCode,
  type DocumentStatusMutationMissingDocument,
} from "./document-status-mutation.ts";
import type { ArtifactPriorityEditSurface } from "./priority-contract.ts";
import { Status, type StatusCode } from "./result.ts";

export const ArtifactPriorityMutationErrorCode = {
  /**
   * The canonical literal, imported rather than re-spelled: the two batch
   * routes answer an unknown id with the same code, so a client branches once.
   */
  ArtifactsNotFound: DocumentStatusMutationErrorCode.ArtifactsNotFound,
  /**
   * A guarded row's persisted priority is neither what the caller expected nor
   * the priority being written (ISS-9486: a same-value retry is not stale).
   */
  StalePriority: "stale_priority",
} as const;
export type ArtifactPriorityMutationErrorCode =
  (typeof ArtifactPriorityMutationErrorCode)[keyof typeof ArtifactPriorityMutationErrorCode];

/**
 * One rejected precondition.
 *
 * Both priorities are `Priority | null` and the `null` is DECLARED, not an
 * absent optional: an artifact holding no priority is a state the caller can
 * legitimately have expected, and the whole point of the guard is that
 * "unset → URGENT" and "HIGH → URGENT" are different writes.
 */
export type ArtifactPriorityMutationStalePriority = JsonObject & {
  documentId: string;
  currentPriority: Priority | null;
  expectedPriority: Priority | null;
};

export type ArtifactPriorityMutationErrorDetails = JsonObject & {
  missingDocuments?: DocumentStatusMutationMissingDocument[];
  stalePriorities?: ArtifactPriorityMutationStalePriority[];
};

export type ArtifactPriorityMutationError = {
  status: StatusCode;
  code: ArtifactPriorityMutationErrorCode;
  message: string;
  details?: ArtifactPriorityMutationErrorDetails;
};

/**
 * The optimistic guard for a batch priority write, keyed by document id. A row
 * already holding the target priority is never refused (ISS-9486).
 *
 * ABSENT KEY ≠ NULL VALUE, and preserving that distinction is what keeps an
 * older client working: an id the map does not mention keeps the legacy
 * last-write-wins behaviour, while `null` asserts "I believe this artifact has
 * no priority". A client that serialized every unguarded id as `null` would
 * turn its own blind writes into conflicts.
 */
export type ExpectedPriorityById = Record<string, Priority | null>;

export type BatchUpdateArtifactPriorityRequest = {
  documentIds: string[];
  priority: Priority;
  expectedPriorityById?: ExpectedPriorityById;
};

/**
 * ISS-10332 — the body of a single-artifact priority write
 * (`PATCH /branches/{id}`; `PATCH /agent-sessions/{id}` carries the same
 * keys among its own).
 *
 * `priority` is REQUIRED and nullable: `null` clears. `expectedPriority` keeps
 * the ABSENT ≠ NULL rule {@link ExpectedPriorityById} states — omitted is
 * unguarded last-write-wins, `null` asserts the artifact holds no priority.
 *
 * `surface` is optional provenance for the activity receipt and canonical
 * `artifact_field_edit_result` analytics event (PLN-2086 Milestone 2): omitted
 * by an older client or an API-key caller, the write commits unattributed.
 */
export type UpdateArtifactPriorityRequest = {
  priority: Priority | null;
  expectedPriority?: Priority | null;
  surface?: ArtifactPriorityEditSurface;
};

/** The stored value after the write, for reconciling an optimistic row. */
export type UpdateBranchPriorityResponse = {
  id: string;
  priority: Priority | null;
};

/**
 * The one `stale_priority` conflict, built here rather than in each service.
 *
 * Every priority writer answers this code — `PUT /documents/{id}`, the
 * `POST /documents/batch-update-priority` pair, `PATCH /agent-sessions/{id}`
 * and `PATCH /branches/{id}` — and the promise the module header
 * makes is that a client parsing one route's envelope parses the other's. The
 * `code` and the `details` shape were already shared; the MESSAGE is the half a
 * client displays, and two hand-written copies is how one route gets reworded
 * and the other does not.
 */
export function stalePriorityConflict(
  stalePriorities: ArtifactPriorityMutationStalePriority[]
): ArtifactPriorityMutationError {
  return {
    status: Status.Conflict,
    code: ArtifactPriorityMutationErrorCode.StalePriority,
    message: "One or more documents changed before the priority update",
    details: { stalePriorities },
  };
}

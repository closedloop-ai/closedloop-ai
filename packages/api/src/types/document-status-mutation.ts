import type { JsonObject } from "./common.ts";
import type { ArtifactStatus } from "./document.ts";
import type { StatusCode } from "./result.ts";

export const DocumentStatusMutationErrorCode = {
  ArtifactsNotFound: "artifacts_not_found",
  InvalidReference: "invalid_reference",
  InvalidStatusForSubtype: "invalid_status_for_subtype",
  StaleStatus: "stale_status",
} as const;
export type DocumentStatusMutationErrorCode =
  (typeof DocumentStatusMutationErrorCode)[keyof typeof DocumentStatusMutationErrorCode];

/**
 * The `stale_status` message. One constant because two writers emit that code
 * (`PUT /documents/{id}` and, since ISS-9486, `PATCH /agent-sessions/{id}`) and
 * a client that shows `message` must see the same words from both.
 */
export const STALE_STATUS_CONFLICT_MESSAGE =
  "One or more documents changed before the status update";

/**
 * The two status writes a caller can make: one artifact
 * (`PUT /documents/{id}`) or a selection (`POST /documents/batch-update-status`).
 * They are separate routes with separate authorization, so the capability
 * answers for each rather than collapsing them into one boolean.
 */
export const DocumentStatusMutationOperation = {
  Single: "single",
  Bulk: "bulk",
} as const;
export type DocumentStatusMutationOperation =
  (typeof DocumentStatusMutationOperation)[keyof typeof DocumentStatusMutationOperation];

/**
 * Whether THIS caller may perform each status write, keyed exhaustively by
 * operation so a third operation cannot be added without answering for it.
 *
 * A display affordance, never the security boundary — both routes re-check
 * scope and org ownership on every write, so a client that ignores this gains
 * nothing. Mirrors {@link ArtifactTagPermissions}, which states the same thing
 * for the tag relation.
 */
export type DocumentStatusMutationPermissions = Record<
  DocumentStatusMutationOperation,
  boolean
>;

export type DocumentStatusMutationCapability = {
  /** Status values this artifact subtype accepts on status writes. */
  allowedStatuses: ArtifactStatus[];
  /** Request-body field a client may send to guard one document update. */
  expectedStatusField: "expectedStatus";
  /** Request-body field a client may send to guard a batch status update. */
  expectedStatusByIdField: "expectedStatusById";
  /**
   * Resolved by the two artifact DETAIL reads, which hold the caller's
   * credential; omitted — never `null` — by the list, project-tree and
   * version-save producers, which are services with no `AuthContext` to
   * resolve it against.
   *
   * So absence means "not resolved here", never "denied": a consumer falls back
   * to attempting the write, which both routes authorize independently either
   * way. An older client that ignores this key is unaffected.
   */
  permissions?: DocumentStatusMutationPermissions;
};

export type DocumentStatusMutationStaleStatus = JsonObject & {
  documentId: string;
  currentStatus: string;
  expectedStatus: string;
};

export type DocumentStatusMutationInvalidStatus = JsonObject & {
  documentId: string;
  /** Raw persisted value: ISS-9434 recorded that rows exist off-vocabulary. */
  currentStatus: string;
  targetStatus: string;
  subtype: string | null;
  allowedStatuses: ArtifactStatus[];
};

export type DocumentStatusMutationMissingDocument = JsonObject & {
  documentId: string;
};

export type DocumentStatusMutationErrorDetails = JsonObject & {
  missingDocuments?: DocumentStatusMutationMissingDocument[];
  invalidStatuses?: DocumentStatusMutationInvalidStatus[];
  staleStatuses?: DocumentStatusMutationStaleStatus[];
};

export type DocumentStatusMutationError = {
  status: StatusCode;
  code: DocumentStatusMutationErrorCode;
  message: string;
  details?: DocumentStatusMutationErrorDetails;
};

export type DocumentStatusTransition = {
  documentId: string;
  before: string;
  after: string;
};

export type BatchUpdateDocumentStatusRequest = {
  documentIds: string[];
  status: ArtifactStatus;
  /**
   * Optional stale-write guard keyed by document id. Omitted ids keep the
   * legacy last-write-wins behavior for version-skewed clients.
   */
  expectedStatusById?: Record<string, string>;
};

export type BatchUpdateDocumentStatusResult = {
  /** Legacy success payload: every validated unique id, in request order. */
  updatedIds: string[];
  /** Only ids whose persisted status actually changed. */
  changedIds: string[];
  /** Verified before/after transitions for `changedIds`. */
  transitions: DocumentStatusTransition[];
};

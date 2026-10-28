import {
  type ArtifactPriorityMutationError,
  stalePriorityConflict,
} from "@repo/api/src/types/artifact-priority-mutation";
import type { Priority } from "@repo/api/src/types/common";
import {
  type ArtifactStatus,
  type Document,
  statusOptionsForSubtype,
  type UpdateDocumentInput,
} from "@repo/api/src/types/document";
import {
  type DocumentFieldMutationError,
  staleDocumentAssigneeConflict,
  staleDocumentTitleConflict,
} from "@repo/api/src/types/document-field-mutation";
import {
  type BatchUpdateDocumentStatusResult,
  type DocumentStatusMutationError,
  DocumentStatusMutationErrorCode,
  type DocumentStatusMutationInvalidStatus,
  type DocumentStatusMutationStaleStatus,
  STALE_STATUS_CONFLICT_MESSAGE,
} from "@repo/api/src/types/document-status-mutation";
import { isStaleExpectation } from "@repo/api/src/types/optimistic-write-guard";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  ArtifactType,
  Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { documentWhere } from "@/lib/artifact-adapters";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { isUserInOrganization } from "@/lib/user-org-membership";
import { writeStatusChanges } from "./document-status-batch-write";
import {
  documentIncludeWithUser,
  splitDocumentPayload,
  toDocument,
} from "./document-utils";

type StatusMutationServiceResult<T> = Result<T, DocumentStatusMutationError>;

/**
 * The single-artifact write guards status, priority, title and assignee, so
 * its failure is one of three closed unions rather than a widened
 * `code: string` (ISS-9440, ISS-11198).
 */
type SingleUpdateServiceResult<T> = Result<
  T,
  | DocumentStatusMutationError
  | ArtifactPriorityMutationError
  | DocumentFieldMutationError
>;

type DocumentStatusUpdateResult = {
  document: Document;
  previous: Document;
};

/** `written` is false for a guarded retry that wrote nothing (ISS-9486). */
type SingleDocumentWrite = DocumentStatusUpdateResult & { written: boolean };

export type LockedDocumentRow = {
  id: string;
  status: string;
  subtype: string | null;
};

/**
 * Mutations on a document artifact that need a persisted value to validate
 * against: the subtype-scoped status vocabulary, and the optimistic guards on
 * status, priority (ISS-9440), title and assignee (ISS-11198). The route
 * layer owns HTTP mapping and side effects; this service owns that validation
 * and stale-write classification.
 * Batch status changes lock their rows. A single-document write locks when it
 * carries an optimistic guard or requests status, priority, or project; an
 * unguarded title, assignee, or content-only write stays on the direct path.
 * Audited writes return transaction-owned before/after facts because
 * post-commit consumers cannot reconstruct an ordered transition later.
 */
export const documentStatusMutationService = {
  /**
   * The search projection is NOT indexed here, and must not be. `PUT
   * /documents/[id]`, the only caller, holds the transaction this write joins
   * (ISS-10993), while `indexDocumentProjection` (`document-service.ts`) is a
   * post-commit contract: the work it schedules issues `withDb` calls of its
   * own, which under an ambient transaction land on that transaction's client.
   * Queued before the commit, a projection failure aborts the user's edit with
   * 25P02; queued after it, the statement hits a closed transaction and is
   * swallowed. The route indexes once its transaction has resolved, and only
   * when `written` says a write actually happened (ISS-9486).
   */
  updateDocument(
    id: string,
    organizationId: string,
    input: Omit<UpdateDocumentInput, "id">
  ): Promise<SingleUpdateServiceResult<SingleDocumentWrite>> {
    return updateSingleDocument(id, organizationId, input).catch(
      (error: unknown) =>
        classifySingleUpdateError(error, id, organizationId, input)
    );
  },

  batchUpdateStatus(
    documentIds: string[],
    status: ArtifactStatus,
    organizationId: string,
    expectedStatusById?: Record<string, string>
  ): Promise<StatusMutationServiceResult<BatchUpdateDocumentStatusResult>> {
    const uniqueIds = [...new Set(documentIds)];

    return withDb.tx(
      async (
        tx
      ): Promise<
        StatusMutationServiceResult<BatchUpdateDocumentStatusResult>
      > => {
        const lockedRows = await lockDocumentRows(
          tx,
          uniqueIds,
          organizationId
        );
        const foundIds = new Set(lockedRows.map((row) => row.id));
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        if (missingIds.length > 0) {
          return missingDocumentsResult(missingIds, Status.BadRequest);
        }

        const invalidStatuses = collectInvalidStatuses(lockedRows, status);
        if (invalidStatuses.length > 0) {
          return invalidStatusesResult(status, invalidStatuses);
        }

        const staleStatuses = collectStaleStatuses(
          lockedRows,
          expectedStatusById,
          status
        );
        if (staleStatuses.length > 0) {
          return staleStatusesResult(staleStatuses);
        }

        const rowsById = new Map(lockedRows.map((row) => [row.id, row]));
        const requestedRows = uniqueIds.flatMap((id): LockedDocumentRow[] => {
          const row = rowsById.get(id);
          return row ? [row] : [];
        });
        const { transitions, changedIds } = await writeStatusChanges(
          tx,
          requestedRows,
          status,
          organizationId
        );

        return Result.ok({ updatedIds: uniqueIds, changedIds, transitions });
      }
    );
  },
};

/**
 * Guarded writes retain ISS-9486's row-lock contract. Status, priority, and
 * project writes also lock, while unguarded non-audited writes remain direct.
 * This keeps committed audit facts ordered without serializing unrelated edits.
 */
function updateSingleDocument(
  id: string,
  organizationId: string,
  input: Omit<UpdateDocumentInput, "id">
): Promise<SingleUpdateServiceResult<SingleDocumentWrite>> {
  if (!(hasGuard(input) || requestsAuditedTransition(input))) {
    return prepareAndWriteSingleDocument(id, organizationId, input);
  }
  return withDb.tx(async (tx) => {
    await lockDocumentRows(tx, [id], organizationId);
    return prepareAndWriteSingleDocument(id, organizationId, input);
  });
}

async function prepareAndWriteSingleDocument(
  id: string,
  organizationId: string,
  input: Omit<UpdateDocumentInput, "id">
): Promise<SingleUpdateServiceResult<SingleDocumentWrite>> {
  const preparation: SingleUpdateServiceResult<{ previous: Document }> =
    await withDb(async (db) => {
      const previousArtifact = await db.artifact.findUnique({
        where: documentWhere({ id, organizationId }),
        include: documentIncludeWithUser,
      });
      if (!previousArtifact) {
        return missingDocumentsResult<{ previous: Document }>([id]);
      }

      const previous = toDocument(previousArtifact);
      const validation = await validateSingleUpdate(db, previous, input);
      if (!validation.ok) {
        return validation;
      }

      return Result.ok({ previous });
    });
  if (!preparation.ok) {
    return preparation;
  }

  const {
    expectedStatus: _expectedStatus,
    expectedPriority: _expectedPriority,
    expectedTitle: _expectedTitle,
    expectedAssigneeId: _expectedAssigneeId,
    ...writeInput
  } = input;
  const { previous } = preparation.value;
  if (isGuardedRetry(input, writeInput, previous)) {
    return Result.ok({ document: previous, previous, written: false });
  }
  const { artifact: artifactData, detail: detailData } =
    splitDocumentPayload(writeInput);
  const updated = await withDb((db) =>
    db.artifact.update({
      where: singleUpdateWhere(id, organizationId, input),
      data: {
        ...artifactData,
        ...(Object.keys(detailData).length > 0 && {
          document: { update: detailData },
        }),
      },
      include: documentIncludeWithUser,
    })
  );
  const document = toDocument(updated);

  return Result.ok({ document, previous, written: true });
}

async function classifySingleUpdateError(
  error: unknown,
  id: string,
  organizationId: string,
  input: Omit<UpdateDocumentInput, "id">
): Promise<SingleUpdateServiceResult<SingleDocumentWrite>> {
  if (getPrismaErrorCode(error) !== "P2025") {
    throw error;
  }

  const current = await withDb((db) =>
    db.artifact.findUnique({
      where: documentWhere({ id, organizationId }),
      select: {
        id: true,
        status: true,
        priority: true,
        name: true,
        assigneeId: true,
      },
    })
  );
  if (!current) {
    return missingDocumentsResult([id]);
  }
  const stale = firstStaleGuard({ ...current, title: current.name }, input);
  if (stale) {
    return Result.err(stale);
  }

  throw error;
}

/**
 * The compare-and-set predicate. A guarded field joins the `where`, so the
 * update either matches the row it was told about or matches nothing and
 * raises P2025 — the one shape that cannot lose a concurrent write between a
 * read and the write it authorized.
 *
 * The guard admits the value being written as well as the expected one
 * (ISS-9486 ruling 2): a row that already holds the target is not stale, so a
 * retry of a committed write succeeds instead of refusing its own result.
 *
 * `priority: null` is a real predicate here, not an absent one: Prisma renders
 * it as `IS NULL`, which is exactly the assertion "this artifact holds no
 * priority". Absence is `undefined`, which spreads to nothing.
 */
function singleUpdateWhere(
  id: string,
  organizationId: string,
  input: Omit<UpdateDocumentInput, "id">
) {
  return documentWhere({
    id,
    organizationId,
    ...(input.expectedStatus === undefined
      ? {}
      : statusGuard(input.expectedStatus, input.status)),
    ...(input.expectedPriority === undefined
      ? {}
      : priorityGuard(input.expectedPriority, input.priority)),
    ...(input.expectedTitle === undefined
      ? {}
      : titleGuard(input.expectedTitle, input.title)),
    ...(input.expectedAssigneeId === undefined
      ? {}
      : assigneeGuard(input.expectedAssigneeId, input.assigneeId)),
  });
}

export function lockDocumentRows(
  tx: TransactionClient,
  documentIds: string[],
  organizationId: string
): Promise<LockedDocumentRow[]> {
  if (documentIds.length === 0) {
    return Promise.resolve([]);
  }
  const documentIdSql = Prisma.join(
    documentIds.map((documentId) => Prisma.sql`${documentId}::uuid`)
  );

  return tx.$queryRaw<LockedDocumentRow[]>(Prisma.sql`
    SELECT "id", "status", "subtype"
    FROM "artifacts"
    WHERE "id" IN (${documentIdSql})
      AND "organization_id" = ${organizationId}::uuid
      AND "type" = ${ArtifactType.DOCUMENT}::"ArtifactType"
    ORDER BY "id" ASC
    FOR NO KEY UPDATE
  `);
}

async function validateSingleUpdate(
  tx: TransactionClient,
  previous: Document,
  input: Omit<UpdateDocumentInput, "id">
): Promise<SingleUpdateServiceResult<true>> {
  const stale = firstStaleGuard(previous, input);
  if (stale) {
    return Result.err(stale);
  }

  if (
    input.status !== undefined &&
    !statusOptionsForSubtype(previous.type).includes(input.status)
  ) {
    return invalidStatusesResult(input.status, [
      {
        documentId: previous.id,
        currentStatus: previous.status,
        targetStatus: input.status,
        subtype: previous.type,
        allowedStatuses: [...statusOptionsForSubtype(previous.type)],
      },
    ]);
  }

  const references = await validateUpdateReferences(
    tx,
    previous.organizationId,
    input
  );
  if (!references.ok) {
    return references;
  }

  return Result.ok(true);
}

async function validateUpdateReferences(
  tx: TransactionClient,
  organizationId: string,
  input: Omit<UpdateDocumentInput, "id">
): Promise<StatusMutationServiceResult<true>> {
  if (
    input.assigneeId &&
    !(await isUserInOrganization(tx, input.assigneeId, organizationId))
  ) {
    return invalidReferenceResult("assigneeId", input.assigneeId);
  }

  if (
    input.approverId &&
    !(await isUserInOrganization(tx, input.approverId, organizationId))
  ) {
    return invalidReferenceResult("approverId", input.approverId);
  }

  if (input.projectId) {
    const project = await tx.project.findUnique({
      where: { id: input.projectId, organizationId },
      select: { id: true },
    });
    if (!project) {
      return invalidReferenceResult("projectId", input.projectId);
    }
  }

  return Result.ok(true);
}

export function collectInvalidStatuses(
  rows: LockedDocumentRow[],
  status: ArtifactStatus
): DocumentStatusMutationInvalidStatus[] {
  return rows
    .filter((row) => !statusOptionsForSubtype(row.subtype).includes(status))
    .map((row) => ({
      documentId: row.id,
      currentStatus: row.status,
      targetStatus: status,
      subtype: row.subtype,
      allowedStatuses: [...statusOptionsForSubtype(row.subtype)],
    }));
}

/**
 * A row already holding `status` is never stale (ISS-9486 ruling 2), so a
 * retried batch does not conflict with its own earlier success.
 */
export function collectStaleStatuses(
  rows: LockedDocumentRow[],
  expectedStatusById: Record<string, string> | undefined,
  status: string
): DocumentStatusMutationStaleStatus[] {
  if (!expectedStatusById) {
    return [];
  }

  return rows.flatMap((row): DocumentStatusMutationStaleStatus[] => {
    const expectedStatus = expectedStatusById[row.id];
    return expectedStatus !== undefined &&
      isStaleExpectation(row.status, status, expectedStatus)
      ? [{ documentId: row.id, currentStatus: row.status, expectedStatus }]
      : [];
  });
}

function missingDocumentsResult<T>(
  documentIds: string[],
  status: StatusCode = Status.NotFound
): StatusMutationServiceResult<T> {
  return Result.err({
    status,
    code: DocumentStatusMutationErrorCode.ArtifactsNotFound,
    message: "One or more documents were not found",
    details: {
      missingDocuments: documentIds.map((documentId) => ({ documentId })),
    },
  });
}

function invalidStatusesResult<T>(
  status: ArtifactStatus,
  invalidStatuses: DocumentStatusMutationInvalidStatus[]
): StatusMutationServiceResult<T> {
  return Result.err({
    status: Status.BadRequest,
    code: DocumentStatusMutationErrorCode.InvalidStatusForSubtype,
    message: `Status "${status}" is not valid for one or more selected documents`,
    details: { invalidStatuses },
  });
}

function staleStatusesResult<T>(
  staleStatuses: DocumentStatusMutationStaleStatus[]
): StatusMutationServiceResult<T> {
  return Result.err(staleStatusesError(staleStatuses));
}

function staleStatusesError(
  staleStatuses: DocumentStatusMutationStaleStatus[]
): DocumentStatusMutationError {
  return {
    status: Status.Conflict,
    code: DocumentStatusMutationErrorCode.StaleStatus,
    message: STALE_STATUS_CONFLICT_MESSAGE,
    details: { staleStatuses },
  };
}

function invalidReferenceResult<T>(
  field: string,
  id: string
): StatusMutationServiceResult<T> {
  return Result.err({
    status: Status.BadRequest,
    code: DocumentStatusMutationErrorCode.InvalidReference,
    message: `${field} is not valid for this organization`,
    details: { field, id },
  });
}

function statusGuard(
  expected: string,
  requested: string | undefined
): { status: string | { in: string[] } } {
  return requested === undefined || requested === expected
    ? { status: expected }
    : { status: { in: [expected, requested] } };
}

function priorityGuard(
  expected: Priority | null,
  requested: Priority | null | undefined
): { priority: Priority | null } | { OR: { priority: Priority | null }[] } {
  return requested === undefined || requested === expected
    ? { priority: expected }
    : { OR: [{ priority: expected }, { priority: requested }] };
}

/**
 * ISS-9486 ruling 2: a guarded write that sets only status, priority, title
 * or assignee, each already at its target, is a retry of a committed write.
 * It runs under the row lock, so `previous` is current, and it writes
 * nothing: no `updatedAt` bump and no reindex.
 */
function isGuardedRetry(
  input: Omit<UpdateDocumentInput, "id">,
  writeInput: Omit<
    UpdateDocumentInput,
    | "id"
    | "expectedStatus"
    | "expectedPriority"
    | "expectedTitle"
    | "expectedAssigneeId"
  >,
  previous: Document
): boolean {
  if (!hasGuard(input)) {
    return false;
  }
  const fields = Object.entries(writeInput).filter(
    ([, value]) => value !== undefined
  );
  return (
    fields.length > 0 &&
    fields.every(
      ([key, value]) =>
        (key === "status" && value === previous.status) ||
        (key === "priority" && value === previous.priority) ||
        (key === "title" && value === previous.title) ||
        (key === "assigneeId" && value === previous.assigneeId)
    )
  );
}

function hasGuard(input: Omit<UpdateDocumentInput, "id">): boolean {
  return (
    input.expectedStatus !== undefined ||
    input.expectedPriority !== undefined ||
    input.expectedTitle !== undefined ||
    input.expectedAssigneeId !== undefined
  );
}

function requestsAuditedTransition(
  input: Omit<UpdateDocumentInput, "id">
): boolean {
  return (
    input.status !== undefined ||
    input.priority !== undefined ||
    input.projectId !== undefined
  );
}

/** `status` is the raw persisted string: rows exist off-vocabulary (ISS-9434). */
type GuardedFields = Pick<
  Document,
  "id" | "priority" | "title" | "assigneeId"
> & {
  status: string;
};

/**
 * The first guard `current` refutes, in body order, or null. One copy for the
 * pre-write read and the compare-and-set miss, so the two cannot disagree on
 * what is stale.
 */
function firstStaleGuard(
  current: GuardedFields,
  input: Omit<UpdateDocumentInput, "id">
):
  | DocumentStatusMutationError
  | ArtifactPriorityMutationError
  | DocumentFieldMutationError
  | null {
  const documentId = current.id;
  const { expectedStatus, expectedPriority, expectedTitle } = input;
  if (
    expectedStatus !== undefined &&
    isStaleExpectation<string>(current.status, input.status, expectedStatus)
  ) {
    return staleStatusesError([
      { documentId, currentStatus: current.status, expectedStatus },
    ]);
  }
  if (
    expectedPriority !== undefined &&
    isStaleExpectation(current.priority, input.priority, expectedPriority)
  ) {
    return stalePriorityConflict([
      { documentId, currentPriority: current.priority, expectedPriority },
    ]);
  }
  if (
    expectedTitle !== undefined &&
    isStaleExpectation(current.title, input.title, expectedTitle)
  ) {
    return staleDocumentTitleConflict({
      documentId,
      currentTitle: current.title,
      expectedTitle,
    });
  }
  const { expectedAssigneeId } = input;
  if (
    expectedAssigneeId !== undefined &&
    isStaleExpectation(current.assigneeId, input.assigneeId, expectedAssigneeId)
  ) {
    return staleDocumentAssigneeConflict({
      documentId,
      currentAssigneeId: current.assigneeId,
      expectedAssigneeId,
    });
  }
  return null;
}

/** `title` is stored as the artifact's `name`. */
function titleGuard(
  expected: string,
  requested: string | undefined
): { name: string | { in: string[] } } {
  return requested === undefined || requested === expected
    ? { name: expected }
    : { name: { in: [expected, requested] } };
}

/**
 * Nested under `AND` because `priorityGuard` already owns the top-level `OR`,
 * and a second spread would overwrite it.
 */
function assigneeGuard(
  expected: string | null,
  requested: string | null | undefined
):
  | { assigneeId: string | null }
  | { AND: [{ OR: { assigneeId: string | null }[] }] } {
  return requested === undefined || requested === expected
    ? { assigneeId: expected }
    : {
        AND: [{ OR: [{ assigneeId: expected }, { assigneeId: requested }] }],
      };
}

/**
 * Resolve a caller-supplied `undoOfTransactionId` against the forward mutation
 * it claims to reverse, in THIS organization (ISS-10458 review, tamsinb and
 * whitlockk). Without it any write-scoped caller could post an arbitrary UUID — or
 * a real one lifted off another tenant's `/v2` response — and the receipt would
 * then permanently assert "this undid X" in an append-only hash chain that can
 * never be corrected.
 *
 * Resolved against `ArtifactActivityEvent` rather than `audit_entries.detail`,
 * which is authoritative but lives in an unindexed `Json` column (ISS-10993).
 * That choice is only sound because ISS-10993 made capture transactional: a
 * forward whose receipts were swallowed used to be unfindable here, so this
 * check would have refused to reverse work the user watched commit.
 *
 * A forward that moved no rows wrote no receipts and so cannot be named — it
 * also has nothing to reverse.
 *
 * Absent id resolves to ok: the field is optional for a client on `/v1`, or one
 * older than the ISS-9465 deployment that began reporting transaction ids.
 */
export async function validateUndoTransactionReference(
  organizationId: string,
  undoOfTransactionId: string | undefined
): Promise<StatusMutationServiceResult<true>> {
  if (undoOfTransactionId === undefined) {
    return Result.ok(true);
  }
  const forward = await withDb((db) =>
    db.artifactActivityEvent.findFirst({
      where: { organizationId, transactionId: undoOfTransactionId },
      select: { id: true },
    })
  );
  if (!forward) {
    return invalidReferenceResult("undoOfTransactionId", undoOfTransactionId);
  }
  return Result.ok(true);
}

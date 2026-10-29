import type { ExpectedPriorityById } from "@repo/api/src/types/artifact-priority-mutation";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { Priority } from "@repo/api/src/types/common";
import {
  type ArtifactStatus,
  DOCUMENT_STATUS_OPTIONS,
  ISSUE_STATUS_OPTIONS,
  type UpdateDocumentInput,
} from "@repo/api/src/types/document";
import type { ArtifactPriorityEditSurface } from "@repo/api/src/types/priority-contract";
import { isPriority } from "@repo/api/src/types/priority-contract";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { isRecord } from "@repo/lib/harness/type-guards";
import type { QueryClient } from "@tanstack/react-query";

/**
 * The optimistic guards a document write carries, derived from what the reader
 * was last shown.
 *
 * Split out of `use-documents.ts` because it is one responsibility and not the
 * hooks': every mutation here answers the same question — what did this client
 * believe the persisted value was when the user acted — and the answer comes
 * from the query cache, not from the request. The guarded fields share the
 * cache scan and differ only in how a row is read, which is the seam the
 * `ExpectedValueReader` parameter follows.
 */

export type BatchUpdateStatusInput = {
  documentIds: string[];
  status: ArtifactStatus;
  expectedStatusById?: Record<string, string>;
  /** ISS-9436: the surface this bulk commit came from, for the receipt. */
  surface?: ArtifactStatusEditSurface;
};

export type BatchUpdatePriorityInput = {
  documentIds: string[];
  priority: Priority;
  expectedPriorityById?: ExpectedPriorityById;
  /** ISS-9443: the surface this bulk commit came from, for the telemetry event. */
  surface?: ArtifactPriorityEditSurface;
};

type MutableArtifactRow = {
  id?: unknown;
  status?: unknown;
  priority?: unknown;
  assigneeId?: unknown;
  statusMutation?: unknown;
};

/**
 * What a cached row asserts about one guarded field, or `undefined` when it
 * asserts nothing and the id must stay unguarded.
 *
 * `undefined` is the only "no expectation" spelling, which is why this is not
 * `TValue | null`: priority's `null` is a REAL assertion ("this artifact holds
 * no priority") and collapsing the two would turn every row the cache could
 * not read into a claim that the row is unset.
 */
type ExpectedValueReader<TValue> = (
  artifact: MutableArtifactRow
) => TValue | undefined;

/**
 * Attach every optimistic guard a single-artifact write can read from the
 * cache: status, priority and assignee.
 *
 * They are guarded from ONE place because they reach the server in one request
 * body: `useUpdateDocument` is the only caller of `PUT /documents/{id}` the
 * product has, so a field guarded anywhere else would be guarded on no shipped
 * path at all (ISS-9440). The title's guard is not read here: the inline
 * title field sends its own (ISS-11198).
 */
export function withExpectedValueGuards(
  queryClient: QueryClient,
  documentId: string,
  body: Omit<UpdateDocumentInput, "id">
): Omit<UpdateDocumentInput, "id"> {
  return withExpectedAssigneeGuard(
    queryClient,
    documentId,
    withExpectedPriorityGuard(
      queryClient,
      documentId,
      withExpectedStatusGuard(queryClient, documentId, body)
    )
  );
}

function withExpectedStatusGuard(
  queryClient: QueryClient,
  documentId: string,
  body: Omit<UpdateDocumentInput, "id">
): Omit<UpdateDocumentInput, "id"> {
  if (body.status === undefined || body.expectedStatus !== undefined) {
    return body;
  }

  const expectedStatus = buildExpectedStatusById(queryClient, [documentId])?.[
    documentId
  ];
  return expectedStatus ? { ...body, expectedStatus } : body;
}

/**
 * The priority twin, and NOT a copy of the line above: `expectedPriority: null`
 * is the assertion "I believe this artifact has no priority", so presence of
 * the KEY — not truthiness of the value — is what decides whether a reading was
 * found. A truthiness test would silently drop the guard on exactly the rows
 * the ISS-9665 unset work made reachable.
 */
function withExpectedPriorityGuard(
  queryClient: QueryClient,
  documentId: string,
  body: Omit<UpdateDocumentInput, "id">
): Omit<UpdateDocumentInput, "id"> {
  if (body.priority === undefined || body.expectedPriority !== undefined) {
    return body;
  }

  const expectedPriorityById = buildExpectedPriorityById(queryClient, [
    documentId,
  ]);
  if (expectedPriorityById && documentId in expectedPriorityById) {
    return { ...body, expectedPriority: expectedPriorityById[documentId] };
  }
  return body;
}

/**
 * ISS-11198: the assignee twin of the priority guard, `null` included — it
 * asserts the document has no assignee. A caller that sends its own
 * `expectedAssigneeId` keeps it: an artifact row that serializes its picks
 * knows a newer confirmed value than the cache (`useArtifactRowEdit`).
 */
function withExpectedAssigneeGuard(
  queryClient: QueryClient,
  documentId: string,
  body: Omit<UpdateDocumentInput, "id">
): Omit<UpdateDocumentInput, "id"> {
  if (body.assigneeId === undefined || body.expectedAssigneeId !== undefined) {
    return body;
  }

  const expectedAssigneeById = buildExpectedById(
    queryClient,
    [documentId],
    readExpectedAssigneeId
  );
  if (expectedAssigneeById && documentId in expectedAssigneeById) {
    return { ...body, expectedAssigneeId: expectedAssigneeById[documentId] };
  }
  return body;
}

export function withBatchExpectedStatusGuard(
  queryClient: QueryClient,
  input: BatchUpdateStatusInput
): BatchUpdateStatusInput {
  if (input.expectedStatusById) {
    return input;
  }

  const expectedStatusById = buildExpectedStatusById(
    queryClient,
    input.documentIds
  );
  return expectedStatusById ? { ...input, expectedStatusById } : input;
}

export function withBatchExpectedPriorityGuard(
  queryClient: QueryClient,
  input: BatchUpdatePriorityInput
): BatchUpdatePriorityInput {
  if (input.expectedPriorityById) {
    return input;
  }

  const expectedPriorityById = buildExpectedPriorityById(
    queryClient,
    input.documentIds
  );
  return expectedPriorityById ? { ...input, expectedPriorityById } : input;
}

function buildExpectedStatusById(
  queryClient: QueryClient,
  documentIds: string[]
): Record<string, string> | undefined {
  return buildExpectedById(queryClient, documentIds, readExpectedStatus);
}

function buildExpectedPriorityById(
  queryClient: QueryClient,
  documentIds: string[]
): ExpectedPriorityById | undefined {
  return buildExpectedById(queryClient, documentIds, readExpectedPriority);
}

/**
 * Read each id's last-seen value out of the query cache: the artifact's own
 * detail entry first, then every other cached query newest-first until every id
 * is answered.
 *
 * An id no cached row answers is simply absent from the result, which both
 * request contracts read as "unguarded" — so a cold cache degrades to the
 * legacy last-write-wins rather than to a wrong assertion.
 */
function buildExpectedById<TValue>(
  queryClient: QueryClient,
  documentIds: string[],
  read: ExpectedValueReader<TValue>
): Record<string, TValue> | undefined {
  const unmatchedIds = new Set(documentIds);
  const expectedById: Record<string, TValue> = {};
  for (const documentId of documentIds) {
    collectArtifactExpectations(
      queryClient.getQueryData(documentKeys.detail(documentId)),
      { expectedById, read, unmatchedIds }
    );
  }

  if (unmatchedIds.size > 0) {
    const queriesNewestFirst = [...queryClient.getQueryCache().findAll()].sort(
      (left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt
    );
    for (const query of queriesNewestFirst) {
      collectArtifactExpectations(query.state.data, {
        expectedById,
        read,
        unmatchedIds,
      });
      if (unmatchedIds.size === 0) {
        break;
      }
    }
  }

  return Object.keys(expectedById).length > 0 ? expectedById : undefined;
}

function collectArtifactExpectations<TValue>(
  value: unknown,
  scope: {
    expectedById: Record<string, TValue>;
    read: ExpectedValueReader<TValue>;
    unmatchedIds: Set<string>;
  },
  depth = 0
): void {
  const { expectedById, read, unmatchedIds } = scope;
  if (unmatchedIds.size === 0 || depth > ARTIFACT_STATUS_CACHE_SCAN_MAX_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectArtifactExpectations(item, scope, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  const artifact = value as MutableArtifactRow;
  if (typeof artifact.id === "string" && unmatchedIds.has(artifact.id)) {
    const expected = read(artifact);
    if (expected !== undefined) {
      expectedById[artifact.id] = expected;
      unmatchedIds.delete(artifact.id);
    }
  }

  for (const child of Object.values(value)) {
    collectArtifactExpectations(child, scope, depth + 1);
  }
}

function readExpectedStatus(artifact: MutableArtifactRow): string | undefined {
  if (
    hasStatusMutationCapability(artifact) &&
    isArtifactStatus(artifact.status)
  ) {
    return artifact.status;
  }
  return undefined;
}

/**
 * A row's priority, but only when it is one of the two things the guard can
 * honestly assert.
 *
 * The third input state — a member only a newer peer knows — returns
 * `undefined` and leaves the id unguarded rather than folding to `null`, which
 * would tell the server "this artifact has no priority" about an artifact that
 * demonstrably has one. That fold is the ISS-9665 defect, and
 * `priority-contract.ts` exports no helper that performs it precisely so this
 * call site has to separate the three states itself.
 */
function readExpectedPriority(
  artifact: MutableArtifactRow
): Priority | null | undefined {
  if (!hasStatusMutationCapability(artifact)) {
    return undefined;
  }
  if (artifact.priority === null) {
    return null;
  }
  return isPriority(artifact.priority) ? artifact.priority : undefined;
}

/**
 * A row's assignee id, `null` included, and `undefined` for a row shape that
 * does not carry the field — which must leave the write unguarded rather than
 * assert that the document is unassigned.
 */
function readExpectedAssigneeId(
  artifact: MutableArtifactRow
): string | null | undefined {
  if (!hasStatusMutationCapability(artifact)) {
    return undefined;
  }
  const { assigneeId } = artifact;
  return assigneeId === null || typeof assigneeId === "string"
    ? assigneeId
    : undefined;
}

/**
 * The discriminator for "this cached object is a mutable document artifact".
 *
 * Shared by every reader rather than given a per-field twin: the server
 * stamps this capability on document artifacts and on nothing else
 * (`project-tree-service.ts` gates it on `ArtifactType.DOCUMENT`), which is the
 * same population the artifacts-only priority ownership ruling of 2026-09-11
 * covers. A Branch or Session row in the same cache carries no capability, so
 * it can never contribute an expectation for any field.
 */
function hasStatusMutationCapability(artifact: MutableArtifactRow): boolean {
  const capability = artifact.statusMutation;
  return (
    isRecord(capability) &&
    Array.isArray(capability.allowedStatuses) &&
    capability.expectedStatusField === "expectedStatus" &&
    capability.expectedStatusByIdField === "expectedStatusById"
  );
}

function isArtifactStatus(value: unknown): value is ArtifactStatus {
  return typeof value === "string" && ARTIFACT_STATUSES.has(value);
}

const ARTIFACT_STATUSES = new Set<string>([
  ...DOCUMENT_STATUS_OPTIONS,
  ...ISSUE_STATUS_OPTIONS,
]);
const ARTIFACT_STATUS_CACHE_SCAN_MAX_DEPTH = 8;

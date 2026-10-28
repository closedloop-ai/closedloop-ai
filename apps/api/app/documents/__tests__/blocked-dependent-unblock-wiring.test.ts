import { randomUUID } from "node:crypto";
import {
  BatchItemFailureCode,
  type BatchItemResult,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { Priority } from "@repo/api/src/types/common";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import { documentService } from "@/app/documents/document-service";
import { documentStatusBatchItemService } from "@/app/documents/document-status-batch-item-service";
import { documentStatusMutationService } from "@/app/documents/document-status-mutation-service";
import type { AuthContext } from "@/lib/auth/with-auth";

/**
 * ISS-9632 — production wiring for the blocker-resolution sweep.
 *
 * The service's own behaviour is covered against a real database in
 * `blocked-dependent-unblock.integration.test.ts`. What is proved HERE is the
 * half that suite cannot see: that both status write paths actually invoke it,
 * and that each drives it off the set of artifacts it ACTUALLY moved rather
 * than the set the caller requested. Delete either call site and these fail.
 */

let mockAuthContext: AuthContext;
const mockResolveBlocks = vi.fn().mockResolvedValue({
  resolvedIds: [],
  unblockedIds: [],
});

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown }) =>
      handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/app/documents/document-service");
vi.mock("@/app/documents/document-status-batch-item-service");
// PARTIAL, not a bare automock: the module also exports
// `validateUndoTransactionReference`, which both routes call before writing
// (ISS-10458). Automocking it to `undefined` 500s every case here. Kept REAL —
// no request in this suite names an `undoOfTransactionId`, so it short-circuits
// without a query, which is also the proof that the field is optional.
vi.mock(
  "@/app/documents/document-status-mutation-service",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    documentStatusMutationService: {
      batchUpdateStatus: vi.fn(),
      updateDocument: vi.fn(),
    },
  })
);
vi.mock("@/app/documents/blocked-dependent-unblock-service", () => ({
  blockedDependentUnblockService: {
    resolveBlocksForChangedArtifacts: (...args: unknown[]) =>
      mockResolveBlocks(...args),
  },
}));
vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvent: vi.fn(),
  dispatchAuditEvents: vi.fn(),
  userAuditActor: (userId: string) => ({ actorType: "user", actorId: userId }),
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactUpdate: vi.fn(),
  captureBatchStatusChange: vi.fn(),
}));
vi.mock("@/lib/assignment-notifications", () => ({
  dispatchAssignmentNotification: vi.fn(),
}));
vi.mock(import("@/lib/identifier-utils"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveDocumentId: (id: string) => Promise.resolve(id),
  resolveProjectId: (id: string) => Promise.resolve(id),
}));
vi.mock("../../custom-fields/route-helpers", () => ({
  customFieldsPreflightResponse: () => Promise.resolve(null),
}));

import { PUT } from "@/app/documents/[id]/route";
import { POST as batchUpdateStatus } from "@/app/documents/batch-update-status/route";
import { POST as batchUpdateStatusV2 } from "@/app/documents/batch-update-status/v2/route";

function documentFixture(id: string, status: string) {
  return {
    id,
    type: DocumentType.Feature,
    status,
    title: "blocker",
    assigneeId: null,
    approverId: null,
    priority: Priority.Medium,
    dueDate: null,
    projectId: null,
    slug: "ISS-1",
  };
}

async function putStatus(id: string, from: string, to: string) {
  vi.mocked(documentService.findById).mockResolvedValue(
    documentFixture(id, from) as never
  );
  vi.mocked(documentStatusMutationService.updateDocument).mockResolvedValue(
    Result.ok({
      document: documentFixture(id, to),
      previous: documentFixture(id, from),
    }) as never
  );

  return await PUT(
    createMockRequest({
      url: `http://localhost:3002/api/documents/${id}`,
      method: "PUT",
      body: { status: to },
    }),
    createMockRouteContext({ id })
  );
}

describe("PUT /documents/[id] blocker-resolution wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveBlocks.mockResolvedValue({ resolvedIds: [], unblockedIds: [] });
    mockAuthContext = createTestAuthContext();
  });

  it("resolves blocks for an artifact whose status actually moved", async () => {
    const id = randomUUID();

    const response = await putStatus(
      id,
      IssueStatus.InProgress,
      IssueStatus.Done
    );

    expect(response.status).toBe(200);
    expect(mockResolveBlocks).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      changedArtifactIds: [id],
    });
  });

  it("does not resolve blocks when the write was a no-op re-apply", async () => {
    const id = randomUUID();

    const response = await putStatus(id, IssueStatus.Done, IssueStatus.Done);

    expect(response.status).toBe(200);
    expect(mockResolveBlocks).not.toHaveBeenCalled();
  });
});

describe("POST /documents/batch-update-status blocker-resolution wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveBlocks.mockResolvedValue({ resolvedIds: [], unblockedIds: [] });
    mockAuthContext = createTestAuthContext();
  });

  it("resolves blocks for the changed subset only, never the requested set", async () => {
    const changed = randomUUID();
    const unchanged = randomUUID();
    vi.mocked(
      documentStatusMutationService.batchUpdateStatus
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [changed, unchanged],
        changedIds: [changed],
        transitions: [
          {
            documentId: changed,
            before: IssueStatus.InProgress,
            after: IssueStatus.Done,
          },
        ],
      }) as never
    );

    const response = await batchUpdateStatus(
      createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: {
          documentIds: [changed, unchanged],
          status: IssueStatus.Done,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mockResolveBlocks).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      changedArtifactIds: [changed],
    });
  });

  it("still calls through with an empty changed set so the contract is one-shaped", async () => {
    const requested = randomUUID();
    vi.mocked(
      documentStatusMutationService.batchUpdateStatus
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [requested],
        changedIds: [],
        transitions: [],
      }) as never
    );

    await batchUpdateStatus(
      createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: { documentIds: [requested], status: IssueStatus.Done },
      }),
      createMockRouteContext({})
    );

    expect(mockResolveBlocks).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      changedArtifactIds: [],
    });
  });
});

describe("POST /documents/batch-update-status/v2 blocker-resolution wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveBlocks.mockResolvedValue({ resolvedIds: [], unblockedIds: [] });
    mockAuthContext = createTestAuthContext();
  });

  it("resolves blocks for the committed subset only, never the requested set", async () => {
    const changed = randomUUID();
    const refused = randomUUID();
    vi.mocked(
      documentStatusBatchItemService.batchUpdateStatus
    ).mockResolvedValue({
      resultsById: new Map<string, BatchItemResult>([
        [changed, batchItemApplied(changed)],
        [refused, batchItemFailed(refused, BatchItemFailureCode.StaleStatus)],
      ]),
      changedIds: [changed],
      transitions: [
        {
          documentId: changed,
          before: IssueStatus.InProgress,
          after: IssueStatus.Done,
        },
      ],
    });

    const response = await batchUpdateStatusV2(
      createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status/v2",
        method: "POST",
        body: {
          documentIds: [changed, refused],
          status: IssueStatus.Done,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mockResolveBlocks).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      changedArtifactIds: [changed],
    });
  });
});

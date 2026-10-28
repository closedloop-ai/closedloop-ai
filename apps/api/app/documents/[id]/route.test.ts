/**
 * Route tests for PUT /documents/[id] activity-capture wiring (FEA-3864).
 *
 * Focus: the activity receipt is atomic with the write and therefore refuses
 * the mutation when capture fails. Post-commit analytics remains best-effort
 * and cannot change a successful response. The suite also asserts capture is
 * invoked with the before/after snapshot on a real update.
 */
import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactPriorityMutationErrorCode } from "@repo/api/src/types/artifact-priority-mutation";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import { AuditActorType } from "@repo/api/src/types/audit";
import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { NUL_CHARACTER as NUL } from "@repo/api/src/types/postgres-text";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_TRANSACTION_CLIENT } from "@/__tests__/utils/mock-with-db";
import type { AuthContext } from "@/lib/auth/with-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import { createTestAuthContext } from "../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

const mockGetByVersion = vi.hoisted(() => vi.fn());
const mockGetLatestVersion = vi.hoisted(() => vi.fn());
const mockFindById = vi.hoisted(() => vi.fn());
const mockUpdateDocument = vi.hoisted(() => vi.fn());
const mockWithDocumentStatusMutation = vi.hoisted(() => vi.fn());
const mockCaptureArtifactUpdate = vi.hoisted(() => vi.fn());
const mockCaptureFieldEditAnalytics = vi.hoisted(() => vi.fn());
const mockMergeCustomFieldsIntoResponse = vi.hoisted(() => vi.fn());
const mockRecordOperationReceipt = vi.hoisted(() => vi.fn());
const mockResolveBlocks = vi.hoisted(() => vi.fn());
const mockIndexDocumentProjection = vi.hoisted(() => vi.fn());

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

// ISS-12552: the receipt store, mocked like every other store this suite
// reaches. A request with no receipt context (a browser session) gets none.
vi.mock("@/lib/operation-receipts/operation-receipt-writer", () => ({
  recordOperationReceipt: mockRecordOperationReceipt,
  recordRejectedOperationReceipt: vi.fn(),
}));

// ISS-12552: receipts are recorded only while attribution-evidence-policy is on.
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    _options?: { requiredScopes?: ApiKeyScope[] }
  ) => {
    return (request: NextRequest, ctx: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, ctx.params);
  },
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveDocumentId: vi.fn(async (id: string) => id),
    resolveProjectId: vi.fn(async (id: string) => id),
  };
});

vi.mock("@/app/documents/document-service", () => ({
  documentService: { delete: vi.fn(), findById: mockFindById },
  // ISS-10993: the route indexes the search projection itself, after its own
  // transaction resolves, because `indexDocumentProjection` issues `withDb`
  // work that an ambient transaction would capture.
  indexDocumentProjection: mockIndexDocumentProjection,
}));

vi.mock("@/app/documents/document-status-mutation-capability", () => ({
  documentStatusMutationPermissionsForAuth: () => ({
    single: true,
    bulk: true,
  }),
  withDocumentStatusMutation: (...args: unknown[]) =>
    mockWithDocumentStatusMutation(...args),
}));

vi.mock("@/app/documents/document-status-mutation-service", () => ({
  documentStatusMutationService: { updateDocument: mockUpdateDocument },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getByVersion: mockGetByVersion,
    getLatest: mockGetLatestVersion,
  },
}));

vi.mock("@/app/documents/blocked-dependent-unblock-service", () => ({
  blockedDependentUnblockService: {
    resolveBlocksForChangedArtifacts: (...args: unknown[]) =>
      mockResolveBlocks(...args),
  },
}));

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactUpdate: mockCaptureArtifactUpdate,
}));

vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: mockCaptureFieldEditAnalytics,
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvent: vi.fn(),
  dispatchAuditEvents: vi.fn(),
  userAuditActor: (userId: string) => ({
    actorType: AuditActorType.User,
    actorId: userId,
  }),
}));

vi.mock("@/lib/assignment-notifications", () => ({
  dispatchAssignmentNotification: vi.fn(),
}));

vi.mock("../../custom-fields/route-helpers", () => ({
  customFieldsPreflightResponse: vi.fn(() => Promise.resolve(null)),
  mergeCustomFieldsIntoResponse: (...args: unknown[]) =>
    mockMergeCustomFieldsIntoResponse(...args),
}));

import { GET, PUT } from "./route";

const STATUS_MUTATION_CAPABILITY = {
  allowedStatuses: [IssueStatus.Todo, IssueStatus.InReview],
  expectedStatusField: "expectedStatus",
  expectedStatusByIdField: "expectedStatusById",
};

const EXISTING = {
  id: "a1",
  status: "DRAFT",
  assigneeId: null,
  approverId: null,
  priority: "MEDIUM",
  title: "Doc",
  dueDate: null,
  projectId: "p1",
  slug: "doc-1",
  latestVersion: 1,
  type: "FEATURE",
};

const UPDATED = { ...EXISTING, status: "IN_REVIEW" };
const RECEIPT = {
  operationId: "clop_01a14224-9b59-77ba-b518-16aaa9880991",
  outcome: OperationReceiptOutcome.Committed,
};
const VERSION = {
  id: "version-1",
  documentId: "a1",
  version: 1,
  content: "version content",
  createdById: null,
  createdAt: new Date("2026-09-10T12:00:00Z"),
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function putReq(body: unknown) {
  return new NextRequest("http://localhost/documents/a1", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getReq(path = "http://localhost/documents/a1") {
  return new NextRequest(path);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mockFindById.mockResolvedValue(EXISTING);
  mockGetLatestVersion.mockResolvedValue(VERSION);
  mockGetByVersion.mockResolvedValue(VERSION);
  mockMergeCustomFieldsIntoResponse.mockImplementation(async (doc) => doc);
  mockWithDocumentStatusMutation.mockImplementation((document: object) => ({
    ...document,
    statusMutation: STATUS_MUTATION_CAPABILITY,
  }));
  mockResolveBlocks.mockResolvedValue({ resolvedIds: [], unblockedIds: [] });
  mockUpdateDocument.mockResolvedValue(
    Result.ok({ document: UPDATED, previous: EXISTING, written: true })
  );
  mockRecordOperationReceipt.mockImplementation(
    ({ request }: { request: unknown }) =>
      Promise.resolve(request ? RECEIPT : null)
  );
});

describe("GET /documents/[id] status mutation metadata", () => {
  it("returns statusMutation metadata after custom-field merging", async () => {
    const res = await GET(getReq(), ctx("a1"));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.statusMutation).toEqual(STATUS_MUTATION_CAPABILITY);
    expect(mockMergeCustomFieldsIntoResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        latestVersionContent: VERSION.content,
        statusMutation: STATUS_MUTATION_CAPABILITY,
        version: VERSION,
      }),
      expect.any(String),
      mockAuthContext.user.organizationId
    );
  });
});

describe("PUT /documents/[id] activity capture (ISS-9489 AC-3)", () => {
  it("captures the update with before/after snapshots", async () => {
    const res = await PUT(putReq({ status: "IN_REVIEW" }), ctx("a1"));
    expect(res.status).toBe(200);
    expect(mockCaptureArtifactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "a1",
        before: expect.objectContaining({ status: "DRAFT" }),
        after: expect.objectContaining({ status: "IN_REVIEW" }),
        actor: { userId: mockAuthContext.user.id, authMethod: "session" },
      })
    );
  });

  /**
   * ISS-10993, operator ruling (Cosimo Corrigan, 2026-09-23). This case asserted
   * 200 until that ruling: the capture was swallowed and the edit still
   * succeeded, leaving a permanent hole in a published feed with nobody able to
   * see it. The receipt now commits with the edit, so a capture that cannot
   * record REFUSES the edit. Restore a `catch {}` around the capture and this
   * returns 200 again and fails.
   */
  it("refuses the write when the capture cannot record its receipt", async () => {
    mockCaptureArtifactUpdate.mockRejectedValueOnce(
      new Error("activity store down")
    );

    const res = await PUT(putReq({ status: "IN_REVIEW" }), ctx("a1"));

    expect(res.status).toBe(500);
  });

  // ISS-10993: this route, not `documentStatusMutationService`, indexes the
  // search projection, because the projection issues `withDb` work of its own
  // and `withDb.tx` JOINS an ambient transaction. Scheduled from inside the
  // transaction this route holds, the projection insert runs on the caller's
  // transaction client: queued before the commit a failure aborts the user's
  // edit with 25P02, queued after it the statement hits a closed transaction
  // and is swallowed. Both cases below exist because neither the 200 nor the
  // 500 can tell you which side of the commit it ran on.
  it("indexes the search projection only after the receipt has committed", async () => {
    const order: string[] = [];
    mockCaptureArtifactUpdate.mockImplementationOnce(() => {
      order.push("receipt");
      return Promise.resolve();
    });
    mockIndexDocumentProjection.mockImplementationOnce(() => {
      order.push("projection");
    });

    const res = await PUT(putReq({ status: "IN_REVIEW" }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(order).toEqual(["receipt", "projection"]);
    expect(mockIndexDocumentProjection).toHaveBeenCalledWith(
      UPDATED,
      undefined
    );
  });

  it("indexes nothing for a guarded retry that wrote nothing", async () => {
    // ISS-9486: a guarded retry whose row already holds the requested values
    // issues no update, so there is no new projection to index.
    mockUpdateDocument.mockResolvedValueOnce(
      Result.ok({ document: UPDATED, previous: UPDATED, written: false })
    );

    const res = await PUT(putReq({ status: "IN_REVIEW" }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(mockIndexDocumentProjection).not.toHaveBeenCalled();
  });

  it("indexes nothing when the receipt refuses the write", async () => {
    mockCaptureArtifactUpdate.mockRejectedValueOnce(
      new Error("activity store down")
    );

    const res = await PUT(putReq({ status: "IN_REVIEW" }), ctx("a1"));

    expect(res.status).toBe(500);
    // A projection for an edit that rolled back is a searchable row for a title
    // the document never had.
    expect(mockIndexDocumentProjection).not.toHaveBeenCalled();
  });

  it("forwards the claimed detail surface onto the analytics event", async () => {
    const res = await PUT(
      putReq({
        status: "IN_REVIEW",
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledTimes(1);
    expect(mockCaptureFieldEditAnalytics.mock.calls[0][0]).toMatchObject({
      field: ArtifactFieldEditField.Status,
      result: ArtifactFieldEditOutcome.Committed,
      provenance: { surface: ArtifactStatusEditSurface.Detail },
      before: "DRAFT",
      after: "IN_REVIEW",
      artifactCount: 1,
    });
  });

  // The compatibility direction an already-deployed client exercises: a body
  // with no `surface` is still a valid edit, and its event omits attribution
  // rather than inventing a surface nobody named.
  it("PRESERVES OMISSION: no surface yields an unattributed analytics event", async () => {
    const res = await PUT(putReq({ status: "IN_REVIEW" }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      userId: mockAuthContext.user.id,
      field: ArtifactFieldEditField.Status,
      result: ArtifactFieldEditOutcome.Committed,
      artifactCount: 1,
      before: "DRAFT",
      after: "IN_REVIEW",
    });
  });

  it.each([
    ArtifactStatusEditSurface.Detail,
    ArtifactStatusEditSurface.InlineCell,
    ArtifactStatusEditSurface.Board,
  ])(
    "emits the shared committed receipt for the %s surface",
    async (surface) => {
      const res = await PUT(
        putReq({ status: "IN_REVIEW", surface }),
        ctx("a1")
      );

      expect(res.status).toBe(200);
      expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith({
        organizationId: mockAuthContext.user.organizationId,
        userId: mockAuthContext.user.id,
        field: ArtifactFieldEditField.Status,
        result: ArtifactFieldEditOutcome.Committed,
        artifactCount: 1,
        before: "DRAFT",
        after: "IN_REVIEW",
        provenance: {
          surface,
          ...(surface === ArtifactStatusEditSurface.Board
            ? { commitGroupId: expect.any(String) }
            : {}),
        },
      });
    }
  );

  it("classifies a guarded same-value retry as no_change without another activity row", async () => {
    mockUpdateDocument.mockResolvedValueOnce(
      Result.ok({ document: UPDATED, previous: UPDATED, written: false })
    );

    const res = await PUT(
      putReq({
        status: "IN_REVIEW",
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Status,
        result: ArtifactFieldEditOutcome.NoChange,
        artifactCount: 1,
      })
    );
    expect(mockIndexDocumentProjection).not.toHaveBeenCalled();
  });

  it("commits an unknown-client surface while omitting fabricated provenance", async () => {
    const res = await PUT(
      putReq({ status: "IN_REVIEW", surface: "command_palette" }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    const input = mockCaptureFieldEditAnalytics.mock.calls[0][0];
    expect(input).toMatchObject({
      field: ArtifactFieldEditField.Status,
      result: ArtifactFieldEditOutcome.Committed,
    });
    expect(input).not.toHaveProperty("surface");
  });

  it("keeps API-key provenance omitted even when the body names a surface", async () => {
    mockAuthContext = createTestAuthContext({ authMethod: "api_key" });

    const res = await PUT(
      putReq({
        status: "IN_REVIEW",
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledTimes(1);
    expect(mockCaptureFieldEditAnalytics.mock.calls[0][0]).not.toHaveProperty(
      "surface"
    );
  });

  it("wires title edits through the shared classifier without changing the activity call", async () => {
    mockUpdateDocument.mockResolvedValueOnce(
      Result.ok({
        document: { ...EXISTING, title: "Renamed" },
        previous: EXISTING,
        written: true,
      })
    );

    const res = await PUT(
      putReq({
        title: "Renamed",
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Title,
        before: "Doc",
        after: "Renamed",
        result: ArtifactFieldEditOutcome.Committed,
      })
    );
    expect(mockCaptureArtifactUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /documents/[id] status mutation errors", () => {
  it("returns 400 (not 500) for a DocumentStatus value on a FEATURE", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.err({
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.InvalidStatusForSubtype,
        message:
          'Status "DRAFT" is not valid for one or more selected documents',
        details: {
          invalidStatuses: [
            {
              documentId: "a1",
              currentStatus: IssueStatus.InProgress,
              targetStatus: DocumentStatus.Draft,
              subtype: DocumentType.Feature,
              allowedStatuses: [IssueStatus.Todo],
            },
          ],
        },
      })
    );

    const res = await PUT(putReq({ status: DocumentStatus.Draft }), ctx("a1"));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({
      success: false,
      code: DocumentStatusMutationErrorCode.InvalidStatusForSubtype,
    });
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Status,
        result: ArtifactFieldEditOutcome.ValidationFailed,
        artifactCount: 1,
      })
    );
  });

  it("returns 400 for an IssueStatus value on a non-FEATURE document (converse direction)", async () => {
    mockFindById.mockResolvedValue({ ...EXISTING, type: DocumentType.Prd });
    mockUpdateDocument.mockResolvedValue(
      Result.err({
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.InvalidStatusForSubtype,
        message:
          'Status "TODO" is not valid for one or more selected documents',
        details: {
          invalidStatuses: [
            {
              documentId: "a1",
              currentStatus: DocumentStatus.Draft,
              targetStatus: IssueStatus.Todo,
              subtype: DocumentType.Prd,
              allowedStatuses: [DocumentStatus.InReview],
            },
          ],
        },
      })
    );

    const res = await PUT(putReq({ status: IssueStatus.Todo }), ctx("a1"));

    expect(res.status).toBe(400);
    expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
  });

  it("allows an in-vocabulary status through to the service (positive control)", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.ok({
        document: { ...EXISTING, status: IssueStatus.Todo },
        previous: EXISTING,
      })
    );
    const res = await PUT(putReq({ status: IssueStatus.Todo }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(mockUpdateDocument).toHaveBeenCalledWith(
      "a1",
      mockAuthContext.user.organizationId,
      { status: IssueStatus.Todo }
    );
  });

  it("forwards expectedStatus and maps stale writes to 409", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        code: DocumentStatusMutationErrorCode.StaleStatus,
        message: "One or more documents changed before the status update",
        details: {
          staleStatuses: [
            {
              documentId: "a1",
              currentStatus: IssueStatus.InReview,
              expectedStatus: IssueStatus.Todo,
            },
          ],
        },
      })
    );

    const res = await PUT(
      putReq({
        expectedStatus: IssueStatus.Todo,
        status: IssueStatus.Done,
      }),
      ctx("a1")
    );

    expect(mockUpdateDocument).toHaveBeenCalledWith(
      "a1",
      mockAuthContext.user.organizationId,
      {
        expectedStatus: IssueStatus.Todo,
        status: IssueStatus.Done,
      }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false,
      code: DocumentStatusMutationErrorCode.StaleStatus,
    });
    expect(mockCaptureArtifactUpdate).not.toHaveBeenCalled();
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Status,
        result: ArtifactFieldEditOutcome.Conflict,
        artifactCount: 1,
      })
    );
  });
  // ISS-9440: the route is the only thing between the validated body and the
  // service, so the guard reaching the service is what makes it a guard. The
  // 409 render is asserted in the same case because a forwarded guard whose
  // rejection is flattened to a 400 or a 500 is no better than none.
  it("forwards expectedPriority and maps a stale priority write to 409", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        code: ArtifactPriorityMutationErrorCode.StalePriority,
        message: "One or more documents changed before the priority update",
        details: {
          stalePriorities: [
            {
              documentId: "a1",
              currentPriority: Priority.Urgent,
              expectedPriority: Priority.Medium,
            },
          ],
        },
      })
    );

    const res = await PUT(
      putReq({
        expectedPriority: Priority.Medium,
        priority: Priority.High,
      }),
      ctx("a1")
    );

    expect(mockUpdateDocument).toHaveBeenCalledWith(
      "a1",
      mockAuthContext.user.organizationId,
      { expectedPriority: Priority.Medium, priority: Priority.High }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false,
      code: ArtifactPriorityMutationErrorCode.StalePriority,
    });
    expect(mockCaptureArtifactUpdate).not.toHaveBeenCalled();
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Priority,
        result: ArtifactFieldEditOutcome.Conflict,
        artifactCount: 1,
      })
    );
  });

  it("does not emit a receipt or edit outcome for a not-found refusal", async () => {
    mockFindById.mockResolvedValueOnce(null);

    const res = await PUT(putReq({ status: IssueStatus.Done }), ctx("missing"));

    expect(res.status).toBe(404);
    expect(mockCaptureArtifactUpdate).not.toHaveBeenCalled();
    expect(mockCaptureFieldEditAnalytics).not.toHaveBeenCalled();
  });
});

/**
 * ISS-9443 — the aggregate half of the priority receipt.
 *
 * Every case here drives the real route and asserts on the emit AFTER the
 * response, because the emit is guarded three ways inside the handler and each
 * guard is a way for the number to be wrong rather than absent.
 */
// ISS-11195: a NUL is legal JSON and illegal in a Postgres `text` column, so a
// title carrying one cleared the schema and failed the write as a 500.
describe("PUT /documents/[id] NUL in text fields", () => {
  it("strips a NUL from the title before the write", async () => {
    const res = await PUT(putReq({ title: `a${NUL}b` }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(mockUpdateDocument).toHaveBeenCalledWith(
      "a1",
      mockAuthContext.user.organizationId,
      { title: "ab" }
    );
  });

  it("forwards a title with no NUL byte for byte", async () => {
    // An astral pair and trailing space: valid text the sanitizer must not touch.
    const title = "Plan 🚀 — v2 ";

    const res = await PUT(putReq({ title }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(mockUpdateDocument).toHaveBeenCalledWith(
      "a1",
      mockAuthContext.user.organizationId,
      { title }
    );
  });

  it("answers 400 for an expectedStatus carrying a NUL, before the write", async () => {
    const res = await PUT(
      putReq({
        expectedStatus: `${IssueStatus.Todo}${NUL}`,
        status: IssueStatus.Done,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(400);
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it("answers 400 for an expectedTitle carrying a NUL, before the write", async () => {
    const res = await PUT(
      putReq({ title: "New", expectedTitle: `Doc${NUL}` }),
      ctx("a1")
    );

    expect(res.status).toBe(400);
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });
});

describe("PUT /documents/[id] operation receipts (ISS-12552)", () => {
  it("records the fields an API-key update moved, on the write's own transaction", async () => {
    mockAuthContext = createTestAuthContext({ authMethod: "api_key" });
    mockUpdateDocument.mockResolvedValue(
      Result.ok({
        document: { ...EXISTING, title: "Renamed" },
        previous: EXISTING,
        written: true,
      })
    );

    const res = await PUT(putReq({ title: "Renamed" }), ctx("a1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRecordOperationReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: MOCK_TRANSACTION_CLIENT,
        write: {
          operationKind: OperationKind.UpdateFields,
          outcome: OperationReceiptOutcome.Committed,
          targetArtifactId: "a1",
          changedFields: ["title"],
        },
      })
    );
    expect(body.data.operationReceipt).toEqual(RECEIPT);
  });

  it("records a no-op when an API-key re-save changes nothing", async () => {
    mockAuthContext = createTestAuthContext({ authMethod: "api_key" });
    mockUpdateDocument.mockResolvedValue(
      Result.ok({ document: EXISTING, previous: EXISTING, written: true })
    );

    await PUT(putReq({ title: EXISTING.title }), ctx("a1"));

    expect(mockRecordOperationReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        write: expect.objectContaining({
          outcome: OperationReceiptOutcome.NoOp,
          changedFields: [],
        }),
      })
    );
  });

  it("gives a browser-session update no receipt", async () => {
    const res = await PUT(putReq({ status: "IN_REVIEW" }), ctx("a1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRecordOperationReceipt).not.toHaveBeenCalled();
    expect(body.data.operationReceipt).toBeUndefined();
  });
});

// ISS-12858: `projectId: null` clears the project; an omitted key leaves it
// alone, so it never reaches the write.
describe("PUT /documents/[id] projectId clear (ISS-12858)", () => {
  it("clears the project when projectId is null", async () => {
    const res = await PUT(putReq({ projectId: null }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(resolveProjectId).not.toHaveBeenCalled();
    expect(mockUpdateDocument).toHaveBeenCalledWith(
      "a1",
      mockAuthContext.user.organizationId,
      { projectId: null }
    );
  });

  it("leaves projectId out of the write when the body omits it", async () => {
    const res = await PUT(putReq({ title: "Renamed" }), ctx("a1"));

    expect(res.status).toBe(200);
    const written = mockUpdateDocument.mock.calls[0]?.[2];
    expect(written).toEqual({ title: "Renamed" });
    expect(written).not.toHaveProperty("projectId");
  });
});

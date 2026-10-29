/**
 * PUT /documents/[id] audit-ledger wiring for single-artifact mutations.
 *
 * The route and mutation-audit adapter are real. Mutation persistence, the
 * terminal audit dispatcher, and unrelated route collaborators are mocked so
 * these cases pin the action, object type, detail, failure boundary, and no-op
 * behavior that the production route sends.
 */
import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { ArtifactPriorityMutationErrorCode } from "@repo/api/src/types/artifact-priority-mutation";
import {
  AuditAction,
  AuditActorType,
  AuditObjectType,
} from "@repo/api/src/types/audit";
import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import { createTestAuthContext } from "../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

const mockCaptureArtifactUpdate = vi.hoisted(() => vi.fn());
const mockDispatchAuditEvent = vi.hoisted(() => vi.fn());
const mockDispatchAuditEvents = vi.hoisted(() => vi.fn());
const mockFindById = vi.hoisted(() => vi.fn());
const mockGetByVersion = vi.hoisted(() => vi.fn());
const mockGetLatestVersion = vi.hoisted(() => vi.fn());
const mockIndexDocumentProjection = vi.hoisted(() => vi.fn());
const mockMergeCustomFieldsIntoResponse = vi.hoisted(() => vi.fn());
const mockResolveBlocks = vi.hoisted(() => vi.fn());
const mockUpdateDocument = vi.hoisted(() => vi.fn());
const mockWithDocumentStatusMutation = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
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

vi.mock("@/lib/artifact-status-analytics", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  captureArtifactStatusChangeAnalytics: vi.fn(),
}));

vi.mock("@/lib/artifact-priority-analytics", () => ({
  captureArtifactPriorityChangeAnalytics: vi.fn(),
}));

vi.mock("@/app/audit/audit-emit-service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dispatchAuditEvent: mockDispatchAuditEvent,
  dispatchAuditEvents: mockDispatchAuditEvents,
}));

vi.mock("@/lib/assignment-notifications", () => ({
  dispatchAssignmentNotification: vi.fn(),
}));

vi.mock("../../custom-fields/route-helpers", () => ({
  customFieldsPreflightResponse: vi.fn(() => Promise.resolve(null)),
  mergeCustomFieldsIntoResponse: (...args: unknown[]) =>
    mockMergeCustomFieldsIntoResponse(...args),
}));

import { PUT } from "./route";

const STATUS_MUTATION_CAPABILITY = {
  allowedStatuses: [IssueStatus.Todo, IssueStatus.InReview],
  expectedStatusField: "expectedStatus",
  expectedStatusByIdField: "expectedStatusById",
};

const EXISTING = {
  id: "a1",
  status: DocumentStatus.Draft,
  assigneeId: null,
  approverId: null,
  priority: Priority.Medium,
  title: "Doc",
  dueDate: null,
  projectId: "p1",
  slug: "doc-1",
  latestVersion: 1,
  type: DocumentType.Feature,
};

const UPDATED = { ...EXISTING, status: IssueStatus.InReview };
const VERSION = {
  id: "version-1",
  documentId: EXISTING.id,
  version: 1,
  content: "version content",
  createdById: null,
  createdAt: new Date("2026-09-10T12:00:00Z"),
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function putReq(body: unknown) {
  return new NextRequest(`http://localhost/documents/${EXISTING.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
});

describe("PUT /documents/[id] audit ledger", () => {
  it("keeps the existing status audit alongside activity capture", async () => {
    const response = await PUT(
      putReq({ status: IssueStatus.InReview }),
      ctx(EXISTING.id)
    );

    expect(response.status).toBe(200);
    expect(mockCaptureArtifactUpdate).toHaveBeenCalledTimes(1);
    expect(mockDispatchAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockDispatchAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId: EXISTING.id,
        detail: {
          from: DocumentStatus.Draft,
          to: IssueStatus.InReview,
        },
      })
    );
  });

  it("sends a priority transition through the real adapter as a Document event", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.ok({
        document: { ...EXISTING, priority: Priority.Urgent },
        previous: EXISTING,
        written: true,
      })
    );

    const response = await PUT(
      putReq({ priority: Priority.Urgent }),
      ctx(EXISTING.id)
    );

    expect(response.status).toBe(200);
    expect(mockCaptureArtifactUpdate).toHaveBeenCalledTimes(1);
    expect(mockDispatchAuditEvents).toHaveBeenCalledWith([
      {
        organizationId: mockAuthContext.user.organizationId,
        actor: {
          actorType: AuditActorType.User,
          actorId: mockAuthContext.user.id,
        },
        action: AuditAction.DocumentPriorityChanged,
        objectType: AuditObjectType.Document,
        objectId: EXISTING.id,
        detail: { from: Priority.Medium, to: Priority.Urgent },
      },
    ]);
  });

  it("sends a project transition through the real adapter as an Artifact event", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.ok({
        document: { ...EXISTING, projectId: "PRO-44" },
        previous: EXISTING,
        written: true,
      })
    );

    const response = await PUT(
      putReq({ projectId: "PRO-44" }),
      ctx(EXISTING.id)
    );

    expect(response.status).toBe(200);
    expect(mockDispatchAuditEvents).toHaveBeenCalledWith([
      {
        organizationId: mockAuthContext.user.organizationId,
        actor: {
          actorType: AuditActorType.User,
          actorId: mockAuthContext.user.id,
        },
        action: AuditAction.ArtifactProjectChanged,
        objectType: AuditObjectType.Artifact,
        objectId: EXISTING.id,
        detail: { from: EXISTING.projectId, to: "PRO-44" },
      },
    ]);
  });

  it("sends priority and project transitions in one combined batch", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.ok({
        document: {
          ...EXISTING,
          priority: Priority.High,
          projectId: "PRO-44",
        },
        previous: EXISTING,
        written: true,
      })
    );

    const response = await PUT(
      putReq({ priority: Priority.High, projectId: "PRO-44" }),
      ctx(EXISTING.id)
    );

    expect(response.status).toBe(200);
    expect(mockDispatchAuditEvents).toHaveBeenCalledTimes(1);
    expect(mockDispatchAuditEvents).toHaveBeenCalledWith([
      {
        organizationId: mockAuthContext.user.organizationId,
        actor: {
          actorType: AuditActorType.User,
          actorId: mockAuthContext.user.id,
        },
        action: AuditAction.DocumentPriorityChanged,
        objectType: AuditObjectType.Document,
        objectId: EXISTING.id,
        detail: { from: Priority.Medium, to: Priority.High },
      },
      {
        organizationId: mockAuthContext.user.organizationId,
        actor: {
          actorType: AuditActorType.User,
          actorId: mockAuthContext.user.id,
        },
        action: AuditAction.ArtifactProjectChanged,
        objectType: AuditObjectType.Artifact,
        objectId: EXISTING.id,
        detail: { from: EXISTING.projectId, to: "PRO-44" },
      },
    ]);
  });

  it("invokes the combined priority/project batch after synchronous status dispatch failure", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.ok({
        document: {
          ...EXISTING,
          status: IssueStatus.InReview,
          priority: Priority.High,
          projectId: "PRO-44",
        },
        previous: EXISTING,
        written: true,
      })
    );
    mockDispatchAuditEvent.mockImplementationOnce(() => {
      throw new Error("waitUntil unavailable");
    });

    const response = await PUT(
      putReq({
        status: IssueStatus.InReview,
        priority: Priority.High,
        projectId: "PRO-44",
      }),
      ctx(EXISTING.id)
    );

    expect(response.status).toBe(200);
    expect(mockDispatchAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockDispatchAuditEvents).toHaveBeenCalledTimes(1);
    expect(mockDispatchAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        action: AuditAction.DocumentPriorityChanged,
        objectType: AuditObjectType.Document,
      }),
      expect.objectContaining({
        action: AuditAction.ArtifactProjectChanged,
        objectType: AuditObjectType.Artifact,
      }),
    ]);
  });

  it("emits no event for an edit with no audited transition", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.ok({
        document: { ...EXISTING, title: "Renamed" },
        previous: EXISTING,
      })
    );

    const response = await PUT(putReq({ title: "Renamed" }), ctx(EXISTING.id));

    expect(response.status).toBe(200);
    expect(mockCaptureArtifactUpdate).toHaveBeenCalledTimes(1);
    expect(mockDispatchAuditEvent).not.toHaveBeenCalled();
    expect(mockDispatchAuditEvents).not.toHaveBeenCalled();
  });

  it("emits no event when activity receipt failure refuses the write", async () => {
    mockCaptureArtifactUpdate.mockRejectedValueOnce(
      new Error("activity store down")
    );

    const response = await PUT(
      putReq({ status: IssueStatus.InReview }),
      ctx(EXISTING.id)
    );

    expect(response.status).toBe(500);
    expect(mockDispatchAuditEvent).not.toHaveBeenCalled();
    expect(mockDispatchAuditEvents).not.toHaveBeenCalled();
  });

  it("emits no status event for a stale status write", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        code: DocumentStatusMutationErrorCode.StaleStatus,
        message: "One or more documents changed before the status update",
        details: {
          staleStatuses: [
            {
              documentId: EXISTING.id,
              currentStatus: IssueStatus.InReview,
              expectedStatus: IssueStatus.Todo,
            },
          ],
        },
      })
    );

    const response = await PUT(
      putReq({
        expectedStatus: IssueStatus.Todo,
        status: IssueStatus.Done,
      }),
      ctx(EXISTING.id)
    );

    expect(response.status).toBe(409);
    expect(mockCaptureArtifactUpdate).not.toHaveBeenCalled();
    expect(mockDispatchAuditEvent).not.toHaveBeenCalled();
    expect(mockDispatchAuditEvents).not.toHaveBeenCalled();
  });

  it("emits no priority event for a stale priority write", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        code: ArtifactPriorityMutationErrorCode.StalePriority,
        message: "One or more documents changed before the priority update",
        details: {
          stalePriorities: [
            {
              documentId: EXISTING.id,
              currentPriority: Priority.Urgent,
              expectedPriority: Priority.Medium,
            },
          ],
        },
      })
    );

    const response = await PUT(
      putReq({
        expectedPriority: Priority.Medium,
        priority: Priority.High,
      }),
      ctx(EXISTING.id)
    );

    expect(response.status).toBe(409);
    expect(mockCaptureArtifactUpdate).not.toHaveBeenCalled();
    expect(mockDispatchAuditEvent).not.toHaveBeenCalled();
    expect(mockDispatchAuditEvents).not.toHaveBeenCalled();
  });
});

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import { Result } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import { createTestAuthContext } from "../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

const mockGetLatestVersion = vi.hoisted(() => vi.fn());
const mockFindById = vi.hoisted(() => vi.fn());
const mockUpdateDocument = vi.hoisted(() => vi.fn());
const mockCaptureFieldEditAnalytics = vi.hoisted(() => vi.fn());
const mockMergeCustomFieldsIntoResponse = vi.hoisted(() => vi.fn());
const mockCustomFieldsPreflightResponse = vi.hoisted(() => vi.fn());
const mockResolveBlocks = vi.hoisted(() => vi.fn());
const mockCapturePriorityChange = vi.hoisted(() => vi.fn());
const mockCaptureStatusChange = vi.hoisted(() => vi.fn());

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
  indexDocumentProjection: vi.fn(),
}));

vi.mock("@/app/documents/document-status-mutation-capability", () => ({
  documentStatusMutationPermissionsForAuth: () => ({
    single: true,
    bulk: true,
  }),
  withDocumentStatusMutation: (document: object) => document,
}));

vi.mock("@/app/documents/document-status-mutation-service", () => ({
  documentStatusMutationService: { updateDocument: mockUpdateDocument },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getByVersion: vi.fn(),
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
  captureArtifactUpdate: vi.fn(),
}));

vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: mockCaptureFieldEditAnalytics,
}));

vi.mock("@/lib/artifact-priority-analytics", () => ({
  captureArtifactPriorityChangeAnalytics: mockCapturePriorityChange,
}));

vi.mock("@/lib/artifact-status-analytics", () => ({
  captureArtifactStatusChangeAnalytics: mockCaptureStatusChange,
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvent: vi.fn(),
  userAuditActor: (userId: string) => ({ actorType: "user", actorId: userId }),
}));

vi.mock("@/lib/assignment-notifications", () => ({
  dispatchAssignmentNotification: vi.fn(),
}));

// ISS-12552: the receipt store, mocked like every other store this suite
// reaches; an API-key update records one, and this suite asserts analytics only.
vi.mock("@/lib/operation-receipts/operation-receipt-writer", () => ({
  recordOperationReceipt: vi.fn(() => Promise.resolve(null)),
  recordRejectedOperationReceipt: vi.fn(),
}));

vi.mock("../../custom-fields/route-helpers", () => ({
  customFieldsPreflightResponse: (...args: unknown[]) =>
    mockCustomFieldsPreflightResponse(...args),
  mergeCustomFieldsIntoResponse: (...args: unknown[]) =>
    mockMergeCustomFieldsIntoResponse(...args),
}));

import { PUT } from "./route";

const existing = {
  id: "a1",
  status: "DRAFT",
  assigneeId: null,
  approverId: null,
  priority: Priority.Medium,
  title: "Doc",
  dueDate: null,
  projectId: "p1",
  slug: "doc-1",
  latestVersion: 1,
  type: "FEATURE",
};

const priorityMoved = {
  ...existing,
  priority: Priority.Urgent,
};

const SENSITIVE_ANALYTICS_DETAIL_PATTERN =
  /22222222-2222-4222-8222-222222222222|private value|invalid secret value/;

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

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mockFindById.mockResolvedValue(existing);
  mockGetLatestVersion.mockResolvedValue(null);
  mockMergeCustomFieldsIntoResponse.mockImplementation(async (doc) => doc);
  mockResolveBlocks.mockResolvedValue({ resolvedIds: [], unblockedIds: [] });
  mockCustomFieldsPreflightResponse.mockResolvedValue(null);
  mockUpdateDocument.mockResolvedValue(
    Result.ok({ document: priorityMoved, previous: existing, written: true })
  );
});

describe("PUT /documents/[id] priority analytics", () => {
  it("emits one value-safe validation outcome when composite preflight refuses", async () => {
    mockCustomFieldsPreflightResponse.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid secret value" }), {
        status: 400,
      })
    );

    const res = await PUT(
      putReq({
        title: "Unwritten title",
        customFields: {
          "22222222-2222-4222-8222-222222222222": "private value",
        },
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(400);
    expect(mockUpdateDocument).not.toHaveBeenCalled();
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledOnce();
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      userId: mockAuthContext.user.id,
      field: ArtifactFieldEditField.CustomField,
      result: ArtifactFieldEditOutcome.ValidationFailed,
      artifactCount: 1,
      provenance: { surface: ArtifactStatusEditSurface.Detail },
    });
    expect(
      JSON.stringify(mockCaptureFieldEditAnalytics.mock.calls)
    ).not.toMatch(SENSITIVE_ANALYTICS_DETAIL_PATTERN);
  });

  it("counts a real priority change under the surface that made it", async () => {
    const res = await PUT(
      putReq({
        priority: Priority.Urgent,
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      userId: mockAuthContext.user.id,
      field: ArtifactFieldEditField.Priority,
      result: ArtifactFieldEditOutcome.Committed,
      provenance: { surface: ArtifactStatusEditSurface.Detail },
      before: Priority.Medium,
      after: Priority.Urgent,
      artifactCount: 1,
    });
  });

  it("keeps `surface` out of the service input", async () => {
    await PUT(
      putReq({
        priority: Priority.Urgent,
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(mockUpdateDocument).toHaveBeenCalledWith(
      "a1",
      mockAuthContext.user.organizationId,
      { priority: Priority.Urgent }
    );
  });

  it("counts a clear as a real write", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.ok({
        document: { ...existing, priority: null },
        previous: existing,
      })
    );

    await PUT(
      putReq({
        priority: null,
        surface: ArtifactStatusEditSurface.InlineCell,
      }),
      ctx("a1")
    );

    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ before: Priority.Medium, after: null })
    );
  });

  it("preserves omitted provenance when the caller named no surface", async () => {
    const res = await PUT(putReq({ priority: Priority.Urgent }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Priority,
        provenance: undefined,
      })
    );
  });

  it("counts a board priority edit with board provenance", async () => {
    const res = await PUT(
      putReq({
        priority: Priority.Urgent,
        surface: ArtifactStatusEditSurface.Board,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Priority,
        provenance: expect.objectContaining({
          surface: ArtifactStatusEditSurface.Board,
        }),
      })
    );
  });

  it("counts nothing for a status-only write whose priority moved underneath it", async () => {
    const res = await PUT(
      putReq({
        status: IssueStatus.InReview,
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockCaptureFieldEditAnalytics).not.toHaveBeenCalledWith(
      expect.objectContaining({ field: ArtifactFieldEditField.Priority })
    );
  });

  it("withholds a surface an API key named", async () => {
    mockAuthContext = createTestAuthContext({ authMethod: "api_key" });

    const res = await PUT(
      putReq({
        priority: Priority.Urgent,
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Priority,
        provenance: undefined,
      })
    );
  });

  it("commits the write when a newer client names an unknown surface", async () => {
    const res = await PUT(
      putReq({ priority: Priority.Urgent, surface: "command_palette" }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Priority,
        provenance: undefined,
      })
    );
  });

  it("delegates a committed write to the shared failure-isolating adapter", async () => {
    const res = await PUT(
      putReq({
        priority: Priority.Urgent,
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledTimes(1);
  });

  it("records no_change when the priority did not move", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.ok({ document: { ...existing }, previous: existing })
    );

    await PUT(
      putReq({
        priority: Priority.Medium,
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(mockCaptureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Priority,
        result: ArtifactFieldEditOutcome.NoChange,
      })
    );
  });
});

describe("PUT /documents/[id] shipped status and priority events (PRD-722 AC6)", () => {
  it("sends artifact_priority_changed for a real priority change", async () => {
    const res = await PUT(
      putReq({
        priority: Priority.Urgent,
        surface: ArtifactStatusEditSurface.Detail,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockCapturePriorityChange.mock.calls).toEqual([
      [
        {
          organizationId: mockAuthContext.user.organizationId,
          userId: mockAuthContext.user.id,
          surface: ArtifactStatusEditSurface.Detail,
          result: "committed",
          from: Priority.Medium,
          to: Priority.Urgent,
          artifactCount: 1,
        },
      ],
    ]);
    expect(mockCaptureStatusChange).not.toHaveBeenCalled();
  });

  it("sends artifact_status_changed for a real status change", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.ok({
        document: { ...existing, status: IssueStatus.Done },
        previous: existing,
        written: true,
      })
    );

    const res = await PUT(
      putReq({
        status: IssueStatus.Done,
        surface: ArtifactStatusEditSurface.InlineCell,
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(mockCaptureStatusChange.mock.calls).toEqual([
      [
        {
          organizationId: mockAuthContext.user.organizationId,
          userId: mockAuthContext.user.id,
          surface: ArtifactStatusEditSurface.InlineCell,
          result: "committed",
          from: "DRAFT",
          to: IssueStatus.Done,
          artifactCount: 1,
        },
      ],
    ]);
    expect(mockCapturePriorityChange).not.toHaveBeenCalled();
  });
});

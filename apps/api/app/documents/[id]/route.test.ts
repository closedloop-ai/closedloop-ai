/**
 * Route tests for PUT /documents/[id] activity-capture wiring (FEA-3864).
 *
 * Focus: ROUTE-LEVEL FAILURE-ISOLATION — the activity capture is best-effort and
 * must never fail the user's write. Even if `captureArtifactUpdate` throws
 * synchronously, the PUT still returns 200 with the updated artifact.
 * Also asserts capture is invoked with the before/after snapshot on a real
 * update.
 */
import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import { createTestAuthContext } from "../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

const mockFindById = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockCaptureArtifactUpdate = vi.hoisted(() => vi.fn());
const mockDispatchAuditEvent = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: any,
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
  documentService: { findById: mockFindById, update: mockUpdate },
}));

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactUpdate: mockCaptureArtifactUpdate,
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvent: mockDispatchAuditEvent,
  userAuditActor: (userId: string) => ({ actorType: "user", actorId: userId }),
}));

vi.mock("@/lib/assignment-notifications", () => ({
  dispatchAssignmentNotification: vi.fn(),
}));

vi.mock("../../custom-fields/route-helpers", () => ({
  applyCustomFieldsFromBody: vi.fn(),
  mergeCustomFieldsIntoResponse: vi.fn(async (doc: unknown) => doc),
}));

import { PUT } from "./route";

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
  type: "FEATURE",
};

const UPDATED = { ...EXISTING, status: "IN_REVIEW" };

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
  mockFindById.mockResolvedValue(EXISTING);
  mockUpdate.mockResolvedValue(UPDATED);
});

describe("PUT /documents/[id] activity capture", () => {
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

  it("also emits an audit-ledger event on a real status change (both hooks coexist)", async () => {
    const res = await PUT(putReq({ status: "IN_REVIEW" }), ctx("a1"));
    expect(res.status).toBe(200);
    // Activity capture and the audit ledger both fire on the same write.
    expect(mockCaptureArtifactUpdate).toHaveBeenCalledTimes(1);
    expect(mockDispatchAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockDispatchAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId: "a1",
        detail: { from: "DRAFT", to: "IN_REVIEW" },
      })
    );
  });

  it("does NOT emit an audit event when the status is unchanged, but still captures activity", async () => {
    // Update that does not touch status (e.g. a title-only edit).
    mockUpdate.mockResolvedValue({ ...EXISTING, title: "Renamed" });
    const res = await PUT(putReq({ title: "Renamed" }), ctx("a1"));
    expect(res.status).toBe(200);
    // Audit ledger guards on a real transition; activity capture is unguarded.
    expect(mockDispatchAuditEvent).not.toHaveBeenCalled();
    expect(mockCaptureArtifactUpdate).toHaveBeenCalledTimes(1);
  });

  it("FAILURE-ISOLATION: a throwing capture does not fail the write", async () => {
    mockCaptureArtifactUpdate.mockImplementation(() => {
      throw new Error("capture boom");
    });

    const res = await PUT(putReq({ status: "IN_REVIEW" }), ctx("a1"));

    // The write still succeeds despite the capture throwing.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.status).toBe("IN_REVIEW");
  });
});

describe("PUT /documents/[id] cross-vocabulary status guard (ISS-4616)", () => {
  it("returns 400 (not 500) for a DocumentStatus value on a FEATURE, without reaching the service", async () => {
    // EXISTING.type is FEATURE, which uses the IssueStatus vocabulary. DRAFT is a
    // DocumentStatus value, so it is outside the target artifact's vocabulary.
    // Previously this fell through to documentService.update and threw → an
    // undocumented 500; now the route rejects it with a clean 400.
    const res = await PUT(putReq({ status: DocumentStatus.Draft }), ctx("a1"));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    // The write must be rejected before it reaches the service.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 for an IssueStatus value on a non-FEATURE document (converse direction)", async () => {
    mockFindById.mockResolvedValue({ ...EXISTING, type: DocumentType.Prd });
    // TODO is an IssueStatus value, invalid for a PRD (DocumentStatus vocabulary).
    const res = await PUT(putReq({ status: IssueStatus.Todo }), ctx("a1"));

    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("allows an in-vocabulary status through to the service (positive control)", async () => {
    // TODO is a valid IssueStatus value for a FEATURE, so the guard must not
    // over-reject it — the update proceeds normally.
    mockUpdate.mockResolvedValue({ ...EXISTING, status: IssueStatus.Todo });
    const res = await PUT(putReq({ status: IssueStatus.Todo }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

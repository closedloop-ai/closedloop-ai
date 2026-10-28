/**
 * ISS-7224: the artifact routes must stamp the span from the PERSISTED ROW.
 *
 * `/documents/{id}` carries no type, so the only wrong-but-plausible
 * implementations are a path/slug-derived guess and a request-body-derived one.
 * Both are ruled out here by making the row disagree with the URL and with the
 * body, and requiring the ROW to be what reaches the recorder.
 *
 * The wrapper-level half of this contract — that what the recorder is handed
 * actually reaches the emitted span — lives in
 * `__tests__/unit/request-span-attribution.test.ts`.
 */
import type { ApiKeyScope } from "@repo/api/src/types/api-key";
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

const mockFindById = vi.hoisted(() => vi.fn());
const mockUpdateDocument = vi.hoisted(() => vi.fn());
const mockRecordRequestArtifact = vi.hoisted(() => vi.fn());
const mockResolveBlocks = vi.hoisted(() => vi.fn());
const mockGetLatest = vi.hoisted(() => vi.fn());

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: never, _options?: { requiredScopes?: ApiKeyScope[] }) =>
    (request: NextRequest, ctx: { params: Promise<unknown> }) =>
      (handler as never as (...args: unknown[]) => unknown)(
        mockAuthContext,
        request,
        ctx.params
      ),
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
  documentService: { findById: mockFindById },
  // ISS-10993: the route indexes the search projection itself, once its own
  // transaction has resolved.
  indexDocumentProjection: vi.fn(),
}));

vi.mock("@/app/documents/document-status-mutation-capability", () => ({
  documentStatusMutationPermissionsForAuth: () => ({
    single: true,
    bulk: true,
  }),
  withDocumentStatusMutation: (document: unknown) => document,
}));

vi.mock("@/app/documents/document-status-mutation-service", () => ({
  documentStatusMutationService: { updateDocument: mockUpdateDocument },
}));

vi.mock("@/app/documents/blocked-dependent-unblock-service", () => ({
  blockedDependentUnblockService: {
    resolveBlocksForChangedArtifacts: (...args: unknown[]) =>
      mockResolveBlocks(...args),
  },
}));

// Spread the real module: `route-utils` imports the error-cause recorder and
// the emitter's reader from here too, so a wholesale replacement would leave
// those undefined and break any path that returns an `errorResponse`.
vi.mock(
  "@/lib/observability/request-span-attribution",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    recordRequestArtifact: mockRecordRequestArtifact,
  })
);

vi.mock("../document-version-service", () => ({
  documentVersionService: { getLatest: mockGetLatest, getByVersion: vi.fn() },
}));

vi.mock("../version-route-helpers", () => ({
  parseVersionParam: vi.fn(() => ({
    ok: true,
    versionNumber: undefined,
    versionParam: null,
  })),
  resolveLatestVersionContent: vi.fn(async () => ({ content: "body" })),
}));

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactUpdate: vi.fn(),
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvent: vi.fn(),
  userAuditActor: (userId: string) => ({ actorType: "user", actorId: userId }),
}));

vi.mock("@/lib/assignment-notifications", () => ({
  dispatchAssignmentNotification: vi.fn(),
}));

// Null from both custom-field helpers is their "nothing to report" contract, so
// the route proceeds to the write and this file stays about span attribution.
vi.mock("../../custom-fields/route-helpers", () => ({
  customFieldsPreflightResponse: vi.fn(async () => null),
  mergeCustomFieldsIntoResponse: vi.fn(async (doc: unknown) => doc),
}));

import { GET, PUT } from "./route";

/**
 * The row is an IMPLEMENTATION_PLAN, but the request path is `/documents/ISS-9`
 * — an `ISS-` slug, which is the Feature/Issue prefix. A path- or slug-derived
 * implementation reads FEATURE here; the row reads IMPLEMENTATION_PLAN.
 */
const ARTIFACT_ID = "ISS-9";
const REQUEST_URL = `http://localhost/documents/${ARTIFACT_ID}`;
const PERSISTED = {
  id: "a1",
  slug: ARTIFACT_ID,
  type: DocumentType.ImplementationPlan,
  status: DocumentStatus.Approved,
  assigneeId: null,
  approverId: null,
  priority: "MEDIUM",
  title: "Plan",
  dueDate: null,
  projectId: "p1",
};

function ctx() {
  return { params: Promise.resolve({ id: ARTIFACT_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mockFindById.mockResolvedValue(PERSISTED);
  mockUpdateDocument.mockResolvedValue(
    Result.ok({ document: PERSISTED, previous: PERSISTED })
  );
  mockResolveBlocks.mockResolvedValue({ resolvedIds: [], unblockedIds: [] });
  mockGetLatest.mockResolvedValue({ version: 1 });
});

describe("GET /documents/[id] artifact span attribution", () => {
  it("stamps the subtype and status from the loaded row, not the request path", async () => {
    const response = await GET(new NextRequest(REQUEST_URL), ctx());

    expect(response.status).toBe(200);
    expect(mockRecordRequestArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        type: DocumentType.ImplementationPlan,
        status: DocumentStatus.Approved,
      })
    );
    // The `ISS-` slug in the path is the plausible wrong answer.
    expect(mockRecordRequestArtifact).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: DocumentType.Feature })
    );
  });

  it("stamps nothing when the artifact does not exist", async () => {
    mockFindById.mockResolvedValue(null);

    const response = await GET(new NextRequest(REQUEST_URL), ctx());

    expect(response.status).toBe(404);
    // Absent stays absent: there is no artifact to attribute a 404 to.
    expect(mockRecordRequestArtifact).not.toHaveBeenCalled();
  });
});

describe("PUT /documents/[id] artifact span attribution", () => {
  it("stamps the post-update row rather than the value the caller sent", async () => {
    // The caller ASKS for a status the row will not end up with — a
    // body-derived implementation would record `IN_REVIEW`.
    mockUpdateDocument.mockResolvedValue(
      Result.ok({
        document: { ...PERSISTED, status: DocumentStatus.Executed },
        previous: PERSISTED,
      })
    );

    const response = await PUT(
      new NextRequest(REQUEST_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: DocumentStatus.InReview }),
      }),
      ctx()
    );

    expect(response.status).toBe(200);
    expect(mockRecordRequestArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        type: DocumentType.ImplementationPlan,
        status: DocumentStatus.Executed,
      })
    );
  });

  it("still stamps the subtype when the update itself throws", async () => {
    // The 5xx this produces is the population that most needs to be findable
    // by `artifact.type:IMPLEMENTATION_PLAN`. Stamping only after the write
    // means a Prisma failure carries an error cause and no artifact type at
    // all, so the very failures the attribute exists to group are the ones
    // missing from it.
    mockUpdateDocument.mockRejectedValue(new Error("db exploded"));

    const response = await PUT(
      new NextRequest(REQUEST_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: DocumentStatus.InReview }),
      }),
      ctx()
    );

    expect(response.status).toBe(500);
    expect(mockUpdateDocument).toHaveBeenCalled();
    // The pre-write row is a sound source for the subtype: an update never
    // changes it. Only the status can move, which is why the success path
    // overwrites this with the post-update row.
    expect(mockRecordRequestArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ type: DocumentType.ImplementationPlan })
    );
  });

  it("stamps the loaded row when the service rejects the write", async () => {
    mockUpdateDocument.mockResolvedValue(
      Result.err({
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.InvalidStatusForSubtype,
        message:
          'Status "TRIAGE" is not valid for one or more selected documents',
        details: {
          invalidStatuses: [
            {
              documentId: PERSISTED.id,
              currentStatus: DocumentStatus.Approved,
              targetStatus: IssueStatus.Triage,
              subtype: DocumentType.ImplementationPlan,
              allowedStatuses: [DocumentStatus.InReview],
            },
          ],
        },
      })
    );

    const response = await PUT(
      new NextRequest(REQUEST_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: IssueStatus.Triage }),
      }),
      ctx()
    );

    expect(response.status).toBe(400);
    expect(mockUpdateDocument).toHaveBeenCalled();
    expect(mockRecordRequestArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ type: DocumentType.ImplementationPlan })
    );
  });
});

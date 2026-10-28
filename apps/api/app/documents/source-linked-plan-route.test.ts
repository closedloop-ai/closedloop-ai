import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { Priority } from "@repo/api/src/types/common";
import {
  type CreateDocumentRequestBody,
  type Document,
  DocumentStatus,
  DocumentType,
  SnapshotSource,
  SourceLinkedPlanCreateErrorCode,
  SourceLinkedPlanOutcome,
  SourceLinkedPlanPolicy,
} from "@repo/api/src/types/document";
import { Result } from "@repo/api/src/types/result";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;
const mockCreate = vi.hoisted(() => vi.fn());
const mockCreateWithInlineImages = vi.hoisted(() => vi.fn());
const mockFindAllWithCustomFields = vi.hoisted(() => vi.fn());
const mockFindPageWithCustomFields = vi.hoisted(() => vi.fn());
const mockFindArrayWithContinuation = vi.hoisted(() => vi.fn());
const mockSourceLinkedPlanCreateOrReuse = vi.hoisted(() => vi.fn());

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactCreation: vi.fn(),
}));

vi.mock("@/app/documents/attachment-upload-feature", () => ({
  isMcpAttachmentUploadEnabled: vi.fn(),
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    create: mockCreate,
    createWithInlineImages: mockCreateWithInlineImages,
    findAllWithCustomFields: mockFindAllWithCustomFields,
  },
}));

vi.mock("@/app/documents/document-list-service", () => ({
  documentListService: {
    findArrayWithContinuation: mockFindArrayWithContinuation,
    findPageWithCustomFields: mockFindPageWithCustomFields,
  },
}));

vi.mock("@/app/documents/source-linked-plan-service", () => ({
  sourceLinkedPlanService: {
    createOrReuse: mockSourceLinkedPlanCreateOrReuse,
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    options?: unknown
  ) => {
    return (request: Request) => {
      const requiredScopes = (
        options as { requiredScopes?: ApiKeyScope[] } | undefined
      )?.requiredScopes ?? ["write"];
      if (
        mockAuthContext.authMethod === "api_key" &&
        !requiredScopes.every((scope) =>
          mockAuthContext.apiKeyScopes?.includes(scope)
        )
      ) {
        return Response.json(
          { error: "Forbidden", success: false },
          { status: 403 }
        );
      }
      return handler(mockAuthContext, request);
    };
  },
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveArtifactIdentifier: vi.fn(async (id: string) => id),
    resolveProjectId: vi.fn(async (id: string) => id),
  };
});

import { documentService } from "@/app/documents/document-service";
import { captureArtifactCreation } from "@/lib/artifact-activity-capture";
import {
  resolveArtifactIdentifier,
  resolveProjectId,
} from "@/lib/identifier-utils";
import { POST } from "./route";
import { sourceLinkedPlanService } from "./source-linked-plan-service";

/** Stands in for the plan create's transaction client. */
const PLAN_CREATE_TX = { __brand: "plan-create-tx" };

describe("POST /documents source-linked plan policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveArtifactIdentifier).mockImplementation(
      async (id: string) => id
    );
    vi.mocked(resolveProjectId).mockImplementation(async (id: string) => id);
    const createdPlan = makeImplementationPlan({
      id: "plan-1",
      latestVersion: 1,
      title: "Created plan",
    });
    mockSourceLinkedPlanCreateOrReuse.mockImplementation(
      async (..._args: unknown[]) => {
        await (
          _args[3] as
            | ((tx: unknown, created: unknown) => Promise<void>)
            | undefined
        )?.(PLAN_CREATE_TX, createdPlan);
        return Result.ok(
          makeSourceLinkedPlanSuccess({
            document: createdPlan,
            outcome: SourceLinkedPlanOutcome.Created,
            sourceId: "source-artifact-1",
          })
        );
      }
    );
  });

  it("routes opt-in source-linked plan creates through the transactional service", async () => {
    vi.mocked(resolveArtifactIdentifier).mockResolvedValueOnce(
      "source-artifact-1"
    );

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({
          content: "Plan content",
          projectId: "PRO-44",
          sourceId: "PRD-12",
          sourceLinkedPlanPolicy: SourceLinkedPlanPolicy.ReuseOrCreate,
          status: DocumentStatus.Draft,
          title: "Created plan",
          type: DocumentType.ImplementationPlan,
        }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      data: {
        id: "plan-1",
        latestVersion: 1,
        sourceLinkedPlanResult: {
          currentPlanVersion: 1,
          outcome: SourceLinkedPlanOutcome.Created,
          planId: "plan-1",
          policy: SourceLinkedPlanPolicy.ReuseOrCreate,
          sourceId: "source-artifact-1",
        },
        title: "Created plan",
      },
      success: true,
    });
    expect(resolveProjectId).not.toHaveBeenCalled();
    expect(sourceLinkedPlanService.createOrReuse).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      expect.objectContaining({
        content: "Plan content",
        projectId: "PRO-44",
        sourceId: "source-artifact-1",
        sourceLinkedPlanPolicy: SourceLinkedPlanPolicy.ReuseOrCreate,
        type: DocumentType.ImplementationPlan,
      }),
      expect.any(Function),
      undefined
    );
    expect(documentService.create).not.toHaveBeenCalled();
    expect(documentService.createWithInlineImages).not.toHaveBeenCalled();
    // ISS-10993: the route no longer records the receipt itself — it hands the
    // service a callback the service runs on the create's OWN transaction. The
    // mock above invokes it, so this still pins the route's wiring.
    expect(captureArtifactCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "plan-1",
        organizationId: mockAuthContext.user.organizationId,
        tx: PLAN_CREATE_TX,
      })
    );
  });

  it("does not emit creation activity when opt-in reuses an existing plan", async () => {
    vi.mocked(resolveArtifactIdentifier).mockResolvedValueOnce(
      "source-artifact-1"
    );
    mockSourceLinkedPlanCreateOrReuse.mockResolvedValueOnce(
      Result.ok(
        makeSourceLinkedPlanSuccess({
          document: makeImplementationPlan({
            id: "plan-existing",
            latestVersion: 3,
            title: "Existing plan",
          }),
          outcome: SourceLinkedPlanOutcome.ReusedExisting,
          sourceId: "source-artifact-1",
        })
      )
    );

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({
          projectId: "PRO-44",
          sourceId: "PRD-12",
          sourceLinkedPlanPolicy: SourceLinkedPlanPolicy.ReuseOrCreate,
          status: DocumentStatus.Draft,
          type: DocumentType.ImplementationPlan,
        }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      data: {
        id: "plan-existing",
        sourceLinkedPlanResult: {
          currentPlanVersion: 3,
          outcome: SourceLinkedPlanOutcome.ReusedExisting,
          planId: "plan-existing",
        },
      },
      success: true,
    });
    expect(captureArtifactCreation).not.toHaveBeenCalled();
  });

  it("returns an ambiguity receipt when opt-in finds multiple linked plans", async () => {
    mockSourceLinkedPlanCreateOrReuse.mockResolvedValueOnce(
      Result.err({
        code: SourceLinkedPlanCreateErrorCode.Ambiguous,
        plans: [
          {
            currentVersion: 1,
            id: "plan-a",
            slug: "PLN-1",
            title: "Plan A",
          },
          {
            currentVersion: 2,
            id: "plan-b",
            slug: "PLN-2",
            title: "Plan B",
          },
        ],
      })
    );

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({
          projectId: "PRO-44",
          sourceId: "PRD-12",
          sourceLinkedPlanPolicy: SourceLinkedPlanPolicy.ReuseOrCreate,
          status: DocumentStatus.Draft,
          type: DocumentType.ImplementationPlan,
        }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: SourceLinkedPlanCreateErrorCode.Ambiguous,
      error:
        "Multiple linked implementation plans already exist for this source",
      plans: [
        {
          currentVersion: 1,
          id: "plan-a",
          slug: "PLN-1",
          title: "Plan A",
        },
        {
          currentVersion: 2,
          id: "plan-b",
          slug: "PLN-2",
          title: "Plan B",
        },
      ],
      success: false,
    });
    expect(captureArtifactCreation).not.toHaveBeenCalled();
  });

  it("does not enter the opt-in transaction when the source identifier is not visible", async () => {
    vi.mocked(resolveArtifactIdentifier).mockResolvedValueOnce(null);

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({
          projectId: "PRO-44",
          sourceId: "PRD-12",
          sourceLinkedPlanPolicy: SourceLinkedPlanPolicy.ReuseOrCreate,
          status: DocumentStatus.Draft,
          type: DocumentType.ImplementationPlan,
        }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(404);
    expect(sourceLinkedPlanService.createOrReuse).not.toHaveBeenCalled();
    expect(captureArtifactCreation).not.toHaveBeenCalled();
  });
});

function postDocuments(request: NextRequest) {
  return POST(request, createMockRouteContext({}));
}

function makeCreateBody(
  overrides: Partial<CreateDocumentRequestBody> = {}
): CreateDocumentRequestBody {
  return {
    content: "Plain content",
    projectId: "PRO-44",
    title: "Created document",
    type: DocumentType.Feature,
    ...overrides,
  };
}

function makeImplementationPlan(overrides: Partial<Document> = {}): Document {
  return {
    approver: null,
    approverId: null,
    assignee: null,
    assigneeId: null,
    createdAt: new Date("2026-07-20T12:00:00.000Z"),
    createdBy: null,
    createdById: "test-user-id",
    fileName: null,
    id: "plan-1",
    latestVersion: 1,
    organizationId: "test-org-id",
    priority: Priority.Medium,
    projectId: "PRO-44",
    repositorySnapshot: {
      createdAt: "2026-07-20T12:00:00.000Z",
      repositories: [],
      source: SnapshotSource.None,
    },
    slug: "PLN-1",
    sortOrder: null,
    status: DocumentStatus.Draft,
    templateForType: null,
    title: "Created plan",
    type: DocumentType.ImplementationPlan,
    updatedAt: new Date("2026-07-20T12:00:00.000Z"),
    ...overrides,
  };
}

function makeSourceLinkedPlanSuccess(input: {
  document: Document;
  outcome: SourceLinkedPlanOutcome;
  sourceId: string;
}) {
  return {
    document: input.document,
    sourceLinkedPlanResult: {
      currentPlanVersion: input.document.latestVersion,
      outcome: input.outcome,
      planId: input.document.id,
      policy: SourceLinkedPlanPolicy.ReuseOrCreate,
      sourceId: input.sourceId,
    },
  };
}

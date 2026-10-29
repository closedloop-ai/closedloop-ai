import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  AttachmentPurpose,
  AttachmentUploadResponseErrorCode,
  CreateInlineImageAttachmentErrorCode,
  INLINE_ATTACHMENT_REF_PREFIX,
} from "@repo/api/src/types/attachment";
import { Priority } from "@repo/api/src/types/common";
import {
  CreateDocumentErrorCode,
  type CreateDocumentInlineImageInput,
  type CreateDocumentRequestBody,
  DOCUMENT_LIST_MAX_OFFSET,
  DOCUMENT_LIST_MAX_RECENCY_DAYS,
  type Document,
  DocumentListRecency,
  DocumentType,
  IssueStatus,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { Result } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
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
const mockWithAnyAuthOptions = vi.hoisted(() => [] as unknown[]);

// ISS-8643: the real `captureArtifactCreation` schedules an UN-AWAITED
// `waitUntil(recordChanges(...))` that opens a pg pool against the unit lane's
// placeholder DATABASE_URL. That work outlives the test body, so its pool
// telemetry / failure logging lands while no test task is active — and when it
// lands during worker teardown vitest fails the whole run on
// `Closing rpc while "onUserConsoleLog" was pending`, with zero failed
// assertions. The seam's own wiring is pinned by
// `create-artifact-activity-capture.test.ts`; here it is replaced purely for
// isolation.
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
    findPageWithCustomFields: mockFindPageWithCustomFields,
    findArrayWithContinuation: mockFindArrayWithContinuation,
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
    mockWithAnyAuthOptions.push(options);
    return (request: Request) => {
      const requiredScopes = (
        options as { requiredScopes?: ApiKeyScope[] } | undefined
      )?.requiredScopes ?? [getDefaultScopeForMethod(request.method)];
      if (
        mockAuthContext.authMethod === "api_key" &&
        !requiredScopes.every((scope) =>
          mockAuthContext.apiKeyScopes?.includes(scope)
        )
      ) {
        return Response.json(
          { success: false, error: "Forbidden" },
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

import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import { documentService } from "@/app/documents/document-service";
import {
  resolveArtifactIdentifier,
  resolveProjectId,
} from "@/lib/identifier-utils";
import { GET, POST } from "./route";

const ASSIGNEE_ID = "11111111-1111-4111-8111-111111111111";

describe("GET /documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveProjectId).mockImplementation(async (id: string) => id);
    mockFindAllWithCustomFields.mockResolvedValue([]);
    // ISS-6941 moved the bare-array arm behind `findArrayWithContinuation`,
    // which in the real service delegates to `documentService
    // .findAllWithCustomFields` and adds the continuation. The default
    // implementation here delegates the same way, so every case that asserts
    // the FILTER reaching the document service keeps asserting exactly that;
    // cases about the continuation override the return value instead.
    mockFindArrayWithContinuation.mockImplementation(
      async (options: unknown) => {
        const items = await mockFindAllWithCustomFields(options);
        return {
          items,
          continuation: {
            total: items.length,
            offset: 0,
            pageCount: items.length,
            hasMore: false,
          },
        };
      }
    );
  });

  it("keeps every subtype on the paged combined document read", async () => {
    const types = [
      DocumentType.Prd,
      DocumentType.ImplementationPlan,
      DocumentType.Doc,
    ];
    const query = types.map((type) => `types=${type}`).join("&");
    const response = await getDocuments(
      `http://localhost:3002/documents?${query}&limit=25&includeTotal=true`
    );
    expect(response.status).toBe(200);
    expect(mockFindPageWithCustomFields).toHaveBeenCalledWith(
      expect.objectContaining({ types })
    );
  });

  it("passes the org-level project-less DOC filter through to the service (FEA-4140)", async () => {
    // The org Documents index requests `?type=DOC&unassignedProject=true`; the
    // route must forward that filter unmodified and never resolve a project id
    // (no projectId was supplied), so the service scopes to project-less DOC
    // docs for this org.
    const response = await getDocuments(
      "http://localhost:3002/documents?type=DOC&unassignedProject=true"
    );

    expect(response.status).toBe(200);
    expect(resolveProjectId).not.toHaveBeenCalled();
    expect(documentService.findAllWithCustomFields).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      projectId: undefined,
      type: DocumentType.Doc,
      unassignedProject: true,
    });
  });

  it("rejects an unsupported unassignedProject value with 400 (FEA-4140)", async () => {
    const response = await getDocuments(
      "http://localhost:3002/documents?unassignedProject=1"
    );

    expect(response.status).toBe(400);
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });

  it("forwards the bounded limit/offset page params to the service (FEA-4373)", async () => {
    const response = await getDocuments(
      "http://localhost:3002/documents?assigneeId=11111111-1111-4111-8111-111111111111&limit=200&offset=50"
    );

    expect(response.status).toBe(200);
    expect(documentService.findAllWithCustomFields).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: mockAuthContext.user.organizationId,
        limit: 200,
        offset: 50,
      })
    );
  });

  it("rejects a limit above the hard ceiling with 400 (FEA-4373)", async () => {
    // A caller cannot widen the page past DOCUMENT_LIST_MAX_LIMIT (500); the
    // validator rejects it rather than silently accepting an unbounded read.
    const response = await getDocuments(
      "http://localhost:3002/documents?limit=100000"
    );

    expect(response.status).toBe(400);
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });

  it("rejects offset without limit with 400 (FEA-4373)", async () => {
    // The service can only page a bounded query, so offset-only would silently
    // drop both and return the full result from the start — the opposite of the
    // request. The validator rejects it instead of doing the wrong thing.
    const response = await getDocuments(
      "http://localhost:3002/documents?offset=100"
    );

    expect(response.status).toBe(400);
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });

  it("forwards a repeated status set to the service as an array (ISS-6778)", async () => {
    // The wiring assertion: the parameter has to survive the route's two
    // destructurings and reach the options the predicate is built from, or the
    // predicate below it is unreachable in production.
    const response = await getDocuments(
      `http://localhost:3002/documents?status=${IssueStatus.Todo}&status=${IssueStatus.InProgress}`
    );

    expect(response.status).toBe(200);
    expect(documentService.findAllWithCustomFields).toHaveBeenCalledWith(
      expect.objectContaining({
        status: [IssueStatus.Todo, IssueStatus.InProgress],
      })
    );
  });

  it("rejects a comma-joined status set with 400 (ISS-6778)", async () => {
    // The repeated form is the only accepted spelling. A caller arriving with
    // `/search`-shaped habits inverted gets a 400 naming the value, not a
    // silently unnarrowed list.
    const response = await getDocuments(
      `http://localhost:3002/documents?status=${IssueStatus.Todo},${IssueStatus.InProgress}`
    );

    expect(response.status).toBe(400);
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });

  it("rejects a blank status occurrence with 400 rather than ignoring it (ISS-6778)", async () => {
    const response = await getDocuments(
      "http://localhost:3002/documents?status="
    );

    expect(response.status).toBe(400);
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });

  it("omits status entirely from the service options when it is not requested (ISS-6778)", async () => {
    const response = await getDocuments("http://localhost:3002/documents");

    expect(response.status).toBe(200);
    expect(
      vi.mocked(documentService.findAllWithCustomFields).mock.calls[0]?.[0]
    ).not.toHaveProperty("status");
  });

  it("parses EVERY repeated status value rather than keeping only the last (ISS-6778)", async () => {
    // The route builds its validation input from `searchParams`; a shape that
    // keeps one occurrence per key silently answers `?status=TODO&status=DONE`
    // with DONE alone — the caller asked to see TODO and never learns it was
    // dropped. That is the same silent no-op the empty-element rejection exists
    // to prevent, so it is pinned at the route boundary, not only in the
    // validator.
    const response = await getDocuments(
      `http://localhost:3002/documents?status=${IssueStatus.Todo}&status=${IssueStatus.Done}`
    );

    expect(response.status).toBe(200);
    expect(documentService.findAllWithCustomFields).toHaveBeenCalledWith(
      expect.objectContaining({
        status: [IssueStatus.Todo, IssueStatus.Done],
      })
    );
  });

  it("rejects an unknown status with 400 rather than returning the whole list (ISS-6778)", async () => {
    const response = await getDocuments(
      "http://localhost:3002/documents?status=NOT_A_STATUS"
    );

    expect(response.status).toBe(400);
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });

  it("rejects unsupported query params instead of silently dropping them (ISS-4505)", async () => {
    const response = await getDocuments(
      "http://localhost:3002/documents?unknownFilter=value"
    );

    expect(response.status).toBe(400);
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });

  it("returns the bare array (unchanged default contract) when includeTotal is absent (ISS-4576)", async () => {
    const response = await getDocuments("http://localhost:3002/documents");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(mockFindPageWithCustomFields).not.toHaveBeenCalled();
  });

  it("returns the paged envelope with a real total when includeTotal=true (ISS-4576)", async () => {
    mockFindPageWithCustomFields.mockResolvedValue({
      items: [],
      total: 1204,
      limit: 50,
      offset: 0,
      hasMore: true,
    });

    const response = await getDocuments(
      "http://localhost:3002/documents?assigneeId=11111111-1111-4111-8111-111111111111&limit=50&offset=0&includeTotal=true"
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ total: 1204, hasMore: true });
    // The paged read owns this branch; the array read must not also run.
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
    expect(mockFindPageWithCustomFields).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: mockAuthContext.user.organizationId,
        assigneeId: "11111111-1111-4111-8111-111111111111",
        limit: 50,
        offset: 0,
      })
    );
  });

  it("serves a paged read past DOCUMENT_LIST_MAX_OFFSET instead of 400ing it (ISS-11161)", async () => {
    // The MCP tool's deep page: before ISS-11161 this 400'd and the tool fell
    // back to reading the whole corpus.
    const offset = DOCUMENT_LIST_MAX_OFFSET + 50;
    mockFindPageWithCustomFields.mockResolvedValue({
      items: [],
      total: offset + 500,
      limit: 100,
      offset,
      hasMore: true,
    });

    const response = await getDocuments(
      `http://localhost:3002/documents?limit=100&offset=${offset}&includeTotal=true`
    );

    expect(response.status).toBe(200);
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
    expect(mockFindPageWithCustomFields).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, offset })
    );
  });

  it("does not forward includeTotal into the service filter set (ISS-4576)", async () => {
    mockFindPageWithCustomFields.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    });

    // `includeTotal` requires a `limit` (the paged envelope is only meaningful
    // for a bounded page), so supply one; the assertion below is that the flag
    // itself never reaches the service.
    await getDocuments(
      "http://localhost:3002/documents?limit=50&includeTotal=true"
    );

    // It selects the response SHAPE; it is not a query predicate, so leaking it
    // into the service options would look like an unimplemented filter.
    expect(mockFindPageWithCustomFields).toHaveBeenCalledWith(
      expect.not.objectContaining({ includeTotal: expect.anything() })
    );
  });

  it("rejects an unsupported includeTotal value with 400 rather than defaulting it (ISS-4576)", async () => {
    const response = await getDocuments(
      "http://localhost:3002/documents?includeTotal=1"
    );

    expect(response.status).toBe(400);
    expect(mockFindPageWithCustomFields).not.toHaveBeenCalled();
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });

  it("rejects includeTotal=true without a limit with 400 rather than materializing the full set (ISS-4576, davetho)", async () => {
    // Requesting the total over an UNBOUNDED read would run a full findMany plus
    // a full count over the same predicate — the unbounded workload this paged
    // path exists to avoid, and a self-DoS on a large org. The boundary must
    // reject it before any read runs.
    const response = await getDocuments(
      "http://localhost:3002/documents?assigneeId=11111111-1111-4111-8111-111111111111&includeTotal=true"
    );

    expect(response.status).toBe(400);
    expect(mockFindPageWithCustomFields).not.toHaveBeenCalled();
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });

  it("keeps the bare-array contract for an explicit includeTotal=false (ISS-4576)", async () => {
    const response = await getDocuments(
      "http://localhost:3002/documents?includeTotal=false"
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(mockFindPageWithCustomFields).not.toHaveBeenCalled();
  });

  it("forwards an explicit recency window to the service (FEA-1626)", async () => {
    const response = await getDocuments(
      `http://localhost:3002/documents?assigneeId=${ASSIGNEE_ID}&limit=50&recencyDays=30`
    );

    expect(response.status).toBe(200);
    expect(documentService.findAllWithCustomFields).toHaveBeenCalledWith(
      expect.objectContaining({ recencyDays: 30 })
    );
  });

  it("forwards the all-history opt-out as the sentinel, not as a number (FEA-1626)", async () => {
    // This is how the frontend asks for older data. `all` must survive the
    // boundary intact: coerced to a number it would become NaN and the window
    // would silently stay on.
    const response = await getDocuments(
      `http://localhost:3002/documents?assigneeId=${ASSIGNEE_ID}&limit=50&recencyDays=all`
    );

    expect(response.status).toBe(200);
    expect(documentService.findAllWithCustomFields).toHaveBeenCalledWith(
      expect.objectContaining({ recencyDays: DocumentListRecency.All })
    );
  });

  it("forwards the archived-project opt-in as a boolean (FEA-1626)", async () => {
    const response = await getDocuments(
      `http://localhost:3002/documents?assigneeId=${ASSIGNEE_ID}&limit=50&includeArchivedProjects=true`
    );

    expect(response.status).toBe(200);
    expect(documentService.findAllWithCustomFields).toHaveBeenCalledWith(
      expect.objectContaining({ includeArchivedProjects: true })
    );
  });

  it("rejects an out-of-range recency window with 400 rather than clamping it silently (FEA-1626)", async () => {
    const tooSmall = await getDocuments(
      `http://localhost:3002/documents?assigneeId=${ASSIGNEE_ID}&limit=50&recencyDays=0`
    );
    expect(tooSmall.status).toBe(400);

    const tooLarge = await getDocuments(
      `http://localhost:3002/documents?assigneeId=${ASSIGNEE_ID}&limit=50&recencyDays=${DOCUMENT_LIST_MAX_RECENCY_DAYS + 1}`
    );
    expect(tooLarge.status).toBe(400);
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric recency window other than the all sentinel with 400 (FEA-1626)", async () => {
    const response = await getDocuments(
      `http://localhost:3002/documents?assigneeId=${ASSIGNEE_ID}&limit=50&recencyDays=recent`
    );

    expect(response.status).toBe(400);
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });

  it("rejects an unsupported date filter the route cannot honor rather than dropping it (FEA-1626)", async () => {
    // `updatedBefore` is a plausible neighbouring recency dimension that no
    // downstream predicate implements. Accepting and ignoring it would hand the
    // caller a result set that silently disagrees with the filter they asked
    // for, so the strict boundary must 400 instead.
    const response = await getDocuments(
      `http://localhost:3002/documents?assigneeId=${ASSIGNEE_ID}&limit=50&updatedBefore=2026-01-01`
    );

    expect(response.status).toBe(400);
    expect(documentService.findAllWithCustomFields).not.toHaveBeenCalled();
  });
});

describe("POST /documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(isMcpAttachmentUploadEnabled).mockResolvedValue(false);
    vi.mocked(resolveProjectId).mockImplementation(async (id: string) => id);
    vi.mocked(resolveArtifactIdentifier).mockImplementation(
      async (id: string) => id
    );
    mockCreate.mockResolvedValue(makeDocument());
    mockCreateWithInlineImages.mockResolvedValue(
      Result.ok({
        document: makeDocument(),
        inlineImages: [makeCreatedInlineImage()],
        versionContent: `Content ![Diagram](${INLINE_ATTACHMENT_REF_PREFIX}attachment-1)`,
      })
    );
  });

  it("keeps the content-only create path and does not check the MCP upload flag", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["write"],
      authMethod: "api_key",
    });

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({ content: "Plain content" }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      data: {
        id: "doc-1",
        title: "Created document",
      },
      success: true,
    });
    expect(JSON.stringify(json)).not.toContain("inlineImages");
    expect(json.data.sourceLinkedPlanResult).toBeUndefined();
    expect(isMcpAttachmentUploadEnabled).not.toHaveBeenCalled();
    expect(documentService.create).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      {
        content: "Plain content",
        projectId: "PRO-44",
        sourceId: undefined,
        title: "Created document",
        type: DocumentType.Feature,
      },
      expect.any(Function)
    );
    expect(documentService.createWithInlineImages).not.toHaveBeenCalled();
  });

  it("creates a project-less org-level DOC: skips resolveProjectId and reaches create with projectId omitted (FEA-4345)", async () => {
    // The org-level "New Document" flow POSTs a DOC with no projectId. The route
    // must not resolve a project (there is none) and must hand the service an
    // undefined projectId so a project-less (org-level) DOC is created. This
    // guards the branch the validator/service unit tests can't see: if the route
    // regressed to resolving an absent project again, this fails.
    const response = await postDocuments(
      createMockRequest({
        body: {
          content: "",
          title: "Team Handbook",
          type: DocumentType.Doc,
        },
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(200);
    expect(resolveProjectId).not.toHaveBeenCalled();
    expect(documentService.create).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      {
        content: "",
        projectId: undefined,
        sourceId: undefined,
        title: "Team Handbook",
        type: DocumentType.Doc,
      },
      expect.any(Function)
    );
    expect(documentService.createWithInlineImages).not.toHaveBeenCalled();
  });

  it("keeps over-cap content-only creates on the legacy path when inlineImages is omitted", async () => {
    const content = "x".repeat(
      MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES + 1000
    );

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({ content }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(200);
    expect(isMcpAttachmentUploadEnabled).not.toHaveBeenCalled();
    expect(documentService.create).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      expect.objectContaining({ content }),
      expect.any(Function)
    );
    expect(documentService.createWithInlineImages).not.toHaveBeenCalled();
  });

  it("keeps over-cap content-only creates on the legacy path when inlineImages is empty", async () => {
    const content = "x".repeat(
      MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES + 1000
    );

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({ content, inlineImages: [] }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(200);
    expect(isMcpAttachmentUploadEnabled).not.toHaveBeenCalled();
    expect(documentService.create).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      expect.objectContaining({ content }),
      expect.any(Function)
    );
    expect(documentService.createWithInlineImages).not.toHaveBeenCalled();
  });

  it("creates inline images for write-scoped API keys when the MCP upload flag is enabled", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["write"],
      authMethod: "api_key",
    });
    vi.mocked(isMcpAttachmentUploadEnabled).mockResolvedValue(true);

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({
          content: "Content [[diagram]]",
          inlineImages: [makeInlineImageInput()],
        }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      data: {
        inlineImages: [
          {
            attachmentId: "attachment-1",
            markdownImage: `![Diagram](${INLINE_ATTACHMENT_REF_PREFIX}attachment-1)`,
            placeholder: "[[diagram]]",
          },
        ],
        versionContent: `Content ![Diagram](${INLINE_ATTACHMENT_REF_PREFIX}attachment-1)`,
      },
      success: true,
    });
    expect(JSON.stringify(json)).not.toContain("aW1hZ2U=");
    expect(JSON.stringify(json)).not.toContain('"attachment"');
    expect(JSON.stringify(json)).not.toContain("sizeBytes");
    expect(JSON.stringify(json)).not.toContain("storageKey");
    expect(isMcpAttachmentUploadEnabled).toHaveBeenCalledWith({
      clerkUserId: mockAuthContext.clerkUserId,
      userId: mockAuthContext.user.id,
    });
    expect(documentService.createWithInlineImages).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      {
        content: "Content [[diagram]]",
        projectId: "PRO-44",
        sourceId: undefined,
        title: "Created document",
        type: DocumentType.Feature,
      },
      [makeInlineImageInput()],
      expect.any(Function)
    );
    expect(documentService.create).not.toHaveBeenCalled();
  });

  it("fails API-key inline image creates closed when the MCP upload flag is disabled", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["write"],
      authMethod: "api_key",
    });

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({
          content: "Content [[diagram]]",
          inlineImages: [makeInlineImageInput()],
        }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json).toMatchObject({
      code: AttachmentUploadResponseErrorCode.McpUploadDisabled,
      success: false,
    });
    expect(documentService.create).not.toHaveBeenCalled();
    expect(documentService.createWithInlineImages).not.toHaveBeenCalled();
  });

  it("returns 413 when an inline image create body exceeds the route cap", async () => {
    const content = `${"x".repeat(
      MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES
    )} [[diagram]]`;
    const request = createMockRequest({
      body: makeCreateBody({
        content,
        inlineImages: [makeInlineImageInput()],
      }),
      method: "POST",
      url: "http://localhost:3002/documents",
    });
    const textSpy = vi.spyOn(request, "text");

    const response = await postDocuments(request);

    expect(textSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(413);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateDocumentErrorCode.RequestBodyTooLarge,
      details: {
        maxBytes: MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES,
      },
      success: false,
    });
    expect(documentService.create).not.toHaveBeenCalled();
    expect(documentService.createWithInlineImages).not.toHaveBeenCalled();
  });

  it("returns 413 when an escaped inlineImages key appears after over-cap content", async () => {
    const content = `${"x".repeat(
      MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES
    )} [[diagram]]`;
    const request = createRawJsonRequest(
      makeEscapedInlineImagesCreateBody(content)
    );
    const textSpy = vi.spyOn(request, "text");

    const response = await postDocuments(request);

    expect(textSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(413);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateDocumentErrorCode.RequestBodyTooLarge,
      details: {
        maxBytes: MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES,
      },
      success: false,
    });
    expect(documentService.create).not.toHaveBeenCalled();
    expect(documentService.createWithInlineImages).not.toHaveBeenCalled();
  });

  it("maps inline image service failures through the attachment error contract", async () => {
    mockCreateWithInlineImages.mockResolvedValue(
      Result.err({
        code: CreateDocumentErrorCode.InlineImageCreationFailed,
        inlineImageError: {
          code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
        },
        placeholder: "[[diagram]]",
      })
    );

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({
          content: "Content [[diagram]]",
          inlineImages: [makeInlineImageInput()],
        }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
      success: false,
    });
  });

  it("preserves create cleanup details when mapping inline image attachment failures", async () => {
    mockCreateWithInlineImages.mockResolvedValue(
      Result.err({
        cleanupFailed: true,
        cleanupFailedCount: 1,
        code: CreateDocumentErrorCode.InlineImageCreationFailed,
        documentCleanupFailed: false,
        documentCleanupSkipped: true,
        inlineImageError: {
          code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
        },
        placeholder: "[[diagram]]",
      })
    );

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({
          content: "Content [[diagram]]",
          inlineImages: [makeInlineImageInput()],
        }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
      details: {
        cleanupFailed: true,
        cleanupFailedCount: 1,
        documentCleanupFailed: false,
        documentCleanupSkipped: true,
        placeholder: "[[diagram]]",
      },
      success: false,
    });
  });

  it("rejects read-only API keys before project or source resolution", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["read"],
      authMethod: "api_key",
    });

    const response = await postDocuments(
      createMockRequest({
        body: makeCreateBody({ content: "Plain content" }),
        method: "POST",
        url: "http://localhost:3002/documents",
      })
    );

    expect(response.status).toBe(403);
    expect(resolveProjectId).not.toHaveBeenCalled();
    expect(resolveArtifactIdentifier).not.toHaveBeenCalled();
    expect(documentService.create).not.toHaveBeenCalled();
  });

  it("keeps the write-scope override for API-key POST callers", () => {
    expect(mockWithAnyAuthOptions).toContainEqual({
      requiredScopes: ["write"],
    });
  });
});

function postDocuments(request: NextRequest) {
  return POST(request, createMockRouteContext({}));
}

function getDocuments(url: string) {
  return GET(
    new NextRequest(url, { method: "GET" }),
    createMockRouteContext({})
  );
}

function createRawJsonRequest(body: string): NextRequest {
  return new NextRequest("http://localhost:3002/documents", {
    body,
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

function getDefaultScopeForMethod(method: string): ApiKeyScope {
  switch (method) {
    case "DELETE":
      return "delete";
    case "GET":
      return "read";
    case "POST":
    case "PUT":
    case "PATCH":
      return "write";
    default:
      return "read";
  }
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

function makeEscapedInlineImagesCreateBody(content: string): string {
  return `{"content":${JSON.stringify(content)},"projectId":"PRO-44","title":"Created document","type":"${DocumentType.Feature}","inline\\u0049mages":[${JSON.stringify(makeInlineImageInput())}]}`;
}

function makeInlineImageInput(
  placeholder = "[[diagram]]"
): CreateDocumentInlineImageInput {
  return {
    altText: "Diagram",
    dataBase64: "aW1hZ2U=",
    filename: "diagram.png",
    mimeType: "image/png",
    placeholder,
  };
}

function makeCreatedInlineImage() {
  return {
    attachment: {
      artifactId: "doc-1",
      createdAt: "2026-07-20T12:00:00.000Z",
      createdById: "test-user-id",
      filename: "diagram.png",
      id: "attachment-1",
      mimeType: "image/png",
      purpose: AttachmentPurpose.Inline,
      sizeBytes: 16,
    },
    attachmentId: "attachment-1",
    attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}attachment-1`,
    markdownImage: `![Diagram](${INLINE_ATTACHMENT_REF_PREFIX}attachment-1)`,
    placeholder: "[[diagram]]",
  };
}

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    approver: null,
    approverId: null,
    assignee: null,
    assigneeId: null,
    createdAt: new Date("2026-07-20T12:00:00.000Z"),
    createdBy: null,
    createdById: "test-user-id",
    fileName: null,
    id: "doc-1",
    latestVersion: 1,
    organizationId: "test-org-id",
    priority: Priority.Medium,
    projectId: "PRO-44",
    repositorySnapshot: {
      createdAt: "2026-07-20T12:00:00.000Z",
      repositories: [],
      source: SnapshotSource.None,
    },
    slug: "FEA-3539",
    sortOrder: null,
    status: IssueStatus.Backlog,
    templateForType: null,
    title: "Created document",
    type: DocumentType.Feature,
    updatedAt: new Date("2026-07-20T12:00:00.000Z"),
    ...overrides,
  };
}

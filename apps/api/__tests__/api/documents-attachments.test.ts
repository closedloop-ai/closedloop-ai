import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  AttachmentPurpose,
  AttachmentPurposeSelector,
} from "@repo/api/src/types/attachment";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE,
  GET as GetDownloadUrl,
} from "@/app/documents/[id]/attachments/[attachmentId]/route";
import { POST as ResolveInlineImages } from "@/app/documents/[id]/attachments/resolve/route";
import {
  GET as GetAttachments,
  POST,
} from "@/app/documents/[id]/attachments/route";
import { MAX_FILE_SIZE_BYTES } from "@/app/documents/[id]/attachments/validators";
import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import {
  attachmentsService,
  DeleteAttachmentErrorCode,
} from "@/app/documents/attachments-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;
const mockWithAnyAuthOptions = vi.hoisted(() => [] as unknown[]);

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any, options?: unknown) => {
    mockWithAnyAuthOptions.push(options);
    return (request: any, context: any) => {
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
      return handler(mockAuthContext, request, context.params);
    };
  },
}));
vi.mock("@/lib/identifier-utils", () => ({
  resolveDocumentId: vi.fn(async (id: string) => id),
}));
vi.mock("@/app/documents/attachment-upload-feature", () => ({
  isMcpAttachmentUploadEnabled: vi.fn(),
}));
vi.mock("@/app/documents/attachments-service", () => ({
  AttachmentUploadError: { RateLimited: "rate_limited" },
  DeleteAttachmentErrorCode: {
    AttachmentNotFound: "attachment_not_found",
    DocumentNotFound: "document_not_found",
    NotOwned: "not_owned",
  },
  ATTACHMENT_NOT_FOUND_ERROR: "Attachment not found",
  DOCUMENT_NOT_FOUND_ERROR: "Document not found",
  INVALID_INLINE_ATTACHMENT_UPLOAD_ERROR: "Invalid inline attachment upload",
  attachmentsService: {
    deleteAttachment: vi.fn(),
    getDownloadUrl: vi.fn(),
    listByDocument: vi.fn(),
    requestDirectUpload: vi.fn(),
    resolveInlineImages: vi.fn(),
  },
}));
// Mock @repo/aws with factory to prevent S3Client instantiation (requires AWS_REGION at module level)
vi.mock("@repo/aws", () => ({
  deleteArtifact: vi.fn(),
  getSignedDownloadUrlWithDisposition: vi.fn(),
  getSignedUploadUrl: vi.fn(),
}));

describe("POST /api/artifacts/:id/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
    vi.mocked(isMcpAttachmentUploadEnabled).mockResolvedValue(false);
  });

  it("returns 400 when mimeType is not in the allowed list", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
      body: {
        filename: "virus.exe",
        mimeType: "application/x-msdownload",
        sizeBytes: 1024,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(attachmentsService.requestDirectUpload).not.toHaveBeenCalled();
  });

  it("returns 400 when sizeBytes exceeds MAX_FILE_SIZE_BYTES", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
      body: {
        filename: "huge-file.pdf",
        mimeType: "application/pdf",
        sizeBytes: MAX_FILE_SIZE_BYTES + 1,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(attachmentsService.requestDirectUpload).not.toHaveBeenCalled();
  });

  it("returns 404 when artifact belongs to another organization", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/other-org-artifact/attachments",
      body: {
        filename: "doc.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "other-org-artifact" })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(attachmentsService.requestDirectUpload).not.toHaveBeenCalled();
  });

  it("returns 200 with upload URL on success", async () => {
    const mockResult = {
      attachmentId: "attachment-1",
      expiresAt: "2026-01-01T00:15:00.000Z",
      uploadUrl: "https://s3.example.com/presigned-upload",
      key: "attachments/artifact-1/cuid",
    };

    vi.mocked(attachmentsService.requestDirectUpload).mockResolvedValue(
      Result.ok(mockResult)
    );

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
      body: {
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(mockResult);
    expect(attachmentsService.requestDirectUpload).toHaveBeenCalledWith(
      "artifact-1",
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      "report.pdf",
      "application/pdf",
      2048,
      AttachmentPurpose.Context
    );
  });

  it("passes inline purpose through for image uploads", async () => {
    const mockResult = {
      attachmentId: "attachment-1",
      expiresAt: "2026-01-01T00:15:00.000Z",
      uploadUrl: "https://s3.example.com/presigned-upload",
      key: "attachments/artifact-1/cuid",
    };

    vi.mocked(attachmentsService.requestDirectUpload).mockResolvedValue(
      Result.ok(mockResult)
    );

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
      body: {
        filename: "diagram.png",
        mimeType: "image/png",
        purpose: AttachmentPurpose.Inline,
        sizeBytes: 2048,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(200);
    expect(attachmentsService.requestDirectUpload).toHaveBeenCalledWith(
      "artifact-1",
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      "diagram.png",
      "image/png",
      2048,
      AttachmentPurpose.Inline
    );
  });

  it("returns 400 for inline uploads with non-image MIME types", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
      body: {
        filename: "report.pdf",
        mimeType: "application/pdf",
        purpose: AttachmentPurpose.Inline,
        sizeBytes: 2048,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(400);
    expect(attachmentsService.requestDirectUpload).not.toHaveBeenCalled();
  });

  it("returns not found for unresolved API-key documents before default-off feature flag handling", async () => {
    mockAuthContext = createTestAuthContext({
      authMethod: "api_key",
      apiKeyScopes: ["write"],
    });
    vi.mocked(resolveDocumentId).mockResolvedValue(null);

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/missing-document/attachments",
      body: {
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "missing-document" })
    );

    expect(response.status).toBe(404);
    expect(isMcpAttachmentUploadEnabled).not.toHaveBeenCalled();
    expect(attachmentsService.requestDirectUpload).not.toHaveBeenCalled();
  });

  it("allows write-scoped API-key callers only when the MCP upload flag is enabled", async () => {
    mockAuthContext = createTestAuthContext({
      authMethod: "api_key",
      apiKeyScopes: ["write"],
    });
    vi.mocked(isMcpAttachmentUploadEnabled).mockResolvedValue(true);
    vi.mocked(attachmentsService.requestDirectUpload).mockResolvedValue(
      Result.ok({
        attachmentId: "attachment-1",
        expiresAt: "2026-01-01T00:15:00.000Z",
        key: "attachments/artifact-1/cuid",
        uploadUrl: "https://s3.example.com/presigned-upload",
      })
    );

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
      body: {
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(200);
    expect(isMcpAttachmentUploadEnabled).toHaveBeenCalledWith({
      clerkUserId: mockAuthContext.clerkUserId,
      userId: mockAuthContext.user.id,
    });
    expect(attachmentsService.requestDirectUpload).toHaveBeenCalledWith(
      "artifact-1",
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      "report.pdf",
      "application/pdf",
      2048,
      AttachmentPurpose.Context
    );
  });

  it("fails API-key callers closed when the MCP upload flag is disabled before service side effects", async () => {
    mockAuthContext = createTestAuthContext({
      authMethod: "api_key",
      apiKeyScopes: ["write"],
    });

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
      body: {
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json).toMatchObject({
      code: "mcp_attachment_upload_disabled",
      success: false,
    });
    expect(attachmentsService.requestDirectUpload).not.toHaveBeenCalled();
  });

  it("bypasses the MCP upload feature flag for browser session callers", async () => {
    vi.mocked(attachmentsService.requestDirectUpload).mockResolvedValue(
      Result.ok({
        attachmentId: "attachment-1",
        expiresAt: "2026-01-01T00:15:00.000Z",
        key: "attachments/artifact-1/cuid",
        uploadUrl: "https://s3.example.com/presigned-upload",
      })
    );

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
      body: {
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(200);
    expect(isMcpAttachmentUploadEnabled).not.toHaveBeenCalled();
  });

  it("returns retry metadata and Retry-After when the direct upload limiter rejects", async () => {
    vi.mocked(attachmentsService.requestDirectUpload).mockResolvedValue(
      Result.err({ type: "rate_limited", retryAfterSeconds: 37 })
    );

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
      body: {
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("37");
    const json = await response.json();
    expect(json).toMatchObject({
      code: "attachment_upload_rate_limited",
      details: { retryAfterSeconds: 37 },
      success: false,
    });
  });

  it("rejects read-only API keys before direct upload service handoff", async () => {
    mockAuthContext = createTestAuthContext({
      authMethod: "api_key",
      apiKeyScopes: ["read"],
    });

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
      body: {
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
      },
    });
    const response = await POST(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(403);
    expect(resolveDocumentId).not.toHaveBeenCalled();
    expect(isMcpAttachmentUploadEnabled).not.toHaveBeenCalled();
    expect(attachmentsService.requestDirectUpload).not.toHaveBeenCalled();
  });
});

describe("GET /api/artifacts/:id/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns attachment array on success", async () => {
    const mockAttachments = [
      {
        id: "attachment-1",
        documentId: "artifact-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        createdAt: "2024-01-01T00:00:00.000Z",
        createdById: "user-1",
      },
      {
        id: "attachment-2",
        documentId: "artifact-1",
        filename: "image.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        createdAt: "2024-01-02T00:00:00.000Z",
        createdById: "user-2",
      },
    ];

    vi.mocked(attachmentsService.listByDocument).mockResolvedValue(
      mockAttachments as any
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
    });
    const response = await GetAttachments(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(mockAttachments);
    expect(attachmentsService.listByDocument).toHaveBeenCalledWith(
      "artifact-1",
      mockAuthContext.user.organizationId,
      AttachmentPurposeSelector.Context
    );
  });

  it("passes the requested attachment purpose selector to the service", async () => {
    vi.mocked(attachmentsService.listByDocument).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments?purpose=inline",
    });
    const response = await GetAttachments(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(200);
    expect(attachmentsService.listByDocument).toHaveBeenCalledWith(
      "artifact-1",
      mockAuthContext.user.organizationId,
      AttachmentPurposeSelector.Inline
    );
  });

  it("returns empty array when artifact has no attachments", async () => {
    vi.mocked(attachmentsService.listByDocument).mockResolvedValue([]);

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
    });
    const response = await GetAttachments(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("returns 404 when artifact belongs to another organization", async () => {
    vi.mocked(attachmentsService.listByDocument).mockRejectedValue(
      new Error("Document not found")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts/other-org-artifact/attachments",
    });
    const response = await GetAttachments(
      request,
      createMockRouteContext({ id: "other-org-artifact" })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });
});

describe("POST /api/artifacts/:id/attachments/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns resolved inline images on success", async () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    const mockResult = {
      images: [
        {
          attachmentId,
          url: "https://s3.example.com/signed",
          filename: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 1024,
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      skipped: [],
    };
    vi.mocked(attachmentsService.resolveInlineImages).mockResolvedValue(
      mockResult
    );

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/resolve",
      body: {
        attachmentIds: [attachmentId],
      },
    });
    const response = await ResolveInlineImages(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(mockResult);
    expect(attachmentsService.resolveInlineImages).toHaveBeenCalledWith(
      "artifact-1",
      mockAuthContext.user.organizationId,
      [attachmentId]
    );
  });

  it("keeps the read-scope override for API-key POST callers", () => {
    expect(mockWithAnyAuthOptions).toContainEqual({
      requiredScopes: ["read"],
    });
  });

  it("returns 400 for invalid attachment IDs", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/resolve",
      body: {
        attachmentIds: ["not-a-uuid"],
      },
    });
    const response = await ResolveInlineImages(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(400);
    expect(attachmentsService.resolveInlineImages).not.toHaveBeenCalled();
  });

  it("returns 400 for empty attachment ID batches", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/resolve",
      body: {
        attachmentIds: [],
      },
    });
    const response = await ResolveInlineImages(
      request,
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(400);
    expect(attachmentsService.resolveInlineImages).not.toHaveBeenCalled();
  });
});

describe("GET /api/artifacts/:id/attachments/:attachmentId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns 404 when attachment does not exist", async () => {
    vi.mocked(attachmentsService.getDownloadUrl).mockRejectedValue(
      new Error("Attachment not found")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/nonexistent",
    });
    const response = await GetDownloadUrl(
      request,
      createMockRouteContext({
        id: "artifact-1",
        attachmentId: "nonexistent",
      })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 404 when artifact belongs to another organization", async () => {
    vi.mocked(attachmentsService.getDownloadUrl).mockRejectedValue(
      new Error("Document not found")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts/other-org-artifact/attachments/attachment-1",
    });
    const response = await GetDownloadUrl(
      request,
      createMockRouteContext({
        id: "other-org-artifact",
        attachmentId: "attachment-1",
      })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 200 with download URL on success", async () => {
    const mockResult = {
      downloadUrl: "https://s3.example.com/presigned-download",
    };

    vi.mocked(attachmentsService.getDownloadUrl).mockResolvedValue(
      mockResult as any
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/attachment-1",
    });
    const response = await GetDownloadUrl(
      request,
      createMockRouteContext({
        id: "artifact-1",
        attachmentId: "attachment-1",
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(mockResult);
  });
});

describe("DELETE /api/artifacts/:id/attachments/:attachmentId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
  });

  it("returns 404 when attachment does not exist", async () => {
    vi.mocked(attachmentsService.deleteAttachment).mockResolvedValue(
      Result.err({ code: DeleteAttachmentErrorCode.AttachmentNotFound })
    );

    const request = createMockRequest({
      method: "DELETE",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/nonexistent",
    });
    const response = await DELETE(
      request,
      createMockRouteContext({
        id: "artifact-1",
        attachmentId: "nonexistent",
      })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 404 without calling the service when document resolution fails", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);

    const request = createMockRequest({
      method: "DELETE",
      url: "http://localhost:3002/api/artifacts/other-org-artifact/attachments/attachment-1",
    });
    const response = await DELETE(
      request,
      createMockRouteContext({
        id: "other-org-artifact",
        attachmentId: "attachment-1",
      })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(attachmentsService.deleteAttachment).not.toHaveBeenCalled();
  });

  it("returns 404 when the service reports document_not_found", async () => {
    vi.mocked(attachmentsService.deleteAttachment).mockResolvedValue(
      Result.err({ code: DeleteAttachmentErrorCode.DocumentNotFound })
    );

    const request = createMockRequest({
      method: "DELETE",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/attachment-1",
    });
    const response = await DELETE(
      request,
      createMockRouteContext({
        id: "artifact-1",
        attachmentId: "attachment-1",
      })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 404 when the API-key actor did not create the attachment", async () => {
    mockAuthContext = {
      ...createTestAuthContext(),
      apiKeyScopes: ["delete"],
      authMethod: "api_key",
    };
    vi.mocked(attachmentsService.deleteAttachment).mockResolvedValue(
      Result.err({ code: DeleteAttachmentErrorCode.NotOwned })
    );

    const request = createMockRequest({
      method: "DELETE",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/attachment-1",
    });
    const response = await DELETE(
      request,
      createMockRouteContext({
        id: "artifact-1",
        attachmentId: "attachment-1",
      })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 200 with deleted: true on success", async () => {
    vi.mocked(attachmentsService.deleteAttachment).mockResolvedValue(
      Result.ok(undefined)
    );

    const request = createMockRequest({
      method: "DELETE",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/attachment-1",
    });
    const response = await DELETE(
      request,
      createMockRouteContext({
        id: "artifact-1",
        attachmentId: "attachment-1",
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ deleted: true });
    expect(attachmentsService.deleteAttachment).toHaveBeenCalledWith(
      "artifact-1",
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      "attachment-1",
      { requireCreatorOwnership: false }
    );
  });

  it.each([
    "read",
    "write",
  ] satisfies ApiKeyScope[])("requires delete scope for API-key callers with only %s scope", async (scope) => {
    mockAuthContext = {
      ...createTestAuthContext(),
      apiKeyScopes: [scope],
      authMethod: "api_key",
    };
    vi.mocked(attachmentsService.deleteAttachment).mockResolvedValue(
      Result.ok(undefined)
    );

    const request = createMockRequest({
      method: "DELETE",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/attachment-1",
    });
    const response = await DELETE(
      request,
      createMockRouteContext({
        id: "artifact-1",
        attachmentId: "attachment-1",
      })
    );

    expect(response.status).toBe(403);
    expect(attachmentsService.deleteAttachment).not.toHaveBeenCalled();
  });

  it("allows delete-scoped API-key callers", async () => {
    mockAuthContext = {
      ...createTestAuthContext(),
      apiKeyScopes: ["delete"],
      authMethod: "api_key",
    };
    vi.mocked(attachmentsService.deleteAttachment).mockResolvedValue(
      Result.ok(undefined)
    );

    const request = createMockRequest({
      method: "DELETE",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/attachment-1",
    });
    const response = await DELETE(
      request,
      createMockRouteContext({
        id: "artifact-1",
        attachmentId: "attachment-1",
      })
    );

    expect(response.status).toBe(200);
    expect(attachmentsService.deleteAttachment).toHaveBeenCalledWith(
      "artifact-1",
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      "attachment-1",
      { requireCreatorOwnership: true }
    );
  });

  it("returns 500 when the service throws unexpectedly", async () => {
    vi.mocked(attachmentsService.deleteAttachment).mockRejectedValue(
      new Error("database unavailable")
    );

    const request = createMockRequest({
      method: "DELETE",
      url: "http://localhost:3002/api/artifacts/artifact-1/attachments/attachment-1",
    });
    const response = await DELETE(
      request,
      createMockRouteContext({
        id: "artifact-1",
        attachmentId: "attachment-1",
      })
    );

    expect(response.status).toBe(500);
  });
});

function getDefaultScopeForMethod(method: string): ApiKeyScope {
  if (method === "GET" || method === "HEAD") {
    return "read";
  }
  if (method === "DELETE") {
    return "delete";
  }
  return "write";
}

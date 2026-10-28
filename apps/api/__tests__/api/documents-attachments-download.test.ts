/**
 * `GET /api/artifacts/:id/attachments/:attachmentId`, the signed download URL
 * route. Split out of `documents-attachments.test.ts`, which owns upload,
 * listing, inline-image resolve and delete, so that grandfathered file shrinks
 * rather than grows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as GetDownloadUrl } from "@/app/documents/[id]/attachments/[attachmentId]/route";
import { attachmentsService } from "@/app/documents/attachments-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;
vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));
vi.mock("@/lib/identifier-utils", () => ({
  resolveDocumentId: vi.fn(async (id: string) => id),
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

  it("returns 404 when the service reports the document is not found", async () => {
    vi.mocked(attachmentsService.getDownloadUrl).mockRejectedValue(
      new Error("Document not found")
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

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 200 with download URL on success", async () => {
    const mockResult = {
      downloadUrl: "https://s3.example.com/presigned-download",
    };

    vi.mocked(attachmentsService.getDownloadUrl).mockResolvedValue(mockResult);

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

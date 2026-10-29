import {
  AttachmentPurpose,
  MAX_MEDIA_FILE_SIZE_BYTES,
  MEDIA_MIME_TYPES,
} from "@repo/api/src/types/attachment";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/documents/[id]/attachments/route";
import { MAX_FILE_SIZE_BYTES } from "@/app/documents/[id]/attachments/validators";
import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import { attachmentsService } from "@/app/documents/attachments-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
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

describe("POST /api/artifacts/:id/attachments media ceilings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
    vi.mocked(isMcpAttachmentUploadEnabled).mockResolvedValue(false);
  });

  // ISS-10415 acceptance 5: one newly accepted type end to end, not just the
  // validator. Every media type is driven, because a single-format fixture
  // cannot tell a per-type allowance from a blanket raise of the ceiling — the
  // "sizeBytes exceeds MAX_FILE_SIZE_BYTES" case in the sibling
  // documents-attachments suite is its counterpart, proving a NON-media body at
  // the same size is still rejected.
  it.each(MEDIA_MIME_TYPES)(
    "reaches requestDirectUpload for %s above the document ceiling",
    async (mimeType) => {
      const mockResult = {
        attachmentId: "attachment-media",
        expiresAt: "2026-01-01T00:15:00.000Z",
        uploadUrl: "https://s3.example.com/presigned-upload",
        key: "attachments/artifact-1/cuid",
      };
      vi.mocked(attachmentsService.requestDirectUpload).mockResolvedValue(
        Result.ok(mockResult)
      );
      const sizeBytes = MAX_FILE_SIZE_BYTES + 1;

      const request = createMockRequest({
        method: "POST",
        url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
        body: {
          filename: "screen-recording",
          mimeType,
          sizeBytes,
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
        "screen-recording",
        mimeType,
        sizeBytes,
        AttachmentPurpose.Context,
        undefined
      );
    }
  );

  it.each(MEDIA_MIME_TYPES)(
    "returns 400 for %s above the media ceiling",
    async (mimeType) => {
      const request = createMockRequest({
        method: "POST",
        url: "http://localhost:3002/api/artifacts/artifact-1/attachments",
        body: {
          filename: "screen-recording",
          mimeType,
          sizeBytes: MAX_MEDIA_FILE_SIZE_BYTES + 1,
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
    }
  );
});

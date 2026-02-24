import { vi } from "vitest";
import {
  DELETE,
  GET as GetDownloadUrl,
} from "@/app/artifacts/[id]/attachments/[attachmentId]/route";
import {
  GET as GetAttachments,
  POST,
} from "@/app/artifacts/[id]/attachments/route";
import { MAX_FILE_SIZE_BYTES } from "@/app/artifacts/[id]/attachments/validators";
import { attachmentsService } from "@/app/artifacts/attachments-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/artifacts/attachments-service");
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
    expect(attachmentsService.requestUpload).not.toHaveBeenCalled();
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
    expect(attachmentsService.requestUpload).not.toHaveBeenCalled();
  });

  it("returns 404 when artifact belongs to another organization", async () => {
    vi.mocked(attachmentsService.requestUpload).mockRejectedValue(
      new Error("Artifact not found")
    );

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
  });

  it("returns 200 with upload URL on success", async () => {
    const mockResult = {
      attachmentId: "attachment-1",
      uploadUrl: "https://s3.example.com/presigned-upload",
      key: "attachments/artifact-1/cuid",
    };

    vi.mocked(attachmentsService.requestUpload).mockResolvedValue(
      mockResult as any
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
    expect(attachmentsService.requestUpload).toHaveBeenCalledWith(
      "artifact-1",
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      "report.pdf",
      "application/pdf",
      2048
    );
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
        artifactId: "artifact-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        createdAt: "2024-01-01T00:00:00.000Z",
        createdById: "user-1",
      },
      {
        id: "attachment-2",
        artifactId: "artifact-1",
        filename: "image.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        createdAt: "2024-01-02T00:00:00.000Z",
        createdById: "user-2",
      },
    ];

    vi.mocked(attachmentsService.listByArtifact).mockResolvedValue(
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
    expect(attachmentsService.listByArtifact).toHaveBeenCalledWith(
      "artifact-1",
      mockAuthContext.user.organizationId
    );
  });

  it("returns empty array when artifact has no attachments", async () => {
    vi.mocked(attachmentsService.listByArtifact).mockResolvedValue([]);

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
    vi.mocked(attachmentsService.listByArtifact).mockRejectedValue(
      new Error("Artifact not found")
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
      new Error("Artifact not found")
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
  });

  it("returns 404 when attachment does not exist", async () => {
    vi.mocked(attachmentsService.deleteAttachment).mockRejectedValue(
      new Error("Attachment not found")
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

  it("returns 404 when artifact belongs to another organization", async () => {
    vi.mocked(attachmentsService.deleteAttachment).mockRejectedValue(
      new Error("Artifact not found")
    );

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
  });

  it("returns 200 with deleted: true on success", async () => {
    vi.mocked(attachmentsService.deleteAttachment).mockResolvedValue(undefined);

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
      "attachment-1"
    );
  });
});

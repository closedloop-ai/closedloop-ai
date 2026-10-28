import { AttachmentPurpose } from "@repo/api/src/types/attachment";
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/documents/[id]/context-attachments/route";
import { attachmentsService } from "@/app/documents/attachments-service";
import {
  ContextDocumentErrorCode,
  contextDocumentService,
} from "@/app/documents/context-document-service";
import { documentService } from "@/app/documents/document-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("@/lib/identifier-utils", () => ({
  resolveDocumentId: vi.fn(async (id: string) => id),
}));

vi.mock("@/app/documents/attachments-service", () => ({
  attachmentsService: {
    requestUpload: vi.fn(),
  },
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/app/documents/context-document-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/documents/context-document-service")
  >()),
  contextDocumentService: { createWithUpload: vi.fn() },
}));

describe("POST /api/artifacts/:id/context-attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("keeps direct context attachments out of the direct-upload limiter response shape", async () => {
    vi.mocked(documentService.findById).mockResolvedValue({
      id: "artifact-1",
      projectId: "project-1",
    } as never);
    vi.mocked(attachmentsService.requestUpload).mockResolvedValue({
      attachmentId: "attachment-1",
      expiresAt: "2026-01-01T00:15:00.000Z",
      key: "attachments/org/artifact/cuid",
      uploadUrl: "https://s3.example.com/upload",
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/api/artifacts/artifact-1/context-attachments",
        body: {
          filename: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 128,
        },
      }),
      createMockRouteContext({ id: "artifact-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual({
      artifactId: "",
      attachmentId: "attachment-1",
      uploadUrl: "https://s3.example.com/upload",
    });
    expect(json.data).not.toHaveProperty("expiresAt");
    expect(attachmentsService.requestUpload).toHaveBeenCalledWith(
      "artifact-1",
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      "notes.txt",
      "text/plain",
      128,
      AttachmentPurpose.Context,
      undefined
    );
  });

  // ISS-7536 / ISS-12552: the document-upload branch creates a PRD and links
  // it in one transaction, so a refused link leaves nothing to clean up; the
  // route still has to answer with the link failure rather than a 200 naming
  // an artifact that does not exist.
  it("answers the link failure when the context link is refused", async () => {
    vi.mocked(documentService.findById).mockResolvedValue({
      id: "artifact-1",
      projectId: "project-1",
    } as never);
    vi.mocked(contextDocumentService.createWithUpload).mockResolvedValue(
      Result.err({
        code: ContextDocumentErrorCode.LinkRejected,
        cause: Status.Conflict,
      })
    );

    const response = await postDocumentFile();

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to link artifact to document");
    expect(contextDocumentService.createWithUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDocumentId: "artifact-1",
        projectId: "project-1",
        filename: "spec.md",
        mimeType: "text/markdown",
      }),
      undefined
    );
  });

  it("answers the upload failure when the upload cannot be signed", async () => {
    vi.mocked(documentService.findById).mockResolvedValue({
      id: "artifact-1",
      projectId: "project-1",
    } as never);
    vi.mocked(contextDocumentService.createWithUpload).mockResolvedValue(
      Result.err({
        code: ContextDocumentErrorCode.SigningFailed,
        cause: new Error("S3 presign failed"),
      })
    );

    const response = await postDocumentFile();

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to request upload");
  });
});

function postDocumentFile() {
  return POST(
    createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/context-attachments",
      body: {
        filename: "spec.md",
        // A document MIME type routes to handleDocumentUpload, the branch
        // that links; text/plain takes the direct path and never links.
        mimeType: "text/markdown",
        sizeBytes: 128,
      },
    }),
    createMockRouteContext({ id: "artifact-1" })
  );
}

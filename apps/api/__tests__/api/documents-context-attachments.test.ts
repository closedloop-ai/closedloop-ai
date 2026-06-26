import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/documents/[id]/context-attachments/route";
import { attachmentsService } from "@/app/documents/attachments-service";
import { documentService } from "@/app/documents/document-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
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

vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: {
    createLink: vi.fn(),
  },
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
      128
    );
  });
});

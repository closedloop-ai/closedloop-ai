/**
 * Branch coverage for this route's own logic that
 * `__tests__/api/documents-attachments.test.ts` (a shared file covering
 * several sibling attachment routes owned by other lanes) does not reach:
 * the inline-attempt diagnostics parser, the inline-attempt logging arm on a
 * missing document, the thrown-error classification in POST's catch block,
 * and GET's own document-resolution and error-classification arms.
 */

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { AttachmentPurpose } from "@repo/api/src/types/attachment";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;
const mockLog = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  flush: vi.fn(async () => undefined),
}));

vi.mock("@repo/observability/log", () => ({ log: mockLog }));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    options?: unknown
  ) => {
    return (request: Request, context: { params: Promise<{ id: string }> }) => {
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
          { success: false, error: "Forbidden" },
          { status: 403 }
        );
      }
      return handler(mockAuthContext, request, context.params);
    };
  },
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveDocumentId: vi.fn(async (id: string) => id),
  };
});

vi.mock("@/app/documents/attachment-upload-feature", () => ({
  isMcpAttachmentUploadEnabled: vi.fn(),
}));

vi.mock("@/app/documents/attachments-service", () => ({
  DOCUMENT_NOT_FOUND_ERROR: "Document not found",
  INVALID_INLINE_ATTACHMENT_UPLOAD_ERROR: "Invalid inline attachment upload",
  attachmentsService: {
    listByDocument: vi.fn(),
    requestDirectUpload: vi.fn(),
  },
}));

import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import {
  attachmentsService,
  DOCUMENT_NOT_FOUND_ERROR,
  INVALID_INLINE_ATTACHMENT_UPLOAD_ERROR,
} from "@/app/documents/attachments-service";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { GET, POST } from "./route";

describe("POST /documents/:id/attachments — inline-attempt diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
    vi.mocked(isMcpAttachmentUploadEnabled).mockResolvedValue(false);
  });

  it("does not log an inline warning for a plain context attachment on an unresolved document", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        body: {
          filename: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
        },
        method: "POST",
        url: "http://localhost:3002/documents/missing/attachments",
      }),
      createMockRouteContext({ id: "missing" })
    );

    expect(response.status).toBe(404);
    expect(mockLog.warn).not.toHaveBeenCalled();
    const json = await response.json();
    expect(json.error).toBe("Document not found");
  });

  it("logs a warning when an inline attachment attempt names a document that does not resolve", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        body: {
          filename: "diagram.png",
          mimeType: "image/png",
          purpose: AttachmentPurpose.Inline,
          sizeBytes: 10,
        },
        method: "POST",
        url: "http://localhost:3002/documents/missing/attachments",
      }),
      createMockRouteContext({ id: "missing" })
    );

    expect(response.status).toBe(404);
    expect(mockLog.warn).toHaveBeenCalledWith(
      "[documents/attachments] Inline attachment upload document not found",
      expect.objectContaining({
        documentId: "missing",
        mimeType: "image/png",
        purpose: AttachmentPurpose.Inline,
        sizeBytes: 10,
        reason: "document_not_found",
      })
    );
  });

  it("does not treat an unparsable body as an inline attempt, and reads no diagnostics from it", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);
    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/documents/missing/attachments",
    });
    // No body was set (createMockRequest omits Content-Type/body when none is
    // passed), so `request.clone().json()` rejects and diagnostics fall back
    // to `{}` — never an inline attempt.
    const response = await POST(
      request,
      createMockRouteContext({ id: "missing" })
    );

    expect(response.status).toBe(404);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("drops non-string mimeType and non-number sizeBytes from the logged diagnostics", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        body: {
          filename: "diagram.png",
          mimeType: 123,
          purpose: AttachmentPurpose.Inline,
          sizeBytes: "not-a-number",
        },
        method: "POST",
        url: "http://localhost:3002/documents/missing/attachments",
      }),
      createMockRouteContext({ id: "missing" })
    );

    expect(response.status).toBe(404);
    expect(mockLog.warn).toHaveBeenCalledWith(
      "[documents/attachments] Inline attachment upload document not found",
      expect.objectContaining({
        documentId: "missing",
        purpose: AttachmentPurpose.Inline,
        reason: "document_not_found",
      })
    );
    const loggedDiagnostics = mockLog.warn.mock.calls[0][1];
    expect(loggedDiagnostics.mimeType).toBeUndefined();
    expect(loggedDiagnostics.sizeBytes).toBeUndefined();
  });

  it("does not treat a non-object JSON body as an inline attempt", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);
    const request = new NextRequest(
      "http://localhost:3002/documents/missing/attachments",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not", "an", "object"]),
      }
    );

    const response = await POST(
      request,
      createMockRouteContext({ id: "missing" })
    );

    expect(response.status).toBe(404);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("logs a warning when an inline attachment attempt fails body validation", async () => {
    const response = await POST(
      createMockRequest({
        body: {
          filename: "diagram.pdf",
          mimeType: "application/pdf",
          purpose: AttachmentPurpose.Inline,
          sizeBytes: 10,
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/attachments",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(400);
    expect(mockLog.warn).toHaveBeenCalledWith(
      "[documents/attachments] Inline attachment upload validation rejected",
      expect.objectContaining({
        documentId: "FEA-42",
        mimeType: "application/pdf",
        purpose: AttachmentPurpose.Inline,
        sizeBytes: 10,
        reason: "validation_rejected",
      })
    );
  });

  it("does not log a validation-rejection warning for a plain context attachment that fails body validation", async () => {
    const response = await POST(
      createMockRequest({
        body: {
          filename: "report.exe",
          mimeType: "application/x-invalid",
          sizeBytes: 10,
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/attachments",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(400);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });
});

describe("POST /documents/:id/attachments — thrown-error classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
    vi.mocked(isMcpAttachmentUploadEnabled).mockResolvedValue(false);
  });

  it("maps a thrown document-not-found error from the service to a 404", async () => {
    vi.mocked(attachmentsService.requestDirectUpload).mockRejectedValue(
      new Error(DOCUMENT_NOT_FOUND_ERROR)
    );

    const response = await POST(
      createMockRequest({
        body: {
          filename: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/attachments",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error).toBe("Document not found");
  });

  it("maps a thrown invalid-inline-upload error from the service to a 400", async () => {
    vi.mocked(attachmentsService.requestDirectUpload).mockRejectedValue(
      new Error(INVALID_INLINE_ATTACHMENT_UPLOAD_ERROR)
    );

    const response = await POST(
      createMockRequest({
        body: {
          filename: "diagram.png",
          mimeType: "image/png",
          purpose: AttachmentPurpose.Inline,
          sizeBytes: 10,
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/attachments",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({
      success: false,
      error: INVALID_INLINE_ATTACHMENT_UPLOAD_ERROR,
    });
  });

  it("falls back to a generic 500 for an unrelated thrown error", async () => {
    vi.mocked(attachmentsService.requestDirectUpload).mockRejectedValue(
      new Error("connection reset")
    );

    const response = await POST(
      createMockRequest({
        body: {
          filename: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/attachments",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to create attachment");
  });
});

describe("GET /documents/:id/attachments — query and resolution branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
  });

  it("rejects a query string carrying an unsupported purpose value", async () => {
    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/documents/FEA-42/attachments?purpose=bogus",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(400);
    expect(resolveDocumentId).not.toHaveBeenCalled();
    expect(attachmentsService.listByDocument).not.toHaveBeenCalled();
  });

  it("returns 404 without listing attachments when the document does not resolve", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null);

    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/documents/missing/attachments",
      }),
      createMockRouteContext({ id: "missing" })
    );

    expect(response.status).toBe(404);
    expect(attachmentsService.listByDocument).not.toHaveBeenCalled();
    const json = await response.json();
    expect(json.error).toBe("Document not found");
  });

  it("maps an unrelated service failure to a generic 500, not a 404", async () => {
    vi.mocked(attachmentsService.listByDocument).mockRejectedValue(
      new Error("connection reset")
    );

    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/documents/FEA-42/attachments",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to list attachments");
  });
});

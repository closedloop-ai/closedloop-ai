import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  AttachmentPurpose,
  AttachmentUploadResponseErrorCode,
  CreateInlineImageAttachmentErrorCode,
  INLINE_ATTACHMENT_REF_PREFIX,
} from "@repo/api/src/types/attachment";
import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  CreateDocumentVersionErrorCode,
  MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES,
} from "@repo/api/src/types/document-version";
import { Result } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;
const mockCreateNewVersion = vi.hoisted(() => vi.fn());
const mockCreateNewVersionWithInlineImages = vi.hoisted(() => vi.fn());
const mockResetDocumentRoom = vi.hoisted(() => vi.fn());
const mockWithAnyAuthOptions = vi.hoisted(() => [] as unknown[]);

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn(async () => {}),
    info: vi.fn(),
  },
}));

vi.mock("@/app/documents/attachment-upload-feature", () => ({
  isMcpAttachmentUploadEnabled: vi.fn(),
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    findByIdSimple: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any, options?: unknown) => {
    mockWithAnyAuthOptions.push(options);
    return (request: Request, context: { params: Promise<{ id: string }> }) => {
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

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveDocumentId: vi.fn(async (id: string) => id),
  };
});

vi.mock("../../document-version-service", () => ({
  documentVersionService: {
    createNewVersion: mockCreateNewVersion,
    createNewVersionWithInlineImages: mockCreateNewVersionWithInlineImages,
    listVersions: vi.fn(),
  },
}));

vi.mock("../../room-utils", () => ({
  resetDocumentRoom: mockResetDocumentRoom,
}));

import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { documentVersionService } from "../../document-version-service";
import { resetDocumentRoom } from "../../room-utils";
import { POST } from "./route";

describe("POST /documents/:id/versions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
    vi.mocked(isMcpAttachmentUploadEnabled).mockResolvedValue(false);
    mockCreateNewVersion.mockResolvedValue(makeDocumentDetail("Saved content"));
    mockCreateNewVersionWithInlineImages.mockResolvedValue(
      Result.ok({
        document: makeDocumentDetail(
          `Content ![Diagram](${INLINE_ATTACHMENT_REF_PREFIX}attachment-1)`
        ),
        inlineImages: [makeCreatedInlineImage()],
        versionContent: `Content ![Diagram](${INLINE_ATTACHMENT_REF_PREFIX}attachment-1)`,
      })
    );
    mockResetDocumentRoom.mockResolvedValue(undefined);
  });

  it("keeps the old content-only body path and does not check the MCP upload flag", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["write"],
      authMethod: "api_key",
    });
    mockCreateNewVersion.mockResolvedValue(makeDocumentDetail("Plain update"));

    const response = await POST(
      createMockRequest({
        body: { content: "Plain update" },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions?reset-room=false",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject({
      id: "FEA-42",
      latestVersionContent: "Plain update",
      version: {
        content: "Plain update",
        createdAt: "2026-07-20T12:00:00.000Z",
      },
    });
    expect(isMcpAttachmentUploadEnabled).not.toHaveBeenCalled();
    expect(documentVersionService.createNewVersion).toHaveBeenCalledWith(
      "FEA-42",
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      "Plain update"
    );
    expect(
      documentVersionService.createNewVersionWithInlineImages
    ).not.toHaveBeenCalled();
    expect(resetDocumentRoom).not.toHaveBeenCalled();
  });

  it("keeps large content-only version requests on the legacy path", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["write"],
      authMethod: "api_key",
    });
    const content = "x".repeat(
      MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES + 1000
    );
    mockCreateNewVersion.mockResolvedValue(makeDocumentDetail(content));

    const response = await POST(
      createMockRequest({
        body: { content },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions?reset-room=false",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(200);
    expect(isMcpAttachmentUploadEnabled).not.toHaveBeenCalled();
    expect(documentVersionService.createNewVersion).toHaveBeenCalledWith(
      "FEA-42",
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      content
    );
    expect(
      documentVersionService.createNewVersionWithInlineImages
    ).not.toHaveBeenCalled();
  });

  it("keeps large content-only version requests with empty inlineImages on the legacy path", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["write"],
      authMethod: "api_key",
    });
    const content = "x".repeat(
      MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES + 1000
    );
    mockCreateNewVersion.mockResolvedValue(makeDocumentDetail(content));

    const response = await POST(
      createMockRequest({
        body: { content, inlineImages: [] },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions?reset-room=false",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(200);
    expect(isMcpAttachmentUploadEnabled).not.toHaveBeenCalled();
    expect(documentVersionService.createNewVersion).toHaveBeenCalledWith(
      "FEA-42",
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      content
    );
    expect(
      documentVersionService.createNewVersionWithInlineImages
    ).not.toHaveBeenCalled();
  });

  it("allows inline images for write-scoped API keys only when the MCP upload flag is enabled", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["write"],
      authMethod: "api_key",
    });
    vi.mocked(isMcpAttachmentUploadEnabled).mockResolvedValue(true);

    const response = await POST(
      createMockRequest({
        body: {
          content: "Content [[diagram]]",
          inlineImages: [makeInlineImageInput()],
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions?reset-room=false",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      success: true,
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
    });
    expect(JSON.stringify(json)).not.toContain("aW1hZ2U=");
    expect(isMcpAttachmentUploadEnabled).toHaveBeenCalledWith({
      clerkUserId: mockAuthContext.clerkUserId,
      userId: mockAuthContext.user.id,
    });
    expect(
      documentVersionService.createNewVersionWithInlineImages
    ).toHaveBeenCalledWith(
      "FEA-42",
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      "Content [[diagram]]",
      [makeInlineImageInput()]
    );
  });

  it("fails API-key inline image requests closed when the MCP upload flag is disabled", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["write"],
      authMethod: "api_key",
    });

    const response = await POST(
      createMockRequest({
        body: {
          content: "Content [[diagram]]",
          inlineImages: [makeInlineImageInput()],
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json).toMatchObject({
      code: AttachmentUploadResponseErrorCode.McpUploadDisabled,
      success: false,
    });
    expect(
      documentVersionService.createNewVersionWithInlineImages
    ).not.toHaveBeenCalled();
  });

  it("returns canonical duplicate-placeholder errors from service validation", async () => {
    mockCreateNewVersionWithInlineImages.mockResolvedValue(
      Result.err({
        code: CreateDocumentVersionErrorCode.DuplicateInlineImagePlaceholder,
        placeholder: "[[diagram]]",
      })
    );

    const response = await POST(
      createMockRequest({
        body: {
          content: "Content [[diagram]]",
          inlineImages: [makeInlineImageInput(), makeInlineImageInput()],
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateDocumentVersionErrorCode.DuplicateInlineImagePlaceholder,
      details: { placeholder: "[[diagram]]" },
      success: false,
    });
    expect(
      documentVersionService.createNewVersionWithInlineImages
    ).toHaveBeenCalled();
  });

  it("returns canonical missing-placeholder errors from service validation", async () => {
    mockCreateNewVersionWithInlineImages.mockResolvedValue(
      Result.err({
        code: CreateDocumentVersionErrorCode.MissingInlineImagePlaceholder,
        placeholder: "[[diagram]]",
      })
    );

    const response = await POST(
      createMockRequest({
        body: {
          content: "Content without marker",
          inlineImages: [makeInlineImageInput()],
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateDocumentVersionErrorCode.MissingInlineImagePlaceholder,
      details: { placeholder: "[[diagram]]" },
      success: false,
    });
    expect(
      documentVersionService.createNewVersionWithInlineImages
    ).toHaveBeenCalled();
  });

  it("returns 413 when the raw create-version request body exceeds the route cap", async () => {
    const content = `${"x".repeat(
      MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES
    )} [[diagram]]`;

    const request = createMockRequest({
      body: {
        content,
        inlineImages: [makeInlineImageInput()],
      },
      method: "POST",
      url: "http://localhost:3002/documents/FEA-42/versions",
    });
    const textSpy = vi.spyOn(request, "text");

    const response = await POST(
      request,
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(textSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(413);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateDocumentVersionErrorCode.RequestBodyTooLarge,
      details: {
        maxBytes: MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES,
      },
      success: false,
    });
    expect(documentVersionService.createNewVersion).not.toHaveBeenCalled();
    expect(
      documentVersionService.createNewVersionWithInlineImages
    ).not.toHaveBeenCalled();
  });

  it("returns 413 when an escaped inlineImages key appears after over-cap version content", async () => {
    const content = `${"x".repeat(
      MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES
    )} [[diagram]]`;
    const request = createRawJsonRequest(
      makeEscapedInlineImagesVersionBody(content)
    );
    const textSpy = vi.spyOn(request, "text");

    const response = await POST(
      request,
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(textSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(413);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateDocumentVersionErrorCode.RequestBodyTooLarge,
      details: {
        maxBytes: MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES,
      },
      success: false,
    });
    expect(documentVersionService.createNewVersion).not.toHaveBeenCalled();
    expect(
      documentVersionService.createNewVersionWithInlineImages
    ).not.toHaveBeenCalled();
  });

  it("returns canonical overlapping-placeholder errors from service validation", async () => {
    mockCreateNewVersionWithInlineImages.mockResolvedValue(
      Result.err({
        code: CreateDocumentVersionErrorCode.OverlappingInlineImagePlaceholder,
        placeholder: "[[diagram]]",
      })
    );

    const response = await POST(
      createMockRequest({
        body: {
          content: "Content [[diagram]]-detail",
          inlineImages: [
            makeInlineImageInput(),
            makeInlineImageInput("[[diagram]]-detail"),
          ],
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateDocumentVersionErrorCode.OverlappingInlineImagePlaceholder,
      details: { placeholder: "[[diagram]]" },
      success: false,
    });
    expect(
      documentVersionService.createNewVersionWithInlineImages
    ).toHaveBeenCalled();
  });

  it("maps inline image service failures through the attachment error contract", async () => {
    mockCreateNewVersionWithInlineImages.mockResolvedValue(
      Result.err({
        code: CreateDocumentVersionErrorCode.InlineImageCreationFailed,
        inlineImageError: {
          code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
        },
        placeholder: "[[diagram]]",
      })
    );

    const response = await POST(
      createMockRequest({
        body: {
          content: "Content [[diagram]]",
          inlineImages: [makeInlineImageInput()],
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
      success: false,
    });
  });

  it("maps expanded-content service failures to 413 with size details", async () => {
    mockCreateNewVersionWithInlineImages.mockResolvedValue(
      Result.err({
        code: CreateDocumentVersionErrorCode.ExpandedContentTooLarge,
        estimatedContentChars: 1_200_000,
        maxContentChars: 1_048_576,
      })
    );

    const response = await POST(
      createMockRequest({
        body: {
          content: "Content [[diagram]]",
          inlineImages: [makeInlineImageInput()],
        },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(413);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateDocumentVersionErrorCode.ExpandedContentTooLarge,
      details: {
        estimatedContentChars: 1_200_000,
        maxContentChars: 1_048_576,
      },
      success: false,
    });
  });

  it("keeps the write-scope override for API-key POST callers", () => {
    expect(mockWithAnyAuthOptions).toContainEqual({
      requiredScopes: ["write"],
    });
  });

  it("rejects read-only API keys before document resolution", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["read"],
      authMethod: "api_key",
    });

    const response = await POST(
      createMockRequest({
        body: { content: "Plain update" },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(403);
    expect(resolveDocumentId).not.toHaveBeenCalled();
    expect(documentVersionService.createNewVersion).not.toHaveBeenCalled();
  });
});

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

function createRawJsonRequest(body: string): NextRequest {
  return new NextRequest("http://localhost:3002/documents/FEA-42/versions", {
    body,
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

function makeInlineImageInput(placeholder = "[[diagram]]") {
  return {
    altText: "Diagram",
    dataBase64: "aW1hZ2U=",
    filename: "diagram.png",
    mimeType: "image/png",
    placeholder,
  };
}

function makeEscapedInlineImagesVersionBody(content: string): string {
  return `{"content":${JSON.stringify(content)},"inline\\u0049mages":[${JSON.stringify(makeInlineImageInput())}]}`;
}

function makeCreatedInlineImage() {
  return {
    attachmentId: "attachment-1",
    attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}attachment-1`,
    markdownImage: `![Diagram](${INLINE_ATTACHMENT_REF_PREFIX}attachment-1)`,
    placeholder: "[[diagram]]",
    attachment: {
      id: "attachment-1",
      artifactId: "FEA-42",
      createdAt: "2026-07-20T12:00:00.000Z",
      createdById: "test-user-id",
      filename: "diagram.png",
      mimeType: "image/png",
      purpose: AttachmentPurpose.Inline,
      sizeBytes: 16,
    },
  };
}

function makeDocumentDetail(content: string): DocumentDetail {
  return {
    id: "FEA-42",
    latestVersion: 2,
    latestVersionContent: content,
    title: "Feature",
    version: {
      content,
      createdAt: new Date("2026-07-20T12:00:00.000Z"),
      createdById: "test-user-id",
      documentId: "FEA-42",
      id: "version-2",
      version: 2,
    },
  } as DocumentDetail;
}

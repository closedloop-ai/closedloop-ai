import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { CreateDocumentVersionErrorCode } from "@repo/api/src/types/document-version";
import { Result } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;
const mockCreateNewVersion = vi.hoisted(() => vi.fn());
const mockCreateNewVersionWithInlineImages = vi.hoisted(() => vi.fn());
const mockResetDocumentRoom = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  error: vi.fn(),
  flush: vi.fn(async () => undefined),
  info: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({ log: mockLog }));

vi.mock("@/app/documents/attachment-upload-feature", () => ({
  isMcpAttachmentUploadEnabled: vi.fn(),
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    findByIdSimple: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    options?: unknown
  ) => {
    return (request: Request, context: { params: Promise<{ id: string }> }) => {
      const requiredScopes = (
        options as { requiredScopes?: ApiKeyScope[] } | undefined
      )?.requiredScopes ?? ["read"];
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

import { documentService } from "@/app/documents/document-service";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { resetDocumentRoom } from "../../room-utils";
import { GET, POST } from "./route";

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

function makeInlineImageInput(placeholder = "[[diagram]]") {
  return {
    altText: "Diagram",
    dataBase64: "aW1hZ2U=",
    filename: "diagram.png",
    mimeType: "image/png",
    placeholder,
  };
}

describe("GET /documents/:id/versions — resolution failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns 404 without querying the document when the id does not resolve", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null as never);

    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/api/documents/missing/versions",
      }),
      createMockRouteContext({ id: "missing" })
    );

    expect(response.status).toBe(404);
    expect(documentService.findByIdSimple).not.toHaveBeenCalled();
    const json = await response.json();
    expect(json.error).toBe("Artifact not found");
  });

  it("maps a null findByIdSimple result to a 404", async () => {
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
    vi.mocked(documentService.findByIdSimple).mockResolvedValue(null);

    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/api/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(404);
    expect(documentService.findByIdSimple).toHaveBeenCalledWith(
      "FEA-42",
      mockAuthContext.user.organizationId
    );
    const json = await response.json();
    expect(json.error).toBe("Artifact not found");
  });

  it("falls through to a generic 500 for an unrecognized error", async () => {
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
    vi.mocked(documentService.findByIdSimple).mockRejectedValue(
      new Error("db down")
    );

    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/api/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to fetch artifact versions");
  });
});

describe("POST /documents/:id/versions — resolution and room reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
    mockCreateNewVersion.mockResolvedValue(makeDocumentDetail("Saved content"));
    mockResetDocumentRoom.mockResolvedValue(undefined);
  });

  it("returns 404 without parsing the body when the id does not resolve", async () => {
    vi.mocked(resolveDocumentId).mockResolvedValue(null as never);

    const response = await POST(
      createMockRequest({
        body: { content: "x" },
        method: "POST",
        url: "http://localhost:3002/documents/missing/versions",
      }),
      createMockRouteContext({ id: "missing" })
    );

    expect(response.status).toBe(404);
    expect(mockCreateNewVersion).not.toHaveBeenCalled();
    const json = await response.json();
    expect(json.error).toBe("Artifact not found");
  });

  it("resets the room by default when reset-room is omitted from the query string", async () => {
    const response = await POST(
      createMockRequest({
        body: { content: "Plain update" },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(200);
    // The stored content, not the request's: the service sanitizes it.
    expect(mockResetDocumentRoom).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FEA-42" }),
      mockAuthContext.user.id,
      "Saved content"
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      "[document-room] Resetting room after version create",
      expect.objectContaining({ documentId: "FEA-42" })
    );
    // The success envelope carries the document under `data`. The content-only
    // path returns that document with no inlineImages/versionContent keys:
    // shapeCreateDocumentVersionResponse adds them only when
    // result.inlineImages is non-empty, which createContentOnlyVersion never
    // produces.
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject({ id: "FEA-42" });
    expect(json.data).not.toHaveProperty("inlineImages");
    expect(json.data).not.toHaveProperty("versionContent");
  });

  it("logs the message and keeps the response successful when resetDocumentRoom rejects with an Error", async () => {
    mockResetDocumentRoom.mockRejectedValue(new Error("room reset boom"));

    const response = await POST(
      createMockRequest({
        body: { content: "Plain update" },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(200);
    expect(mockLog.error).toHaveBeenCalledWith(
      "[document-room] Failed to reset room after version create",
      expect.objectContaining({
        documentId: "FEA-42",
        error: "room reset boom",
      })
    );
  });

  it("stringifies a non-Error rejection from resetDocumentRoom rather than reading .message", async () => {
    mockResetDocumentRoom.mockRejectedValue("plain string rejection");

    const response = await POST(
      createMockRequest({
        body: { content: "Plain update" },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(200);
    expect(mockLog.error).toHaveBeenCalledWith(
      "[document-room] Failed to reset room after version create",
      expect.objectContaining({ error: "plain string rejection" })
    );
  });
});

describe("POST /documents/:id/versions — error mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
    mockResetDocumentRoom.mockResolvedValue(undefined);
  });

  it("returns 400 for an unparsable JSON body", async () => {
    const request = new NextRequest(
      "http://localhost:3002/documents/FEA-42/versions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      }
    );

    const response = await POST(
      request,
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Invalid JSON body");
    expect(mockCreateNewVersion).not.toHaveBeenCalled();
  });

  it("falls back to a generic 500 for an unrelated thrown error", async () => {
    mockCreateNewVersion.mockRejectedValue(new Error("db down"));

    const response = await POST(
      createMockRequest({
        body: { content: "Plain update" },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to create new version");
  });

  it("maps a missing content-only document to a 404, never reaching the switch's inline-image cases", async () => {
    mockCreateNewVersion.mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        body: { content: "Update for a deleted document" },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions?reset-room=false",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(404);
    expect(resetDocumentRoom).not.toHaveBeenCalled();
    const json = await response.json();
    expect(json.error).toBe("Artifact not found");
  });

  it("rejects a version request whose body fails schema validation", async () => {
    const response = await POST(
      createMockRequest({
        body: { content: 42 },
        method: "POST",
        url: "http://localhost:3002/documents/FEA-42/versions",
      }),
      createMockRouteContext({ id: "FEA-42" })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(mockCreateNewVersion).not.toHaveBeenCalled();
    expect(mockCreateNewVersionWithInlineImages).not.toHaveBeenCalled();
  });

  it("maps VersionCreationFailed to a 500 carrying the cleanup-failure counts", async () => {
    mockCreateNewVersionWithInlineImages.mockResolvedValue(
      Result.err({
        code: CreateDocumentVersionErrorCode.VersionCreationFailed,
        cleanupFailed: true,
        cleanupFailedCount: 2,
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

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateDocumentVersionErrorCode.VersionCreationFailed,
      success: false,
    });
    expect(json.error).toBe("Failed to create document version");
    // pins current behavior: buildCreateDocumentVersionErrorDetails only
    // carries over fields the upstream error actually set, so an error with
    // just cleanupFailed/cleanupFailedCount must not also leak a
    // placeholder/estimatedContentChars/maxContentChars/requestBodyBytes/
    // maxBytes key.
    expect(json.details).toStrictEqual({
      cleanupFailed: true,
      cleanupFailedCount: 2,
    });
  });

  it("maps InlineImageCreationFailed with no inner error to a generic 500", async () => {
    mockCreateNewVersionWithInlineImages.mockResolvedValue(
      Result.err({
        code: CreateDocumentVersionErrorCode.InlineImageCreationFailed,
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

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json).toMatchObject({
      code: CreateDocumentVersionErrorCode.InlineImageCreationFailed,
      success: false,
    });
    expect(json.error).toBe("Inline image creation failed");
    // pins current behavior: cleanupFailed/cleanupFailedCount are undefined
    // on this error, so details must carry only the placeholder key.
    expect(json.details).toStrictEqual({ placeholder: "[[diagram]]" });
  });
});

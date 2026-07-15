import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import type { ResolveInlineImagesResponse } from "@repo/api/src/types/attachment";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import {
  extractInlineImageAttachmentIds,
  registerGetDocument,
  shapeGetDocumentPayload,
} from "../tools/get-document.js";
import {
  registerListDocuments,
  shapeListDocumentItem,
} from "../tools/list-documents.js";

const routeRow = {
  id: "doc-1",
  title: "Feature",
  slug: "FEA-1031",
  type: DocumentType.Feature,
  status: DocumentStatus.Approved,
  projectId: "project-1",
  assigneeId: "user-1",
  createdAt: "2026-05-13T00:00:00.000Z",
  updatedAt: "2026-05-13T00:00:00.000Z",
  assignee: null,
  project: { name: "Project" },
};

const detailRow = {
  ...routeRow,
  latestVersion: 5,
  version: {
    id: "version-1",
    version: 5,
    createdAt: "2026-05-13T00:00:00.000Z",
    createdById: "user-1",
    content: "hello world",
  },
};

const documentParentProjection = {
  targetId: "doc-1",
  linkId: "link-doc-1",
  linkType: LinkType.Produces,
  linkCreatedAt: "2026-05-13T01:00:00.000Z",
  parentArtifact: {
    id: "parent-doc-1",
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Prd,
    name: "Parent PRD",
    slug: "PRD-100",
    externalUrl: null,
  },
};

const pullRequestParentProjection = {
  targetId: "doc-1",
  linkId: "link-pr-1",
  linkType: LinkType.Produces,
  linkCreatedAt: "2026-05-13T02:00:00.000Z",
  parentArtifact: {
    id: "parent-pr-1",
    type: ArtifactType.Branch,
    subtype: null,
    name: "PR #1170",
    slug: null,
    externalUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1170",
  },
};

const deploymentParentProjection = {
  targetId: "doc-1",
  linkId: "link-deploy-1",
  linkType: LinkType.Produces,
  linkCreatedAt: "2026-05-13T03:00:00.000Z",
  parentArtifact: {
    id: "parent-deploy-1",
    type: ArtifactType.Deployment,
    subtype: null,
    name: "Preview",
    slug: null,
    externalUrl: "https://example.com",
  },
};

const nullParentProjection = {
  targetId: "doc-1",
  linkId: null,
  linkType: null,
  linkCreatedAt: null,
  parentArtifact: null,
};

const INCOMPLETE_TRUNCATED_MARKDOWN_IMAGE_REGEX =
  /!\[[^\]]*]\([^)]*\.\.\.\[truncated]/;

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  isError?: boolean;
}>;

function createToolHarness(
  register: (
    server: {
      registerTool: (
        name: string,
        config: unknown,
        callback: ToolHandler
      ) => void;
    },
    api: ApiClient
  ) => void,
  apiClient: ApiClient
): ToolHandler {
  let handler: ToolHandler | undefined;
  const registerTool = vi.fn(
    (_name: string, _config: unknown, callback: ToolHandler): void => {
      handler = callback;
    }
  );

  register({ registerTool }, apiClient);

  if (!handler) {
    throw new Error("Tool handler was not registered");
  }

  return handler;
}

function parseToolPayload(result: Awaited<ReturnType<ToolHandler>>) {
  if (result.isError) {
    throw new Error(result.content[0]?.text ?? "Tool returned an error");
  }
  return JSON.parse(result.content[0]?.text ?? "null");
}

describe("MCP document parent artifact shaping", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a nested document parent projection for list and detail rows", () => {
    const listPayload = shapeListDocumentItem(
      routeRow,
      documentParentProjection
    );
    const detailPayload = shapeGetDocumentPayload(detailRow, {
      parentProjection: documentParentProjection,
    });

    expect(listPayload).toMatchObject({
      parentArtifact: {
        id: "parent-doc-1",
        type: ArtifactType.Document,
        subtype: ArtifactSubtype.Prd,
        name: "Parent PRD",
        slug: "PRD-100",
        externalUrl: null,
        linkId: "link-doc-1",
        linkType: LinkType.Produces,
        linkCreatedAt: "2026-05-13T01:00:00.000Z",
      },
    });
    expect(detailPayload).toMatchObject({
      parentArtifact: {
        id: "parent-doc-1",
        type: ArtifactType.Document,
        subtype: ArtifactSubtype.Prd,
      },
    });
  });

  it("emits pull-request and deployment parent projections artifact-generically", () => {
    expect(
      shapeListDocumentItem(routeRow, pullRequestParentProjection)
    ).toMatchObject({
      parentArtifact: {
        id: "parent-pr-1",
        type: ArtifactType.Branch,
        subtype: null,
        slug: null,
        externalUrl:
          "https://github.com/closedloop-ai/symphony-alpha/pull/1170",
      },
    });

    expect(
      shapeGetDocumentPayload(detailRow, {
        parentProjection: deploymentParentProjection,
      })
    ).toMatchObject({
      parentArtifact: {
        id: "parent-deploy-1",
        type: ArtifactType.Deployment,
        subtype: null,
        externalUrl: "https://example.com",
      },
    });
  });

  it("surfaces stack-rank sortOrder on list and detail rows", () => {
    expect(
      shapeListDocumentItem({ ...routeRow, sortOrder: 2000 })
    ).toMatchObject({ sortOrder: 2000 });
    expect(
      shapeGetDocumentPayload({ ...detailRow, sortOrder: 2000 })
    ).toMatchObject({ sortOrder: 2000 });
  });

  it("emits null sortOrder when the artifact is unranked", () => {
    // routeRow / detailRow carry no sortOrder, mirroring an unranked artifact.
    expect(shapeListDocumentItem(routeRow)).toMatchObject({ sortOrder: null });
    expect(shapeGetDocumentPayload(detailRow)).toMatchObject({
      sortOrder: null,
    });
  });

  it("emits explicit null parentArtifact for no qualifying direct parent", () => {
    expect(shapeListDocumentItem(routeRow, nullParentProjection)).toMatchObject(
      {
        parentArtifact: null,
      }
    );
    expect(
      shapeGetDocumentPayload(detailRow, {
        parentProjection: nullParentProjection,
      })
    ).toMatchObject({
      parentArtifact: null,
    });
  });

  it("omits parentArtifact when compatibility mode has no projection source", () => {
    const listPayload = shapeListDocumentItem(routeRow);
    const detailPayload = shapeGetDocumentPayload(detailRow);

    expect(listPayload).not.toHaveProperty("parentArtifact");
    expect(detailPayload).not.toHaveProperty("parentArtifact");
  });

  it("does not reintroduce flat document parent fields", () => {
    const payload = shapeGetDocumentPayload(detailRow, {
      parentProjection: pullRequestParentProjection,
    });

    expect(payload).not.toHaveProperty("parentDocumentId");
    expect(payload).not.toHaveProperty("parentArtifactId");
    expect(payload).not.toHaveProperty("parentArtifactType");
    expect(payload).not.toHaveProperty("parentArtifactSubtype");
    expect(payload.version).not.toHaveProperty("parentArtifact");
  });

  it("list-documents fetches parent projections from artifact-link parents endpoint", async () => {
    const apiClient = {
      get: vi
        .fn()
        .mockResolvedValueOnce([routeRow])
        .mockResolvedValueOnce([documentParentProjection]),
    } as unknown as ApiClient;
    const handler = createToolHarness(registerListDocuments, apiClient);

    const result = await handler({ limit: 25, offset: 0 });
    const payload = parseToolPayload(result);

    expect(apiClient.get).toHaveBeenNthCalledWith(1, "/documents", {});
    expect(apiClient.get).toHaveBeenNthCalledWith(
      2,
      "/artifact-links/parents",
      {
        targetIds: ["doc-1"],
        linkType: LinkType.Produces,
      }
    );
    expect(payload.items[0]).toMatchObject({
      id: "doc-1",
      parentArtifact: { id: "parent-doc-1", type: ArtifactType.Document },
    });
  });

  it("list-documents emits null parentArtifact when projection row is missing", async () => {
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce([routeRow]).mockResolvedValueOnce([]),
    } as unknown as ApiClient;
    const handler = createToolHarness(registerListDocuments, apiClient);

    const payload = parseToolPayload(await handler({}));

    expect(payload.items[0]).toMatchObject({
      id: "doc-1",
      parentArtifact: null,
    });
  });

  it("get-document fetches one parent projection after the document row", async () => {
    const apiClient = {
      get: vi
        .fn()
        .mockResolvedValueOnce(detailRow)
        .mockResolvedValueOnce([pullRequestParentProjection]),
    } as unknown as ApiClient;
    const handler = createToolHarness(registerGetDocument, apiClient);

    const payload = parseToolPayload(
      await handler({ documentId: "FEA-1031", includeContent: false })
    );

    expect(apiClient.get).toHaveBeenNthCalledWith(1, "/documents/FEA-1031");
    expect(apiClient.get).toHaveBeenNthCalledWith(
      2,
      "/artifact-links/parents",
      {
        targetIds: ["doc-1"],
        linkType: LinkType.Produces,
      }
    );
    expect(payload).toMatchObject({
      id: "doc-1",
      parentArtifact: {
        id: "parent-pr-1",
        type: ArtifactType.Branch,
      },
    });
  });

  it("omits parentArtifact when older API builds return 404 for parents endpoint", async () => {
    const apiClient = {
      get: vi
        .fn()
        .mockResolvedValueOnce(detailRow)
        .mockRejectedValueOnce(new McpApiError("Not found", { status: 404 })),
    } as unknown as ApiClient;
    const handler = createToolHarness(registerGetDocument, apiClient);

    const payload = parseToolPayload(
      await handler({ documentId: "FEA-1031", includeContent: false })
    );

    expect(payload).not.toHaveProperty("parentArtifact");
  });

  it("skips list-documents parent lookup when includeParentArtifact is false", async () => {
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce([routeRow]),
    } as unknown as ApiClient;
    const handler = createToolHarness(registerListDocuments, apiClient);

    const payload = parseToolPayload(
      await handler({ includeParentArtifact: false })
    );

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(payload.items[0]).not.toHaveProperty("parentArtifact");
  });

  it("skips get-document parent lookup when includeParentArtifact is false", async () => {
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce(detailRow),
    } as unknown as ApiClient;
    const handler = createToolHarness(registerGetDocument, apiClient);

    const payload = parseToolPayload(
      await handler({
        documentId: "FEA-1031",
        includeContent: false,
        includeParentArtifact: false,
      })
    );

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(payload).not.toHaveProperty("parentArtifact");
  });

  it("extracts unique attachment:// inline image references in document order", () => {
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";

    expect(
      extractInlineImageAttachmentIds(
        [
          `![diagram](attachment://${firstId})`,
          `![duplicate](attachment://${firstId} "same")`,
          `![second](attachment://${secondId})`,
          "![external](https://example.com/image.png)",
        ].join("\n")
      )
    ).toEqual([firstId, secondId]);
  });

  it("get-document resolves inline image refs without mutating canonical content", async () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    const content = `Before\n![diagram](attachment://${attachmentId})\nAfter`;
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce({
        ...detailRow,
        version: {
          ...detailRow.version,
          content,
        },
      }),
      post: vi.fn().mockResolvedValueOnce({
        images: [
          {
            attachmentId,
            url: "https://s3.example.com/signed-diagram",
            filename: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 2048,
            expiresAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        skipped: [],
      }),
    } as unknown as ApiClient;
    const handler = createToolHarness(registerGetDocument, apiClient);

    const payload = parseToolPayload(
      await handler({
        documentId: "FEA-1031",
        includeContent: true,
        includeParentArtifact: false,
      })
    );

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents/doc-1/attachments/resolve",
      { attachmentIds: [attachmentId] }
    );
    expect(payload.version.content).toBe(content);
    expect(payload.contentWithResolvedInlineImages).toContain(
      "https://s3.example.com/signed-diagram"
    );
    expect(payload.inlineImages).toEqual([
      {
        attachmentId,
        status: "resolved",
        url: "https://s3.example.com/signed-diagram",
        filename: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("keeps canonical content when default inline image resolution fails", async () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    const content = `Before\n![diagram](attachment://${attachmentId})\nAfter`;
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce({
        ...detailRow,
        version: {
          ...detailRow.version,
          content,
        },
      }),
      post: vi
        .fn()
        .mockRejectedValueOnce(new McpApiError("Not found", { status: 404 })),
    } as unknown as ApiClient;
    const handler = createToolHarness(registerGetDocument, apiClient);

    const payload = parseToolPayload(
      await handler({
        documentId: "FEA-1031",
        includeContent: true,
        includeParentArtifact: false,
      })
    );

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents/doc-1/attachments/resolve",
      { attachmentIds: [attachmentId] }
    );
    expect(payload.version.content).toBe(content);
    expect(payload.contentWithResolvedInlineImages).toBe(content);
    expect(payload.inlineImages).toEqual([
      {
        attachmentId,
        status: "skipped",
        reason: "resolver_unavailable",
      },
    ]);
  });

  it("resolves inline image chunks concurrently", async () => {
    const attachmentIds = Array.from(
      { length: 51 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    );
    const content = attachmentIds
      .map((attachmentId) => `![image](attachment://${attachmentId})`)
      .join("\n");
    let resolveFirstChunk!: (response: ResolveInlineImagesResponse) => void;
    const firstChunkResponse = new Promise<ResolveInlineImagesResponse>(
      (resolve) => {
        resolveFirstChunk = resolve;
      }
    );
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce({
        ...detailRow,
        version: {
          ...detailRow.version,
          content,
        },
      }),
      post: vi
        .fn()
        .mockImplementationOnce(() => firstChunkResponse)
        .mockResolvedValueOnce({
          images: [
            {
              attachmentId: attachmentIds[50],
              expiresAt: "2026-01-01T00:00:00.000Z",
              filename: "tail.png",
              mimeType: "image/png",
              sizeBytes: 2048,
              url: "https://s3.example.com/signed-tail",
            },
          ],
          skipped: [],
        }),
    } as unknown as ApiClient;
    const handler = createToolHarness(registerGetDocument, apiClient);

    const resultPromise = handler({
      documentId: "FEA-1031",
      includeContent: true,
      includeParentArtifact: false,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(apiClient.post).toHaveBeenCalledTimes(2);
    expect(apiClient.post).toHaveBeenNthCalledWith(
      1,
      "/documents/doc-1/attachments/resolve",
      { attachmentIds: attachmentIds.slice(0, 50) }
    );
    expect(apiClient.post).toHaveBeenNthCalledWith(
      2,
      "/documents/doc-1/attachments/resolve",
      { attachmentIds: attachmentIds.slice(50) }
    );

    resolveFirstChunk({
      images: attachmentIds.slice(0, 50).map((attachmentId) => ({
        attachmentId,
        expiresAt: "2026-01-01T00:00:00.000Z",
        filename: `${attachmentId}.png`,
        mimeType: "image/png",
        sizeBytes: 2048,
        url: `https://s3.example.com/${attachmentId}`,
      })),
      skipped: [],
    });

    const payload = parseToolPayload(await resultPromise);
    expect(payload.inlineImages).toHaveLength(51);
    expect(payload.contentWithResolvedInlineImages).toContain(
      "https://s3.example.com/signed-tail"
    );
  });

  it("does not truncate resolved inline image content inside a signed URL", async () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    const content = `Before\n![diagram](attachment://${attachmentId})\nAfter`;
    const signedUrl = `https://s3.example.com/${"a".repeat(300)}/diagram.png`;
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce({
        ...detailRow,
        version: {
          ...detailRow.version,
          content,
        },
      }),
      post: vi.fn().mockResolvedValueOnce({
        images: [
          {
            attachmentId,
            url: signedUrl,
            filename: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 2048,
            expiresAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        skipped: [],
      }),
    } as unknown as ApiClient;
    const handler = createToolHarness(registerGetDocument, apiClient);

    const payload = parseToolPayload(
      await handler({
        documentId: "FEA-1031",
        includeContent: true,
        includeParentArtifact: false,
        contentMaxChars: 200,
      })
    );

    expect(payload.version.content).toBe(content);
    expect(payload.contentWithResolvedInlineImages).toBe(
      "Before\n...[truncated]"
    );
    expect(payload.contentWithResolvedInlineImages).not.toContain(signedUrl);
    expect(payload.contentWithResolvedInlineImages).not.toMatch(
      INCOMPLETE_TRUNCATED_MARKDOWN_IMAGE_REGEX
    );
  });

  it("reports includeImages per-image cap skips in the text payload", async () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    const content = `![large](attachment://${attachmentId})`;
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce({
        ...detailRow,
        version: {
          ...detailRow.version,
          content,
        },
      }),
      post: vi.fn().mockResolvedValueOnce({
        images: [
          {
            attachmentId,
            url: "https://s3.example.com/large",
            filename: "large.png",
            mimeType: "image/png",
            sizeBytes: 3 * 1024 * 1024,
            expiresAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        skipped: [],
      }),
    } as unknown as ApiClient;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const handler = createToolHarness(registerGetDocument, apiClient);

    const result = await handler({
      documentId: "FEA-1031",
      includeContent: true,
      includeImages: true,
      includeParentArtifact: false,
    });
    const payload = parseToolPayload(result);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
    expect(payload.inlineImageBlockSkips).toEqual([
      {
        attachmentId,
        status: "skipped",
        reason: "image_block_too_large",
      },
    ]);
  });

  it("reports includeImages fetch failures in the text payload", async () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    const content = `![missing](attachment://${attachmentId})`;
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce({
        ...detailRow,
        version: {
          ...detailRow.version,
          content,
        },
      }),
      post: vi.fn().mockResolvedValueOnce({
        images: [
          {
            attachmentId,
            url: "https://s3.example.com/missing",
            filename: "missing.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            expiresAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        skipped: [],
      }),
    } as unknown as ApiClient;
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("network failed")
    );
    const handler = createToolHarness(registerGetDocument, apiClient);

    const payload = parseToolPayload(
      await handler({
        documentId: "FEA-1031",
        includeContent: true,
        includeImages: true,
        includeParentArtifact: false,
      })
    );

    expect(payload.inlineImageBlockSkips).toEqual([
      {
        attachmentId,
        status: "skipped",
        reason: "image_block_fetch_failed",
      },
    ]);
  });

  it("logs image-fetch failures with document context without leaking the presigned signature", async () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    const content = `![missing](attachment://${attachmentId})`;
    const signedUrl =
      "https://s3.example.com/attachments/missing.png?X-Amz-Signature=deadbeefsecret&X-Amz-Expires=600";
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce({
        ...detailRow,
        version: {
          ...detailRow.version,
          content,
        },
      }),
      post: vi.fn().mockResolvedValueOnce({
        images: [
          {
            attachmentId,
            url: signedUrl,
            filename: "missing.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            expiresAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        skipped: [],
      }),
    } as unknown as ApiClient;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    } as unknown as Response);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = createToolHarness(registerGetDocument, apiClient);

    await handler({
      documentId: "FEA-1031",
      includeContent: true,
      includeImages: true,
      includeParentArtifact: false,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0]);
    expect(message).toContain(attachmentId);
    expect(message).toContain("FEA-1031");
    expect(message).toContain("HTTP 403 Forbidden");
    expect(message).toContain("https://s3.example.com/attachments/missing.png");
    expect(message).not.toContain("deadbeefsecret");
    expect(message).not.toContain("X-Amz-Signature");
  });

  it("reports includeImages count cap skips in the text payload", async () => {
    const attachmentIds = Array.from(
      { length: 11 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    );
    const content = attachmentIds
      .map((attachmentId) => `![image](attachment://${attachmentId})`)
      .join("\n");
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce({
        ...detailRow,
        version: {
          ...detailRow.version,
          content,
        },
      }),
      post: vi.fn().mockResolvedValueOnce({
        images: attachmentIds.map((attachmentId) => ({
          attachmentId,
          expiresAt: "2026-01-01T00:00:00.000Z",
          filename: `${attachmentId}.png`,
          mimeType: "image/png",
          sizeBytes: 1,
          url: `https://s3.example.com/${attachmentId}`,
        })),
        skipped: [],
      }),
    } as unknown as ApiClient;
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(new Uint8Array([1]), { status: 200 }))
    );
    const handler = createToolHarness(registerGetDocument, apiClient);

    const result = await handler({
      documentId: "FEA-1031",
      includeContent: true,
      includeImages: true,
      includeParentArtifact: false,
    });
    const payload = parseToolPayload(result);

    expect(
      result.content.filter((block) => block.type === "image")
    ).toHaveLength(10);
    expect(payload.inlineImageBlockSkips).toEqual([
      {
        attachmentId: attachmentIds[10],
        status: "skipped",
        reason: "image_block_count_exceeded",
      },
    ]);
  });

  it("reports includeImages aggregate budget skips in the text payload", async () => {
    const attachmentIds = Array.from(
      { length: 4 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    );
    const content = attachmentIds
      .map((attachmentId) => `![image](attachment://${attachmentId})`)
      .join("\n");
    const twoMiB = 2 * 1024 * 1024;
    const apiClient = {
      get: vi.fn().mockResolvedValueOnce({
        ...detailRow,
        version: {
          ...detailRow.version,
          content,
        },
      }),
      post: vi.fn().mockResolvedValueOnce({
        images: attachmentIds.map((attachmentId) => ({
          attachmentId,
          expiresAt: "2026-01-01T00:00:00.000Z",
          filename: `${attachmentId}.png`,
          mimeType: "image/png",
          sizeBytes: twoMiB,
          url: `https://s3.example.com/${attachmentId}`,
        })),
        skipped: [],
      }),
    } as unknown as ApiClient;
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(new Uint8Array(twoMiB), { status: 200 }))
    );
    const handler = createToolHarness(registerGetDocument, apiClient);

    const result = await handler({
      documentId: "FEA-1031",
      includeContent: true,
      includeImages: true,
      includeParentArtifact: false,
    });
    const payload = parseToolPayload(result);

    expect(
      result.content.filter((block) => block.type === "image")
    ).toHaveLength(3);
    expect(payload.inlineImageBlockSkips).toEqual([
      {
        attachmentId: attachmentIds[3],
        status: "skipped",
        reason: "image_block_budget_exceeded",
      },
    ]);
  });
});

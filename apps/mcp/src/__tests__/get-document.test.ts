import { Priority } from "@repo/api/src/types/common.js";
import {
  DocumentType,
  IssueStatus,
  SnapshotSource,
} from "@repo/api/src/types/document.js";
import { TagColor } from "@repo/api/src/types/tag.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import {
  registerGetDocument,
  shapeGetDocumentPayload,
} from "../tools/get-document.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

const baseVersion = {
  id: "ver-1",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdById: "user-1",
  content: "",
};

describe("shapeGetDocumentPayload", () => {
  it("exposes priority, dueDate, fileName, assigneeId, assignee, approverId, approver and repositorySnapshot when present", () => {
    const fixture = {
      id: "doc-1",
      slug: "FEA-100",
      title: "My Feature",
      type: DocumentType.Feature,
      status: IssueStatus.Triage,
      statusMutation: {
        allowedStatuses: [IssueStatus.Triage, IssueStatus.Done],
        expectedStatusField: "expectedStatus",
        expectedStatusByIdField: "expectedStatusById",
      },
      projectId: "project-1",
      priority: Priority.High,
      dueDate: "2026-07-24T00:00:00.000Z",
      fileName: "my-feature.md",
      assigneeId: "019c2991-0bce-76bc-bc7e-a4750929f668",
      assignee: {
        id: "019c2991-0bce-76bc-bc7e-a4750929f668",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: null,
        avatarUrl: null,
      },
      approverId: "019c2991-0bce-76bc-bc7e-a4750929f669",
      approver: {
        id: "019c2991-0bce-76bc-bc7e-a4750929f669",
        email: "bob@example.com",
        firstName: "Bob",
        lastName: null,
        avatarUrl: null,
      },
      tags: [{ id: "tag-1", name: "groomed", color: TagColor.Green }],
      repositorySnapshot: {
        source: SnapshotSource.LoopSelection,
        repositories: [
          { fullName: "org/repo", role: "primary" as const, position: 0 },
        ],
      },
      latestVersion: 1,
      sortOrder: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: baseVersion,
    };

    const result = shapeGetDocumentPayload(fixture);

    expect(result.priority).toBe(Priority.High);
    expect(result.dueDate).toBe("2026-07-24T00:00:00.000Z");
    expect(result.fileName).toBe("my-feature.md");
    expect(result.assigneeId).toBe("019c2991-0bce-76bc-bc7e-a4750929f668");
    expect(result.assignee).toEqual({
      id: "019c2991-0bce-76bc-bc7e-a4750929f668",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: null,
      avatarUrl: null,
    });
    expect(result.approverId).toBe("019c2991-0bce-76bc-bc7e-a4750929f669");
    expect(result.approver).toEqual({
      id: "019c2991-0bce-76bc-bc7e-a4750929f669",
      email: "bob@example.com",
      firstName: "Bob",
      lastName: null,
      avatarUrl: null,
    });
    expect(result.tags).toEqual([
      { id: "tag-1", name: "groomed", color: TagColor.Green },
    ]);
    expect(result.statusMutation).toEqual({
      allowedStatuses: [IssueStatus.Triage, IssueStatus.Done],
      expectedStatusField: "expectedStatus",
      expectedStatusByIdField: "expectedStatusById",
    });
    expect(result.repositorySnapshot).toEqual({
      source: SnapshotSource.LoopSelection,
      repositories: [{ fullName: "org/repo", role: "primary", position: 0 }],
    });
  });

  it("returns null for priority, dueDate, fileName, assigneeId, assignee, approverId, approver and repositorySnapshot when absent", () => {
    const fixture = {
      id: "doc-1",
      slug: "FEA-101",
      title: "Minimal Feature",
      type: DocumentType.Feature,
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: baseVersion,
    };

    const result = shapeGetDocumentPayload(fixture);

    expect(result.priority).toBeNull();
    expect(result.dueDate).toBeNull();
    expect(result.fileName).toBeNull();
    expect(result.assigneeId).toBeNull();
    expect(result.assignee).toBeNull();
    expect(result.approverId).toBeNull();
    expect(result.approver).toBeNull();
    expect(result.tags).toEqual([]);
    expect(result.repositorySnapshot).toBeNull();
    expect(Object.hasOwn(result, "statusMutation")).toBe(false);
  });

  it("preserves empty tags when the API returns no tag relations", () => {
    const fixture = {
      id: "doc-1",
      slug: "FEA-102",
      title: "Untagged Feature",
      type: DocumentType.Feature,
      tags: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: baseVersion,
    };

    const result = shapeGetDocumentPayload(fixture);

    expect(result.tags).toEqual([]);
  });

  it("unwraps a { data: … } API envelope before reading document fields", () => {
    const inner = {
      id: "doc-wrapped",
      slug: "ISS-5",
      title: "Wrapped Document",
      type: DocumentType.Feature,
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: baseVersion,
    };

    const result = shapeGetDocumentPayload({ data: inner });

    expect(result.id).toBe("doc-wrapped");
    expect(result.slug).toBe("ISS-5");
    expect(result.title).toBe("Wrapped Document");
  });

  it.each([
    {
      name: "empty",
      content: "",
      limit: 4,
      expectedContent: "",
      expectedLength: 0,
      expectedReturned: 0,
      expectedTruncated: false,
    },
    {
      name: "exactly at the limit",
      content: "abcd",
      limit: 4,
      expectedContent: "abcd",
      expectedLength: 4,
      expectedReturned: 4,
      expectedTruncated: false,
    },
    {
      name: "one UTF-16 code unit over the limit",
      content: "abcde",
      limit: 4,
      expectedContent: "abcd...[truncated]",
      expectedLength: 5,
      expectedReturned: 4,
      expectedTruncated: true,
    },
    {
      name: "astral and CJK content with a custom limit",
      content: "😀漢",
      limit: 2,
      expectedContent: "😀...[truncated]",
      expectedLength: 3,
      expectedReturned: 2,
      expectedTruncated: true,
    },
  ])(
    "reports source-body completeness for $name",
    ({
      content,
      limit,
      expectedContent,
      expectedLength,
      expectedReturned,
      expectedTruncated,
    }) => {
      const result = shapeGetDocumentPayload(
        { version: { ...baseVersion, content } },
        { includeContent: true, contentMaxChars: limit }
      );

      expect(result.version.content).toBe(expectedContent);
      expect(result.version.contentLength).toBe(expectedLength);
      expect(result.version.returnedChars).toBe(expectedReturned);
      expect(result.version.contentTruncated).toBe(expectedTruncated);
      expect(result.version.returnedChars).toBeLessThanOrEqual(limit);
      if (expectedTruncated) {
        expect(result.version.content?.endsWith("...[truncated]")).toBe(true);
        expect(result.version.content?.length).toBeGreaterThan(limit);
      } else {
        expect(result.version.content?.endsWith("...[truncated]")).toBe(false);
      }
    }
  );

  it("omits completeness fields when source content is not requested", () => {
    const result = shapeGetDocumentPayload({
      version: { ...baseVersion, content: "abcde" },
    });

    expect(result.version.contentLength).toBe(5);
    expect(result.version).not.toHaveProperty("content");
    expect(result.version).not.toHaveProperty("contentTruncated");
    expect(result.version).not.toHaveProperty("returnedChars");
  });

  it("keeps completeness metadata scoped to source content, not resolved inline-image content", () => {
    const source = `![img](attachment://${MOCK_ATTACHMENT_ID})`;
    const result = shapeGetDocumentPayload(
      { version: { ...baseVersion, content: source } },
      {
        includeContent: true,
        contentMaxChars: source.length,
        contentWithResolvedInlineImages:
          "![img](https://example.com/a-much-longer-signed-image-url)",
      }
    );

    expect(result.version.contentLength).toBe(source.length);
    expect(result.version.returnedChars).toBe(source.length);
    expect(result.version.contentTruncated).toBe(false);
    expect(result.contentWithResolvedInlineImages).toContain("https://");
  });
});

const MOCK_ATTACHMENT_ID = "00000000-0000-0000-0000-000000000001";
const CONTENT_WITH_INLINE_IMAGE = `![img](attachment://${MOCK_ATTACHMENT_ID})`;

function makeGetDocumentHandler() {
  const getMock = vi.fn();
  const postMock = vi.fn();
  const apiClient = { get: getMock, post: postMock } as unknown as ApiClient;
  const handler = createToolHarness(registerGetDocument, apiClient);
  return { handler, getMock, postMock };
}

describe("registerGetDocument tool handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips the parent-links call when the document response has no id", async () => {
    const { handler, getMock } = makeGetDocumentHandler();
    getMock.mockResolvedValue({ slug: "FEA-1", version: {} });

    const result = await handler({ documentId: "FEA-1" });

    expect(result.isError).not.toBe(true);
    // fetchParentProjection is called with null and returns null immediately without an extra get
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("uses a null parentArtifact when the parent-links response returns no match", async () => {
    const { handler, getMock } = makeGetDocumentHandler();
    getMock.mockImplementation((path: string) => {
      if (path.includes("artifact-links")) {
        return Promise.resolve([]);
      }
      return Promise.resolve({ id: "doc-1", slug: "FEA-1", version: {} });
    });

    const result = await handler({ documentId: "doc-1" });

    expect(result.isError).not.toBe(true);
    const payload = parseToolPayload(result) as Record<string, unknown>;
    expect(payload.parentArtifact).toBeNull();
  });

  it("omits parentArtifact from the payload when the parent-links endpoint returns 404", async () => {
    const { handler, getMock } = makeGetDocumentHandler();
    getMock.mockImplementation((path: string) => {
      if (path.includes("artifact-links")) {
        throw new McpApiError("Not found", { status: 404 });
      }
      return Promise.resolve({ id: "doc-1", slug: "FEA-1", version: {} });
    });

    const result = await handler({ documentId: "doc-1" });

    expect(result.isError).not.toBe(true);
    const payload = parseToolPayload(result) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("parentArtifact");
  });

  it("propagates non-404 errors from the parent-links endpoint as a tool error", async () => {
    const { handler, getMock } = makeGetDocumentHandler();
    getMock.mockImplementation((path: string) => {
      if (path.includes("artifact-links")) {
        throw new McpApiError("Server error", { status: 500 });
      }
      return Promise.resolve({ id: "doc-1", slug: "FEA-1", version: {} });
    });

    const result = await handler({ documentId: "doc-1" });

    expect(result.isError).toBe(true);
  });

  it("omits inlineImages and contentWithResolvedInlineImages when resolveInlineImages is false", async () => {
    const { handler, getMock } = makeGetDocumentHandler();
    getMock.mockResolvedValue({
      id: "doc-1",
      slug: "FEA-1",
      version: { content: CONTENT_WITH_INLINE_IMAGE },
    });

    const result = await handler({
      documentId: "doc-1",
      includeContent: true,
      resolveInlineImages: false,
      includeParentArtifact: false,
    });

    expect(result.isError).not.toBe(true);
    const payload = parseToolPayload(result) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("inlineImages");
    expect(payload).not.toHaveProperty("contentWithResolvedInlineImages");
  });

  it("treats non-array images and skipped fields in the resolve response as empty lists", async () => {
    const { handler, getMock, postMock } = makeGetDocumentHandler();
    getMock.mockResolvedValue({
      id: "doc-1",
      slug: "FEA-1",
      version: { content: CONTENT_WITH_INLINE_IMAGE },
    });
    postMock.mockResolvedValue({ images: null, skipped: null });

    const result = await handler({
      documentId: "doc-1",
      includeContent: true,
      includeParentArtifact: false,
    });

    expect(result.isError).not.toBe(true);
    const payload = parseToolPayload(result) as {
      inlineImages: Array<{ reason: string }>;
    };
    expect(payload.inlineImages[0].reason).toBe("not_found");
  });

  it("classifies a non-404 resolve API error as resolve_failed in the inline image manifest", async () => {
    const { handler, getMock, postMock } = makeGetDocumentHandler();
    getMock.mockResolvedValue({
      id: "doc-1",
      slug: "FEA-1",
      version: { content: CONTENT_WITH_INLINE_IMAGE },
    });
    postMock.mockRejectedValue(new Error("Network timeout"));

    const result = await handler({
      documentId: "doc-1",
      includeContent: true,
      includeParentArtifact: false,
    });

    expect(result.isError).not.toBe(true);
    const payload = parseToolPayload(result) as {
      inlineImages: Array<{ reason: string }>;
    };
    expect(payload.inlineImages[0].reason).toBe("resolve_failed");
  });

  it("marks an oversized image as skipped before fetching it", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { handler, getMock, postMock } = makeGetDocumentHandler();
    getMock.mockResolvedValue({
      id: "doc-1",
      slug: "FEA-1",
      version: { content: CONTENT_WITH_INLINE_IMAGE },
    });
    postMock.mockResolvedValue({
      images: [
        {
          attachmentId: MOCK_ATTACHMENT_ID,
          url: "https://example.com/img.png",
          filename: "img.png",
          mimeType: "image/png",
          sizeBytes: 3 * 1024 * 1024,
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
      ],
      skipped: [],
    });

    const result = await handler({
      documentId: "doc-1",
      includeContent: true,
      includeImages: true,
      includeParentArtifact: false,
    });

    expect(result.isError).not.toBe(true);
    const payload = parseToolPayload(result) as {
      inlineImageBlockSkips: Array<{ attachmentId: string; reason: string }>;
    };
    expect(payload.inlineImageBlockSkips).toEqual([
      expect.objectContaining({
        attachmentId: MOCK_ATTACHMENT_ID,
        reason: "image_block_too_large",
      }),
    ]);
    // fetch should NOT have been called for the oversized image
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

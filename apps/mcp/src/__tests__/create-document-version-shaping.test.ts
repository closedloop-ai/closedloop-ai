/**
 * Branch coverage for the private shaping functions inside
 * create-document-version.ts.  All shaping logic is private, so we drive it
 * through the public `registerCreateDocumentVersion` handler using the shared
 * tool-harness fixture.
 *
 * Each test controls what `apiClient.post` returns and asserts on the
 * parsed output — key presence, key absence, and value correctness.
 */

import {
  AttachmentPurpose,
  INLINE_ATTACHMENT_REF_PREFIX,
} from "@repo/api/src/types/attachment.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerCreateDocumentVersion } from "../tools/create-document-version.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

const mockPost = vi.fn();
const apiClient = { post: mockPost } as unknown as ApiClient;
const handler = createToolHarness(registerCreateDocumentVersion, apiClient);

const BASE_INPUT = { documentId: "DOC-1", content: "body" };

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// readNullableStringProp — null / missing arms
// ---------------------------------------------------------------------------

describe("readNullableStringProp", () => {
  it("includes the key with null when the API returns an explicit null", async () => {
    mockPost.mockResolvedValueOnce({ projectId: null, assigneeId: null });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).toHaveProperty("projectId", null);
    expect(output).toHaveProperty("assigneeId", null);
  });

  it("omits the key when the API value is absent (undefined)", async () => {
    // Returning an empty object means all nullable-string keys are absent
    mockPost.mockResolvedValueOnce({});

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).not.toHaveProperty("projectId");
    expect(output).not.toHaveProperty("assigneeId");
  });
});

// ---------------------------------------------------------------------------
// readNullableNumberProp — null / missing arms
// ---------------------------------------------------------------------------

describe("readNullableNumberProp (sortOrder)", () => {
  it("includes sortOrder as null when the API returns null", async () => {
    mockPost.mockResolvedValueOnce({ sortOrder: null });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).toHaveProperty("sortOrder", null);
  });

  it("omits sortOrder when the API does not return a number", async () => {
    mockPost.mockResolvedValueOnce({ sortOrder: "not-a-number" });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).not.toHaveProperty("sortOrder");
  });
});

// ---------------------------------------------------------------------------
// readOptionalUnknownProp — present / absent arms
// ---------------------------------------------------------------------------

describe("readOptionalUnknownProp (createdBy, assignee, approver)", () => {
  it("includes the key when the API value is present (even as an object)", async () => {
    mockPost.mockResolvedValueOnce({
      createdBy: { id: "u1", email: "u@example.com" },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).toHaveProperty("createdBy");
    expect((output.createdBy as { id: string }).id).toBe("u1");
  });

  it("omits the key when the API value is absent (undefined)", async () => {
    mockPost.mockResolvedValueOnce({});

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).not.toHaveProperty("createdBy");
    expect(output).not.toHaveProperty("assignee");
    expect(output).not.toHaveProperty("approver");
  });
});

// ---------------------------------------------------------------------------
// readOptionalUnknownArrayProp — array / non-array arms
// ---------------------------------------------------------------------------

describe("readOptionalUnknownArrayProp (customFields, tags)", () => {
  it("includes customFields when the API returns an array", async () => {
    mockPost.mockResolvedValueOnce({ customFields: [{ key: "priority" }] });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).toHaveProperty("customFields");
    expect(Array.isArray(output.customFields)).toBe(true);
  });

  it("omits tags when the API returns a non-array value", async () => {
    mockPost.mockResolvedValueOnce({ tags: "not-an-array" });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).not.toHaveProperty("tags");
  });
});

// ---------------------------------------------------------------------------
// readNullableString / versionContent / latestVersionContent
// ---------------------------------------------------------------------------

describe("versionContent and latestVersionContent", () => {
  it("includes versionContent from the primary field when present", async () => {
    mockPost.mockResolvedValueOnce({
      versionContent: "v2-body",
      latestVersionContent: "old-body",
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output.versionContent).toBe("v2-body");
  });

  it("falls back to latestVersionContent when versionContent is absent", async () => {
    mockPost.mockResolvedValueOnce({ latestVersionContent: "old-body" });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output.versionContent).toBe("old-body");
  });

  it("omits versionContent when neither field is present", async () => {
    mockPost.mockResolvedValueOnce({});

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).not.toHaveProperty("versionContent");
  });

  it("includes latestVersionContent as null when the API returns null (readNullableString null arm)", async () => {
    mockPost.mockResolvedValueOnce({ latestVersionContent: null });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).toHaveProperty("latestVersionContent", null);
  });

  it("omits latestVersionContent when the API does not include it", async () => {
    mockPost.mockResolvedValueOnce({});

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).not.toHaveProperty("latestVersionContent");
  });
});

// ---------------------------------------------------------------------------
// shapeDocumentVersion — empty vs non-empty
// ---------------------------------------------------------------------------

describe("shapeDocumentVersion (version field)", () => {
  it("includes version when the API returns a non-empty version object", async () => {
    mockPost.mockResolvedValueOnce({
      version: { id: "ver-1", documentId: "DOC-1", version: 3 },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).toHaveProperty("version");
    const version = output.version as Record<string, unknown>;
    expect(version.id).toBe("ver-1");
    expect(version.version).toBe(3);
  });

  it("omits version when the API returns an empty object", async () => {
    mockPost.mockResolvedValueOnce({ version: {} });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).not.toHaveProperty("version");
  });

  it("includes version.content as null when the API version record has a null content", async () => {
    mockPost.mockResolvedValueOnce({
      version: { id: "ver-2", content: null },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect((output.version as Record<string, unknown>).content).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shapeCreatedInlineImages — non-array / array
// ---------------------------------------------------------------------------

describe("shapeCreatedInlineImages (inlineImages field)", () => {
  it("omits inlineImages when the API does not return an array", async () => {
    mockPost.mockResolvedValueOnce({ inlineImages: null });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output).not.toHaveProperty("inlineImages");
  });

  it("includes shaped inlineImages entries when the API returns an array", async () => {
    mockPost.mockResolvedValueOnce({
      inlineImages: [
        {
          placeholder: "{{IMG}}",
          attachmentId: "att-1",
          attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}att-1`,
          markdownImage: `![photo](${INLINE_ATTACHMENT_REF_PREFIX}att-1)`,
          attachment: {
            id: "att-1",
            artifactId: "doc-id",
            filename: "photo.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            purpose: AttachmentPurpose.Inline,
            createdAt: "2024-01-01T00:00:00Z",
            createdById: "u1",
          },
        },
      ],
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(Array.isArray(output.inlineImages)).toBe(true);
    const images = output.inlineImages as Record<string, unknown>[];
    expect(images).toHaveLength(1);
    expect(images[0]?.placeholder).toBe("{{IMG}}");
    expect(images[0]?.attachmentId).toBe("att-1");
  });
});

// ---------------------------------------------------------------------------
// resolveAttachmentRef — prefix present / prefix missing
// ---------------------------------------------------------------------------

describe("resolveAttachmentRef (inlineImages attachmentRef)", () => {
  it("keeps the API attachmentRef when it already carries the attachment:// prefix", async () => {
    const existingRef = `${INLINE_ATTACHMENT_REF_PREFIX}existing-id`;
    mockPost.mockResolvedValueOnce({
      inlineImages: [
        {
          placeholder: "{{IMG}}",
          attachmentId: "att-1",
          attachmentRef: existingRef,
          markdownImage: `![img](${existingRef})`,
          attachment: {
            id: "att-1",
            artifactId: null,
            filename: "x.jpg",
            mimeType: "image/jpeg",
            sizeBytes: null,
            purpose: AttachmentPurpose.Inline,
            createdAt: null,
            createdById: null,
          },
        },
      ],
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const images = output.inlineImages as Record<string, unknown>[];
    expect(images[0]?.attachmentRef).toBe(existingRef);
  });

  it("builds attachmentRef from attachmentId when the API value lacks the prefix", async () => {
    mockPost.mockResolvedValueOnce({
      inlineImages: [
        {
          placeholder: "{{IMG}}",
          attachmentId: "att-2",
          attachmentRef: "no-prefix-ref",
          markdownImage: `![img](${INLINE_ATTACHMENT_REF_PREFIX}att-2)`,
          attachment: {
            id: "att-2",
            artifactId: null,
            filename: "y.png",
            mimeType: "image/png",
            sizeBytes: null,
            purpose: AttachmentPurpose.Inline,
            createdAt: null,
            createdById: null,
          },
        },
      ],
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const images = output.inlineImages as Record<string, unknown>[];
    expect(images[0]?.attachmentRef).toBe(
      `${INLINE_ATTACHMENT_REF_PREFIX}att-2`
    );
  });
});

// ---------------------------------------------------------------------------
// readImageMimeType — valid / invalid
// ---------------------------------------------------------------------------

describe("readImageMimeType (inlineImages attachment.mimeType)", () => {
  it("uses the API mimeType when it is a supported image MIME type", async () => {
    mockPost.mockResolvedValueOnce({
      inlineImages: [
        {
          placeholder: "{{IMG}}",
          attachmentId: "att-3",
          attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}att-3`,
          markdownImage: `![img](${INLINE_ATTACHMENT_REF_PREFIX}att-3)`,
          attachment: {
            id: "att-3",
            artifactId: null,
            filename: "z.webp",
            mimeType: "image/webp",
            sizeBytes: null,
            purpose: AttachmentPurpose.Inline,
            createdAt: null,
            createdById: null,
          },
        },
      ],
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const att = (output.inlineImages as Record<string, unknown>[])[0]
      ?.attachment as Record<string, unknown>;
    expect(att.mimeType).toBe("image/webp");
  });

  it("falls back to image/png when the API returns an unsupported MIME type", async () => {
    mockPost.mockResolvedValueOnce({
      inlineImages: [
        {
          placeholder: "{{IMG}}",
          attachmentId: "att-4",
          attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}att-4`,
          markdownImage: `![img](${INLINE_ATTACHMENT_REF_PREFIX}att-4)`,
          attachment: {
            id: "att-4",
            artifactId: null,
            filename: "z.bmp",
            mimeType: "image/bmp",
            sizeBytes: null,
            purpose: AttachmentPurpose.Inline,
            createdAt: null,
            createdById: null,
          },
        },
      ],
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const att = (output.inlineImages as Record<string, unknown>[])[0]
      ?.attachment as Record<string, unknown>;
    expect(att.mimeType).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// readAttachmentPurpose — context / default-inline arms
// ---------------------------------------------------------------------------

describe("readAttachmentPurpose (inlineImages attachment.purpose)", () => {
  it("returns AttachmentPurpose.Context when the API returns 'context'", async () => {
    mockPost.mockResolvedValueOnce({
      inlineImages: [
        {
          placeholder: "{{IMG}}",
          attachmentId: "att-5",
          attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}att-5`,
          markdownImage: `![img](${INLINE_ATTACHMENT_REF_PREFIX}att-5)`,
          attachment: {
            id: "att-5",
            artifactId: null,
            filename: "ctx.png",
            mimeType: "image/png",
            sizeBytes: null,
            purpose: AttachmentPurpose.Context,
            createdAt: null,
            createdById: null,
          },
        },
      ],
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const att = (output.inlineImages as Record<string, unknown>[])[0]
      ?.attachment as Record<string, unknown>;
    expect(att.purpose).toBe(AttachmentPurpose.Context);
  });

  it("returns AttachmentPurpose.Inline as the default for unknown purpose values", async () => {
    mockPost.mockResolvedValueOnce({
      inlineImages: [
        {
          placeholder: "{{IMG}}",
          attachmentId: "att-6",
          attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}att-6`,
          markdownImage: `![img](${INLINE_ATTACHMENT_REF_PREFIX}att-6)`,
          attachment: {
            id: "att-6",
            artifactId: null,
            filename: "u.png",
            mimeType: "image/png",
            sizeBytes: null,
            purpose: "unknown-purpose",
            createdAt: null,
            createdById: null,
          },
        },
      ],
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const att = (output.inlineImages as Record<string, unknown>[])[0]
      ?.attachment as Record<string, unknown>;
    expect(att.purpose).toBe(AttachmentPurpose.Inline);
  });
});

/**
 * Branch coverage for the private shaping functions inside
 * create-inline-image-attachment.ts.  All shaping logic is private, so we
 * drive it through the public `registerCreateInlineImageAttachment` handler
 * using the shared tool-harness fixture.
 *
 * Covered arms:
 *   - attachmentId: primary top-level field used when present
 *   - attachmentId: fallback to attachment.id via ?? operator
 *   - filename: from API attachment.filename when present
 *   - filename: fallback to input.filename when absent
 *   - mimeType: from API when it is a valid ImageMimeType
 *   - mimeType: fallback to input.mimeType when API value is unsupported
 *   - attachment.id: from API attachment record when present
 *   - attachment.id: fallback to attachmentId when absent in record
 *   - resolveAttachmentRef: retains API ref that already has the prefix
 *   - resolveAttachmentRef: builds ref via buildInlineAttachmentRef when prefix absent
 *   - readAttachmentPurpose: returns AttachmentPurpose.Inline as default for unknown value
 */

import {
  AttachmentPurpose,
  INLINE_ATTACHMENT_REF_PREFIX,
} from "@repo/api/src/types/attachment.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerCreateInlineImageAttachment } from "../tools/create-inline-image-attachment.js";
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
const handler = createToolHarness(
  registerCreateInlineImageAttachment,
  apiClient
);

const BASE_INPUT = {
  entityId: "DOC-1",
  filename: "input-photo.png",
  mimeType: "image/png",
  dataBase64: "base64encodedimage",
};

const BASE_ATTACHMENT = {
  id: "att-base",
  artifactId: null,
  filename: "api-file.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 512,
  purpose: AttachmentPurpose.Inline,
  createdAt: "2024-01-01T00:00:00Z",
  createdById: "user-1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// attachmentId resolution — primary field vs ?? fallback
// ---------------------------------------------------------------------------

describe("attachmentId resolution", () => {
  it("uses resultRecord.attachmentId when it is present (primary field)", async () => {
    mockPost.mockResolvedValueOnce({
      attachmentId: "top-level-id",
      attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}top-level-id`,
      attachment: { ...BASE_ATTACHMENT, id: "record-id" },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output.attachmentId).toBe("top-level-id");
  });

  it("falls back to attachment.id when resultRecord.attachmentId is absent", async () => {
    // No top-level `attachmentId` → fallback via ?? to attachment.id
    mockPost.mockResolvedValueOnce({
      attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}record-id`,
      attachment: { ...BASE_ATTACHMENT, id: "record-id" },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output.attachmentId).toBe("record-id");
  });
});

// ---------------------------------------------------------------------------
// attachment.id — record id vs attachmentId fallback
// ---------------------------------------------------------------------------

describe("attachment.id resolution", () => {
  it("uses attachment.id from the API record when present", async () => {
    mockPost.mockResolvedValueOnce({
      attachmentId: "att-1",
      attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}att-1`,
      attachment: { ...BASE_ATTACHMENT, id: "distinct-record-id" },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const attachment = output.attachment as Record<string, unknown>;
    expect(attachment.id).toBe("distinct-record-id");
  });

  it("falls back to attachmentId when attachment.id is absent from the record", async () => {
    const { id: _id, ...attachmentWithoutId } = BASE_ATTACHMENT;
    mockPost.mockResolvedValueOnce({
      attachmentId: "fallback-id",
      attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}fallback-id`,
      attachment: attachmentWithoutId,
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const attachment = output.attachment as Record<string, unknown>;
    // readString(undefined) → null; null ?? attachmentId → attachmentId
    expect(attachment.id).toBe("fallback-id");
  });
});

// ---------------------------------------------------------------------------
// filename — API value vs input fallback
// ---------------------------------------------------------------------------

describe("filename resolution", () => {
  it("uses attachment.filename from the API when present", async () => {
    mockPost.mockResolvedValueOnce({
      attachmentId: "att-1",
      attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}att-1`,
      attachment: { ...BASE_ATTACHMENT, filename: "api-provided.jpg" },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const attachment = output.attachment as Record<string, unknown>;
    expect(attachment.filename).toBe("api-provided.jpg");
  });

  it("falls back to input.filename when attachment.filename is absent", async () => {
    const { filename: _fn, ...attachmentWithoutFilename } = BASE_ATTACHMENT;
    mockPost.mockResolvedValueOnce({
      attachmentId: "att-1",
      attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}att-1`,
      attachment: attachmentWithoutFilename,
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const attachment = output.attachment as Record<string, unknown>;
    expect(attachment.filename).toBe(BASE_INPUT.filename);
  });
});

// ---------------------------------------------------------------------------
// mimeType — API value vs input fallback
// ---------------------------------------------------------------------------

describe("mimeType resolution", () => {
  it("uses attachment.mimeType from the API when it is a supported image type", async () => {
    mockPost.mockResolvedValueOnce({
      attachmentId: "att-1",
      attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}att-1`,
      attachment: { ...BASE_ATTACHMENT, mimeType: "image/gif" },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const attachment = output.attachment as Record<string, unknown>;
    expect(attachment.mimeType).toBe("image/gif");
  });

  it("falls back to input.mimeType when the API returns an unsupported MIME type", async () => {
    mockPost.mockResolvedValueOnce({
      attachmentId: "att-1",
      attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}att-1`,
      attachment: { ...BASE_ATTACHMENT, mimeType: "image/tiff" },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const attachment = output.attachment as Record<string, unknown>;
    // input.mimeType is "image/png" (from BASE_INPUT)
    expect(attachment.mimeType).toBe(BASE_INPUT.mimeType);
  });
});

// ---------------------------------------------------------------------------
// resolveAttachmentRef — prefix present vs absent
// ---------------------------------------------------------------------------

describe("resolveAttachmentRef", () => {
  it("retains the API attachmentRef when it already starts with attachment://", async () => {
    const existingRef = `${INLINE_ATTACHMENT_REF_PREFIX}already-valid`;
    mockPost.mockResolvedValueOnce({
      attachmentId: "att-1",
      attachmentRef: existingRef,
      attachment: BASE_ATTACHMENT,
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output.attachmentRef).toBe(existingRef);
  });

  it("builds the attachmentRef via buildInlineAttachmentRef when the API value lacks the prefix", async () => {
    mockPost.mockResolvedValueOnce({
      attachmentId: "att-built",
      attachmentRef: "no-prefix-here",
      attachment: BASE_ATTACHMENT,
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    expect(output.attachmentRef).toBe(
      `${INLINE_ATTACHMENT_REF_PREFIX}att-built`
    );
  });
});

// ---------------------------------------------------------------------------
// readAttachmentPurpose — default arm
// ---------------------------------------------------------------------------

it("returns AttachmentPurpose.Inline as default when the API purpose is unrecognised", async () => {
  mockPost.mockResolvedValueOnce({
    attachmentId: "att-1",
    attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}att-1`,
    attachment: { ...BASE_ATTACHMENT, purpose: "unrecognised-purpose" },
  });

  const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
    string,
    unknown
  >;

  const attachment = output.attachment as Record<string, unknown>;
  expect(attachment.purpose).toBe(AttachmentPurpose.Inline);
});

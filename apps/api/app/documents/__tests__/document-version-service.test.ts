import {
  AttachmentPurpose,
  CreateInlineImageAttachmentErrorCode,
  type CreateInlineImageAttachmentResponse,
  INLINE_ATTACHMENT_REF_PREFIX,
} from "@repo/api/src/types/attachment";
import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  CreateDocumentVersionErrorCode,
  type CreateDocumentVersionInlineImageInput,
  MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS,
} from "@repo/api/src/types/document-version";
import { Result } from "@repo/api/src/types/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateInlineImageAttachment = vi.hoisted(() => vi.fn());
const mockDeleteAttachment = vi.hoisted(() => vi.fn());

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../attachments-service", () => ({
  attachmentsService: {
    createInlineImageAttachment: mockCreateInlineImageAttachment,
    deleteAttachment: mockDeleteAttachment,
  },
}));

import { documentVersionService } from "../document-version-service";

const DOCUMENT_ID = "doc-1";
const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";

describe("documentVersionService.createNewVersionWithInlineImages", () => {
  let createNewVersionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    createNewVersionSpy = vi.spyOn(documentVersionService, "createNewVersion");
  });

  afterEach(() => {
    createNewVersionSpy.mockRestore();
  });

  it("creates inline attachments and replaces every placeholder occurrence in the saved version content", async () => {
    mockCreateInlineImageAttachment
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-1", "one.png"))
      )
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-2", "two.png"))
      );

    createNewVersionSpy.mockImplementation(
      async (
        _id: string,
        _organizationId: string,
        _userId: string | null,
        content: string
      ) => makeDocumentDetail(content)
    );

    const result =
      await documentVersionService.createNewVersionWithInlineImages(
        DOCUMENT_ID,
        ORGANIZATION_ID,
        USER_ID,
        "Before [[first]] between [[second]] repeat [[first]] after",
        [
          {
            altText: "Primary ]\ndiagram",
            dataBase64: "Zmlyc3Q=",
            filename: "one.png",
            mimeType: "image/png",
            placeholder: "[[first]]",
          },
          {
            altText: "Second diagram",
            dataBase64: "c2Vjb25k",
            filename: "two.png",
            mimeType: "image/png",
            placeholder: "[[second]]",
          },
        ]
      );

    const expectedContent =
      "Before ![Primary \\] diagram](attachment://attachment-1) between ![Second diagram](attachment://attachment-2) repeat ![Primary \\] diagram](attachment://attachment-1) after";

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.versionContent).toBe(expectedContent);
    expect(createNewVersionSpy).toHaveBeenCalledWith(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      USER_ID,
      expectedContent
    );
    expect(result.value.inlineImages).toEqual([
      expect.objectContaining({
        attachmentId: "attachment-1",
        attachmentRef: "attachment://attachment-1",
        markdownImage: "![Primary \\] diagram](attachment://attachment-1)",
        placeholder: "[[first]]",
      }),
      expect.objectContaining({
        attachmentId: "attachment-2",
        attachmentRef: "attachment://attachment-2",
        markdownImage: "![Second diagram](attachment://attachment-2)",
        placeholder: "[[second]]",
      }),
    ]);
    expect(mockDeleteAttachment).not.toHaveBeenCalled();
  });

  it("rejects duplicate placeholders before any upload side effects", async () => {
    const result =
      await documentVersionService.createNewVersionWithInlineImages(
        DOCUMENT_ID,
        ORGANIZATION_ID,
        USER_ID,
        "Content [[image]]",
        [makeInlineImageInput("[[image]]"), makeInlineImageInput("[[image]]")]
      );

    expect(result).toEqual(
      Result.err({
        code: CreateDocumentVersionErrorCode.DuplicateInlineImagePlaceholder,
        placeholder: "[[image]]",
      })
    );
    expect(mockCreateInlineImageAttachment).not.toHaveBeenCalled();
    expect(mockDeleteAttachment).not.toHaveBeenCalled();
    expect(createNewVersionSpy).not.toHaveBeenCalled();
  });

  it("rejects missing placeholders before any upload side effects", async () => {
    const result =
      await documentVersionService.createNewVersionWithInlineImages(
        DOCUMENT_ID,
        ORGANIZATION_ID,
        USER_ID,
        "Content without marker",
        [makeInlineImageInput("[[missing]]")]
      );

    expect(result).toEqual(
      Result.err({
        code: CreateDocumentVersionErrorCode.MissingInlineImagePlaceholder,
        placeholder: "[[missing]]",
      })
    );
    expect(mockCreateInlineImageAttachment).not.toHaveBeenCalled();
    expect(mockDeleteAttachment).not.toHaveBeenCalled();
    expect(createNewVersionSpy).not.toHaveBeenCalled();
  });

  it("rejects overlapping placeholders before any upload side effects", async () => {
    const result =
      await documentVersionService.createNewVersionWithInlineImages(
        DOCUMENT_ID,
        ORGANIZATION_ID,
        USER_ID,
        "Content [[image]]-detail",
        [
          makeInlineImageInput("[[image]]"),
          makeInlineImageInput("[[image]]-detail"),
        ]
      );

    expect(result).toEqual(
      Result.err({
        code: CreateDocumentVersionErrorCode.OverlappingInlineImagePlaceholder,
        placeholder: "[[image]]",
      })
    );
    expect(mockCreateInlineImageAttachment).not.toHaveBeenCalled();
    expect(mockDeleteAttachment).not.toHaveBeenCalled();
    expect(createNewVersionSpy).not.toHaveBeenCalled();
  });

  it("rejects empty placeholders before any upload side effects", async () => {
    const result =
      await documentVersionService.createNewVersionWithInlineImages(
        DOCUMENT_ID,
        ORGANIZATION_ID,
        USER_ID,
        "Content",
        [makeInlineImageInput("")]
      );

    expect(result).toEqual(
      Result.err({
        code: CreateDocumentVersionErrorCode.MissingInlineImagePlaceholder,
        placeholder: "",
      })
    );
    expect(mockCreateInlineImageAttachment).not.toHaveBeenCalled();
    expect(mockDeleteAttachment).not.toHaveBeenCalled();
    expect(createNewVersionSpy).not.toHaveBeenCalled();
  });

  it("cleans up attachments already created when a later inline image upload fails", async () => {
    mockCreateInlineImageAttachment
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-1", "one.png"))
      )
      .mockResolvedValueOnce(
        Result.err({
          code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
        })
      );
    mockDeleteAttachment.mockResolvedValue(Result.ok(undefined));

    const result =
      await documentVersionService.createNewVersionWithInlineImages(
        DOCUMENT_ID,
        ORGANIZATION_ID,
        USER_ID,
        "Content [[first]] [[second]]",
        [
          makeInlineImageInput("[[first]]", "one.png"),
          makeInlineImageInput("[[second]]", "two.png"),
        ]
      );

    expect(result).toEqual(
      Result.err({
        cleanupFailed: false,
        cleanupFailedCount: 0,
        code: CreateDocumentVersionErrorCode.InlineImageCreationFailed,
        inlineImageError: {
          code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
        },
        placeholder: "[[second]]",
      })
    );
    expect(mockDeleteAttachment).toHaveBeenCalledWith(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      USER_ID,
      "attachment-1"
    );
    expect(createNewVersionSpy).not.toHaveBeenCalled();
  });

  it("cleans up attachments already created when a later inline image upload throws", async () => {
    mockCreateInlineImageAttachment
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-1", "one.png"))
      )
      .mockRejectedValueOnce(new Error("s3 write failed"));
    mockDeleteAttachment.mockResolvedValue(Result.ok(undefined));

    const result =
      await documentVersionService.createNewVersionWithInlineImages(
        DOCUMENT_ID,
        ORGANIZATION_ID,
        USER_ID,
        "Content [[first]] [[second]]",
        [
          makeInlineImageInput("[[first]]", "one.png"),
          makeInlineImageInput("[[second]]", "two.png"),
        ]
      );

    expect(result).toEqual(
      Result.err({
        cleanupFailed: false,
        cleanupFailedCount: 0,
        code: CreateDocumentVersionErrorCode.InlineImageCreationFailed,
        inlineImageError: {
          code: CreateInlineImageAttachmentErrorCode.PersistenceFailed,
        },
        placeholder: "[[second]]",
      })
    );
    expect(mockDeleteAttachment).toHaveBeenCalledWith(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      USER_ID,
      "attachment-1"
    );
    expect(createNewVersionSpy).not.toHaveBeenCalled();
  });

  it("rejects placeholder expansion that would exceed the final content cap before upload side effects", async () => {
    const result =
      await documentVersionService.createNewVersionWithInlineImages(
        DOCUMENT_ID,
        ORGANIZATION_ID,
        USER_ID,
        `${"z".repeat(MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS - 100)}${"x".repeat(200)}`,
        [
          {
            ...makeInlineImageInput("x"),
            altText: "]".repeat(500),
          },
        ]
      );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatchObject({
      code: CreateDocumentVersionErrorCode.ExpandedContentTooLarge,
      maxContentChars: MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS,
    });
    expect(mockCreateInlineImageAttachment).not.toHaveBeenCalled();
    expect(mockDeleteAttachment).not.toHaveBeenCalled();
    expect(createNewVersionSpy).not.toHaveBeenCalled();
  });

  it("cleans up created attachments when document version creation fails", async () => {
    mockCreateInlineImageAttachment
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-1", "one.png"))
      )
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-2", "two.png"))
      );
    mockDeleteAttachment.mockResolvedValue(Result.ok(undefined));
    createNewVersionSpy.mockResolvedValue(null);

    const result =
      await documentVersionService.createNewVersionWithInlineImages(
        DOCUMENT_ID,
        ORGANIZATION_ID,
        USER_ID,
        "Content [[first]] [[second]]",
        [
          makeInlineImageInput("[[first]]", "one.png"),
          makeInlineImageInput("[[second]]", "two.png"),
        ]
      );

    expect(result).toEqual(
      Result.err({
        cleanupFailed: false,
        cleanupFailedCount: 0,
        code: CreateDocumentVersionErrorCode.DocumentNotFound,
      })
    );
    expect(mockDeleteAttachment).toHaveBeenCalledTimes(2);
    expect(mockDeleteAttachment).toHaveBeenNthCalledWith(
      1,
      DOCUMENT_ID,
      ORGANIZATION_ID,
      USER_ID,
      "attachment-1"
    );
    expect(mockDeleteAttachment).toHaveBeenNthCalledWith(
      2,
      DOCUMENT_ID,
      ORGANIZATION_ID,
      USER_ID,
      "attachment-2"
    );
  });
});

function makeInlineImageInput(
  placeholder: string,
  filename = "diagram.png"
): CreateDocumentVersionInlineImageInput {
  return {
    dataBase64: "aW1hZ2U=",
    filename,
    mimeType: "image/png",
    placeholder,
  };
}

function makeInlineImageAttachmentResponse(
  attachmentId: string,
  filename: string
): CreateInlineImageAttachmentResponse {
  return {
    attachmentId,
    attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}${attachmentId}`,
    attachment: {
      id: attachmentId,
      artifactId: DOCUMENT_ID,
      createdAt: "2026-07-20T12:00:00.000Z",
      createdById: USER_ID,
      filename,
      mimeType: "image/png",
      purpose: AttachmentPurpose.Inline,
      sizeBytes: 16,
    },
  };
}

function makeDocumentDetail(content: string): DocumentDetail {
  return {
    id: DOCUMENT_ID,
    latestVersion: 2,
    latestVersionContent: content,
    title: "Document",
    version: {
      content,
      createdAt: new Date("2026-07-20T12:00:00.000Z"),
      createdById: USER_ID,
      documentId: DOCUMENT_ID,
      id: "version-2",
      version: 2,
    },
  } as DocumentDetail;
}

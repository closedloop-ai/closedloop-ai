import {
  AttachmentPurpose,
  CreateInlineImageAttachmentErrorCode,
  type CreateInlineImageAttachmentResponse,
  INLINE_ATTACHMENT_REF_PREFIX,
} from "@repo/api/src/types/attachment";
import { Priority } from "@repo/api/src/types/common";
import {
  CreateDocumentErrorCode,
  type CreateDocumentInlineImageInput,
  type Document,
  DocumentType,
  IssueStatus,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { Result } from "@repo/api/src/types/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateInlineImageAttachment = vi.hoisted(() => vi.fn());
const mockDeleteAttachment = vi.hoisted(() => vi.fn());
const mockDocumentDetailFindFirst = vi.hoisted(() => vi.fn());
const mockDocumentVersionUpdateMany = vi.hoisted(() => vi.fn());
const mockWithDbTx = vi.hoisted(() => vi.fn());
const mockDeleteAttachmentErrorCode = vi.hoisted(() => ({
  AttachmentNotFound: "attachment_not_found",
  DocumentNotFound: "document_not_found",
  NotOwned: "not_owned",
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withDb: Object.assign(vi.fn(), { tx: mockWithDbTx }),
  };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../attachments-service", () => ({
  DeleteAttachmentErrorCode: mockDeleteAttachmentErrorCode,
  attachmentsService: {
    createInlineImageAttachment: mockCreateInlineImageAttachment,
    deleteAttachment: mockDeleteAttachment,
  },
}));

import { DeleteAttachmentErrorCode } from "../attachments-service";
import { documentService } from "../document-service";

const DOCUMENT_ID = "doc-1";
const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";

describe("documentService.createWithInlineImages", () => {
  let createSpy: ReturnType<typeof vi.spyOn>;
  let deleteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    createSpy = vi
      .spyOn(documentService, "create")
      .mockResolvedValue(makeDocument());
    deleteSpy = vi
      .spyOn(documentService, "delete")
      .mockResolvedValue(undefined);
    mockDeleteAttachment.mockResolvedValue(Result.ok(undefined));
    mockDocumentDetailFindFirst.mockResolvedValue({ artifactId: DOCUMENT_ID });
    mockDocumentVersionUpdateMany.mockResolvedValue({ count: 1 });
    mockWithDbTx.mockImplementation(
      async (
        callback: (tx: {
          documentDetail: { findFirst: typeof mockDocumentDetailFindFirst };
          documentVersion: { updateMany: typeof mockDocumentVersionUpdateMany };
        }) => Promise<unknown>
      ) =>
        await callback({
          documentDetail: { findFirst: mockDocumentDetailFindFirst },
          documentVersion: { updateMany: mockDocumentVersionUpdateMany },
        })
    );
  });

  afterEach(() => {
    createSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  it("creates inline attachments, then updates version 1 with placeholder replacements", async () => {
    mockCreateInlineImageAttachment
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-1", "one.png"))
      )
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-2", "two.png"))
      );

    const result = await documentService.createWithInlineImages(
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput(
        "Before [[first]] between [[second]] repeat [[first]] after"
      ),
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
    expect(createSpy).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput(
        "Before [[first]] between [[second]] repeat [[first]] after"
      )
    );
    expect(mockDocumentDetailFindFirst).toHaveBeenCalledWith({
      select: { artifactId: true },
      where: {
        artifact: { organizationId: ORGANIZATION_ID },
        artifactId: DOCUMENT_ID,
      },
    });
    expect(mockDocumentVersionUpdateMany).toHaveBeenCalledWith({
      data: { content: expectedContent },
      where: { documentId: DOCUMENT_ID, version: 1 },
    });
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
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("returns the sanitized version content that was persisted", async () => {
    mockCreateInlineImageAttachment.mockResolvedValueOnce(
      Result.ok(makeInlineImageAttachmentResponse("attachment-1", "one.png"))
    );

    const result = await documentService.createWithInlineImages(
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput("Before <script>[[image]]</script> after"),
      [makeInlineImageInput("[[image]]", "one.png")]
    );

    const unsanitizedContent =
      "Before <script>![one.png](attachment://attachment-1)</script> after";
    const persistedContent =
      mockDocumentVersionUpdateMany.mock.calls[0][0].data.content;

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(persistedContent).not.toBe(unsanitizedContent);
    expect(result.value.versionContent).toBe(persistedContent);
  });

  it("rejects invalid placeholders before document or storage side effects", async () => {
    const result = await documentService.createWithInlineImages(
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput("Content [[image]]"),
      [makeInlineImageInput("[[image]]"), makeInlineImageInput("[[image]]")]
    );

    expect(result).toEqual(
      Result.err({
        code: CreateDocumentErrorCode.DuplicateInlineImagePlaceholder,
        placeholder: "[[image]]",
      })
    );
    expect(createSpy).not.toHaveBeenCalled();
    expect(mockCreateInlineImageAttachment).not.toHaveBeenCalled();
    expect(mockDocumentVersionUpdateMany).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("deletes the document when the first image upload fails after creation", async () => {
    mockCreateInlineImageAttachment.mockResolvedValueOnce(
      Result.err({
        code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
      })
    );

    const result = await documentService.createWithInlineImages(
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput("Content [[image]]"),
      [makeInlineImageInput("[[image]]")]
    );

    expect(result).toEqual(
      Result.err({
        cleanupFailed: false,
        cleanupFailedCount: 0,
        code: CreateDocumentErrorCode.InlineImageCreationFailed,
        documentCleanupFailed: false,
        documentCleanupSkipped: false,
        inlineImageError: {
          code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
        },
        placeholder: "[[image]]",
      })
    );
    expect(createSpy).toHaveBeenCalled();
    expect(mockDeleteAttachment).not.toHaveBeenCalled();
    expect(mockDocumentVersionUpdateMany).not.toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledWith(DOCUMENT_ID, ORGANIZATION_ID);
  });

  it("cleans up created attachments before deleting the document when a later upload fails", async () => {
    mockCreateInlineImageAttachment
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-1", "one.png"))
      )
      .mockResolvedValueOnce(
        Result.err({
          code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
        })
      );

    const result = await documentService.createWithInlineImages(
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput("Content [[first]] [[second]]"),
      [
        makeInlineImageInput("[[first]]", "one.png"),
        makeInlineImageInput("[[second]]", "two.png"),
      ]
    );

    expect(result).toEqual(
      Result.err({
        cleanupFailed: false,
        cleanupFailedCount: 0,
        code: CreateDocumentErrorCode.InlineImageCreationFailed,
        documentCleanupFailed: false,
        documentCleanupSkipped: false,
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
    expect(deleteSpy).toHaveBeenCalledWith(DOCUMENT_ID, ORGANIZATION_ID);
    expect(mockDeleteAttachment.mock.invocationCallOrder[0]).toBeLessThan(
      deleteSpy.mock.invocationCallOrder[0]
    );
  });

  it("keeps the document when attachment cleanup returns an expected failure", async () => {
    mockCreateInlineImageAttachment
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-1", "one.png"))
      )
      .mockResolvedValueOnce(
        Result.err({
          code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
        })
      );
    mockDeleteAttachment.mockResolvedValue(
      Result.err({ code: DeleteAttachmentErrorCode.AttachmentNotFound })
    );

    const result = await documentService.createWithInlineImages(
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput("Content [[first]] [[second]]"),
      [
        makeInlineImageInput("[[first]]", "one.png"),
        makeInlineImageInput("[[second]]", "two.png"),
      ]
    );

    expect(result).toEqual(
      Result.err({
        cleanupFailed: true,
        cleanupFailedCount: 1,
        code: CreateDocumentErrorCode.InlineImageCreationFailed,
        documentCleanupFailed: false,
        documentCleanupSkipped: true,
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
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("keeps the document when attachment cleanup throws", async () => {
    mockCreateInlineImageAttachment
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-1", "one.png"))
      )
      .mockResolvedValueOnce(
        Result.err({
          code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
        })
      );
    mockDeleteAttachment.mockRejectedValue(new Error("delete failed"));

    const result = await documentService.createWithInlineImages(
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput("Content [[first]] [[second]]"),
      [
        makeInlineImageInput("[[first]]", "one.png"),
        makeInlineImageInput("[[second]]", "two.png"),
      ]
    );

    expect(result).toEqual(
      Result.err({
        cleanupFailed: true,
        cleanupFailedCount: 1,
        code: CreateDocumentErrorCode.InlineImageCreationFailed,
        documentCleanupFailed: false,
        documentCleanupSkipped: true,
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
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("cleans up all created attachments before deleting the document when the version update fails", async () => {
    mockCreateInlineImageAttachment
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-1", "one.png"))
      )
      .mockResolvedValueOnce(
        Result.ok(makeInlineImageAttachmentResponse("attachment-2", "two.png"))
      );
    mockDocumentVersionUpdateMany.mockResolvedValue({ count: 0 });

    const result = await documentService.createWithInlineImages(
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput("Content [[first]] [[second]]"),
      [
        makeInlineImageInput("[[first]]", "one.png"),
        makeInlineImageInput("[[second]]", "two.png"),
      ]
    );

    expect(result).toEqual(
      Result.err({
        cleanupFailed: false,
        cleanupFailedCount: 0,
        code: CreateDocumentErrorCode.VersionContentUpdateFailed,
        documentCleanupFailed: false,
        documentCleanupSkipped: false,
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
    expect(deleteSpy).toHaveBeenCalledWith(DOCUMENT_ID, ORGANIZATION_ID);
    expect(mockDeleteAttachment.mock.invocationCallOrder[1]).toBeLessThan(
      deleteSpy.mock.invocationCallOrder[0]
    );
  });
});

function makeCreateInput(content: string) {
  return {
    content,
    projectId: "project-1",
    title: "Created document",
    type: DocumentType.Feature,
  };
}

function makeInlineImageInput(
  placeholder: string,
  filename = "diagram.png"
): CreateDocumentInlineImageInput {
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
    attachment: {
      artifactId: DOCUMENT_ID,
      createdAt: "2026-07-20T12:00:00.000Z",
      createdById: USER_ID,
      filename,
      id: attachmentId,
      mimeType: "image/png",
      purpose: AttachmentPurpose.Inline,
      sizeBytes: 16,
    },
    attachmentId,
    attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}${attachmentId}`,
  };
}

function makeDocument(): Document {
  return {
    approver: null,
    approverId: null,
    assignee: null,
    assigneeId: null,
    createdAt: new Date("2026-07-20T12:00:00.000Z"),
    createdBy: null,
    createdById: USER_ID,
    fileName: null,
    id: DOCUMENT_ID,
    latestVersion: 1,
    organizationId: ORGANIZATION_ID,
    priority: Priority.Medium,
    projectId: "project-1",
    repositorySnapshot: {
      createdAt: "2026-07-20T12:00:00.000Z",
      repositories: [],
      source: SnapshotSource.None,
    },
    slug: "FEA-3539",
    sortOrder: null,
    status: IssueStatus.Backlog,
    templateForType: null,
    title: "Created document",
    type: DocumentType.Feature,
    updatedAt: new Date("2026-07-20T12:00:00.000Z"),
  };
}

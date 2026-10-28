/**
 * Inline-image behavior across the two modules that own it —
 * `attachmentInlineImageCreateService.createInlineImageAttachment` (decode,
 * validate, rate-limit and persist a pasted data URI) and
 * `attachmentsService.resolveInlineImages` (turn stored inline refs back into
 * signed URLs).
 *
 * Split out of `attachments-service.test.ts`, which owns upload, plain
 * listing, delete and download, so that grandfathered file shrinks rather than
 * grows (AGENTS.md → "File Size and Organization"). Row builders and
 * identifiers are shared through
 * `__tests__/support/documents/attachments-service.test-fixtures`, matching
 * `attachments-service-signed-urls.test.ts`.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

vi.mock("@repo/database", () => {
  const tx = vi.fn();
  const withDbFn = Object.assign(vi.fn(), { tx });
  return {
    withDb: withDbFn,
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      BRANCH: "BRANCH",
      DEPLOYMENT: "DEPLOYMENT",
    },
  };
});

vi.mock("@repo/aws", () => ({
  deleteArtifact: vi.fn(),
  getSignedDownloadUrl: vi.fn(),
  getSignedDownloadUrlWithDisposition: vi.fn(),
  getSignedUploadUrl: vi.fn(),
  putAttachmentObject: vi.fn(),
}));

vi.mock("@repo/aws/keys", () => ({
  keys: () => ({
    FILE_ATTACHMENTS_BUCKET: process.env.FILE_ATTACHMENTS_BUCKET,
  }),
}));

vi.mock("@paralleldrive/cuid2", () => ({
  createId: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { createId } from "@paralleldrive/cuid2";
import {
  AttachmentPurpose,
  CreateInlineImageAttachmentErrorCode,
  INLINE_ATTACHMENT_REF_PREFIX,
  InlineImageResolveSkipReason,
  MAX_INLINE_IMAGE_ATTACHMENT_BYTES,
} from "@repo/api/src/types/attachment";
import { Result } from "@repo/api/src/types/result";
import {
  deleteArtifact,
  getSignedDownloadUrl,
  putAttachmentObject,
} from "@repo/aws";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  ARTIFACT_ID,
  MOCK_CUID,
  makeAttachmentRecord,
  ORG_ID,
  USER_ID,
} from "@/__tests__/support/documents/attachments-service.test-fixtures";
import { PNG_BASE64, PNG_BYTES } from "../../../__tests__/utils/image-fixtures";
import { attachmentInlineImageCreateService } from "../attachment-inline-image-create-service";
import {
  attachmentServiceInternalsForTesting,
  attachmentsService,
} from "../attachments-service";

const mockWithDb = withDb as unknown as Mock & { tx: Mock };
const mockWithDbTx = mockWithDb.tx;
const mockGetSignedDownloadUrl = getSignedDownloadUrl as unknown as Mock;
const mockDeleteArtifact = deleteArtifact as unknown as Mock;
const mockPutAttachmentObject = putAttachmentObject as unknown as Mock;
const mockCreateId = createId as unknown as Mock;
const mockLog = log as unknown as {
  error: Mock;
  info: Mock;
  warn: Mock;
};

const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64");
const GIF_BASE64 = Buffer.from("GIF89a", "ascii").toString("base64");
const WEBP_BASE64 = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]).toString("base64");

function setupInlineImageDocumentAndLimiter({
  fileAttachmentCreate = vi.fn(),
}: {
  fileAttachmentCreate?: ReturnType<typeof vi.fn>;
} = {}) {
  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      artifact: {
        findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
      },
      fileAttachment: {
        create: fileAttachmentCreate,
        findFirst: vi.fn().mockResolvedValue(null),
      },
      oAuthRateLimit: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    })
  );
  mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      oAuthRateLimit: {
        create: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
      },
    })
  );
}

// ---------------------------------------------------------------------------
// createInlineImageAttachment
// ---------------------------------------------------------------------------

describe("attachmentInlineImageCreateService.createInlineImageAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockReset();
    mockWithDbTx.mockReset();
    mockPutAttachmentObject.mockReset();
    mockDeleteArtifact.mockReset();
    mockCreateId.mockReset();
    process.env.FILE_ATTACHMENTS_BUCKET = "test-bucket";
    mockCreateId.mockReturnValue(MOCK_CUID);
    mockPutAttachmentObject.mockResolvedValue(undefined);
    mockDeleteArtifact.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    mockWithDb.mockReset();
    mockWithDbTx.mockReset();
    mockPutAttachmentObject.mockReset();
    mockDeleteArtifact.mockReset();
    mockCreateId.mockReset();
    Reflect.deleteProperty(process.env, "FILE_ATTACHMENTS_BUCKET");
  });

  it("stores image bytes directly, persists inline purpose, and returns attachment metadata without upload details", async () => {
    const operations: string[] = [];
    const expectedKey = `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`;
    const createdRecord = makeAttachmentRecord({
      id: "inline-attachment-1",
      filename: "diagram.png",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.byteLength,
      purpose: AttachmentPurpose.Inline,
      key: expectedKey,
    });
    const fileAttachmentCreate = vi.fn().mockImplementation(() => {
      operations.push("createRow");
      return Promise.resolve(createdRecord);
    });
    mockPutAttachmentObject.mockImplementation(() => {
      operations.push("putObject");
      return Promise.resolve();
    });
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockImplementation(() => {
            operations.push("requireDocument");
            return Promise.resolve({ id: ARTIFACT_ID });
          }),
        },
        fileAttachment: {
          create: fileAttachmentCreate,
        },
        oAuthRateLimit: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      })
    );
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          create: vi.fn().mockImplementation(() => {
            operations.push("consumeLimit");
            return Promise.resolve({});
          }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const result =
      await attachmentInlineImageCreateService.createInlineImageAttachment(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.png",
        "image/png",
        PNG_BASE64
      );

    expect(result).toEqual(
      Result.ok({
        attachmentId: "inline-attachment-1",
        attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}inline-attachment-1`,
        attachment: {
          id: "inline-attachment-1",
          artifactId: ARTIFACT_ID,
          filename: "diagram.png",
          mimeType: "image/png",
          sizeBytes: PNG_BYTES.byteLength,
          createdAt: createdRecord.createdAt.toISOString(),
          createdById: USER_ID,
          purpose: AttachmentPurpose.Inline,
        },
      })
    );
    if (result.ok) {
      expect(JSON.stringify(result.value)).not.toContain(expectedKey);
      expect(JSON.stringify(result.value)).not.toContain(PNG_BASE64);
    }
    expect(operations).toEqual([
      "requireDocument",
      "consumeLimit",
      "putObject",
      "createRow",
    ]);
    const putArgs = mockPutAttachmentObject.mock.calls[0][0];
    expect(Buffer.from(putArgs.body)).toEqual(Buffer.from(PNG_BYTES));
    expect(mockPutAttachmentObject).toHaveBeenCalledWith({
      body: expect.any(Uint8Array),
      bucket: "test-bucket",
      contentLength: PNG_BYTES.byteLength,
      contentType: "image/png",
      key: expectedKey,
    });
    expect(fileAttachmentCreate).toHaveBeenCalledWith({
      data: {
        artifactId: ARTIFACT_ID,
        bucket: "test-bucket",
        createdById: USER_ID,
        filename: "diagram.png",
        key: expectedKey,
        mimeType: "image/png",
        purpose: AttachmentPurpose.Inline,
        sizeBytes: PNG_BYTES.byteLength,
      },
    });
  });

  it.each([
    ["data URL", `data:image/png;base64,${PNG_BASE64}`],
    ["base64url", "abcd-efg"],
    ["whitespace", `${PNG_BASE64}\n`],
    ["empty", ""],
  ])(
    "rejects non-canonical %s base64 after consuming the scoped limiter but before storage",
    async (_label, dataBase64) => {
      const fileAttachmentCreate = vi.fn();
      setupInlineImageDocumentAndLimiter({ fileAttachmentCreate });

      const result =
        await attachmentInlineImageCreateService.createInlineImageAttachment(
          ARTIFACT_ID,
          ORG_ID,
          USER_ID,
          "diagram.png",
          "image/png",
          dataBase64
        );

      expect(result).toEqual(
        Result.err({
          code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
        })
      );
      expect(mockPutAttachmentObject).not.toHaveBeenCalled();
      expect(fileAttachmentCreate).not.toHaveBeenCalled();
      expect(mockWithDbTx).toHaveBeenCalledOnce();
    }
  );

  it("rejects unsupported image MIME types before side effects", async () => {
    const fileAttachmentCreate = vi.fn();
    setupInlineImageDocumentAndLimiter({ fileAttachmentCreate });

    const result =
      await attachmentInlineImageCreateService.createInlineImageAttachment(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.svg",
        "image/svg+xml",
        PNG_BASE64
      );

    expect(result).toEqual(
      Result.err({
        code: CreateInlineImageAttachmentErrorCode.UnsupportedMimeType,
      })
    );
    expect(mockPutAttachmentObject).not.toHaveBeenCalled();
    expect(fileAttachmentCreate).not.toHaveBeenCalled();
    expect(mockWithDbTx).toHaveBeenCalledOnce();
  });

  it.each([
    ["png", "image/png", JPEG_BASE64],
    ["jpeg", "image/jpeg", PNG_BASE64],
    ["gif", "image/gif", WEBP_BASE64],
    ["webp", "image/webp", GIF_BASE64],
  ])(
    "rejects %s uploads when bytes do not match the declared MIME type",
    async (_label, mimeType, dataBase64) => {
      const fileAttachmentCreate = vi.fn();
      setupInlineImageDocumentAndLimiter({ fileAttachmentCreate });

      const result =
        await attachmentInlineImageCreateService.createInlineImageAttachment(
          ARTIFACT_ID,
          ORG_ID,
          USER_ID,
          "diagram",
          mimeType,
          dataBase64
        );

      expect(result).toEqual(
        Result.err({
          code: CreateInlineImageAttachmentErrorCode.MimeMismatch,
        })
      );
      expect(mockPutAttachmentObject).not.toHaveBeenCalled();
      expect(fileAttachmentCreate).not.toHaveBeenCalled();
      expect(mockWithDbTx).toHaveBeenCalledOnce();
    }
  );

  it("rejects decoded image bytes above the inline cap before storage or database work", async () => {
    const fileAttachmentCreate = vi.fn();
    setupInlineImageDocumentAndLimiter({ fileAttachmentCreate });
    const oversizedBytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(MAX_INLINE_IMAGE_ATTACHMENT_BYTES - 2),
    ]);

    const result =
      await attachmentInlineImageCreateService.createInlineImageAttachment(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.jpg",
        "image/jpeg",
        oversizedBytes.toString("base64")
      );

    expect(result).toEqual(
      Result.err({
        actualBytes: MAX_INLINE_IMAGE_ATTACHMENT_BYTES + 1,
        code: CreateInlineImageAttachmentErrorCode.PayloadTooLarge,
        maxBytes: MAX_INLINE_IMAGE_ATTACHMENT_BYTES,
      })
    );
    expect(mockPutAttachmentObject).not.toHaveBeenCalled();
    expect(fileAttachmentCreate).not.toHaveBeenCalled();
    expect(mockWithDbTx).toHaveBeenCalledOnce();
  });

  it("returns document_not_found without consuming the limiter or writing storage", async () => {
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const result =
      await attachmentInlineImageCreateService.createInlineImageAttachment(
        "missing-document",
        ORG_ID,
        USER_ID,
        "diagram.png",
        "image/png",
        PNG_BASE64
      );

    expect(result).toEqual(
      Result.err({
        code: CreateInlineImageAttachmentErrorCode.DocumentNotFound,
      })
    );
    expect(mockWithDbTx).not.toHaveBeenCalled();
    expect(mockPutAttachmentObject).not.toHaveBeenCalled();
  });

  it("returns storage_unconfigured before document lookup or storage work", async () => {
    Reflect.deleteProperty(process.env, "FILE_ATTACHMENTS_BUCKET");

    const result =
      await attachmentInlineImageCreateService.createInlineImageAttachment(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.png",
        "image/png",
        PNG_BASE64
      );

    expect(result).toEqual(
      Result.err({
        code: CreateInlineImageAttachmentErrorCode.StorageUnconfigured,
      })
    );
    expect(mockWithDb).not.toHaveBeenCalled();
    expect(mockPutAttachmentObject).not.toHaveBeenCalled();
  });

  it("returns rate_limited before S3 writes or DB row creation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mockWithDb
      .mockImplementationOnce((callback: (db: unknown) => unknown) =>
        callback({
          artifact: {
            findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
          },
        })
      )
      .mockImplementationOnce((callback: (db: unknown) => unknown) =>
        callback({
          oAuthRateLimit: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        })
      );
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          findUnique: vi.fn().mockResolvedValue({
            id: "limit-row",
            requestCount: 60,
            windowExpiresAt: new Date("2026-01-01T01:00:00.000Z"),
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      })
    );

    const result =
      await attachmentInlineImageCreateService.createInlineImageAttachment(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.png",
        "image/png",
        PNG_BASE64
      );

    expect(result).toEqual(
      Result.err({
        code: CreateInlineImageAttachmentErrorCode.RateLimited,
        retryAfterSeconds: 3600,
      })
    );
    expect(mockPutAttachmentObject).not.toHaveBeenCalled();
  });

  it("does not create a DB row when S3 storage fails", async () => {
    const expectedKey = `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`;
    const fileAttachmentCreate = vi.fn();
    mockPutAttachmentObject.mockRejectedValue(
      new Error(`S3 unavailable for ${expectedKey}`)
    );
    setupInlineImageDocumentAndLimiter({ fileAttachmentCreate });

    const result =
      await attachmentInlineImageCreateService.createInlineImageAttachment(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.png",
        "image/png",
        PNG_BASE64
      );

    expect(result).toEqual(
      Result.err({
        code: CreateInlineImageAttachmentErrorCode.StorageWriteFailed,
      })
    );
    expect(fileAttachmentCreate).not.toHaveBeenCalled();
    expect(mockDeleteArtifact).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLog.error.mock.calls)).not.toContain(expectedKey);
    expect(JSON.stringify(mockLog.error.mock.calls)).toContain(
      "[attachment-storage-key]"
    );
  });

  it("cleans up the S3 object when DB persistence fails after storage succeeds", async () => {
    const expectedKey = `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`;
    const fileAttachmentCreate = vi
      .fn()
      .mockRejectedValue(new Error("DB unavailable"));
    const fileAttachmentFindFirst = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
        fileAttachment: {
          create: fileAttachmentCreate,
          findFirst: fileAttachmentFindFirst,
        },
        oAuthRateLimit: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      })
    );
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          create: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const result =
      await attachmentInlineImageCreateService.createInlineImageAttachment(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.png",
        "image/png",
        PNG_BASE64
      );

    expect(result).toEqual(
      Result.err({
        code: CreateInlineImageAttachmentErrorCode.PersistenceFailed,
      })
    );
    expect(mockPutAttachmentObject).toHaveBeenCalledOnce();
    expect(mockDeleteArtifact).toHaveBeenCalledWith(expectedKey, "test-bucket");
    expect(fileAttachmentFindFirst).toHaveBeenCalledWith({
      where: {
        artifact: { organizationId: ORG_ID },
        artifactId: ARTIFACT_ID,
        bucket: "test-bucket",
        key: expectedKey,
      },
      // ISS-6325: the RETURNING is now the mapper's own column set. The
      // predicate is unchanged.
      select: {
        id: true,
        artifactId: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
        createdById: true,
        purpose: true,
      },
    });
  });

  it("returns the existing row instead of deleting S3 when DB create throws after committing", async () => {
    const expectedKey = `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`;
    const createdRecord = makeAttachmentRecord({
      id: "inline-attachment-committed",
      filename: "diagram.png",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.byteLength,
      purpose: AttachmentPurpose.Inline,
      key: expectedKey,
    });
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
        fileAttachment: {
          create: vi.fn().mockRejectedValue(new Error("connection lost")),
          findFirst: vi.fn().mockResolvedValue(createdRecord),
        },
        oAuthRateLimit: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      })
    );
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          create: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const result =
      await attachmentInlineImageCreateService.createInlineImageAttachment(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.png",
        "image/png",
        PNG_BASE64
      );

    expect(result).toEqual(
      Result.ok({
        attachmentId: createdRecord.id,
        attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}${createdRecord.id}`,
        attachment: {
          id: createdRecord.id,
          artifactId: ARTIFACT_ID,
          filename: "diagram.png",
          mimeType: "image/png",
          sizeBytes: PNG_BYTES.byteLength,
          createdAt: createdRecord.createdAt.toISOString(),
          createdById: USER_ID,
          purpose: AttachmentPurpose.Inline,
        },
      })
    );
    expect(mockDeleteArtifact).not.toHaveBeenCalled();
  });

  it("leaves S3 for scheduled reconcile when DB persistence status is unknown", async () => {
    const expectedKey = `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`;
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
        fileAttachment: {
          create: vi
            .fn()
            .mockRejectedValue(new Error(`DB unavailable for ${expectedKey}`)),
          findFirst: vi
            .fn()
            .mockRejectedValue(new Error(`lookup failed for ${expectedKey}`)),
        },
        oAuthRateLimit: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      })
    );
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          create: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const result =
      await attachmentInlineImageCreateService.createInlineImageAttachment(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.png",
        "image/png",
        PNG_BASE64
      );

    expect(result).toEqual(
      Result.err({
        code: CreateInlineImageAttachmentErrorCode.PersistenceFailed,
      })
    );
    expect(mockDeleteArtifact).not.toHaveBeenCalled();
    const serializedLogs = JSON.stringify(mockLog.error.mock.calls);
    expect(serializedLogs).not.toContain(expectedKey);
    expect(serializedLogs).toContain("[attachment-storage-key]");
    expect(serializedLogs).toContain("scheduled_attachment_reconcile_sweep");
    expect(serializedLogs).toContain("reconcileAfterSeconds");
  });

  it("redacts storage keys when immediate cleanup fails and leaves the object for reconcile", async () => {
    const expectedKey = `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`;
    mockDeleteArtifact.mockRejectedValue(
      new Error(`delete failed for ${expectedKey}`)
    );
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
        fileAttachment: {
          create: vi
            .fn()
            .mockRejectedValue(new Error(`DB unavailable for ${expectedKey}`)),
          findFirst: vi.fn().mockResolvedValue(null),
        },
        oAuthRateLimit: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      })
    );
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          create: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const result =
      await attachmentInlineImageCreateService.createInlineImageAttachment(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.png",
        "image/png",
        PNG_BASE64
      );

    expect(result).toEqual(
      Result.err({
        code: CreateInlineImageAttachmentErrorCode.PersistenceFailed,
      })
    );
    expect(mockDeleteArtifact).toHaveBeenCalledWith(expectedKey, "test-bucket");
    const serializedLogs = JSON.stringify(mockLog.error.mock.calls);
    expect(serializedLogs).not.toContain(expectedKey);
    expect(serializedLogs).toContain("[attachment-storage-key]");
  });
});

// ---------------------------------------------------------------------------
// resolveInlineImages
// ---------------------------------------------------------------------------

describe("attachmentsService.resolveInlineImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    attachmentServiceInternalsForTesting.clearSignedDownloadUrlCache();
    mockGetSignedDownloadUrl.mockResolvedValue("https://s3.example.com/inline");
  });

  it("resolves unique inline image attachments and reports skipped records", async () => {
    const inlineImage = makeAttachmentRecord({
      id: "inline-image",
      filename: "diagram.png",
      mimeType: "image/png",
      purpose: AttachmentPurpose.Inline,
    });
    const contextImage = makeAttachmentRecord({
      id: "context-image",
      filename: "context.png",
      mimeType: "image/png",
      purpose: AttachmentPurpose.Context,
    });
    const inlinePdf = makeAttachmentRecord({
      id: "inline-pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      purpose: AttachmentPurpose.Inline,
    });
    let capturedArgs: Record<string, unknown> | undefined;

    mockWithDb
      .mockImplementationOnce((callback: (db: unknown) => unknown) =>
        callback({
          artifact: {
            findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
          },
        })
      )
      .mockImplementationOnce((callback: (db: unknown) => unknown) =>
        callback({
          fileAttachment: {
            findMany: vi.fn((args: Record<string, unknown>) => {
              capturedArgs = args;
              return Promise.resolve([inlineImage, contextImage, inlinePdf]);
            }),
          },
        })
      );

    const result = await attachmentsService.resolveInlineImages(
      ARTIFACT_ID,
      ORG_ID,
      [
        "inline-image",
        "inline-image",
        "context-image",
        "inline-pdf",
        "missing-image",
      ]
    );

    expect(capturedArgs).toMatchObject({
      where: {
        id: {
          in: ["inline-image", "context-image", "inline-pdf", "missing-image"],
        },
        artifactId: ARTIFACT_ID,
        artifact: { organizationId: ORG_ID },
      },
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      attachmentId: "inline-image",
      filename: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4096,
      url: "https://s3.example.com/inline",
    });
    expect(result.skipped).toEqual([
      {
        attachmentId: "context-image",
        reason: InlineImageResolveSkipReason.NotInline,
      },
      {
        attachmentId: "inline-pdf",
        reason: InlineImageResolveSkipReason.NotImage,
      },
      {
        attachmentId: "missing-image",
        reason: InlineImageResolveSkipReason.NotFound,
      },
    ]);
  });

  it("reuses a cached signed URL across repeated renders of the same inline image", async () => {
    const inlineImage = makeAttachmentRecord({
      id: "inline-image",
      filename: "diagram.png",
      mimeType: "image/png",
      purpose: AttachmentPurpose.Inline,
      key: "attachments/org-abc/artifact-123/stable-inline-image",
      bucket: "stable-bucket",
    });
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
        fileAttachment: {
          findMany: vi.fn().mockResolvedValue([inlineImage]),
        },
      })
    );

    const first = await attachmentsService.resolveInlineImages(
      ARTIFACT_ID,
      ORG_ID,
      ["inline-image"]
    );
    const second = await attachmentsService.resolveInlineImages(
      ARTIFACT_ID,
      ORG_ID,
      ["inline-image"]
    );

    expect(first.images[0]?.url).toBe("https://s3.example.com/inline");
    expect(second.images[0]?.url).toBe(first.images[0]?.url);
    expect(mockGetSignedDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it("reports the cached signature's real expiry, not a fresh full lifetime, when an inline URL is reused", async () => {
    vi.useFakeTimers();
    attachmentServiceInternalsForTesting.clearSignedDownloadUrlCache();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const inlineImage = makeAttachmentRecord({
        id: "inline-image",
        filename: "diagram.png",
        mimeType: "image/png",
        purpose: AttachmentPurpose.Inline,
        key: "attachments/org-abc/artifact-123/stable-inline-expiry",
        bucket: "stable-bucket",
      });
      mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
        callback({
          artifact: {
            findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
          },
          fileAttachment: {
            findMany: vi.fn().mockResolvedValue([inlineImage]),
          },
        })
      );

      const first = await attachmentsService.resolveInlineImages(
        ARTIFACT_ID,
        ORG_ID,
        ["inline-image"]
      );

      // Reuse the cached signature 10 minutes later — still inside the reuse
      // window (beyond the 5-minute safety margin), so no re-sign happens.
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const second = await attachmentsService.resolveInlineImages(
        ARTIFACT_ID,
        ORG_ID,
        ["inline-image"]
      );

      expect(mockGetSignedDownloadUrl).toHaveBeenCalledTimes(1);
      expect(second.images[0]?.url).toBe(first.images[0]?.url);
      // The reused URL expires one hour after it was FIRST signed, not one hour
      // after the second call. Reporting the latter would let a consumer treat
      // an already-expired URL as still valid.
      expect(second.images[0]?.expiresAt).toBe(first.images[0]?.expiresAt);
      expect(second.images[0]?.expiresAt).toBe("2026-01-01T01:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports signing failures per attachment without leaking S3 keys", async () => {
    const inlineImage = makeAttachmentRecord({
      id: "inline-image",
      filename: "diagram.png",
      mimeType: "image/png",
      purpose: AttachmentPurpose.Inline,
    });
    mockGetSignedDownloadUrl.mockRejectedValue(new Error("S3 unavailable"));

    mockWithDb
      .mockImplementationOnce((callback: (db: unknown) => unknown) =>
        callback({
          artifact: {
            findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
          },
        })
      )
      .mockImplementationOnce((callback: (db: unknown) => unknown) =>
        callback({
          fileAttachment: {
            findMany: vi.fn().mockResolvedValue([inlineImage]),
          },
        })
      );

    const result = await attachmentsService.resolveInlineImages(
      ARTIFACT_ID,
      ORG_ID,
      ["inline-image"]
    );

    expect(result).toEqual({
      images: [],
      skipped: [
        {
          attachmentId: "inline-image",
          reason: InlineImageResolveSkipReason.SigningFailed,
        },
      ],
    });
    expect(mockLog.warn).toHaveBeenCalledWith(
      "[attachments-service] Failed to resolve inline image URL",
      expect.objectContaining({
        attachmentId: "inline-image",
        documentId: ARTIFACT_ID,
        error: "S3 unavailable",
        mimeType: "image/png",
        purpose: AttachmentPurpose.Inline,
        reason: InlineImageResolveSkipReason.SigningFailed,
        sizeBytes: 4096,
      })
    );
    expect(JSON.stringify(mockLog.warn.mock.calls)).not.toContain(
      inlineImage.key
    );
  });
});

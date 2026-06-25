/**
 * Unit tests for attachmentsService.
 *
 * All database calls are mocked via vi.mock("@repo/database").
 * AWS S3 functions and cuid2 are also mocked.
 * Tests verify:
 *   - requestUpload calls getSignedUploadUrl with expiresIn=900 and the correct S3 key pattern
 *   - listByDocument returns records with createdAt serialized as ISO strings
 *   - deleteAttachment preserves session semantics, enforces creator ownership when requested, deletes the DB record before S3, and logs S3 errors
 *   - getDownloadUrl calls getSignedDownloadUrlWithDisposition with (key, filename)
 *   - All methods throw "Document not found" when the ownership check returns null
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
  AttachmentPurposeSelector,
  InlineImageResolveSkipReason,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
} from "@repo/api/src/types/attachment";
import {
  deleteArtifact,
  getSignedDownloadUrl,
  getSignedDownloadUrlWithDisposition,
  getSignedUploadUrl,
} from "@repo/aws";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  attachmentsService,
  DeleteAttachmentErrorCode,
} from "../attachments-service";

const mockWithDb = withDb as unknown as Mock & { tx: Mock };
const mockWithDbTx = mockWithDb.tx;
const mockGetSignedUploadUrl = getSignedUploadUrl as unknown as Mock;
const mockGetSignedDownloadUrl = getSignedDownloadUrl as unknown as Mock;
const mockGetSignedDownloadUrlWithDisposition =
  getSignedDownloadUrlWithDisposition as unknown as Mock;
const mockDeleteArtifact = deleteArtifact as unknown as Mock;
const mockCreateId = createId as unknown as Mock;
const mockLog = log as unknown as {
  error: Mock;
  info: Mock;
  warn: Mock;
};

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const ARTIFACT_ID = "artifact-123";
const ORG_ID = "org-abc";
const USER_ID = "user-xyz";
const ATTACHMENT_ID = "attach-456";
const MOCK_CUID = "cuid2mockval01";

function makeAttachmentRecord(
  overrides: Partial<{
    id: string;
    artifactId: string | undefined;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: Date;
    createdById: string;
    key: string;
    bucket: string;
    purpose: string;
  }> = {}
) {
  return {
    id: ATTACHMENT_ID,
    artifactId: ARTIFACT_ID,
    filename: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4096,
    createdAt: new Date("2026-01-15T12:00:00.000Z"),
    createdById: USER_ID,
    key: `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`,
    bucket: "test-bucket",
    purpose: AttachmentPurpose.Context,
    ...overrides,
  };
}

function setupUploadDb({
  artifactId = ARTIFACT_ID,
  createdRecord = makeAttachmentRecord({ id: "new-attach-direct" }),
  limitDeleteMany = vi.fn().mockResolvedValue({ count: 0 }),
}: {
  artifactId?: string | null;
  createdRecord?: ReturnType<typeof makeAttachmentRecord>;
  limitDeleteMany?: ReturnType<typeof vi.fn>;
} = {}) {
  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      artifact: {
        findFirst: vi
          .fn()
          .mockResolvedValue(artifactId === null ? null : { id: artifactId }),
      },
      fileAttachment: {
        create: vi.fn().mockResolvedValue(createdRecord),
      },
      oAuthRateLimit: {
        deleteMany: limitDeleteMany,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// requestUpload
// ---------------------------------------------------------------------------

describe("attachmentsService.requestUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FILE_ATTACHMENTS_BUCKET = "test-bucket";
    mockCreateId.mockReturnValue(MOCK_CUID);
    mockGetSignedUploadUrl.mockResolvedValue(
      "https://s3.example.com/upload-url"
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(process.env, "FILE_ATTACHMENTS_BUCKET");
  });

  it("calls getSignedUploadUrl with expiresIn=900 (not the default 3600)", async () => {
    const createdRecord = makeAttachmentRecord({ id: "new-attach-1" });

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
            create: vi.fn().mockResolvedValue(createdRecord),
          },
        })
      );

    await attachmentsService.requestUpload(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "report.pdf",
      "application/pdf",
      4096
    );

    expect(mockGetSignedUploadUrl).toHaveBeenCalledWith(
      expect.any(String),
      "application/pdf",
      900,
      "test-bucket",
      4096
    );
  });

  it("uses S3 key pattern attachments/<orgId>/<artifactId>/<cuid>", async () => {
    const expectedKey = `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`;
    const createdRecord = makeAttachmentRecord({
      id: "new-attach-2",
      key: expectedKey,
    });

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
            create: vi.fn().mockResolvedValue(createdRecord),
          },
        })
      );

    await attachmentsService.requestUpload(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "report.pdf",
      "application/pdf",
      4096
    );

    expect(mockGetSignedUploadUrl).toHaveBeenCalledWith(
      expectedKey,
      expect.any(String),
      expect.any(Number),
      "test-bucket",
      4096
    );
  });

  it("returns attachmentId, uploadUrl, and key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const expectedKey = `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`;
    const uploadUrl = "https://s3.example.com/presigned-put";
    mockGetSignedUploadUrl.mockResolvedValue(uploadUrl);

    const createdRecord = makeAttachmentRecord({
      id: "new-attach-3",
      key: expectedKey,
    });

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
            create: vi.fn().mockResolvedValue(createdRecord),
          },
        })
      );

    const result = await attachmentsService.requestUpload(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "report.pdf",
      "application/pdf",
      4096
    );

    expect(result).toEqual({
      attachmentId: createdRecord.id,
      expiresAt: "2026-01-01T00:15:00.000Z",
      uploadUrl,
      key: expectedKey,
    });
  });

  it("orders direct upload limiting after document verification and before signing or row creation", async () => {
    const operations: string[] = [];
    const createdRecord = makeAttachmentRecord({ id: "new-attach-6" });
    mockGetSignedUploadUrl.mockImplementation(() => {
      operations.push("sign");
      return Promise.resolve("https://s3.example.com/upload-url");
    });
    mockWithDb
      .mockImplementationOnce((callback: (db: unknown) => unknown) =>
        callback({
          artifact: {
            findFirst: vi.fn().mockImplementation(() => {
              operations.push("requireDocument");
              return Promise.resolve({ id: ARTIFACT_ID });
            }),
          },
        })
      )
      .mockImplementationOnce((callback: (db: unknown) => unknown) =>
        callback({
          oAuthRateLimit: {
            deleteMany: vi.fn().mockImplementation(() => {
              operations.push("cleanupExpiredLimits");
              return Promise.resolve({ count: 0 });
            }),
          },
        })
      )
      .mockImplementationOnce((callback: (db: unknown) => unknown) =>
        callback({
          fileAttachment: {
            create: vi.fn().mockImplementation(() => {
              operations.push("createRow");
              return Promise.resolve(createdRecord);
            }),
          },
        })
      );
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          findUnique: vi.fn().mockImplementation(() => {
            operations.push("findLimit");
            return Promise.resolve({
              id: "limit-row",
              windowExpiresAt: new Date(Date.now() + 60_000),
            });
          }),
          updateMany: vi.fn().mockImplementation(() => {
            operations.push("consumeLimit");
            return Promise.resolve({ count: 1 });
          }),
        },
      })
    );

    const result = await attachmentsService.requestDirectUpload(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "report.pdf",
      "application/pdf",
      4096,
      AttachmentPurpose.Context
    );

    expect(result.ok).toBe(true);
    expect(operations).toEqual([
      "requireDocument",
      "cleanupExpiredLimits",
      "findLimit",
      "consumeLimit",
      "sign",
      "createRow",
    ]);
  });

  it("creates the first direct upload limiter window before signing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const limitDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const limitCreate = vi.fn().mockResolvedValue({});
    setupUploadDb({ limitDeleteMany });
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          create: limitCreate,
          findUnique: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const result = await attachmentsService.requestDirectUpload(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "report.pdf",
      "application/pdf",
      4096
    );

    expect(result.ok).toBe(true);
    expect(limitDeleteMany).toHaveBeenCalledWith({
      where: {
        bucket: "document_attachment_upload_request",
        subject: { not: `${ORG_ID}:${ARTIFACT_ID}` },
        windowExpiresAt: { lt: new Date("2026-01-01T00:00:00.000Z") },
      },
    });
    expect(limitCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bucket: "document_attachment_upload_request",
        requestCount: 1,
        subject: `${ORG_ID}:${ARTIFACT_ID}`,
        windowExpiresAt: new Date("2026-01-01T01:00:00.000Z"),
        windowStartedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    });
    expect(mockGetSignedUploadUrl).toHaveBeenCalledOnce();
  });

  it("does not block direct upload when expired limiter cleanup fails", async () => {
    const limitDeleteMany = vi
      .fn()
      .mockRejectedValue(new Error("cleanup failed"));
    const limitCreate = vi.fn().mockResolvedValue({});
    setupUploadDb({ limitDeleteMany });
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          create: limitCreate,
          findUnique: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const result = await attachmentsService.requestDirectUpload(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "report.pdf",
      "application/pdf",
      4096
    );

    expect(result.ok).toBe(true);
    expect(limitCreate).toHaveBeenCalledOnce();
    expect(mockLog.warn).toHaveBeenCalledWith(
      "[attachments-service] Failed to clean up expired attachment upload limiter rows",
      {
        bucket: "document_attachment_upload_request",
        error: "cleanup failed",
      }
    );
    expect(mockGetSignedUploadUrl).toHaveBeenCalledOnce();
  });

  it("increments the limiter when first-window creation loses a unique-key race", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const operations: string[] = [];
    const firstTransactionUpdate = vi
      .fn()
      .mockRejectedValue(new Error("recovery must use a fresh transaction"));
    const limitCreate = vi.fn().mockImplementation(() => {
      operations.push("createLimit");
      return Promise.reject({ code: "P2002" });
    });
    const limitUpdateMany = vi.fn().mockImplementation(() => {
      operations.push("incrementLimit");
      return Promise.resolve({ count: 1 });
    });
    setupUploadDb();
    mockWithDbTx
      .mockImplementationOnce((callback: (db: unknown) => unknown) =>
        callback({
          oAuthRateLimit: {
            create: limitCreate,
            findUnique: vi.fn().mockImplementation(() => {
              operations.push("findLimit");
              return Promise.resolve(null);
            }),
            updateMany: firstTransactionUpdate,
          },
        })
      )
      .mockImplementationOnce((callback: (db: unknown) => unknown) =>
        callback({
          oAuthRateLimit: {
            findUnique: vi.fn().mockImplementation(() => {
              operations.push("findRacedLimit");
              return Promise.resolve({
                id: "limit-row",
                requestCount: 1,
                windowExpiresAt: new Date("2026-01-01T01:00:00.000Z"),
              });
            }),
            updateMany: limitUpdateMany,
          },
        })
      );

    const result = await attachmentsService.requestDirectUpload(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "report.pdf",
      "application/pdf",
      4096
    );

    expect(result.ok).toBe(true);
    expect(operations).toEqual([
      "findLimit",
      "createLimit",
      "findRacedLimit",
      "incrementLimit",
    ]);
    expect(firstTransactionUpdate).not.toHaveBeenCalled();
    expect(mockWithDbTx).toHaveBeenCalledTimes(2);
    expect(limitUpdateMany).toHaveBeenCalledWith({
      data: { requestCount: { increment: 1 } },
      where: {
        id: "limit-row",
        requestCount: { lt: 60 },
        windowExpiresAt: { gt: new Date("2026-01-01T00:00:00.000Z") },
      },
    });
    expect(mockGetSignedUploadUrl).toHaveBeenCalledOnce();
  });

  it("resets an expired direct upload limiter window deterministically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
    const limitUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    setupUploadDb();
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn().mockResolvedValue({
            id: "limit-row",
            requestCount: 60,
            windowExpiresAt: new Date("2026-01-01T01:00:00.000Z"),
          }),
          updateMany: limitUpdateMany,
        },
      })
    );

    const result = await attachmentsService.requestDirectUpload(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "report.pdf",
      "application/pdf",
      4096
    );

    expect(result.ok).toBe(true);
    expect(limitUpdateMany).toHaveBeenCalledWith({
      data: {
        requestCount: 1,
        windowExpiresAt: new Date("2026-01-01T03:00:00.000Z"),
        windowStartedAt: new Date("2026-01-01T02:00:00.000Z"),
      },
      where: {
        id: "limit-row",
        windowExpiresAt: { lte: new Date("2026-01-01T02:00:00.000Z") },
      },
    });
    expect(mockGetSignedUploadUrl).toHaveBeenCalledOnce();
  });

  it("rejects the 61st direct upload in a fixed window before signing or row creation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
      })
    );
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn().mockResolvedValue({
            id: "limit-row",
            requestCount: 60,
            windowExpiresAt: new Date("2026-01-01T01:00:00.000Z"),
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      })
    );

    const result = await attachmentsService.requestDirectUpload(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "report.pdf",
      "application/pdf",
      4096,
      AttachmentPurpose.Context
    );

    expect(result).toEqual({
      ok: false,
      error: { type: "rate_limited", retryAfterSeconds: 3600 },
    });
    expect(mockGetSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("allows 60 accepted direct uploads per document window and keeps other documents independent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fileCreate = vi.fn().mockImplementation(() =>
      Promise.resolve(
        makeAttachmentRecord({
          id: `new-attach-${fileCreate.mock.calls.length}`,
        })
      )
    );
    const limitRows = new Map<
      string,
      {
        id: string;
        requestCount: number;
        subject: string;
        windowExpiresAt: Date;
        windowStartedAt: Date;
      }
    >();
    setupUploadDb();
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
        fileAttachment: {
          create: fileCreate,
        },
      })
    );
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          create: vi.fn(
            ({
              data,
            }: {
              data: {
                id: string;
                requestCount: number;
                subject: string;
                windowExpiresAt: Date;
                windowStartedAt: Date;
              };
            }) => {
              limitRows.set(data.subject, data);
              return Promise.resolve(data);
            }
          ),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn(
            ({ where }: { where: { bucket_subject: { subject: string } } }) =>
              Promise.resolve(
                limitRows.get(where.bucket_subject.subject) ?? null
              )
          ),
          updateMany: vi.fn(
            ({
              data,
              where,
            }: {
              data: { requestCount: { increment: number } };
              where: {
                id: string;
                requestCount: { lt: number };
                windowExpiresAt: { gt: Date };
              };
            }) => {
              const row = [...limitRows.values()].find(
                (candidate) => candidate.id === where.id
              );
              if (
                row &&
                row.requestCount < where.requestCount.lt &&
                row.windowExpiresAt > where.windowExpiresAt.gt
              ) {
                row.requestCount += data.requestCount.increment;
                return Promise.resolve({ count: 1 });
              }
              return Promise.resolve({ count: 0 });
            }
          ),
        },
      })
    );

    for (let index = 0; index < 60; index += 1) {
      const result = await attachmentsService.requestDirectUpload(
        ARTIFACT_ID,
        ORG_ID,
        index % 2 === 0 ? USER_ID : "another-user",
        "report.pdf",
        "application/pdf",
        4096
      );
      expect(result.ok).toBe(true);
    }

    const limitedResult = await attachmentsService.requestDirectUpload(
      ARTIFACT_ID,
      ORG_ID,
      "another-user",
      "report.pdf",
      "application/pdf",
      4096
    );
    const otherDocumentResult = await attachmentsService.requestDirectUpload(
      "another-document",
      ORG_ID,
      USER_ID,
      "report.pdf",
      "application/pdf",
      4096
    );

    expect(limitedResult).toEqual({
      ok: false,
      error: { type: "rate_limited", retryAfterSeconds: 3600 },
    });
    expect(otherDocumentResult.ok).toBe(true);
    expect(limitRows.get(`${ORG_ID}:${ARTIFACT_ID}`)?.requestCount).toBe(60);
    expect(limitRows.get(`${ORG_ID}:another-document`)?.requestCount).toBe(1);
    expect(mockGetSignedUploadUrl).toHaveBeenCalledTimes(61);
    expect(fileCreate).toHaveBeenCalledTimes(61);
  });

  it("does not consume the direct upload limiter when document verification fails", async () => {
    setupUploadDb({ artifactId: null });

    await expect(
      attachmentsService.requestDirectUpload(
        "missing-document",
        ORG_ID,
        USER_ID,
        "report.pdf",
        "application/pdf",
        4096
      )
    ).rejects.toThrow("Document not found");

    expect(mockWithDbTx).not.toHaveBeenCalled();
    expect(mockGetSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("uses the verified organization/document pair as the shared limiter subject", async () => {
    const limitCreate = vi.fn().mockResolvedValue({});
    setupUploadDb();
    mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        oAuthRateLimit: {
          create: limitCreate,
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const result = await attachmentsService.requestDirectUpload(
      ARTIFACT_ID,
      ORG_ID,
      "another-user",
      "report.pdf",
      "application/pdf",
      4096
    );

    expect(result.ok).toBe(true);
    expect(limitCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subject: `${ORG_ID}:${ARTIFACT_ID}`,
      }),
    });
  });

  it("persists context purpose by default", async () => {
    let capturedCreateArgs: Record<string, unknown> | undefined;
    const createdRecord = makeAttachmentRecord({ id: "new-attach-4" });

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
            create: vi.fn((args: Record<string, unknown>) => {
              capturedCreateArgs = args;
              return Promise.resolve(createdRecord);
            }),
          },
        })
      );

    await attachmentsService.requestUpload(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "report.pdf",
      "application/pdf",
      4096
    );

    expect(capturedCreateArgs).toMatchObject({
      data: {
        artifactId: ARTIFACT_ID,
        purpose: AttachmentPurpose.Context,
      },
    });
  });

  it("persists inline purpose when requested", async () => {
    let capturedCreateArgs: Record<string, unknown> | undefined;
    const createdRecord = makeAttachmentRecord({
      id: "new-attach-5",
      purpose: AttachmentPurpose.Inline,
    });

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
            create: vi.fn((args: Record<string, unknown>) => {
              capturedCreateArgs = args;
              return Promise.resolve(createdRecord);
            }),
          },
        })
      );

    await attachmentsService.requestUpload(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "diagram.png",
      "image/png",
      4096,
      AttachmentPurpose.Inline
    );

    expect(capturedCreateArgs).toMatchObject({
      data: {
        artifactId: ARTIFACT_ID,
        purpose: AttachmentPurpose.Inline,
      },
    });
  });

  it.each([
    ["non-image MIME", "application/pdf", 4096],
    ["SVG MIME", "image/svg+xml", 4096],
    ["oversize image", "image/png", MAX_ATTACHMENT_FILE_SIZE_BYTES + 1],
  ])("rejects inline uploads at the service boundary for %s before signing or creating rows", async (_label, mimeType, sizeBytes) => {
    await expect(
      attachmentsService.requestUpload(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.png",
        mimeType,
        sizeBytes,
        AttachmentPurpose.Inline
      )
    ).rejects.toThrow("Invalid inline attachment upload");

    expect(mockWithDb).not.toHaveBeenCalled();
    expect(mockGetSignedUploadUrl).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      "[attachments-service] Inline attachment upload rejected",
      expect.objectContaining({
        documentId: ARTIFACT_ID,
        mimeType,
        purpose: AttachmentPurpose.Inline,
        sizeBytes,
      })
    );
  });

  it("logs missing storage bucket for inline uploads without touching the database", async () => {
    Reflect.deleteProperty(process.env, "FILE_ATTACHMENTS_BUCKET");

    await expect(
      attachmentsService.requestUpload(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.png",
        "image/png",
        4096,
        AttachmentPurpose.Inline
      )
    ).rejects.toThrow("FILE_ATTACHMENTS_BUCKET is not configured");

    expect(mockWithDb).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith(
      "[attachments-service] Inline attachment upload missing storage bucket",
      expect.objectContaining({
        documentId: ARTIFACT_ID,
        mimeType: "image/png",
        purpose: AttachmentPurpose.Inline,
        reason: "missing_file_attachments_bucket",
        sizeBytes: 4096,
      })
    );
  });

  it("logs inline upload signing failures without leaking storage keys", async () => {
    const expectedKey = `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`;
    mockGetSignedUploadUrl.mockRejectedValue(
      new Error("S3 signer unavailable")
    );
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
      })
    );

    await expect(
      attachmentsService.requestUpload(
        ARTIFACT_ID,
        ORG_ID,
        USER_ID,
        "diagram.png",
        "image/png",
        4096,
        AttachmentPurpose.Inline
      )
    ).rejects.toThrow("S3 signer unavailable");

    expect(mockLog.error).toHaveBeenCalledWith(
      "[attachments-service] Inline attachment upload signing failed",
      expect.objectContaining({
        documentId: ARTIFACT_ID,
        error: "S3 signer unavailable",
        mimeType: "image/png",
        purpose: AttachmentPurpose.Inline,
        reason: "signing_failed",
        sizeBytes: 4096,
      })
    );
    expect(JSON.stringify(mockLog.error.mock.calls)).not.toContain(expectedKey);
  });

  it("throws 'Artifact not found' when artifact ownership check returns null", async () => {
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );

    await expect(
      attachmentsService.requestUpload(
        "nonexistent-artifact",
        ORG_ID,
        USER_ID,
        "file.txt",
        "text/plain",
        100
      )
    ).rejects.toThrow("Document not found");
  });
});

// ---------------------------------------------------------------------------
// listByDocument
// ---------------------------------------------------------------------------

describe("attachmentsService.listByDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns records with createdAt serialized as ISO 8601 strings", async () => {
    const date = new Date("2026-01-15T12:00:00.000Z");
    const record = makeAttachmentRecord({ createdAt: date });

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
            findMany: vi.fn().mockResolvedValue([record]),
          },
        })
      );

    const results = await attachmentsService.listByDocument(
      ARTIFACT_ID,
      ORG_ID
    );

    expect(results).toHaveLength(1);
    expect(results[0].createdAt).toBe(date.toISOString());
  });

  it("queries fileAttachment.findMany scoped to the given artifactId and org, ordered newest first", async () => {
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
              return Promise.resolve([]);
            }),
          },
        })
      );

    await attachmentsService.listByDocument(ARTIFACT_ID, ORG_ID);

    expect(capturedArgs).toEqual({
      where: {
        artifactId: ARTIFACT_ID,
        artifact: { organizationId: ORG_ID },
        purpose: AttachmentPurpose.Context,
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("filters by inline purpose when requested", async () => {
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
              return Promise.resolve([]);
            }),
          },
        })
      );

    await attachmentsService.listByDocument(
      ARTIFACT_ID,
      ORG_ID,
      AttachmentPurposeSelector.Inline
    );

    expect(capturedArgs).toMatchObject({
      where: {
        artifactId: ARTIFACT_ID,
        artifact: { organizationId: ORG_ID },
        purpose: AttachmentPurpose.Inline,
      },
    });
  });

  it("does not add a purpose filter when all attachments are requested", async () => {
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
              return Promise.resolve([]);
            }),
          },
        })
      );

    await attachmentsService.listByDocument(
      ARTIFACT_ID,
      ORG_ID,
      AttachmentPurposeSelector.All
    );

    expect(capturedArgs).toMatchObject({
      where: {
        artifactId: ARTIFACT_ID,
        artifact: { organizationId: ORG_ID },
      },
    });
    expect(capturedArgs?.where).not.toHaveProperty("purpose");
  });

  it("throws 'Artifact not found' when artifact ownership check returns null", async () => {
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );

    await expect(
      attachmentsService.listByDocument("nonexistent-artifact", ORG_ID)
    ).rejects.toThrow("Document not found");
  });
});

// ---------------------------------------------------------------------------
// deleteAttachment
// ---------------------------------------------------------------------------

describe("attachmentsService.deleteAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteArtifact.mockResolvedValue(undefined);
  });

  it("deletes the DB record before calling S3 deleteArtifact", async () => {
    const callOrder: string[] = [];
    const record = makeAttachmentRecord();
    const mockDbDelete = vi.fn(() => {
      callOrder.push("db.delete");
      return Promise.resolve({ count: 1 });
    });
    mockDeleteArtifact.mockImplementation(() => {
      callOrder.push("s3.delete");
      return Promise.resolve();
    });

    // requireArtifact uses withDb
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
      })
    );

    // deleteAttachment uses withDb.tx for atomic find + delete
    mockWithDbTx.mockImplementationOnce(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          fileAttachment: {
            findFirst: vi.fn().mockResolvedValue(record),
            deleteMany: mockDbDelete,
          },
        })
    );

    const result = await attachmentsService.deleteAttachment(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      ATTACHMENT_ID
    );

    expect(result.ok).toBe(true);
    expect(callOrder).toEqual(["db.delete", "s3.delete"]);
  });

  it("does not fail when S3 deleteArtifact throws", async () => {
    const record = makeAttachmentRecord();
    mockDeleteArtifact.mockRejectedValue(new Error("S3 unavailable"));

    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
      })
    );

    mockWithDbTx.mockImplementationOnce(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          fileAttachment: {
            findFirst: vi.fn().mockResolvedValue(record),
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        })
    );

    const result = await attachmentsService.deleteAttachment(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      ATTACHMENT_ID
    );

    expect(result.ok).toBe(true);
  });

  it("passes the attachment key to deleteArtifact", async () => {
    const expectedKey = `attachments/${ARTIFACT_ID}/specific-key`;
    const record = makeAttachmentRecord({ key: expectedKey });

    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
      })
    );

    mockWithDbTx.mockImplementationOnce(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          fileAttachment: {
            findFirst: vi.fn().mockResolvedValue(record),
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        })
    );

    const result = await attachmentsService.deleteAttachment(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      ATTACHMENT_ID
    );

    expect(result.ok).toBe(true);
    expect(mockDeleteArtifact).toHaveBeenCalledWith(expectedKey, "test-bucket");
  });

  it("returns document_not_found when document ownership check returns null", async () => {
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const result = await attachmentsService.deleteAttachment(
      "nonexistent-artifact",
      ORG_ID,
      USER_ID,
      ATTACHMENT_ID
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: { code: DeleteAttachmentErrorCode.DocumentNotFound },
        ok: false,
      })
    );
    expect(mockWithDbTx).not.toHaveBeenCalled();
  });

  it("returns attachment_not_found when attachment lookup returns null", async () => {
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
      })
    );

    mockWithDbTx.mockImplementationOnce(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          fileAttachment: {
            findFirst: vi.fn().mockResolvedValue(null),
          },
        })
    );

    const result = await attachmentsService.deleteAttachment(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      "nonexistent-attach"
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: { code: DeleteAttachmentErrorCode.AttachmentNotFound },
        ok: false,
      })
    );
    expect(mockDeleteArtifact).not.toHaveBeenCalled();
  });

  it("returns not_owned without deleting DB or S3 when actor is not creator", async () => {
    const deleteMany = vi.fn();
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
      })
    );

    mockWithDbTx.mockImplementationOnce(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          fileAttachment: {
            deleteMany,
            findFirst: vi
              .fn()
              .mockResolvedValue(
                makeAttachmentRecord({ createdById: USER_ID })
              ),
          },
        })
    );

    const result = await attachmentsService.deleteAttachment(
      ARTIFACT_ID,
      ORG_ID,
      "different-user",
      ATTACHMENT_ID,
      { requireCreatorOwnership: true }
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: { code: DeleteAttachmentErrorCode.NotOwned },
        ok: false,
      })
    );
    expect(deleteMany).not.toHaveBeenCalled();
    expect(mockDeleteArtifact).not.toHaveBeenCalled();
  });

  it("preserves session delete semantics when creator ownership is not required", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
      })
    );

    mockWithDbTx.mockImplementationOnce(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          fileAttachment: {
            deleteMany,
            findFirst: vi
              .fn()
              .mockResolvedValue(
                makeAttachmentRecord({ createdById: "different-user" })
              ),
          },
        })
    );

    const result = await attachmentsService.deleteAttachment(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      ATTACHMENT_ID
    );

    expect(result.ok).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        artifactId: ARTIFACT_ID,
        id: ATTACHMENT_ID,
      },
    });
    expect(mockDeleteArtifact).toHaveBeenCalled();
  });

  it("uses createdById in the automation delete predicate", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const record = makeAttachmentRecord();
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
      })
    );

    mockWithDbTx.mockImplementationOnce(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          fileAttachment: {
            deleteMany,
            findFirst: vi.fn().mockResolvedValue(record),
          },
        })
    );

    const result = await attachmentsService.deleteAttachment(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      ATTACHMENT_ID,
      { requireCreatorOwnership: true }
    );

    expect(result.ok).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        artifactId: ARTIFACT_ID,
        createdById: USER_ID,
        id: ATTACHMENT_ID,
      },
    });
  });

  it("returns attachment_not_found if the guarded delete matches no rows", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
        },
      })
    );

    mockWithDbTx.mockImplementationOnce(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          fileAttachment: {
            deleteMany,
            findFirst: vi.fn().mockResolvedValue(makeAttachmentRecord()),
          },
        })
    );

    const result = await attachmentsService.deleteAttachment(
      ARTIFACT_ID,
      ORG_ID,
      USER_ID,
      ATTACHMENT_ID,
      { requireCreatorOwnership: true }
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: { code: DeleteAttachmentErrorCode.AttachmentNotFound },
        ok: false,
      })
    );
    expect(mockDeleteArtifact).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getDownloadUrl
// ---------------------------------------------------------------------------

describe("attachmentsService.getDownloadUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSignedDownloadUrlWithDisposition.mockResolvedValue(
      "https://s3.example.com/download-url"
    );
  });

  it("calls getSignedDownloadUrlWithDisposition with (key, filename)", async () => {
    const record = makeAttachmentRecord({
      key: `attachments/${ARTIFACT_ID}/somekey`,
      filename: "report.pdf",
    });

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
            findFirst: vi.fn().mockResolvedValue(record),
          },
        })
      );

    await attachmentsService.getDownloadUrl(ARTIFACT_ID, ORG_ID, ATTACHMENT_ID);

    expect(mockGetSignedDownloadUrlWithDisposition).toHaveBeenCalledWith(
      record.key,
      record.filename,
      3600,
      record.bucket
    );
  });

  it("returns the downloadUrl from the signed URL response", async () => {
    const signedUrl = "https://s3.example.com/presigned-download?signature=abc";
    mockGetSignedDownloadUrlWithDisposition.mockResolvedValue(signedUrl);
    const record = makeAttachmentRecord();

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
            findFirst: vi.fn().mockResolvedValue(record),
          },
        })
      );

    const result = await attachmentsService.getDownloadUrl(
      ARTIFACT_ID,
      ORG_ID,
      ATTACHMENT_ID
    );

    expect(result).toEqual({ downloadUrl: signedUrl });
  });

  it("throws 'Artifact not found' when artifact ownership check returns null", async () => {
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );

    await expect(
      attachmentsService.getDownloadUrl(
        "nonexistent-artifact",
        ORG_ID,
        ATTACHMENT_ID
      )
    ).rejects.toThrow("Document not found");
  });

  it("throws 'Attachment not found' when attachment lookup returns null", async () => {
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
            findFirst: vi.fn().mockResolvedValue(null),
          },
        })
      );

    await expect(
      attachmentsService.getDownloadUrl(
        ARTIFACT_ID,
        ORG_ID,
        "nonexistent-attach"
      )
    ).rejects.toThrow("Attachment not found");
  });
});

// ---------------------------------------------------------------------------
// resolveInlineImages
// ---------------------------------------------------------------------------

describe("attachmentsService.resolveInlineImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

// ---------------------------------------------------------------------------
// listWithSignedUrlsByDocument
// ---------------------------------------------------------------------------

describe("attachmentsService.listWithSignedUrlsByDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries with org-scoped where clause and returns ContextPackAttachment shape", async () => {
    const record = makeAttachmentRecord();
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        fileAttachment: {
          findMany: vi.fn().mockResolvedValue([record]),
        },
      })
    );
    mockGetSignedDownloadUrl.mockResolvedValue("https://s3.example.com/signed");

    const result = await attachmentsService.listWithSignedUrlsByDocument(
      ARTIFACT_ID,
      ORG_ID
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: ATTACHMENT_ID,
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      signedUrl: "https://s3.example.com/signed",
    });
    expect(result[0].signedUrlExpiresAt).toBeDefined();
  });

  it("passes org-scoped where clause to fileAttachment.findMany", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        fileAttachment: {
          findMany: vi.fn((args: Record<string, unknown>) => {
            capturedArgs = args;
            return Promise.resolve([]);
          }),
        },
      })
    );

    await attachmentsService.listWithSignedUrlsByDocument(ARTIFACT_ID, ORG_ID);

    expect(capturedArgs).toMatchObject({
      where: {
        artifactId: ARTIFACT_ID,
        artifact: { organizationId: ORG_ID },
        purpose: AttachmentPurpose.Context,
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("calls getSignedDownloadUrl with the record's key and bucket", async () => {
    const record = makeAttachmentRecord({
      key: "attachments/org-abc/artifact-123/specific-key",
      bucket: "my-bucket",
    });
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        fileAttachment: {
          findMany: vi.fn().mockResolvedValue([record]),
        },
      })
    );
    mockGetSignedDownloadUrl.mockResolvedValue("https://s3.example.com/url");

    await attachmentsService.listWithSignedUrlsByDocument(ARTIFACT_ID, ORG_ID);

    expect(mockGetSignedDownloadUrl).toHaveBeenCalledWith(
      record.key,
      3600,
      "my-bucket"
    );
  });

  it("returns empty array and does not call getSignedDownloadUrl when no records exist", async () => {
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        fileAttachment: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      })
    );

    const result = await attachmentsService.listWithSignedUrlsByDocument(
      ARTIFACT_ID,
      ORG_ID
    );

    expect(result).toHaveLength(0);
    expect(mockGetSignedDownloadUrl).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for attachmentsService.
 *
 * All database calls are mocked via vi.mock("@repo/database").
 * AWS S3 functions and cuid2 are also mocked.
 * Tests verify:
 *   - requestUpload calls getSignedUploadUrl with expiresIn=900 and the correct S3 key pattern
 *   - listByDocument returns records with createdAt serialized as ISO strings
 *   - deleteAttachment deletes the DB record before S3 and swallows S3 errors
 *   - getDownloadUrl calls getSignedDownloadUrlWithDisposition with (key, filename)
 *   - All methods throw "Document not found" when the ownership check returns null
 */
import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => {
  const tx = vi.fn();
  const withDbFn = Object.assign(vi.fn(), { tx });
  return {
    withDb: withDbFn,
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      PULL_REQUEST: "PULL_REQUEST",
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

import { createId } from "@paralleldrive/cuid2";
import {
  deleteArtifact,
  getSignedDownloadUrl,
  getSignedDownloadUrlWithDisposition,
  getSignedUploadUrl,
} from "@repo/aws";
import { withDb } from "@repo/database";
import { attachmentsService } from "../attachments-service";

const mockWithDb = withDb as unknown as Mock & { tx: Mock };
const mockWithDbTx = mockWithDb.tx;
const mockGetSignedUploadUrl = getSignedUploadUrl as unknown as Mock;
const mockGetSignedDownloadUrl = getSignedDownloadUrl as unknown as Mock;
const mockGetSignedDownloadUrlWithDisposition =
  getSignedDownloadUrlWithDisposition as unknown as Mock;
const mockDeleteArtifact = deleteArtifact as unknown as Mock;
const mockCreateId = createId as unknown as Mock;

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
    ...overrides,
  };
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
      uploadUrl,
      key: expectedKey,
    });
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
      where: { artifactId: ARTIFACT_ID, artifact: { organizationId: ORG_ID } },
      orderBy: { createdAt: "desc" },
    });
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
      return Promise.resolve(record);
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
            delete: mockDbDelete,
          },
        })
    );

    await attachmentsService.deleteAttachment(
      ARTIFACT_ID,
      ORG_ID,
      ATTACHMENT_ID
    );

    expect(callOrder).toEqual(["db.delete", "s3.delete"]);
  });

  it("does not re-throw when S3 deleteArtifact throws", async () => {
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
            delete: vi.fn().mockResolvedValue(record),
          },
        })
    );

    await expect(
      attachmentsService.deleteAttachment(ARTIFACT_ID, ORG_ID, ATTACHMENT_ID)
    ).resolves.toBeUndefined();
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
            delete: vi.fn().mockResolvedValue(record),
          },
        })
    );

    await attachmentsService.deleteAttachment(
      ARTIFACT_ID,
      ORG_ID,
      ATTACHMENT_ID
    );

    expect(mockDeleteArtifact).toHaveBeenCalledWith(expectedKey, "test-bucket");
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
      attachmentsService.deleteAttachment(
        "nonexistent-artifact",
        ORG_ID,
        ATTACHMENT_ID
      )
    ).rejects.toThrow("Document not found");
  });

  it("throws 'Attachment not found' when attachment lookup returns null", async () => {
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

    await expect(
      attachmentsService.deleteAttachment(
        ARTIFACT_ID,
        ORG_ID,
        "nonexistent-attach"
      )
    ).rejects.toThrow("Attachment not found");
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
      where: { artifactId: ARTIFACT_ID, artifact: { organizationId: ORG_ID } },
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

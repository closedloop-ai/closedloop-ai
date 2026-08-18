import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_ASSET_MAX_BYTES,
  CatalogAssetTooLargeError,
  deleteObjects,
  getCatalogAssetBytes,
  getCatalogAssetUploadUrl,
  getSignedDownloadUrl,
  getSignedDownloadUrlWithDisposition,
  getSignedTranscriptDownloadUrl,
  getSignedUploadUrl,
  getTranscriptObjectBytesRange,
  headAttachmentObject,
  headAttachmentsBucket,
  INTELLIGENT_TIERING_STORAGE_CLASS,
  listObjects,
  putAttachmentObject,
} from "./index";

const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => {
  class MockCommand {
    readonly input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  return {
    DeleteObjectCommand: MockCommand,
    DeleteObjectsCommand: MockCommand,
    GetObjectCommand: MockCommand,
    HeadBucketCommand: MockCommand,
    HeadObjectCommand: MockCommand,
    ListObjectsV2Command: MockCommand,
    PutObjectCommand: MockCommand,
    S3Client: class S3Client {
      send = s3Send;
    },
    StorageClass: { INTELLIGENT_TIERING: "INTELLIGENT_TIERING" },
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://s3.example.com/upload"),
}));

vi.mock("server-only", () => ({}));

vi.mock("./credentials", () => ({
  getAwsCredentials: vi.fn(),
}));

vi.mock("./keys", () => ({
  keys: () => ({
    AWS_REGION: "us-east-1",
    FILE_ATTACHMENTS_BUCKET: "test-bucket",
  }),
}));

describe("getSignedUploadUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds ContentType and ContentLength into the presigned PutObjectCommand", async () => {
    await getSignedUploadUrl(
      "attachments/org/doc/file",
      "image/png",
      900,
      "attachment-bucket",
      2048
    );

    const command = vi.mocked(getSignedUrl).mock.calls[0][1] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      Bucket: "attachment-bucket",
      ContentLength: 2048,
      ContentType: "image/png",
      Key: "attachments/org/doc/file",
    });
    expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), command, {
      expiresIn: 900,
    });
  });
});

describe("putAttachmentObject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3Send.mockResolvedValue({});
  });

  it("sends attachment bytes with MIME type and content length directly to S3", async () => {
    const body = new Uint8Array([1, 2, 3]);

    await putAttachmentObject({
      body,
      bucket: "attachment-bucket",
      contentLength: body.byteLength,
      contentType: "image/png",
      key: "attachments/org/doc/file",
    });

    expect(s3Send).toHaveBeenCalledOnce();
    const command = s3Send.mock.calls[0][0] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      Body: body,
      Bucket: "attachment-bucket",
      ContentLength: 3,
      ContentType: "image/png",
      Key: "attachments/org/doc/file",
    });
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});

describe("getSignedDownloadUrl", () => {
  // Pin the clock so the absolute `Expires` (now + TTL) is deterministic.
  const SIGNING_INSTANT = new Date("2026-06-29T00:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(SIGNING_INSTANT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches privately and pins an ABSOLUTE Expires at the signature deadline (no fetch-relative max-age, no immutable)", async () => {
    await getSignedDownloadUrl(
      "attachments/org/doc/file",
      900,
      "attachment-bucket"
    );

    const command = vi.mocked(getSignedUrl).mock.calls[0][1] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      Bucket: "attachment-bucket",
      Key: "attachments/org/doc/file",
      ResponseCacheControl: "private",
      // 900s URL: cache expires at the exact signing instant + TTL, so the
      // browser copy lapses with the signature regardless of fetch timing.
      ResponseExpires: new Date("2026-06-29T00:15:00.000Z"),
    });
    // No fetch-relative lifetime and no year-long immutable that could let a
    // cached copy outlive the signature.
    expect(String(command.input.ResponseCacheControl)).not.toContain("max-age");
    expect(String(command.input.ResponseCacheControl)).not.toContain(
      "immutable"
    );
    expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), command, {
      expiresIn: 900,
    });
  });

  it("pins Expires to the short URL TTL for short-lived signatures", async () => {
    await getSignedDownloadUrl("attachments/org/doc/file", 60, "short-bucket");

    const command = vi.mocked(getSignedUrl).mock.calls[0][1] as {
      input: Record<string, unknown>;
    };
    expect(command.input.ResponseExpires).toEqual(
      new Date("2026-06-29T00:01:00.000Z")
    );
  });

  it("pins Expires to the default 3600s deadline", async () => {
    await getSignedDownloadUrl("attachments/org/doc/file");

    const command = vi.mocked(getSignedUrl).mock.calls[0][1] as {
      input: Record<string, unknown>;
    };
    expect(command.input.ResponseExpires).toEqual(
      new Date("2026-06-29T01:00:00.000Z")
    );
  });

  it("bounds the cache by the signature's absolute deadline, so a delayed or reused first fetch cannot cache past expiry", async () => {
    // Regression for the delayed/reused-URL hazard: the cache bound is the
    // signature's absolute deadline, independent of when the browser first
    // fetches. A fetch-relative max-age would let a near-expiry first fetch keep
    // bytes cached past authorization; an absolute Expires cannot.
    const ttlSeconds = 900;
    await getSignedDownloadUrl(
      "attachments/org/doc/file",
      ttlSeconds,
      "attachment-bucket"
    );

    const command = vi.mocked(getSignedUrl).mock.calls[0][1] as {
      input: Record<string, unknown>;
    };
    const signatureDeadlineMs = SIGNING_INSTANT.getTime() + ttlSeconds * 1000;
    const expiresAt = command.input.ResponseExpires as Date;
    // The cache deadline equals (never exceeds) the signature deadline.
    expect(expiresAt.getTime()).toBe(signatureDeadlineMs);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(signatureDeadlineMs);
  });
});

describe("getSignedTranscriptDownloadUrl", () => {
  const SIGNING_INSTANT = new Date("2026-06-29T00:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(SIGNING_INSTANT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs against the transcripts bucket and bounds the cache to the URL's own expiry", async () => {
    await getSignedTranscriptDownloadUrl("org/ct/ext.jsonl", {
      expiresIn: 300,
      bucket: "transcripts-bucket",
    });

    const command = vi.mocked(getSignedUrl).mock.calls[0][1] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      Bucket: "transcripts-bucket",
      Key: "org/ct/ext.jsonl",
      ResponseCacheControl: "private",
      // Cache lapses with the 5-min signature, so a cached transcript copy can
      // never outlive the authorization window.
      ResponseExpires: new Date("2026-06-29T00:05:00.000Z"),
    });
    expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), command, {
      expiresIn: 300,
    });
  });
});

describe("getTranscriptObjectBytesRange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues a bounded ranged GET and returns only the requested prefix bytes", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    s3Send.mockResolvedValueOnce({
      Body: { transformToByteArray: () => Promise.resolve(payload) },
    });

    const result = await getTranscriptObjectBytesRange(
      "org/ct/ext/main.jsonl",
      4,
      "transcripts-bucket"
    );

    expect(Buffer.from(result as Buffer)).toEqual(Buffer.from(payload));
    const command = s3Send.mock.calls[0][0] as {
      input: Record<string, unknown>;
    };
    // Range is 0-based inclusive: bytes 0..(maxBytes-1).
    expect(command.input).toMatchObject({
      Bucket: "transcripts-bucket",
      Key: "org/ct/ext/main.jsonl",
      Range: "bytes=0-3",
    });
  });

  it("floors the range at a single byte for a zero/negative cap", async () => {
    s3Send.mockResolvedValueOnce({
      Body: {
        transformToByteArray: () => Promise.resolve(new Uint8Array([9])),
      },
    });

    await getTranscriptObjectBytesRange("k", 0, "transcripts-bucket");

    const command = s3Send.mock.calls[0][0] as {
      input: Record<string, unknown>;
    };
    expect(command.input.Range).toBe("bytes=0-0");
  });

  it("returns null for a missing object (NoSuchKey) instead of throwing", async () => {
    s3Send.mockRejectedValueOnce(
      Object.assign(new Error("no such key"), { name: "NoSuchKey" })
    );

    const result = await getTranscriptObjectBytesRange(
      "missing",
      100,
      "transcripts-bucket"
    );
    expect(result).toBeNull();
  });

  it("rethrows a non-404 S3 error", async () => {
    s3Send.mockRejectedValueOnce(
      Object.assign(new Error("access denied"), { name: "AccessDenied" })
    );

    await expect(
      getTranscriptObjectBytesRange("k", 100, "transcripts-bucket")
    ).rejects.toThrow("access denied");
  });
});

describe("getSignedDownloadUrlWithDisposition", () => {
  // Pin the clock so the absolute `Expires` (now + TTL) is deterministic.
  const SIGNING_INSTANT = new Date("2026-06-29T00:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(SIGNING_INSTANT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forces a download disposition while still bounding the browser cache by the signature deadline", async () => {
    await getSignedDownloadUrlWithDisposition(
      "attachments/org/doc/file",
      "report.pdf",
      900,
      "attachment-bucket"
    );

    const command = vi.mocked(getSignedUrl).mock.calls[0][1] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      Bucket: "attachment-bucket",
      Key: "attachments/org/doc/file",
      ResponseContentDisposition: 'attachment; filename="report.pdf"',
      // Same cache bound as the inline download path, so a forced-download
      // re-fetch within the signature window serves from cache instead of
      // re-egressing from S3.
      ResponseCacheControl: "private",
      ResponseExpires: new Date("2026-06-29T00:15:00.000Z"),
    });
    expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), command, {
      expiresIn: 900,
    });
  });
});

describe("listObjects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps Contents to keys and surfaces a continuation token when truncated", async () => {
    const lastModified = new Date("2026-06-01T00:00:00.000Z");
    s3Send.mockResolvedValueOnce({
      Contents: [
        { Key: "attachments/a", LastModified: lastModified, Size: 10 },
        { Key: undefined },
      ],
      IsTruncated: true,
      NextContinuationToken: "next-token",
    });

    const page = await listObjects({
      prefix: "attachments/",
      bucket: "attachment-bucket",
      maxKeys: 1000,
    });

    const command = s3Send.mock.calls[0][0] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      Bucket: "attachment-bucket",
      Prefix: "attachments/",
      MaxKeys: 1000,
    });
    expect(page.objects).toEqual([
      { key: "attachments/a", lastModified, size: 10 },
    ]);
    expect(page.nextContinuationToken).toBe("next-token");
  });

  it("omits the continuation token when the listing is exhausted", async () => {
    s3Send.mockResolvedValueOnce({
      Contents: [{ Key: "attachments/b" }],
      IsTruncated: false,
      NextContinuationToken: "should-be-ignored",
    });

    const page = await listObjects({ bucket: "attachment-bucket" });

    expect(page.objects).toEqual([
      { key: "attachments/b", lastModified: undefined, size: undefined },
    ]);
    expect(page.nextContinuationToken).toBeUndefined();
  });
});

describe("deleteObjects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues a single batched DeleteObjects request for all keys", async () => {
    s3Send.mockResolvedValueOnce({ Deleted: [{}, {}] });

    await deleteObjects(
      ["attachments/a", "attachments/b"],
      "attachment-bucket"
    );

    expect(s3Send).toHaveBeenCalledTimes(1);
    const command = s3Send.mock.calls[0][0] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      Bucket: "attachment-bucket",
      Delete: {
        Objects: [{ Key: "attachments/a" }, { Key: "attachments/b" }],
        Quiet: true,
      },
    });
  });

  it("no-ops without calling S3 when given no keys", async () => {
    await deleteObjects([], "attachment-bucket");
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("throws when S3 reports per-key delete errors", async () => {
    s3Send.mockResolvedValueOnce({
      Errors: [{ Key: "attachments/a", Code: "AccessDenied", Message: "nope" }],
    });

    await expect(
      deleteObjects(["attachments/a"], "attachment-bucket")
    ).rejects.toThrow("AccessDenied");
  });

  it("rejects more than 1000 keys in a single call", async () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => `attachments/${i}`);
    await expect(deleteObjects(tooMany, "attachment-bucket")).rejects.toThrow(
      "at most 1000 keys"
    );
    expect(s3Send).not.toHaveBeenCalled();
  });
});

describe("getCatalogAssetUploadUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tiers zip bundles to INTELLIGENT_TIERING", async () => {
    await getCatalogAssetUploadUrl({
      orgId: "org",
      itemId: "item",
      kind: "zip",
      contentType: "application/zip",
      contentLength: 2048,
      bucket: "plugin-store-bucket",
    });

    const command = vi.mocked(getSignedUrl).mock.calls[0][1] as {
      input: Record<string, unknown>;
    };
    // StorageClass is hoisted into the signed query string by the presigner, so
    // the uploader applies it with no header change.
    expect(command.input).toMatchObject({
      Bucket: "plugin-store-bucket",
      ContentLength: 2048,
      ContentType: "application/zip",
      Key: "org/org/catalog/item/zip",
      StorageClass: INTELLIGENT_TIERING_STORAGE_CLASS,
    });
  });

  it("leaves logos on S3 Standard (no StorageClass set)", async () => {
    await getCatalogAssetUploadUrl({
      orgId: "org",
      itemId: "item",
      kind: "logo",
      contentType: "image/png",
      contentLength: 1024,
      bucket: "plugin-store-bucket",
    });

    const command = vi.mocked(getSignedUrl).mock.calls[0][1] as {
      input: Record<string, unknown>;
    };
    expect(command.input.StorageClass).toBeUndefined();
    expect(command.input).toMatchObject({
      Key: "org/org/catalog/item/logo",
    });
  });
});

describe("getCatalogAssetBytes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Build a GetObject response whose Body streams `bytes`. */
  function s3ObjectResponse(bytes: Uint8Array, contentLength?: number) {
    return {
      ContentLength: contentLength,
      Body: { transformToByteArray: () => Promise.resolve(bytes) },
    };
  }

  it("returns the bytes for an in-cap asset", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    s3Send.mockResolvedValueOnce(s3ObjectResponse(payload, payload.length));

    const result = await getCatalogAssetBytes("k", "plugin-store-bucket");

    expect(Buffer.from(result)).toEqual(Buffer.from(payload));
  });

  it("rejects up front when ContentLength exceeds the cap (no full download)", async () => {
    const transformToByteArray = vi.fn();
    s3Send.mockResolvedValueOnce({
      ContentLength: CATALOG_ASSET_MAX_BYTES + 1,
      Body: { transformToByteArray },
    });

    await expect(
      getCatalogAssetBytes("k", "plugin-store-bucket")
    ).rejects.toBeInstanceOf(CatalogAssetTooLargeError);
    // Guard tripped before the body was streamed into memory.
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("rejects when the downloaded buffer exceeds the cap despite a small/absent ContentLength", async () => {
    // ContentLength is omitted (or understated) — the post-download length check
    // is the authoritative guard and must still reject.
    const bytes = new Uint8Array(CATALOG_ASSET_MAX_BYTES + 1);
    s3Send.mockResolvedValueOnce(s3ObjectResponse(bytes, undefined));

    await expect(
      getCatalogAssetBytes("k", "plugin-store-bucket")
    ).rejects.toBeInstanceOf(CatalogAssetTooLargeError);
  });
});

describe("headAttachmentObject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the object metadata when the key exists", async () => {
    s3Send.mockResolvedValueOnce({ ContentLength: 12, ETag: '"abc"' });

    await expect(headAttachmentObject("attachments/o/d/k")).resolves.toEqual({
      byteSize: 12,
      etag: '"abc"',
    });
  });

  it("returns null on an authoritative per-key 404", async () => {
    s3Send.mockRejectedValueOnce({
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });

    await expect(headAttachmentObject("attachments/o/d/k")).resolves.toBeNull();
  });

  it("THROWS on a NoSuchBucket 404 instead of reporting the key absent", async () => {
    // The catastrophic conflation: NoSuchBucket is also HTTP 404, so a
    // status-only test would report every key in a deleted or misconfigured
    // bucket as absent — and the row sweep deletes on absence. The caller must
    // see an error it can classify as indeterminate, not a `null`.
    s3Send.mockRejectedValueOnce({
      name: "NoSuchBucket",
      $metadata: { httpStatusCode: 404 },
    });

    await expect(headAttachmentObject("attachments/o/d/k")).rejects.toEqual(
      expect.objectContaining({ name: "NoSuchBucket" })
    );
  });

  it("THROWS when only the wire-format Code names the missing bucket", async () => {
    // Same systemic failure, surfaced under the S3 error body's `Code` rather
    // than the SDK error name.
    s3Send.mockRejectedValueOnce({
      name: "NotFound",
      Code: "NoSuchBucket",
      $metadata: { httpStatusCode: 404 },
    });

    await expect(headAttachmentObject("attachments/o/d/k")).rejects.toEqual(
      expect.objectContaining({ Code: "NoSuchBucket" })
    );
  });

  it("throws on a non-404 failure (indeterminate, not absent)", async () => {
    s3Send.mockRejectedValueOnce(
      Object.assign(new Error("slow down"), {
        name: "SlowDown",
        $metadata: { httpStatusCode: 503 },
      })
    );

    await expect(headAttachmentObject("attachments/o/d/k")).rejects.toThrow(
      "slow down"
    );
  });
});

describe("headAttachmentsBucket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves and probes the configured bucket when it is reachable", async () => {
    s3Send.mockResolvedValueOnce({});

    await expect(headAttachmentsBucket()).resolves.toBeUndefined();

    const command = s3Send.mock.calls[0][0] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toEqual({ Bucket: "test-bucket" });
  });

  it("rejects when the bucket is missing, so the caller can fail the whole run", async () => {
    s3Send.mockRejectedValueOnce(
      Object.assign(new Error("NoSuchBucket"), { name: "NoSuchBucket" })
    );

    await expect(headAttachmentsBucket("attachment-bucket")).rejects.toThrow(
      "NoSuchBucket"
    );
  });
});

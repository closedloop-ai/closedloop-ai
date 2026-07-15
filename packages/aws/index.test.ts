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
  INTELLIGENT_TIERING_STORAGE_CLASS,
  listObjects,
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

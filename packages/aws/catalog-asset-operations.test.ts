import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_ASSET_MAX_BYTES,
  CatalogAssetTooLargeError,
  getCatalogAssetBytes,
  getCatalogAssetDownloadUrl,
  getCatalogAssetUploadUrl,
  headCatalogAsset,
} from "./catalog-assets";
import { deleteArtifact } from "./index";
import { INTELLIGENT_TIERING_STORAGE_CLASS } from "./s3-client";

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
    HeadObjectCommand: MockCommand,
    ListObjectsV2Command: MockCommand,
    PutObjectCommand: MockCommand,
    S3Client: class S3Client {
      middlewareStack = { add: vi.fn() };
      send = s3Send;
    },
    StorageClass: { INTELLIGENT_TIERING: "INTELLIGENT_TIERING" },
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://s3.example.com/download"),
}));

vi.mock("server-only", () => ({}));

vi.mock("./credentials", () => ({
  getAwsCredentials: vi.fn(),
}));

vi.mock("./keys", () => ({
  keys: () => ({
    AWS_REGION: "us-east-1",
    FILE_ATTACHMENTS_BUCKET: "test-bucket",
    PLUGIN_STORE_BUCKET: "plugin-store-bucket",
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deleteArtifact", () => {
  it("uses the configured attachments bucket by default", async () => {
    s3Send.mockResolvedValueOnce({});

    await deleteArtifact("attachments/org/doc/file");

    expect(firstS3Command().input).toEqual({
      Bucket: "test-bucket",
      Key: "attachments/org/doc/file",
    });
  });

  it("honors an explicit bucket override", async () => {
    s3Send.mockResolvedValueOnce({});

    await deleteArtifact("attachments/org/doc/file", "override-bucket");

    expect(firstS3Command().input.Bucket).toBe("override-bucket");
  });
});

describe("getCatalogAssetBytes", () => {
  it("rejects a response without a body", async () => {
    s3Send.mockResolvedValueOnce({ ContentLength: 0 });

    await expect(getCatalogAssetBytes("k")).rejects.toThrow(
      "Empty catalog asset body"
    );
  });

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

describe("headCatalogAsset", () => {
  it("returns object metadata from the configured catalog bucket", async () => {
    s3Send.mockResolvedValueOnce({ ContentLength: 2048, ETag: "etag" });

    await expect(headCatalogAsset("org/o/catalog/i/zip")).resolves.toEqual({
      byteSize: 2048,
      etag: "etag",
    });
  });

  it("returns null for an HTTP 404 response", async () => {
    s3Send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });

    await expect(headCatalogAsset("missing")).resolves.toBeNull();
  });

  it("rethrows errors that are not missing-object responses", async () => {
    s3Send.mockRejectedValueOnce("service unavailable");

    await expect(headCatalogAsset("asset")).rejects.toBe("service unavailable");
  });
});

describe("getCatalogAssetDownloadUrl", () => {
  it("uses the configured bucket and default expiration", async () => {
    await getCatalogAssetDownloadUrl("org/o/catalog/i/logo");

    const command = firstSignedCommand();
    expect(command.input).toMatchObject({
      Bucket: "plugin-store-bucket",
      Key: "org/o/catalog/i/logo",
      ResponseCacheControl: "private",
    });
    expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), command, {
      expiresIn: 900,
    });
  });

  it("honors bucket and expiration overrides", async () => {
    await getCatalogAssetDownloadUrl("org/o/catalog/i/zip", {
      bucket: "override-bucket",
      expiresIn: 60,
    });

    const command = firstSignedCommand();
    expect(command.input.Bucket).toBe("override-bucket");
    expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), command, {
      expiresIn: 60,
    });
  });
});

/** Build a GetObject response whose Body streams `bytes`. */
function s3ObjectResponse(bytes: Uint8Array, contentLength?: number) {
  return {
    ContentLength: contentLength,
    Body: { transformToByteArray: () => Promise.resolve(bytes) },
  };
}

function firstS3Command(): { input: Record<string, unknown> } {
  return s3Send.mock.calls[0][0] as { input: Record<string, unknown> };
}

function firstSignedCommand(): { input: Record<string, unknown> } {
  return vi.mocked(getSignedUrl).mock.calls[0][1] as {
    input: Record<string, unknown>;
  };
}

describe("getCatalogAssetUploadUrl", () => {
  it("tiers zip bundles to INTELLIGENT_TIERING", async () => {
    await getCatalogAssetUploadUrl({
      orgId: "org",
      itemId: "item",
      kind: "zip",
      contentType: "application/zip",
      contentLength: 2048,
      bucket: "plugin-store-bucket",
    });

    const command = firstSignedCommand();
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

    const command = firstSignedCommand();
    expect(command.input.StorageClass).toBeUndefined();
    expect(command.input).toMatchObject({
      Key: "org/org/catalog/item/logo",
    });
  });
});

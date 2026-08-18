import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteArtifact,
  getCatalogAssetBytes,
  getCatalogAssetDownloadUrl,
  headCatalogAsset,
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

function firstS3Command(): { input: Record<string, unknown> } {
  return s3Send.mock.calls[0][0] as { input: Record<string, unknown> };
}

function firstSignedCommand(): { input: Record<string, unknown> } {
  return vi.mocked(getSignedUrl).mock.calls[0][1] as {
    input: Record<string, unknown>;
  };
}

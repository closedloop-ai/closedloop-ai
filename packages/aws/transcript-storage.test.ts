import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortTranscriptMultipartUpload,
  completeTranscriptMultipartUpload,
  copyTranscriptPart,
  createTranscriptMultipartUpload,
  deleteTranscriptObjects,
  headTranscriptObject,
  listTranscriptParts,
  presignTranscriptPutObject,
  presignTranscriptUploadPart,
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
    AbortMultipartUploadCommand: MockCommand,
    CompleteMultipartUploadCommand: MockCommand,
    CreateMultipartUploadCommand: MockCommand,
    DeleteObjectCommand: MockCommand,
    DeleteObjectsCommand: MockCommand,
    GetObjectCommand: MockCommand,
    HeadObjectCommand: MockCommand,
    ListObjectsV2Command: MockCommand,
    ListPartsCommand: MockCommand,
    PutObjectCommand: MockCommand,
    UploadPartCommand: MockCommand,
    UploadPartCopyCommand: MockCommand,
    S3Client: class S3Client {
      send = s3Send;
    },
    StorageClass: { INTELLIGENT_TIERING: "INTELLIGENT_TIERING" },
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://s3.example.com/signed"),
}));

vi.mock("server-only", () => ({}));
vi.mock("./credentials", () => ({ getAwsCredentials: vi.fn() }));
vi.mock("./keys", () => ({
  keys: () => ({
    AWS_REGION: "us-east-1",
    TRANSCRIPTS_BUCKET: "transcripts-bucket",
  }),
}));

function lastCommandInput(): Record<string, unknown> {
  const call = s3Send.mock.calls.at(-1);
  return (call?.[0] as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createTranscriptMultipartUpload", () => {
  it("requests a FULL_OBJECT CRC64NVME multipart upload and returns the id", async () => {
    s3Send.mockResolvedValue({ UploadId: "upload-1" });
    const result = await createTranscriptMultipartUpload("org/ct/s.jsonl");
    expect(result).toEqual({ uploadId: "upload-1" });
    expect(lastCommandInput()).toMatchObject({
      Bucket: "transcripts-bucket",
      Key: "org/ct/s.jsonl",
      ChecksumAlgorithm: "CRC64NVME",
      ChecksumType: "FULL_OBJECT",
      // Cold archive data — tier so parts (and the completed object) auto-move to
      // cheaper storage instead of accruing full S3 Standard cost forever.
      StorageClass: "INTELLIGENT_TIERING",
    });
  });

  it("throws when S3 returns no UploadId", async () => {
    s3Send.mockResolvedValue({});
    await expect(
      createTranscriptMultipartUpload("org/ct/s.jsonl")
    ).rejects.toThrow("UploadId");
  });
});

describe("copyTranscriptPart", () => {
  it("issues an UploadPartCopy guarded by copy-source If-Match", async () => {
    s3Send.mockResolvedValue({
      CopyPartResult: { ETag: "etag-1", ChecksumCRC64NVME: "crc-1" },
    });
    const result = await copyTranscriptPart({
      key: "org/ct/s.jsonl",
      uploadId: "upload-1",
      partNumber: 1,
      sourceKey: "org/ct/s.jsonl",
      ifMatchEtag: "prev-etag",
    });
    expect(result).toEqual({
      partNumber: 1,
      etag: "etag-1",
      checksumCrc64Nvme: "crc-1",
    });
    expect(lastCommandInput()).toMatchObject({
      CopySource: "transcripts-bucket/org/ct/s.jsonl",
      CopySourceIfMatch: "prev-etag",
      PartNumber: 1,
      UploadId: "upload-1",
    });
  });

  it("percent-encodes copy-source path segments but keeps slashes", async () => {
    s3Send.mockResolvedValue({ CopyPartResult: { ETag: "e" } });
    await copyTranscriptPart({
      key: "org/ct/s/subagent/a b.jsonl",
      uploadId: "u",
      partNumber: 1,
      sourceKey: "org/ct/s/subagent/a b.jsonl",
      ifMatchEtag: "e0",
    });
    expect(lastCommandInput().CopySource).toBe(
      "transcripts-bucket/org/ct/s/subagent/a%20b.jsonl"
    );
  });

  it("rejects a copy response without an ETag", async () => {
    s3Send.mockResolvedValue({ CopyPartResult: {} });

    await expect(
      copyTranscriptPart({
        key: "org/ct/s.jsonl",
        uploadId: "u",
        partNumber: 1,
        sourceKey: "org/ct/s.jsonl",
        ifMatchEtag: "e0",
      })
    ).rejects.toThrow("UploadPartCopy did not return an ETag");
  });
});

describe("completeTranscriptMultipartUpload", () => {
  it("sorts parts and sends the full-object checksum + If-Match", async () => {
    s3Send.mockResolvedValue({ ETag: "final", ChecksumCRC64NVME: "crc-x" });
    const result = await completeTranscriptMultipartUpload({
      key: "org/ct/s.jsonl",
      uploadId: "u",
      parts: [
        { partNumber: 2, etag: "e2" },
        { partNumber: 1, etag: "e1" },
      ],
      checksumCrc64Nvme: "crc-x",
      ifMatchEtag: "prev",
    });
    expect(result).toEqual({ etag: "final", checksumCrc64Nvme: "crc-x" });
    const input = lastCommandInput() as {
      MultipartUpload: { Parts: Array<{ PartNumber: number }> };
      ChecksumCRC64NVME: string;
      ChecksumType: string;
      IfMatch: string;
    };
    expect(input.MultipartUpload.Parts.map((p) => p.PartNumber)).toEqual([
      1, 2,
    ]);
    expect(input.ChecksumCRC64NVME).toBe("crc-x");
    expect(input.ChecksumType).toBe("FULL_OBJECT");
    expect(input.IfMatch).toBe("prev");
  });

  it("omits absent object guards and includes per-part checksums", async () => {
    s3Send.mockResolvedValue({});

    await completeTranscriptMultipartUpload({
      key: "org/ct/s.jsonl",
      uploadId: "u",
      parts: [{ partNumber: 1, etag: "e1", checksumCrc64Nvme: "part-crc" }],
    });

    expect(lastCommandInput()).toEqual({
      Bucket: "transcripts-bucket",
      Key: "org/ct/s.jsonl",
      MultipartUpload: {
        Parts: [
          {
            PartNumber: 1,
            ETag: "e1",
            ChecksumCRC64NVME: "part-crc",
          },
        ],
      },
      UploadId: "u",
    });
  });
});

describe("listTranscriptParts", () => {
  it("follows pagination and normalizes parts", async () => {
    s3Send
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 1, ETag: "e1", Size: 100 }],
        IsTruncated: true,
        NextPartNumberMarker: "1",
      })
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 2, ETag: "e2", Size: 50 }],
        IsTruncated: false,
      });
    const parts = await listTranscriptParts({ key: "k", uploadId: "u" });
    expect(parts).toEqual([
      { partNumber: 1, etag: "e1", size: 100, checksumCrc64Nvme: undefined },
      { partNumber: 2, etag: "e2", size: 50, checksumCrc64Nvme: undefined },
    ]);
    expect(s3Send).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed parts and handles an absent parts collection", async () => {
    s3Send
      .mockResolvedValueOnce({
        Parts: [
          { ETag: "missing-number" },
          { PartNumber: 2 },
          { PartNumber: 0, ETag: "zero-is-valid" },
        ],
        IsTruncated: true,
        NextPartNumberMarker: "2",
      })
      .mockResolvedValueOnce({});

    await expect(
      listTranscriptParts({ key: "k", uploadId: "u" })
    ).resolves.toEqual([
      {
        partNumber: 0,
        etag: "zero-is-valid",
        size: undefined,
        checksumCrc64Nvme: undefined,
      },
    ]);
  });
});

describe("presignTranscriptUploadPart", () => {
  it("uses the configured bucket and default expiration", async () => {
    await presignTranscriptUploadPart({
      key: "org/ct/s.jsonl",
      uploadId: "u",
      partNumber: 2,
    });

    const signCall = vi.mocked(getSignedUrl).mock.calls.at(-1);
    expect((signCall?.[1] as { input: Record<string, unknown> }).input).toEqual(
      {
        Bucket: "transcripts-bucket",
        Key: "org/ct/s.jsonl",
        PartNumber: 2,
        UploadId: "u",
      }
    );
    expect(signCall?.[2]).toEqual({ expiresIn: 3600 });
  });

  it("honors bucket and expiration overrides", async () => {
    await presignTranscriptUploadPart({
      key: "org/ct/s.jsonl",
      uploadId: "u",
      partNumber: 3,
      bucket: "override-bucket",
      expiresIn: 60,
    });

    const signCall = vi.mocked(getSignedUrl).mock.calls.at(-1);
    expect(
      (signCall?.[1] as { input: Record<string, unknown> }).input.Bucket
    ).toBe("override-bucket");
    expect(signCall?.[2]).toEqual({ expiresIn: 60 });
  });
});

describe("presignTranscriptPutObject", () => {
  it("signs the concrete checksum as an unhoistable header and tiers to INTELLIGENT_TIERING", async () => {
    await presignTranscriptPutObject({
      key: "org/ct/s.jsonl",
      checksumCrc64Nvme: "crc-64-value",
    });

    const signCall = (
      getSignedUrl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.at(-1);
    if (!signCall) {
      throw new Error("getSignedUrl was not called");
    }
    // Sign the concrete CRC64NVME value (not just the algorithm) so the desktop's
    // `x-amz-checksum-crc64nvme` request header is covered by the signature; S3
    // 403s an unsigned `x-amz-*` header otherwise. StorageClass is hoisted into
    // the query string, so the desktop applies it with no header change.
    expect(
      (signCall[1] as { input: Record<string, unknown> }).input
    ).toMatchObject({
      Bucket: "transcripts-bucket",
      Key: "org/ct/s.jsonl",
      ChecksumCRC64NVME: "crc-64-value",
      StorageClass: "INTELLIGENT_TIERING",
    });
    // The checksum header must stay a SIGNED request header (unhoisted), or the
    // desktop's header won't match the signature.
    expect(
      (signCall[2] as { unhoistableHeaders?: Set<string> }).unhoistableHeaders
    ).toEqual(new Set(["x-amz-checksum-crc64nvme"]));
  });
});

describe("headTranscriptObject", () => {
  it("returns byte size, etag and checksum", async () => {
    s3Send.mockResolvedValue({
      ContentLength: 2048,
      ETag: "etag",
      ChecksumCRC64NVME: "crc",
    });
    const head = await headTranscriptObject("k");
    expect(head).toEqual({
      byteSize: 2048,
      etag: "etag",
      checksumCrc64Nvme: "crc",
    });
  });

  it("returns null when the object is absent (404)", async () => {
    s3Send.mockRejectedValue({ name: "NotFound" });
    expect(await headTranscriptObject("k")).toBeNull();
  });

  it("rethrows non-404 errors", async () => {
    s3Send.mockRejectedValue(new Error("boom"));
    await expect(headTranscriptObject("k")).rejects.toThrow("boom");
  });

  it("recognizes an HTTP 404 without an AWS error name", async () => {
    s3Send.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });

    await expect(headTranscriptObject("k")).resolves.toBeNull();
  });
});

describe("abortTranscriptMultipartUpload", () => {
  it("aborts the requested upload", async () => {
    s3Send.mockResolvedValue({});

    await abortTranscriptMultipartUpload({
      key: "org/ct/s.jsonl",
      uploadId: "u",
      bucket: "override-bucket",
    });

    expect(lastCommandInput()).toEqual({
      Bucket: "override-bucket",
      Key: "org/ct/s.jsonl",
      UploadId: "u",
    });
  });
});

describe("deleteTranscriptObjects", () => {
  it("does not call S3 for an empty key list", async () => {
    await deleteTranscriptObjects([]);

    expect(s3Send).not.toHaveBeenCalled();
  });

  it("deletes keys from the configured transcripts bucket", async () => {
    s3Send.mockResolvedValue({});

    await deleteTranscriptObjects(["org/ct/a.jsonl", "org/ct/b.jsonl"]);

    expect(lastCommandInput()).toEqual({
      Bucket: "transcripts-bucket",
      Delete: {
        Objects: [{ Key: "org/ct/a.jsonl" }, { Key: "org/ct/b.jsonl" }],
        Quiet: true,
      },
    });
  });

  it("reports S3 per-key errors", async () => {
    s3Send.mockResolvedValue({
      Errors: [{ Key: "org/ct/a.jsonl" }],
    });

    await expect(
      deleteTranscriptObjects(["org/ct/a.jsonl", "org/ct/b.jsonl"])
    ).rejects.toThrow("1 transcript object(s) out of 2 total");
  });

  it("continues after a failed batch and reports every key in that batch", async () => {
    const keys = Array.from({ length: 1001 }, (_, index) => `key-${index}`);
    s3Send
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce({});

    await expect(deleteTranscriptObjects(keys)).rejects.toThrow(
      "1000 transcript object(s) out of 1001 total"
    );
    expect(s3Send).toHaveBeenCalledTimes(2);
  });
});

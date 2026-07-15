import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeTranscriptMultipartUpload,
  copyTranscriptPart,
  createTranscriptMultipartUpload,
  headTranscriptObject,
  listTranscriptParts,
  presignTranscriptPutObject,
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
});

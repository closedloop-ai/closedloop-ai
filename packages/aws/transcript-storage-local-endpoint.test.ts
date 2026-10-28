import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-12043: a local S3-compatible store (`AWS_S3_ENDPOINT`, the vibe
 * environment's MinIO) rejects multipart uploads naming INTELLIGENT_TIERING, so
 * transcript uploads carry no storage class there. With the endpoint unset,
 * `transcript-storage.test.ts` pins INTELLIGENT_TIERING on both paths; this
 * suite builds the module both ways so one file shows the switch.
 */

const { s3Send, env } = vi.hoisted(() => ({
  s3Send: vi.fn(),
  env: {} as Record<string, string | undefined>,
}));

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
    DeleteObjectsCommand: MockCommand,
    GetObjectCommand: MockCommand,
    HeadObjectCommand: MockCommand,
    ListPartsCommand: MockCommand,
    PutObjectCommand: MockCommand,
    UploadPartCommand: MockCommand,
    UploadPartCopyCommand: MockCommand,
    S3Client: class S3Client {
      middlewareStack = { add: vi.fn() };
      send = s3Send;
    },
    StorageClass: { INTELLIGENT_TIERING: "INTELLIGENT_TIERING" },
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("http://127.0.0.1:9390/signed"),
}));

vi.mock("server-only", () => ({}));
vi.mock("./credentials", () => ({ getAwsCredentials: vi.fn() }));
vi.mock("./keys", () => ({ keys: () => env }));

const LOCAL_ENDPOINT = "http://127.0.0.1:9390";
const KEY = "org/ct/s.jsonl";

async function loadStorage(endpoint: string | undefined) {
  for (const name of Object.keys(env)) {
    Reflect.deleteProperty(env, name);
  }
  Object.assign(env, {
    AWS_REGION: "us-east-1",
    TRANSCRIPTS_BUCKET: "transcripts-bucket",
    AWS_S3_ENDPOINT: endpoint,
  });
  vi.resetModules();
  return await import("./transcript-storage");
}

function sentInput(): Record<string, unknown> {
  const call = s3Send.mock.calls.at(-1);
  if (!call) {
    throw new Error("no S3 command was sent");
  }
  return (call[0] as { input: Record<string, unknown> }).input;
}

function signedInput(): Record<string, unknown> {
  const call = vi.mocked(getSignedUrl).mock.calls.at(-1);
  if (!call) {
    throw new Error("getSignedUrl was never called");
  }
  return call[1].input as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  s3Send.mockResolvedValue({ UploadId: "upload-1" });
});

describe("transcript storage class against a local endpoint", () => {
  it("omits the storage class on multipart create and the presigned PUT", async () => {
    const storage = await loadStorage(LOCAL_ENDPOINT);
    await storage.createTranscriptMultipartUpload(KEY);
    expect(sentInput()).not.toHaveProperty("StorageClass");
    await storage.presignTranscriptPutObject({
      key: KEY,
      checksumCrc64Nvme: "AAAAAAAAAAA=",
    });
    expect(signedInput()).not.toHaveProperty("StorageClass");
  });

  it("keeps INTELLIGENT_TIERING when no endpoint override is set", async () => {
    const storage = await loadStorage(undefined);
    await storage.createTranscriptMultipartUpload(KEY);
    expect(sentInput()).toHaveProperty("StorageClass", "INTELLIGENT_TIERING");
    await storage.presignTranscriptPutObject({
      key: KEY,
      checksumCrc64Nvme: "AAAAAAAAAAA=",
    });
    expect(signedInput()).toHaveProperty("StorageClass", "INTELLIGENT_TIERING");
  });
});

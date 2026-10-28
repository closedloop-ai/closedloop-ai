import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteArtifact,
  deleteObjects,
  getSignedDownloadUrl,
  getSignedDownloadUrlWithDisposition,
  getSignedUploadUrl,
  headAttachmentObject,
  headAttachmentsBucket,
  listObjects,
  putAttachmentObject,
} from "./index";
import type * as S3ClientModule from "./s3-client";

const { s3Send, bucketConfig } = vi.hoisted(() => ({
  s3Send: vi.fn(),
  bucketConfig: {} as { FILE_ATTACHMENTS_BUCKET?: string },
}));

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
      middlewareStack = { add: vi.fn() };
      send = s3Send;
    },
    StorageClass: { INTELLIGENT_TIERING: "INTELLIGENT_TIERING" },
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://s3.example.com/signed"),
}));

vi.mock("server-only", () => ({}));

vi.mock("./credentials", () => ({
  getAwsCredentials: vi.fn(),
}));

vi.mock("./keys", () => ({
  keys: () => ({ AWS_REGION: "us-east-1" }),
}));

// s3-client copies the bucket names out of keys() at import time. Swapping its
// `config` for a mutable object lets each describe set the configured bucket.
vi.mock("./s3-client", async (importOriginal) => ({
  ...(await importOriginal<typeof S3ClientModule>()),
  config: bucketConfig,
}));

describe("with FILE_ATTACHMENTS_BUCKET unset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3Send.mockResolvedValue({});
    Reflect.deleteProperty(bucketConfig, "FILE_ATTACHMENTS_BUCKET");
  });

  for (const call of bucketResolvingCalls()) {
    it(`${call.name} refuses before reaching S3 when no bucket is passed`, async () => {
      await expect(call.withoutBucket()).rejects.toThrow(NOT_CONFIGURED);
      expect(s3Send).not.toHaveBeenCalled();
      expect(getSignedUrl).not.toHaveBeenCalled();
    });

    it(`${call.name} uses an explicitly passed bucket`, async () => {
      await call.withBucket("explicit-bucket");
      expect(sentBucket(call.sink)).toBe("explicit-bucket");
    });

    it(`${call.name} rejects an empty-string bucket when none is configured`, async () => {
      await expect(call.withBucket("")).rejects.toThrow(NOT_CONFIGURED);
      expect(s3Send).not.toHaveBeenCalled();
      expect(getSignedUrl).not.toHaveBeenCalled();
    });
  }
});

describe("with FILE_ATTACHMENTS_BUCKET configured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3Send.mockResolvedValue({});
    bucketConfig.FILE_ATTACHMENTS_BUCKET = "configured-bucket";
  });

  for (const call of bucketResolvingCalls()) {
    it(`${call.name} treats an empty-string bucket as not passed`, async () => {
      await call.withBucket("");
      expect(sentBucket(call.sink)).toBe("configured-bucket");
    });
  }
});

const NOT_CONFIGURED = "FILE_ATTACHMENTS_BUCKET is not configured";

function bucketResolvingCalls(): BucketResolvingCall[] {
  return [
    {
      name: "deleteArtifact",
      withoutBucket: () => deleteArtifact("k"),
      withBucket: (bucket) => deleteArtifact("k", bucket),
      sink: "send",
    },
    {
      name: "deleteObjects",
      withoutBucket: () => deleteObjects(["k"]),
      withBucket: (bucket) => deleteObjects(["k"], bucket),
      sink: "send",
    },
    {
      name: "listObjects",
      withoutBucket: () => listObjects(),
      withBucket: (bucket) => listObjects({ bucket }),
      sink: "send",
    },
    {
      name: "getSignedDownloadUrl",
      withoutBucket: () => getSignedDownloadUrl("k"),
      withBucket: (bucket) => getSignedDownloadUrl("k", 60, bucket),
      sink: "presign",
    },
    {
      name: "getSignedUploadUrl",
      withoutBucket: () => getSignedUploadUrl("k"),
      withBucket: (bucket) => getSignedUploadUrl("k", "text/plain", 60, bucket),
      sink: "presign",
    },
    {
      name: "putAttachmentObject",
      withoutBucket: () =>
        putAttachmentObject({
          key: "k",
          body: new Uint8Array([1]),
          contentType: "text/plain",
          contentLength: 1,
        }),
      withBucket: (bucket) =>
        putAttachmentObject({
          key: "k",
          body: new Uint8Array([1]),
          contentType: "text/plain",
          contentLength: 1,
          bucket,
        }),
      sink: "send",
    },
    {
      name: "headAttachmentObject",
      withoutBucket: () => headAttachmentObject("k"),
      withBucket: (bucket) => headAttachmentObject("k", bucket),
      sink: "send",
    },
    {
      name: "headAttachmentsBucket",
      withoutBucket: () => headAttachmentsBucket(),
      withBucket: (bucket) => headAttachmentsBucket(bucket),
      sink: "send",
    },
    {
      name: "getSignedDownloadUrlWithDisposition",
      withoutBucket: () => getSignedDownloadUrlWithDisposition("k", "f.txt"),
      withBucket: (bucket) =>
        getSignedDownloadUrlWithDisposition("k", "f.txt", 60, bucket),
      sink: "presign",
    },
  ];
}

function sentBucket(sink: BucketSink): unknown {
  if (sink === "send") {
    return (s3Send.mock.calls[0][0] as { input: { Bucket: unknown } }).input
      .Bucket;
  }
  return (
    vi.mocked(getSignedUrl).mock.calls[0][1] as {
      input: Record<string, unknown>;
    }
  ).input.Bucket;
}

type BucketResolvingCall = {
  name: string;
  withoutBucket: () => Promise<unknown>;
  withBucket: (bucket: string) => Promise<unknown>;
  sink: BucketSink;
};

type BucketSink = "send" | "presign";

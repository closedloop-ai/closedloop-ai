/**
 * Unit tests for context-pack secret handling in loop-state.ts.
 *
 * Covers:
 * - uploadContextPack writes a pre-scrubbed canonical context-pack.json plus a
 *   raw secrets sidecar (context-pack.secrets.json) when secrets are present
 * - Per-repo githubToken (even without top-level secrets) is treated as secret
 *   material and isolated into the sidecar
 * - Packs with no secrets write only the canonical object
 * - scrubContextPackSecrets deletes the ephemeral secrets sidecar and never
 *   rewrites the canonical object
 */

import { gunzipSync, gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  // Keep the real `StorageClass` enum: @repo/aws (imported below for
  // INTELLIGENT_TIERING_STORAGE_CLASS) reads StorageClass.INTELLIGENT_TIERING at
  // module-eval, so the mock must expose it rather than shadowing it away.
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();

  class MockS3Client {
    send = mockSend;
  }

  function MockGetObjectCommand(params: Record<string, unknown>) {
    return { _type: "GetObjectCommand", ...params };
  }

  function MockPutObjectCommand(params: Record<string, unknown>) {
    return { _type: "PutObjectCommand", ...params };
  }

  function MockListObjectsV2Command(params: Record<string, unknown>) {
    return { _type: "ListObjectsV2Command", ...params };
  }

  function MockDeleteObjectCommand(params: Record<string, unknown>) {
    return { _type: "DeleteObjectCommand", ...params };
  }

  function MockDeleteObjectsCommand(params: Record<string, unknown>) {
    return { _type: "DeleteObjectsCommand", ...params };
  }

  return {
    StorageClass: actual.StorageClass,
    S3Client: MockS3Client,
    GetObjectCommand: MockGetObjectCommand,
    PutObjectCommand: MockPutObjectCommand,
    ListObjectsV2Command: MockListObjectsV2Command,
    DeleteObjectCommand: MockDeleteObjectCommand,
    DeleteObjectsCommand: MockDeleteObjectsCommand,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://mock-presigned-url"),
}));

vi.mock("@repo/aws/credentials", () => ({
  getAwsCredentials: vi.fn().mockReturnValue({}),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { INTELLIGENT_TIERING_STORAGE_CLASS } from "@repo/aws";
import type { ContextPack } from "@closedloop-ai/loops-api/context-pack";
import {
  deleteLoopState,
  downloadMetadata,
  generateUploadUrl,
  getLoopPrefix,
  scrubContextPackSecrets,
  uploadContextPack,
} from "@/lib/loops/loop-state";

/**
 * Build a minimal async-iterable stream for the S3 GetObject Body mock.
 */
function makeS3GetObjectBody(json: unknown): AsyncIterable<Uint8Array> {
  const bytes = Buffer.from(JSON.stringify(json));
  return {
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (sent) {
            return Promise.resolve({
              value: undefined as unknown as Uint8Array,
              done: true,
            });
          }
          sent = true;
          return Promise.resolve({ value: bytes, done: false });
        },
      };
    },
  };
}

/**
 * Build an async-iterable stream of gzip-encoded bytes for the GetObject mock,
 * mirroring how putObject stores compressed objects.
 */
function makeS3GzipBody(json: unknown): AsyncIterable<Uint8Array> {
  const bytes = gzipSync(Buffer.from(JSON.stringify(json)));
  return {
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (sent) {
            return Promise.resolve({
              value: undefined as unknown as Uint8Array,
              done: true,
            });
          }
          sent = true;
          return Promise.resolve({ value: bytes, done: false });
        },
      };
    },
  };
}

function capturedPutCommand(): { Body: Buffer; ContentEncoding?: string } {
  const putCall = (mockSend.mock.calls as unknown[][]).find(
    (call) =>
      (call[0] as { _type?: string } | undefined)?._type === "PutObjectCommand"
  );
  if (!putCall) {
    throw new Error("PutObjectCommand was not called");
  }
  return putCall[0] as { Body: Buffer; ContentEncoding?: string };
}

function capturedPutBody(): ContextPack {
  // Bodies are gzip-encoded (ContentEncoding "gzip"); decode before parsing.
  const bodyBuffer = gunzipSync(capturedPutCommand().Body);
  return JSON.parse(bodyBuffer.toString()) as ContextPack;
}

function putCallCount(): number {
  return (mockSend.mock.calls as unknown[][]).filter(
    (call) =>
      (call[0] as { _type?: string } | undefined)?._type === "PutObjectCommand"
  ).length;
}

type CapturedPut = { Key: string; Body: Buffer; ContentEncoding?: string };

function capturedPuts(): CapturedPut[] {
  return (mockSend.mock.calls as unknown[][])
    .map((call) => call[0] as CapturedPut & { _type?: string })
    .filter((cmd) => cmd?._type === "PutObjectCommand");
}

function putBodyForKeySuffix(suffix: string): ContextPack {
  const put = capturedPuts().find((p) => p.Key.endsWith(suffix));
  if (!put) {
    throw new Error(`No PutObjectCommand for key ending in ${suffix}`);
  }
  return JSON.parse(gunzipSync(put.Body).toString()) as ContextPack;
}

function capturedDeletes(): { Key: string }[] {
  return (mockSend.mock.calls as unknown[][])
    .map((call) => call[0] as { Key: string; _type?: string })
    .filter((cmd) => cmd?._type === "DeleteObjectCommand");
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOP_STATE_BUCKET = "test-loop-state-bucket";
});

describe("uploadContextPack secret isolation", () => {
  it("writes a pre-scrubbed canonical object plus a raw secrets sidecar when secrets exist", async () => {
    const contextPack: ContextPack = {
      command: LoopCommand.Execute,
      artifacts: [],
      secrets: { anthropicApiKey: "sk-ant-key", githubToken: "ghp_main" },
      additionalRepos: [
        { fullName: "org/repo-a", branch: "main", githubToken: "ghp_token_a" },
        {
          fullName: "org/repo-b",
          branch: "develop",
          githubToken: "ghp_token_b",
        },
      ],
    };
    mockSend.mockResolvedValue({});

    const key = await uploadContextPack(
      "org-1/loops/loop-1/run-1",
      contextPack
    );

    // The returned key (handed to the runner) is the ephemeral secrets sidecar.
    expect(key).toBe("org-1/loops/loop-1/run-1/context-pack.secrets.json");
    expect(putCallCount()).toBe(2);

    // Canonical object is born pre-scrubbed: no top-level or per-repo secrets.
    const canonical = putBodyForKeySuffix("/context-pack.json");
    expect(canonical.secrets).toBeUndefined();
    expect(canonical.additionalRepos).toHaveLength(2);
    expect(canonical.additionalRepos?.[0].githubToken).toBeUndefined();
    expect(canonical.additionalRepos?.[0].fullName).toBe("org/repo-a");
    expect(canonical.additionalRepos?.[1].githubToken).toBeUndefined();

    // Sidecar carries the raw secrets for the runner to consume once.
    const sidecar = putBodyForKeySuffix("/context-pack.secrets.json");
    expect(sidecar.secrets?.anthropicApiKey).toBe("sk-ant-key");
    expect(sidecar.additionalRepos?.[0].githubToken).toBe("ghp_token_a");
  });

  it("treats per-repo tokens (without top-level secrets) as secret material", async () => {
    const contextPack: ContextPack = {
      command: LoopCommand.Execute,
      artifacts: [],
      additionalRepos: [
        { fullName: "org/repo-a", branch: "main", githubToken: "ghp_token_a" },
      ],
    };
    mockSend.mockResolvedValue({});

    const key = await uploadContextPack(
      "org-1/loops/loop-1/run-1",
      contextPack
    );

    expect(key).toBe("org-1/loops/loop-1/run-1/context-pack.secrets.json");
    expect(putCallCount()).toBe(2);
    expect(
      putBodyForKeySuffix("/context-pack.json").additionalRepos?.[0].githubToken
    ).toBeUndefined();
  });

  it("writes only the canonical object when the pack has no secrets", async () => {
    const contextPack: ContextPack = {
      command: LoopCommand.Execute,
      artifacts: [],
      additionalRepos: [{ fullName: "org/repo-a", branch: "main" }],
    };
    mockSend.mockResolvedValue({});

    const key = await uploadContextPack(
      "org-1/loops/loop-1/run-1",
      contextPack
    );

    expect(key).toBe("org-1/loops/loop-1/run-1/context-pack.json");
    expect(putCallCount()).toBe(1);
  });
});

describe("scrubContextPackSecrets", () => {
  it("deletes the ephemeral secrets sidecar", async () => {
    mockSend.mockResolvedValue({});

    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    // Never rewrites the canonical object (it was already born scrubbed).
    expect(putCallCount()).toBe(0);
    const deletes = capturedDeletes();
    expect(deletes).toHaveLength(1);
    expect(deletes[0].Key).toBe(
      "org-1/loops/loop-1/run-1/context-pack.secrets.json"
    );
  });
});

describe("context pack gzip compression", () => {
  it("uploads the context pack gzip-encoded with ContentEncoding gzip", async () => {
    const contextPack: ContextPack = {
      command: LoopCommand.Execute,
      artifacts: [],
    };
    mockSend.mockResolvedValueOnce({});

    await uploadContextPack("org-1/loops/loop-1/run-1", contextPack);

    const put = capturedPutCommand();
    expect(put.ContentEncoding).toBe("gzip");
    // Body is gzip bytes (magic header 0x1f 0x8b), not raw JSON.
    expect(put.Body[0]).toBe(0x1f);
    expect(put.Body[1]).toBe(0x8b);
    expect(capturedPutBody()).toEqual(contextPack);
  });
});

describe("getObject content decoding", () => {
  const metadata = {
    loopId: "loop-1",
    command: LoopCommand.Execute,
    status: LoopStatus.Completed,
    startedAt: "2024-01-01T00:00:00.000Z",
    completedAt: "2024-01-01T00:01:00.000Z",
    tokensInput: 1,
    tokensOutput: 2,
    filesRead: [],
    filesWritten: [],
    toolCalls: 0,
  };

  it("decompresses gzip-encoded objects on download", async () => {
    mockSend.mockResolvedValueOnce({
      Body: makeS3GzipBody(metadata),
      ContentEncoding: "gzip",
    });

    const result = await downloadMetadata("org-1/loops/loop-1/run-1");

    expect(result).toEqual(metadata);
  });

  it("passes through uncompressed objects (no ContentEncoding) unchanged", async () => {
    // Harness-uploaded objects (e.g. metadata.json) carry no ContentEncoding.
    mockSend.mockResolvedValueOnce({
      Body: makeS3GetObjectBody(metadata),
    });

    const result = await downloadMetadata("org-1/loops/loop-1/run-1");

    expect(result).toEqual(metadata);
  });
});

function deleteCommands(): Array<{ Delete: { Objects: { Key: string }[] } }> {
  return (mockSend.mock.calls as unknown[][])
    .map((call) => call[0] as { _type?: string })
    .filter((cmd) => cmd?._type === "DeleteObjectsCommand") as Array<{
    Delete: { Objects: { Key: string }[] };
  }>;
}

describe("getLoopPrefix", () => {
  it("builds the loop-level prefix covering every run", () => {
    expect(getLoopPrefix("org-1", "loop-1")).toBe("org-1/loops/loop-1/");
  });
});

describe("deleteLoopState", () => {
  it("lists then batch-deletes every object under the prefix", async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [
          { Key: "org-1/loops/loop-1/run-1/conversation.json" },
          { Key: "org-1/loops/loop-1/run-1/context-pack.json" },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});

    const deleted = await deleteLoopState("org-1/loops/loop-1/");

    expect(deleted).toBe(2);
    const deletes = deleteCommands();
    expect(deletes).toHaveLength(1);
    expect(deletes[0].Delete.Objects).toEqual([
      { Key: "org-1/loops/loop-1/run-1/conversation.json" },
      { Key: "org-1/loops/loop-1/run-1/context-pack.json" },
    ]);
  });

  it("paginates the listing, deleting each page", async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: "org-1/loops/loop-1/a" }],
        IsTruncated: true,
        NextContinuationToken: "token-1",
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Contents: [{ Key: "org-1/loops/loop-1/b" }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});

    const deleted = await deleteLoopState("org-1/loops/loop-1/");

    expect(deleted).toBe(2);
    expect(deleteCommands()).toHaveLength(2);
  });

  it("normalizes a prefix without a trailing slash", async () => {
    mockSend.mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    await deleteLoopState("org-1/loops/loop-1");

    const listCall = (mockSend.mock.calls as unknown[][])
      .map((call) => call[0] as { _type?: string; Prefix?: string })
      .find((cmd) => cmd?._type === "ListObjectsV2Command");
    expect(listCall?.Prefix).toBe("org-1/loops/loop-1/");
  });

  it("issues no delete when the prefix is empty", async () => {
    mockSend.mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    const deleted = await deleteLoopState("org-1/loops/loop-1/");

    expect(deleted).toBe(0);
    expect(deleteCommands()).toHaveLength(0);
  });

  it("throws when S3 reports a per-key delete error", async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: "org-1/loops/loop-1/a" }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Errors: [{ Key: "org-1/loops/loop-1/a", Code: "AccessDenied" }],
      });

    await expect(deleteLoopState("org-1/loops/loop-1/")).rejects.toThrow(
      "DeleteObjects failed"
    );
  });
});

describe("generateUploadUrl", () => {
  it("signs a PutObjectCommand with INTELLIGENT_TIERING storage class", async () => {
    await generateUploadUrl("org-1/loops/loop-1/run-1/metadata.json");

    const signCall = (
      getSignedUrl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.at(-1);
    if (!signCall) {
      throw new Error("getSignedUrl was not called");
    }
    const command = signCall[1] as {
      _type?: string;
      Key?: string;
      StorageClass?: string;
    };
    expect(command._type).toBe("PutObjectCommand");
    expect(command.Key).toBe("org-1/loops/loop-1/run-1/metadata.json");
    // Harness-uploaded loop state must tier like backend writes (putObject),
    // otherwise presigned uploads accrue full S3 Standard cost indefinitely.
    expect(command.StorageClass).toBe(INTELLIGENT_TIERING_STORAGE_CLASS);
  });

  it("omits ContentEncoding by default", async () => {
    await generateUploadUrl("org-1/loops/loop-1/run-1/metadata.json");

    const signCall = (
      getSignedUrl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.at(-1);
    if (!signCall) {
      throw new Error("getSignedUrl was not called");
    }
    const command = signCall[1] as { ContentEncoding?: string };
    expect(command.ContentEncoding).toBeUndefined();
  });

  it("signs ContentEncoding into the URL when requested", async () => {
    await generateUploadUrl(
      "org-1/loops/loop-1/run-1/support/perf.jsonl",
      undefined,
      { contentEncoding: "gzip" }
    );

    const signCall = (
      getSignedUrl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.at(-1);
    if (!signCall) {
      throw new Error("getSignedUrl was not called");
    }
    const command = signCall[1] as {
      ContentEncoding?: string;
      StorageClass?: string;
    };
    // Compressed support files are stored with gzip ContentEncoding so readers
    // transparently decompress; still tiered like every other presigned write.
    expect(command.ContentEncoding).toBe("gzip");
    expect(command.StorageClass).toBe(INTELLIGENT_TIERING_STORAGE_CLASS);
  });
});

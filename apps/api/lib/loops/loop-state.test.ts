/**
 * Unit tests for scrubContextPackSecrets() in loop-state.ts.
 *
 * Covers:
 * - Per-repo githubToken is stripped from additionalRepos entries
 * - Function does not early-return when additionalRepos have tokens but secrets is absent
 * - Function returns early (no S3 write) when neither secrets nor per-repo tokens exist
 * - Top-level secrets are removed along with per-repo tokens
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => {
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

  return {
    S3Client: MockS3Client,
    GetObjectCommand: MockGetObjectCommand,
    PutObjectCommand: MockPutObjectCommand,
    ListObjectsV2Command: MockListObjectsV2Command,
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

import type { ContextPack } from "@closedloop-ai/loops-api/context-pack";
import { scrubContextPackSecrets } from "@/lib/loops/loop-state";

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

function capturedPutBody(): ContextPack {
  const putCall = (mockSend.mock.calls as unknown[][]).find(
    (call) =>
      (call[0] as { _type?: string } | undefined)?._type === "PutObjectCommand"
  );
  if (!putCall) {
    throw new Error("PutObjectCommand was not called");
  }
  const bodyBuffer = (putCall[0] as { Body: Buffer }).Body;
  return JSON.parse(bodyBuffer.toString()) as ContextPack;
}

function putCallCount(): number {
  return (mockSend.mock.calls as unknown[][]).filter(
    (call) =>
      (call[0] as { _type?: string } | undefined)?._type === "PutObjectCommand"
  ).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOP_STATE_BUCKET = "test-loop-state-bucket";
});

describe("scrubContextPackSecrets", () => {
  it("strips githubToken from each additionalRepos entry", async () => {
    const contextPack: ContextPack = {
      command: "EXECUTE",
      artifacts: [],
      additionalRepos: [
        { fullName: "org/repo-a", branch: "main", githubToken: "ghp_token_a" },
        {
          fullName: "org/repo-b",
          branch: "develop",
          githubToken: "ghp_token_b",
        },
      ],
    };

    mockSend
      .mockResolvedValueOnce({ Body: makeS3GetObjectBody(contextPack) })
      .mockResolvedValueOnce({});

    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    const scrubbed = capturedPutBody();
    expect(scrubbed.additionalRepos).toHaveLength(2);
    expect(scrubbed.additionalRepos?.[0].githubToken).toBeUndefined();
    expect(scrubbed.additionalRepos?.[0].fullName).toBe("org/repo-a");
    expect(scrubbed.additionalRepos?.[1].githubToken).toBeUndefined();
    expect(scrubbed.additionalRepos?.[1].fullName).toBe("org/repo-b");
  });

  it("does not early-return when only additionalRepos have tokens (secrets is absent)", async () => {
    const contextPack: ContextPack = {
      command: "EXECUTE",
      artifacts: [],
      additionalRepos: [
        { fullName: "org/repo-a", branch: "main", githubToken: "ghp_token_a" },
      ],
    };

    mockSend
      .mockResolvedValueOnce({ Body: makeS3GetObjectBody(contextPack) })
      .mockResolvedValueOnce({});

    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    expect(putCallCount()).toBe(1);
    const scrubbed = capturedPutBody();
    expect(scrubbed.additionalRepos?.[0].githubToken).toBeUndefined();
  });

  it("returns early without S3 write when neither secrets nor per-repo tokens exist", async () => {
    const contextPack: ContextPack = {
      command: "EXECUTE",
      artifacts: [],
      additionalRepos: [{ fullName: "org/repo-a", branch: "main" }],
    };

    mockSend.mockResolvedValueOnce({ Body: makeS3GetObjectBody(contextPack) });

    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    expect(putCallCount()).toBe(0);
  });

  it("removes top-level secrets alongside per-repo token scrubbing", async () => {
    const contextPack: ContextPack = {
      command: "EXECUTE",
      artifacts: [],
      secrets: { anthropicApiKey: "sk-ant-key", githubToken: "ghp_main" },
      additionalRepos: [
        { fullName: "org/repo-b", branch: "main", githubToken: "ghp_b" },
      ],
    };

    mockSend
      .mockResolvedValueOnce({ Body: makeS3GetObjectBody(contextPack) })
      .mockResolvedValueOnce({});

    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    const scrubbed = capturedPutBody();
    expect(scrubbed.secrets).toBeUndefined();
    expect(scrubbed.additionalRepos?.[0].githubToken).toBeUndefined();
  });

  it("returns early without S3 write when downloadContextPack returns null", async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error("NoSuchKey"), { Code: "NoSuchKey" })
    );

    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    expect(putCallCount()).toBe(0);
  });
});

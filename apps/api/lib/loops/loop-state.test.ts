/**
 * Unit tests for loop-state.ts
 *
 * Covers scrubContextPackSecrets():
 * - Per-repo githubToken is stripped from additionalRepos entries
 * - Function does not early-return when additionalRepos have tokens but secrets is absent
 * - Function returns early (no S3 write) when neither secrets nor per-repo tokens exist
 * - top-level secrets are removed along with per-repo tokens
 *
 * Also covers pure utility functions (no S3 dependency):
 * - validateKeyBelongsToOrg
 * - validateKeyBelongsToLoop
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted() — define shared mock references available inside vi.mock factories.
// ---------------------------------------------------------------------------

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

// ---------------------------------------------------------------------------
// AWS SDK mock — must come before imports so the module under test receives
// the mock when it first imports S3Client.
//
// S3Client is mocked as a class so "new S3Client()" returns the mock instance.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { ContextPack } from "@closedloop-ai/loops-api/context-pack";
import {
  scrubContextPackSecrets,
  validateKeyBelongsToLoop,
  validateKeyBelongsToOrg,
} from "@/lib/loops/loop-state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Return the JSON parsed from the Body that was passed to the PutObjectCommand.
 * Scans all mockSend.mock.calls for the call with _type === "PutObjectCommand".
 */
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

// ---------------------------------------------------------------------------
// LOOP_STATE_BUCKET env — required by requireBucket()
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOP_STATE_BUCKET = "test-loop-state-bucket";
});

// ---------------------------------------------------------------------------
// scrubContextPackSecrets
// ---------------------------------------------------------------------------

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
      .mockResolvedValueOnce({ Body: makeS3GetObjectBody(contextPack) }) // GetObject
      .mockResolvedValueOnce({}); // PutObject

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
      // secrets is intentionally absent
      additionalRepos: [
        { fullName: "org/repo-a", branch: "main", githubToken: "ghp_token_a" },
      ],
    };

    mockSend
      .mockResolvedValueOnce({ Body: makeS3GetObjectBody(contextPack) })
      .mockResolvedValueOnce({});

    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    // PutObject should have been called (function did not early-return)
    const putCalls = (mockSend.mock.calls as unknown[][]).filter(
      (call) =>
        (call[0] as { _type?: string } | undefined)?._type ===
        "PutObjectCommand"
    );
    expect(putCalls).toHaveLength(1);

    const scrubbed = capturedPutBody();
    expect(scrubbed.additionalRepos?.[0].githubToken).toBeUndefined();
  });

  it("returns early without S3 write when neither secrets nor per-repo tokens exist", async () => {
    const contextPack: ContextPack = {
      command: "EXECUTE",
      artifacts: [],
      additionalRepos: [
        { fullName: "org/repo-a", branch: "main" }, // no githubToken
      ],
    };

    mockSend.mockResolvedValueOnce({ Body: makeS3GetObjectBody(contextPack) });

    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    // Only GetObject was called; PutObject was not called (early return)
    const putCalls = (mockSend.mock.calls as unknown[][]).filter(
      (call) =>
        (call[0] as { _type?: string } | undefined)?._type ===
        "PutObjectCommand"
    );
    expect(putCalls).toHaveLength(0);
  });

  it("returns early without S3 write when context pack has no secrets and no additionalRepos", async () => {
    const contextPack: ContextPack = {
      command: "PLAN",
      artifacts: [],
    };

    mockSend.mockResolvedValueOnce({ Body: makeS3GetObjectBody(contextPack) });

    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    const putCalls = (mockSend.mock.calls as unknown[][]).filter(
      (call) =>
        (call[0] as { _type?: string } | undefined)?._type ===
        "PutObjectCommand"
    );
    expect(putCalls).toHaveLength(0);
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

  it("removes top-level secrets when no additionalRepos are present", async () => {
    const contextPack: ContextPack = {
      command: "EXECUTE",
      artifacts: [],
      secrets: { anthropicApiKey: "sk-ant-key" },
    };

    mockSend
      .mockResolvedValueOnce({ Body: makeS3GetObjectBody(contextPack) })
      .mockResolvedValueOnce({});

    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    const scrubbed = capturedPutBody();
    expect(scrubbed.secrets).toBeUndefined();
  });

  it("preserves non-secret additionalRepos fields after scrubbing", async () => {
    const contextPack: ContextPack = {
      command: "EXECUTE",
      artifacts: [],
      additionalRepos: [
        {
          fullName: "org/repo-a",
          branch: "feature/auth",
          githubToken: "ghp_a",
        },
      ],
    };

    mockSend
      .mockResolvedValueOnce({ Body: makeS3GetObjectBody(contextPack) })
      .mockResolvedValueOnce({});

    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    const scrubbed = capturedPutBody();
    expect(scrubbed.additionalRepos?.[0].fullName).toBe("org/repo-a");
    expect(scrubbed.additionalRepos?.[0].branch).toBe("feature/auth");
  });

  it("returns early without S3 write when downloadContextPack returns null", async () => {
    // Simulate S3 GetObject throwing (object not found)
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error("NoSuchKey"), { Code: "NoSuchKey" })
    );

    // downloadContextPack catches the error and returns null; scrubContextPackSecrets
    // then evaluates contextPack?.secrets (undefined) and additionalRepos (undefined)
    // as falsy, so it returns early without a PutObject call.
    await scrubContextPackSecrets("org-1/loops/loop-1/run-1");

    const putCalls = (mockSend.mock.calls as unknown[][]).filter(
      (call) =>
        (call[0] as { _type?: string } | undefined)?._type ===
        "PutObjectCommand"
    );
    expect(putCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateKeyBelongsToOrg — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("validateKeyBelongsToOrg", () => {
  it("returns true for a key that starts with the org prefix", () => {
    expect(
      validateKeyBelongsToOrg(
        "org-abc/loops/loop-1/run-1/context-pack.json",
        "org-abc"
      )
    ).toBe(true);
  });

  it("returns false for a key belonging to a different org", () => {
    expect(
      validateKeyBelongsToOrg(
        "org-xyz/loops/loop-1/run-1/context-pack.json",
        "org-abc"
      )
    ).toBe(false);
  });

  it("returns false for a key containing path traversal (..)", () => {
    expect(
      validateKeyBelongsToOrg(
        "org-abc/../org-abc/loops/loop-1/secret.json",
        "org-abc"
      )
    ).toBe(false);
  });

  it("returns false for a key containing path traversal (./)", () => {
    expect(
      validateKeyBelongsToOrg("org-abc/./loops/loop-1/secret.json", "org-abc")
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateKeyBelongsToLoop — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("validateKeyBelongsToLoop", () => {
  it("returns true for a key scoped to the org and loop", () => {
    expect(
      validateKeyBelongsToLoop(
        "org-abc/loops/loop-1/run-1/context-pack.json",
        "org-abc",
        "loop-1"
      )
    ).toBe(true);
  });

  it("returns false for a key belonging to a different loop under the same org", () => {
    expect(
      validateKeyBelongsToLoop(
        "org-abc/loops/loop-2/run-1/context-pack.json",
        "org-abc",
        "loop-1"
      )
    ).toBe(false);
  });

  it("returns false for a key containing path traversal (..)", () => {
    expect(
      validateKeyBelongsToLoop(
        "org-abc/loops/loop-1/../loop-2/secret.json",
        "org-abc",
        "loop-1"
      )
    ).toBe(false);
  });

  it("returns false when org prefix does not match", () => {
    expect(
      validateKeyBelongsToLoop(
        "org-xyz/loops/loop-1/run-1/context-pack.json",
        "org-abc",
        "loop-1"
      )
    ).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { boundedRequestHandler, STREAMING_BOUNDS } from "./request-handler";

/**
 * ISS-7016 — the shared attachments/transcripts/catalog S3 client must be built
 * with the streaming bound. Without one the SDK waits on a hung socket forever,
 * and every caller of `@repo/aws` inherits that unbounded wait.
 *
 * Asserted as an equality against the shared config rather than "some timeout
 * is set", so a hand-rolled weaker handler here (notably `requestTimeout`
 * without `throwOnRequestTimeout`, which only warns) fails too.
 */

type S3ClientConfig = {
  requestHandler?: unknown;
};

const { s3ClientConfigs } = vi.hoisted(() => ({
  s3ClientConfigs: [] as S3ClientConfig[],
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class S3ClientMock {
    middlewareStack = { add: vi.fn() };
    constructor(config: S3ClientConfig) {
      s3ClientConfigs.push(config);
    }
  },
  StorageClass: { INTELLIGENT_TIERING: "INTELLIGENT_TIERING" },
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

describe("s3Client", () => {
  beforeEach(() => {
    s3ClientConfigs.length = 0;
    vi.resetModules();
  });

  it("is built with the shared streaming request bound", async () => {
    await import("./s3-client");

    expect(s3ClientConfigs).toHaveLength(1);
    expect(s3ClientConfigs[0].requestHandler).toEqual(
      boundedRequestHandler(STREAMING_BOUNDS)
    );
  });
});

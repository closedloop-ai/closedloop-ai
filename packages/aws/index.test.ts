import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSignedUploadUrl } from "./index";

vi.mock("@aws-sdk/client-s3", () => {
  class MockCommand {
    readonly input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  return {
    DeleteObjectCommand: MockCommand,
    GetObjectCommand: MockCommand,
    PutObjectCommand: MockCommand,
    S3Client: class S3Client {
      send = vi.fn();
    },
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://s3.example.com/upload"),
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

describe("getSignedUploadUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds ContentType and ContentLength into the presigned PutObjectCommand", async () => {
    await getSignedUploadUrl(
      "attachments/org/doc/file",
      "image/png",
      900,
      "attachment-bucket",
      2048
    );

    const command = vi.mocked(getSignedUrl).mock.calls[0][1] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      Bucket: "attachment-bucket",
      ContentLength: 2048,
      ContentType: "image/png",
      Key: "attachments/org/doc/file",
    });
    expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), command, {
      expiresIn: 900,
    });
  });
});

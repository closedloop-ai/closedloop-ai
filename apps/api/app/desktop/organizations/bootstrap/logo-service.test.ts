import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  findFirst: vi.fn(),
  sign: vi.fn(),
  send: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@repo/auth/desktop-bootstrap-jwt", () => ({
  verifyDesktopBootstrapToken: mocks.verify,
}));
vi.mock("@repo/database", () => ({
  withDb: (run: (db: unknown) => unknown) =>
    run({ desktopBootstrapCode: { findFirst: mocks.findFirst } }),
}));
vi.mock("@repo/aws", () => ({
  getSignedUploadUrl: mocks.sign,
  deleteArtifact: mocks.remove,
}));
vi.mock("@repo/aws/s3-client", () => ({
  config: { FILE_ATTACHMENTS_BUCKET: "bucket" },
  s3Client: { send: mocks.send },
}));

import { desktopBootstrapLogoService } from "./logo-service";

const stagedKeyPattern = /^attachments\/desktop-bootstrap\/[a-f0-9]{64}\/logo$/;
const logo = {
  name: "logo.png",
  type: "image/png",
  size: 4,
  sha256: createHash("sha256").update("logo").digest("hex"),
};

describe("bootstrap logo staging", () => {
  beforeEach(() => {
    mocks.verify.mockResolvedValue({
      bootstrapId: "bootstrap-1",
      clerkUserId: "user-1",
      gatewayId: "gateway-1",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    mocks.findFirst.mockResolvedValue({ id: "bootstrap-1" });
    mocks.sign.mockResolvedValue("https://bucket.s3.amazonaws.com/upload");
    mocks.send.mockResolvedValue({
      ContentType: logo.type,
      Body: { transformToByteArray: async () => Buffer.from("logo") },
    });
  });

  it("binds authorization to a redeemed, unfinished bootstrap and signs the exact size for at most 60s", async () => {
    expect(
      (await desktopBootstrapLogoService.authorize("token", logo)).ok
    ).toBe(true);
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        id: "bootstrap-1",
        clerkUserId: "user-1",
        gatewayId: "gateway-1",
        redeemedAt: { not: null },
        completedAt: null,
      },
      select: { id: true },
    });
    expect(mocks.sign).toHaveBeenCalledWith(
      expect.stringMatching(stagedKeyPattern),
      logo.type,
      60,
      undefined,
      4
    );
  });

  it("never signs for an invalid or expired token", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("expired"));
    expect(
      (await desktopBootstrapLogoService.authorize("token", logo)).ok
    ).toBe(false);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("never signs for a missing, mismatched or completed bootstrap", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(
      (await desktopBootstrapLogoService.authorize("token", logo)).ok
    ).toBe(false);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("bounds signed URL expiry to the remaining credential lifetime", async () => {
    mocks.verify.mockResolvedValue({
      bootstrapId: "bootstrap-1",
      clerkUserId: "user-1",
      gatewayId: "gateway-1",
      expiresAt: Math.floor(Date.now() / 1000) + 5,
    });
    await desktopBootstrapLogoService.authorize("token", logo);
    expect(mocks.sign.mock.calls[0][2]).toBeLessThanOrEqual(5);
  });

  it("reads only the current bootstrap's object, checks the digest, and removes that same object", async () => {
    const file = await desktopBootstrapLogoService.read("bootstrap-1", logo);
    expect(await file?.text()).toBe("logo");
    const firstKey = mocks.send.mock.calls[0][0].input.Key;
    expect(mocks.send.mock.calls[0][0].input).toMatchObject({
      Bucket: "bucket",
      Range: "bytes=0-4",
    });
    await desktopBootstrapLogoService.remove("bootstrap-1");
    expect(mocks.remove).toHaveBeenCalledWith(firstKey);
    await desktopBootstrapLogoService.read("bootstrap-2", logo);
    expect(mocks.send.mock.calls[1][0].input.Key).not.toBe(firstKey);
  });

  it.each([
    { ...logo, sha256: "a".repeat(64) },
    { ...logo, size: 3 },
    { ...logo, type: "image/jpeg" },
  ])(
    "rejects changed bytes, length or content type before Clerk sees the file",
    async (reference) => {
      expect(
        await desktopBootstrapLogoService.read("bootstrap-1", reference)
      ).toBeNull();
    }
  );
});

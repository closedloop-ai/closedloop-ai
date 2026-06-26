import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMcpAttachmentUploadEnabled,
  MCP_UPLOAD_ATTACHMENT_FEATURE_FLAG_KEY,
} from "../attachment-upload-feature";

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

describe("isMcpAttachmentUploadEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the exact MCP upload attachment flag key", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(true);

    await expect(
      isMcpAttachmentUploadEnabled({ userId: "user-1" })
    ).resolves.toBe(true);

    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      MCP_UPLOAD_ATTACHMENT_FEATURE_FLAG_KEY,
      "user-1"
    );
    expect(MCP_UPLOAD_ATTACHMENT_FEATURE_FLAG_KEY).toBe(
      "mcp-upload-attachment"
    );
  });

  it.each([
    ["false", false],
    ["null", null],
  ])("fails closed when the feature provider returns %s", async (_label, value) => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(value);

    await expect(
      isMcpAttachmentUploadEnabled({ userId: "user-1" })
    ).resolves.toBe(false);
  });

  it("fails closed when feature evaluation throws", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockRejectedValue(
      new Error("PostHog unavailable")
    );

    await expect(
      isMcpAttachmentUploadEnabled({ userId: "user-1" })
    ).resolves.toBe(false);
  });
});

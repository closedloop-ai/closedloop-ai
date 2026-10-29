/**
 * Unit tests for maybeDropPreviewSchemaOnClose
 *
 * Verifies:
 * (a) closed + closedloop-ai/closedloop-ai + branch → dropSchemaForBranch called
 *     with the branch and waitUntil called once
 * (b) closed + different repo → dropSchemaForBranch NOT called
 * (c) non-`closed` action (opened) → dropSchemaForBranch not called
 * (d) non-`closed` action (reopened) → dropSchemaForBranch not called
 * (e) missing branch → dropSchemaForBranch not called
 *
 * Alert integration (f–i):
 * (f) dropSchemaForBranch returns error !== null → notifySlack called with route
 * (g) dropSchemaForBranch rejects → notifySlack called with route
 * (h) dropSchemaForBranch returns error === null → notifySlack NOT called
 * (i) notifySlack rejecting does not propagate / break the waitUntil promise
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const {
  mockWaitUntil,
  mockDropSchemaForBranch,
  mockNotifySlack,
  mockBuildCorrelationId,
} = vi.hoisted(() => ({
  mockWaitUntil: vi.fn(),
  mockDropSchemaForBranch: vi.fn(),
  mockNotifySlack: vi.fn(),
  mockBuildCorrelationId: vi
    .fn()
    .mockReturnValue("ts=2024-01-01T00:00:00.000Z"),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mockWaitUntil,
}));

vi.mock("@/app/preview-schemas/service", () => ({
  previewSchemaCleanupService: {
    dropSchemaForBranch: mockDropSchemaForBranch,
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/slack-notifier", () => ({
  notifySlack: mockNotifySlack,
  buildCorrelationId: mockBuildCorrelationId,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { PreviewSchemaSourceRepo } from "@/app/preview-schemas/constants";
import { maybeDropPreviewSchemaOnClose } from "@/app/webhooks/github/preview-schema-drop";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SOURCE_REPO = PreviewSchemaSourceRepo.fullName;
const OTHER_REPO = "closedloop-ai/claude_code";
const BRANCH = "feat/my-branch";

describe("maybeDropPreviewSchemaOnClose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDropSchemaForBranch.mockResolvedValue({
      schemaName: "preview_feat_my_branch",
      dropped: true,
      alreadyGone: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(a) calls dropSchemaForBranch and waitUntil once when action is closed, repo matches, and branch is present", () => {
    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch: BRANCH,
      repoFullName: SOURCE_REPO,
    });

    expect(mockWaitUntil).toHaveBeenCalledOnce();
    expect(mockDropSchemaForBranch).toHaveBeenCalledOnce();
    expect(mockDropSchemaForBranch).toHaveBeenCalledWith(BRANCH);
  });

  it("(b) does not call dropSchemaForBranch when repo is not closedloop-ai/closedloop-ai", () => {
    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch: BRANCH,
      repoFullName: OTHER_REPO,
    });

    expect(mockDropSchemaForBranch).not.toHaveBeenCalled();
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("retains vibe branches when their PR closes", () => {
    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch: "vibe/bulk-tags",
      repoFullName: SOURCE_REPO,
    });

    expect(mockDropSchemaForBranch).not.toHaveBeenCalled();
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it.each(["andy/bulk-tags", "vibe-bulk-tags", "feat/vibe/bulk-tags"])(
    "still drops %s when its PR closes",
    (branch) => {
      maybeDropPreviewSchemaOnClose({
        action: "closed",
        branch,
        repoFullName: SOURCE_REPO,
      });

      expect(mockDropSchemaForBranch).toHaveBeenCalledExactlyOnceWith(branch);
      expect(mockWaitUntil).toHaveBeenCalledOnce();
    }
  );

  it.each(["functional-prototype/x", "prototype/x"])(
    "retains %s when its PR closes (ISS-12226, ISS-12214)",
    (branch) => {
      maybeDropPreviewSchemaOnClose({
        action: "closed",
        branch,
        repoFullName: SOURCE_REPO,
      });

      expect(mockDropSchemaForBranch).not.toHaveBeenCalled();
      expect(mockWaitUntil).not.toHaveBeenCalled();
    }
  );

  it.each([
    "feat/x",
    "prototype-x",
    "functional-prototype-x",
    "feat/functional-prototype/x",
    "feat/prototype/x",
  ])("still drops %s when its PR closes", (branch) => {
    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch,
      repoFullName: SOURCE_REPO,
    });

    expect(mockDropSchemaForBranch).toHaveBeenCalledExactlyOnceWith(branch);
    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });

  it("(c) does not call dropSchemaForBranch when action is not closed", () => {
    maybeDropPreviewSchemaOnClose({
      action: "opened",
      branch: BRANCH,
      repoFullName: SOURCE_REPO,
    });

    expect(mockDropSchemaForBranch).not.toHaveBeenCalled();
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("(d) does not call dropSchemaForBranch when action is reopened", () => {
    maybeDropPreviewSchemaOnClose({
      action: "reopened",
      branch: BRANCH,
      repoFullName: SOURCE_REPO,
    });

    expect(mockDropSchemaForBranch).not.toHaveBeenCalled();
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("(e) does not call dropSchemaForBranch when branch is undefined", () => {
    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch: undefined,
      repoFullName: SOURCE_REPO,
    });

    expect(mockDropSchemaForBranch).not.toHaveBeenCalled();
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Alert integration tests — notifySlack behaviour
// ---------------------------------------------------------------------------

/**
 * Extracts and awaits the promise passed to waitUntil so that the
 * .then/.catch callbacks (which call notifySlack) have a chance to execute.
 */
async function triggerAndFlush(): Promise<void> {
  const waitUntilArg: Promise<unknown> = mockWaitUntil.mock.calls[0][0];
  // Await the promise; swallow any rejection so the test assertion can run.
  await waitUntilArg.catch(() => undefined);
  // Flush remaining microtasks (inner notifySlack.catch chain).
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("maybeDropPreviewSchemaOnClose — Slack alert integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: success with no error — overridden in individual tests as needed.
    mockDropSchemaForBranch.mockResolvedValue({
      schemaName: "preview_feat_my_branch",
      dropped: true,
      alreadyGone: false,
      error: null,
    });
    mockNotifySlack.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(f) calls notifySlack with route 'cleanup-preview-schemas:pr-close' when dropSchemaForBranch returns error !== null", async () => {
    mockDropSchemaForBranch.mockResolvedValue({
      schemaName: "preview_feat_my_branch",
      dropped: false,
      alreadyGone: false,
      error: "DROP SCHEMA failed: permission denied",
    });

    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch: BRANCH,
      repoFullName: SOURCE_REPO,
    });

    await triggerAndFlush();

    expect(mockNotifySlack).toHaveBeenCalledOnce();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({ route: "cleanup-preview-schemas:pr-close" })
    );
  });

  it("(g) calls notifySlack with route 'cleanup-preview-schemas:pr-close' when dropSchemaForBranch rejects", async () => {
    mockDropSchemaForBranch.mockRejectedValue(new Error("connection timeout"));

    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch: BRANCH,
      repoFullName: SOURCE_REPO,
    });

    await triggerAndFlush();

    expect(mockNotifySlack).toHaveBeenCalledOnce();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({ route: "cleanup-preview-schemas:pr-close" })
    );
  });

  it("(j) redacts credential-bearing drop-failure text out of the Slack alert", async () => {
    mockDropSchemaForBranch.mockResolvedValue({
      schemaName: "preview_feat_my_branch",
      dropped: false,
      alreadyGone: false,
      error:
        "DROP SCHEMA failed: postgres://vercel_iam:pw-that-must-not-escape@db.internal.example.com:5432/symphony",
    });

    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch: BRANCH,
      repoFullName: SOURCE_REPO,
    });

    await triggerAndFlush();

    const message = mockNotifySlack.mock.calls[0]?.[0]?.message ?? "";
    expect(message).toContain("preview_feat_my_branch");
    expect(message).not.toContain("pw-that-must-not-escape");
    expect(message).not.toContain("db.internal.example.com");
    expect(message).toContain("[redacted sensitive value]");
  });

  it("(h) does NOT call notifySlack when dropSchemaForBranch returns error === null", async () => {
    // mockDropSchemaForBranch already set to return error: null in beforeEach.
    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch: BRANCH,
      repoFullName: SOURCE_REPO,
    });

    await triggerAndFlush();

    expect(mockNotifySlack).not.toHaveBeenCalled();
  });

  it("(i) waitUntil promise resolves cleanly even when notifySlack rejects", async () => {
    mockDropSchemaForBranch.mockResolvedValue({
      schemaName: "preview_feat_my_branch",
      dropped: false,
      alreadyGone: false,
      error: "some error",
    });
    mockNotifySlack.mockRejectedValue(new Error("Slack API unreachable"));

    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch: BRANCH,
      repoFullName: SOURCE_REPO,
    });

    const waitUntilArg: Promise<unknown> = mockWaitUntil.mock.calls[0][0];

    // The outer promise (passed to waitUntil) must resolve (to undefined),
    // i.e. settle without rejecting.
    await expect(waitUntilArg).resolves.toBeUndefined();

    // Flush any remaining microtasks for the inner notifySlack.catch.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // notifySlack was still called — the rejection was handled internally.
    expect(mockNotifySlack).toHaveBeenCalledOnce();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockHandlePush,
  mockHandlePullRequestReviewThread,
  mockIsGitHubConfigured,
  mockScheduleLogFlush,
  mockValidateRequest,
  mockVerifyWebhookSignature,
} = vi.hoisted(() => ({
  mockHandlePush: vi.fn(),
  mockHandlePullRequestReviewThread: vi.fn(),
  mockIsGitHubConfigured: vi.fn(),
  mockScheduleLogFlush: vi.fn(),
  mockValidateRequest: vi.fn(),
  mockVerifyWebhookSignature: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  verifyWebhookSignature: mockVerifyWebhookSignature,
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: mockScheduleLogFlush,
}));

vi.mock("@/app/webhooks/github/webhook-service", () => ({
  isGitHubConfigured: mockIsGitHubConfigured,
  validateRequest: mockValidateRequest,
}));

vi.mock(
  "@/app/webhooks/github/handlers/pull-request-review-thread-handler",
  () => ({
    handlePullRequestReviewThread: mockHandlePullRequestReviewThread,
  })
);

vi.mock("@/app/webhooks/github/handlers/check-run-handler", () => ({
  handleCheckRun: vi.fn(),
}));
vi.mock("@/app/webhooks/github/handlers/deployment-status-handler", () => ({
  handleDeploymentStatus: vi.fn(),
}));
vi.mock("@/app/webhooks/github/handlers/installation-handler", () => ({
  handleInstallation: vi.fn(),
}));
vi.mock(
  "@/app/webhooks/github/handlers/installation-repositories-handler",
  () => ({ handleInstallationRepositories: vi.fn() })
);
vi.mock("@/app/webhooks/github/handlers/issue-comment-handler", () => ({
  handleIssueComment: vi.fn(),
}));
vi.mock("@/app/webhooks/github/handlers/pull-request-handler", () => ({
  handlePullRequest: vi.fn(),
}));
vi.mock(
  "@/app/webhooks/github/handlers/pull-request-review-comment-handler",
  () => ({ handlePullRequestReviewComment: vi.fn() })
);
vi.mock("@/app/webhooks/github/handlers/pull-request-review-handler", () => ({
  handlePullRequestReview: vi.fn(),
}));
vi.mock("@/app/webhooks/github/handlers/push-handler", () => ({
  handlePush: mockHandlePush,
}));
vi.mock("@/app/webhooks/github/preview-schema-drop", () => ({
  maybeDropPreviewSchemaOnClose: vi.fn(),
}));

import { POST } from "@/app/webhooks/github/route";

describe("POST /webhooks/github pull_request_review_thread dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGitHubConfigured.mockReturnValue(true);
    mockVerifyWebhookSignature.mockReturnValue(true);
    mockValidateRequest.mockResolvedValue({
      body: JSON.stringify({ action: "resolved", thread: { node_id: "PRRT" } }),
      signature: "sha256=valid",
      eventType: "pull_request_review_thread",
    });
    mockHandlePullRequestReviewThread.mockResolvedValue(
      Response.json({ ok: true })
    );
    mockHandlePush.mockResolvedValue(Response.json({ ok: true }));
  });

  it("dispatches signed pull_request_review_thread deliveries through the production route", async () => {
    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(mockVerifyWebhookSignature).toHaveBeenCalledWith(
      JSON.stringify({ action: "resolved", thread: { node_id: "PRRT" } }),
      "sha256=valid"
    );
    expect(mockHandlePullRequestReviewThread).toHaveBeenCalledWith({
      action: "resolved",
      thread: { node_id: "PRRT" },
    });
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("dispatches signed push deliveries through the production route", async () => {
    const payload = {
      ref: "refs/heads/FEA-2528-webhook-branch",
      before: "before-sha",
      after: "after-sha",
      created: false,
      deleted: false,
    };
    mockValidateRequest.mockResolvedValueOnce({
      body: JSON.stringify(payload),
      signature: "sha256=valid",
      eventType: "push",
    });

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(mockVerifyWebhookSignature).toHaveBeenCalledWith(
      JSON.stringify(payload),
      "sha256=valid"
    );
    expect(mockHandlePush).toHaveBeenCalledWith(payload);
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("preserves invalid signature rejection before handler dispatch", async () => {
    mockVerifyWebhookSignature.mockReturnValueOnce(false);

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(401);
    expect(mockHandlePullRequestReviewThread).not.toHaveBeenCalled();
    expect(mockHandlePush).not.toHaveBeenCalled();
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("preserves unsupported event acknowledgement", async () => {
    mockValidateRequest.mockResolvedValueOnce({
      body: JSON.stringify({ action: "created" }),
      signature: "sha256=valid",
      eventType: "meta",
    });

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mockHandlePullRequestReviewThread).not.toHaveBeenCalled();
    expect(mockHandlePush).not.toHaveBeenCalled();
  });
});

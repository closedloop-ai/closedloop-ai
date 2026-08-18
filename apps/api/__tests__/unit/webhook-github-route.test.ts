import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockHandleCheckRun,
  mockHandleDeploymentStatus,
  mockHandleIssueComment,
  mockHandlePullRequest,
  mockHandlePullRequestReview,
  mockHandlePullRequestReviewComment,
  mockHandlePush,
  mockHandlePullRequestReviewThread,
  mockIsGitHubConfigured,
  mockLogInfo,
  mockScheduleLogFlush,
  mockValidateRequest,
  mockVerifyWebhookSignature,
} = vi.hoisted(() => ({
  mockHandleCheckRun: vi.fn(),
  mockHandleDeploymentStatus: vi.fn(),
  mockHandleIssueComment: vi.fn(),
  mockHandlePullRequest: vi.fn(),
  mockHandlePullRequestReview: vi.fn(),
  mockHandlePullRequestReviewComment: vi.fn(),
  mockHandlePush: vi.fn(),
  mockHandlePullRequestReviewThread: vi.fn(),
  mockIsGitHubConfigured: vi.fn(),
  mockLogInfo: vi.fn(),
  mockScheduleLogFlush: vi.fn(),
  mockValidateRequest: vi.fn(),
  mockVerifyWebhookSignature: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: mockLogInfo, warn: vi.fn() },
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
  handleCheckRun: mockHandleCheckRun,
}));
vi.mock("@/app/webhooks/github/handlers/deployment-status-handler", () => ({
  handleDeploymentStatus: mockHandleDeploymentStatus,
}));
vi.mock("@/app/webhooks/github/handlers/installation-handler", () => ({
  handleInstallation: vi.fn(),
}));
vi.mock(
  "@/app/webhooks/github/handlers/installation-repositories-handler",
  () => ({ handleInstallationRepositories: vi.fn() })
);
vi.mock("@/app/webhooks/github/handlers/issue-comment-handler", () => ({
  handleIssueComment: mockHandleIssueComment,
}));
vi.mock("@/app/webhooks/github/handlers/pull-request-handler", () => ({
  handlePullRequest: mockHandlePullRequest,
}));
vi.mock(
  "@/app/webhooks/github/handlers/pull-request-review-comment-handler",
  () => ({ handlePullRequestReviewComment: mockHandlePullRequestReviewComment })
);
vi.mock("@/app/webhooks/github/handlers/pull-request-review-handler", () => ({
  handlePullRequestReview: mockHandlePullRequestReview,
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
    mockHandleCheckRun.mockResolvedValue(Response.json({ ok: true }));
    mockHandleDeploymentStatus.mockResolvedValue(Response.json({ ok: true }));
    mockHandleIssueComment.mockResolvedValue(Response.json({ ok: true }));
    mockHandlePullRequest.mockResolvedValue(Response.json({ ok: true }));
    mockHandlePullRequestReview.mockResolvedValue(Response.json({ ok: true }));
    mockHandlePullRequestReviewComment.mockResolvedValue(
      Response.json({ ok: true })
    );
    mockHandlePush.mockResolvedValue(Response.json({ ok: true }));
  });

  it("dispatches signed pull_request_review_thread deliveries through the production route", async () => {
    const observedAt = new Date("2026-08-12T20:00:00.000Z");
    mockValidateRequest.mockResolvedValueOnce({
      body: JSON.stringify({ action: "resolved", thread: { node_id: "PRRT" } }),
      signature: "sha256=valid",
      eventType: "pull_request_review_thread",
      deliveryId: "delivery-review-thread-1",
      observedAt,
    });
    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(mockVerifyWebhookSignature).toHaveBeenCalledWith(
      JSON.stringify({ action: "resolved", thread: { node_id: "PRRT" } }),
      "sha256=valid"
    );
    expect(mockHandlePullRequestReviewThread).toHaveBeenCalledWith(
      {
        action: "resolved",
        thread: { node_id: "PRRT" },
      },
      { deliveryId: "delivery-review-thread-1", observedAt }
    );
    expect(mockLogInfo).toHaveBeenCalledWith(
      "[webhook/github] Completed webhook handling",
      {
        action: "resolved",
        eventType: "pull_request_review_thread",
        outcome: "processed",
        provider: "github",
      }
    );
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("dispatches signed push deliveries through the production route", async () => {
    const observedAt = new Date("2026-08-10T20:00:00.000Z");
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
      deliveryId: "delivery-push-1",
      observedAt,
    });

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(mockVerifyWebhookSignature).toHaveBeenCalledWith(
      JSON.stringify(payload),
      "sha256=valid"
    );
    expect(mockHandlePush).toHaveBeenCalledWith(payload, {
      deliveryId: "delivery-push-1",
      observedAt,
    });
    expect(mockLogInfo).toHaveBeenCalledWith(
      "[webhook/github] Completed webhook handling",
      {
        action: undefined,
        eventType: "push",
        outcome: "processed",
        provider: "github",
      }
    );
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "pull_request",
      mockHandlePullRequest,
      {
        action: "opened",
        pull_request: { head: { ref: "feature-branch" } },
        repository: { full_name: "acme/repo" },
      },
    ],
    ["pull_request_review", mockHandlePullRequestReview, { action: "created" }],
    [
      "pull_request_review_comment",
      mockHandlePullRequestReviewComment,
      { action: "created" },
    ],
    ["issue_comment", mockHandleIssueComment, { action: "created" }],
    ["check_run", mockHandleCheckRun, { action: "created" }],
    ["deployment_status", mockHandleDeploymentStatus, { action: "created" }],
  ])("passes stable delivery context to the %s handler", async (eventType, handler, payload) => {
    const observedAt = new Date("2026-08-12T21:00:00.000Z");
    mockValidateRequest.mockResolvedValueOnce({
      body: JSON.stringify(payload),
      signature: "sha256=valid",
      eventType,
      deliveryId: `delivery-${eventType}`,
      observedAt,
    });

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(payload, {
      deliveryId: `delivery-${eventType}`,
      observedAt,
    });
  });

  it("records ignored handler responses without marking them processed", async () => {
    mockValidateRequest.mockResolvedValueOnce({
      body: JSON.stringify({ ref: "refs/tags/v1.0.0" }),
      signature: "sha256=valid",
      eventType: "push",
    });
    mockHandlePush.mockResolvedValueOnce(
      Response.json({ message: "Ignoring non-branch push ref", ok: true })
    );

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(mockLogInfo).toHaveBeenCalledWith(
      "[webhook/github] Completed webhook handling",
      {
        action: undefined,
        eventType: "push",
        outcome: "ignored",
        provider: "github",
      }
    );
  });

  it("records failed handler responses without marking them processed", async () => {
    mockValidateRequest.mockResolvedValueOnce({
      body: JSON.stringify({ action: "opened" }),
      signature: "sha256=valid",
      eventType: "push",
    });
    mockHandlePush.mockResolvedValueOnce(
      Response.json(
        { message: "Missing installation", ok: false },
        { status: 400 }
      )
    );

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(400);
    expect(mockLogInfo).toHaveBeenCalledWith(
      "[webhook/github] Completed webhook handling",
      {
        action: "opened",
        eventType: "push",
        outcome: "failed_response",
        provider: "github",
      }
    );
  });

  it("returns 500 when an awaited handler persistence path rejects", async () => {
    const observedAt = new Date("2026-08-12T22:00:00.000Z");
    mockValidateRequest.mockResolvedValueOnce({
      body: JSON.stringify({ action: "completed" }),
      signature: "sha256=valid",
      eventType: "check_run",
      deliveryId: "delivery-check-failure",
      observedAt,
    });
    mockHandleCheckRun.mockRejectedValueOnce(
      new Error("activity persistence failed")
    );

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(mockHandleCheckRun).toHaveBeenCalledWith(
      { action: "completed" },
      { deliveryId: "delivery-check-failure", observedAt }
    );
  });

  it("preserves invalid signature rejection before handler dispatch", async () => {
    mockVerifyWebhookSignature.mockReturnValueOnce(false);

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(401);
    expect(mockHandlePullRequestReviewThread).not.toHaveBeenCalled();
    expect(mockHandlePush).not.toHaveBeenCalled();
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("preserves missing signature rejection before handler dispatch", async () => {
    mockValidateRequest.mockResolvedValueOnce({
      body: JSON.stringify({ action: "created" }),
      signature: "",
      eventType: "meta",
    });

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(401);
    expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
    expect(mockHandlePullRequestReviewThread).not.toHaveBeenCalled();
    expect(mockHandlePush).not.toHaveBeenCalled();
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("preserves not-configured acknowledgement before validation", async () => {
    mockIsGitHubConfigured.mockReturnValueOnce(false);

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(mockValidateRequest).not.toHaveBeenCalled();
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("emits one terminal info log for unsupported event acknowledgement", async () => {
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
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    expect(mockLogInfo).toHaveBeenCalledWith(
      "[webhook/github] Completed webhook handling",
      {
        action: "created",
        eventType: "meta",
        outcome: "unsupported_event",
        provider: "github",
      }
    );
  });
});

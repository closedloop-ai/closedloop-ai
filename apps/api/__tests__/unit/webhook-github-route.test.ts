import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockHandleCheckRun,
  mockHandleDeploymentStatus,
  mockHandleInstallation,
  mockHandleInstallationRepositories,
  mockHandleIssueComment,
  mockHandlePullRequest,
  mockHandlePullRequestReview,
  mockHandlePullRequestReviewComment,
  mockHandlePush,
  mockHandlePullRequestReviewThread,
  mockIsGitHubConfigured,
  mockLogDebug,
  mockLogError,
  mockLogFlush,
  mockLogInfo,
  mockMaybeDropPreviewSchemaOnClose,
  mockValidateRequest,
  mockVerifyWebhookSignature,
} = vi.hoisted(() => ({
  mockHandleCheckRun: vi.fn(),
  mockHandleDeploymentStatus: vi.fn(),
  mockHandleInstallation: vi.fn(),
  mockHandleInstallationRepositories: vi.fn(),
  mockHandleIssueComment: vi.fn(),
  mockHandlePullRequest: vi.fn(),
  mockHandlePullRequestReview: vi.fn(),
  mockHandlePullRequestReviewComment: vi.fn(),
  mockHandlePush: vi.fn(),
  mockHandlePullRequestReviewThread: vi.fn(),
  mockIsGitHubConfigured: vi.fn(),
  mockLogDebug: vi.fn(),
  mockLogError: vi.fn(),
  mockLogFlush: vi.fn(async () => undefined),
  mockLogInfo: vi.fn(),
  mockMaybeDropPreviewSchemaOnClose: vi.fn(),
  mockValidateRequest: vi.fn(),
  mockVerifyWebhookSignature: vi.fn(),
}));

// ISS-9053: `log.flush` is the flush COUNT this suite asserts on. Every arm
// below pins exactly one per delivery — `withRequestCompleted`'s `finally` is
// the sole terminal flush owner, so a receiver-side `scheduleLogFlush()` added
// back would read as two here.
vi.mock("@repo/observability/log", () => ({
  log: {
    debug: mockLogDebug,
    error: mockLogError,
    flush: mockLogFlush,
    info: mockLogInfo,
    warn: vi.fn(),
  },
}));

vi.mock("@repo/github", () => ({
  verifyWebhookSignature: mockVerifyWebhookSignature,
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
  handleInstallation: mockHandleInstallation,
}));
vi.mock(
  "@/app/webhooks/github/handlers/installation-repositories-handler",
  () => ({ handleInstallationRepositories: mockHandleInstallationRepositories })
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
  maybeDropPreviewSchemaOnClose: mockMaybeDropPreviewSchemaOnClose,
}));

import { POST } from "@/app/webhooks/github/route";
import { REQUEST_COMPLETED_EVENT } from "@/lib/route-utils";

describe("POST /webhooks/github pull_request_review_thread dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGitHubConfigured.mockReturnValue(true);
    mockVerifyWebhookSignature.mockReturnValue(true);
    mockValidateRequest.mockResolvedValue({
      oversized: null,
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
    mockHandleInstallation.mockResolvedValue(Response.json({ ok: true }));
    mockHandleInstallationRepositories.mockResolvedValue(
      Response.json({ ok: true })
    );
  });

  it("dispatches signed pull_request_review_thread deliveries through the production route", async () => {
    const observedAt = new Date("2026-08-12T20:00:00.000Z");
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
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
    expect(webhookOutcomeLogs()).toEqual([
      {
        level: "debug",
        fields: {
          action: "resolved",
          eventType: "pull_request_review_thread",
          outcome: "processed",
          provider: "github",
        },
      },
    ]);
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
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
      oversized: null,
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
    expect(webhookOutcomeLogs()).toEqual([
      {
        level: "debug",
        fields: {
          action: undefined,
          eventType: "push",
          outcome: "processed",
          provider: "github",
        },
      },
    ]);
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
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
  ])(
    "passes stable delivery context to the %s handler",
    async (eventType, handler, payload) => {
      const observedAt = new Date("2026-08-12T21:00:00.000Z");
      mockValidateRequest.mockResolvedValueOnce({
        oversized: null,
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
    }
  );

  // The "pull_request" row above already covers a real, non-empty deliveryId
  // control. These two cover the undefined-context arm of
  // createWebhookObservationContext: an undefined context makes
  // pull-request-projection.ts:175-183 log
  // github_repository_default_authority_malformed and drop the
  // repository-authority write.
  it("passes an undefined observation context to handlePullRequest when validateRequest resolves deliveryId: null", async () => {
    const payload = {
      action: "opened",
      pull_request: { head: { ref: "feature-branch" } },
      repository: { full_name: "acme/repo" },
    };
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
      body: JSON.stringify(payload),
      signature: "sha256=valid",
      eventType: "pull_request",
      deliveryId: null,
      observedAt: new Date("2026-08-12T21:10:00.000Z"),
    });

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(mockHandlePullRequest).toHaveBeenCalledWith(payload, undefined);
  });

  it("passes an undefined observation context to handlePullRequest when validateRequest resolves a whitespace-only deliveryId", async () => {
    const payload = {
      action: "opened",
      pull_request: { head: { ref: "feature-branch" } },
      repository: { full_name: "acme/repo" },
    };
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
      body: JSON.stringify(payload),
      signature: "sha256=valid",
      eventType: "pull_request",
      deliveryId: "   ",
      observedAt: new Date("2026-08-12T21:15:00.000Z"),
    });

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(mockHandlePullRequest).toHaveBeenCalledWith(payload, undefined);
  });

  it("passes repository.full_name to preview schema cleanup", async () => {
    const payload = {
      action: "closed",
      pull_request: { head: { ref: "feature-branch" } },
      repository: { full_name: "closedloop-ai/closedloop-ai" },
    };
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
      body: JSON.stringify(payload),
      signature: "sha256=valid",
      eventType: "pull_request",
    });

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(mockMaybeDropPreviewSchemaOnClose).toHaveBeenCalledWith({
      action: "closed",
      branch: "feature-branch",
      repoFullName: payload.repository.full_name,
    });
  });

  it("records ignored handler responses without marking them processed", async () => {
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
      body: JSON.stringify({ ref: "refs/tags/v1.0.0" }),
      signature: "sha256=valid",
      eventType: "push",
    });
    mockHandlePush.mockResolvedValueOnce(
      Response.json({ message: "Ignoring non-branch push ref", ok: true })
    );

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(webhookOutcomeLogs()).toEqual([
      {
        level: "info",
        fields: {
          action: undefined,
          eventType: "push",
          outcome: "ignored",
          provider: "github",
        },
      },
    ]);
  });

  it.each([
    "Default branch push ignored",
    "Repository not tracked",
    "No matching branch",
    "Push event missing installation identity, ignoring",
    "No resolvable lineage for branch push",
    "Branch push rejected",
    "Deployment skipped: branch artifact has no project",
    "Installation action 'new_permissions_accepted' acknowledged",
  ])("records %s as ignored rather than processed", async (message) => {
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
      body: JSON.stringify({ ref: "refs/heads/main" }),
      signature: "sha256=valid",
      eventType: "push",
    });
    mockHandlePush.mockResolvedValueOnce(Response.json({ message, ok: true }));

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(webhookOutcomeLogs()).toEqual([
      {
        level: "info",
        fields: {
          action: undefined,
          eventType: "push",
          outcome: "ignored",
          provider: "github",
        },
      },
    ]);
  });

  it.each(["Push event processed successfully", "Deployment status processed"])(
    "records %s as processed at debug",
    async (message) => {
      mockValidateRequest.mockResolvedValueOnce({
        oversized: null,
        body: JSON.stringify({ ref: "refs/heads/feature" }),
        signature: "sha256=valid",
        eventType: "push",
      });
      mockHandlePush.mockResolvedValueOnce(
        Response.json({ message, ok: true })
      );

      const response = await POST(new Request("http://localhost/webhook"));

      expect(response.status).toBe(200);
      expect(webhookOutcomeLogs()).toEqual([
        {
          level: "debug",
          fields: {
            action: undefined,
            eventType: "push",
            outcome: "processed",
            provider: "github",
          },
        },
      ]);
    }
  );

  // The App lifecycle events answer "... successfully", so they reach the
  // processed arm; `apps/api/AGENTS.md` reserves info for lifecycle
  // transitions, and the route line is the only info record of an uninstall.
  it.each([
    [
      "installation",
      "deleted",
      mockHandleInstallation,
      "Installation deleted successfully",
    ],
    [
      "installation",
      "suspend",
      mockHandleInstallation,
      "Installation suspended successfully",
    ],
    [
      "installation_repositories",
      "removed",
      mockHandleInstallationRepositories,
      "Repositories removed successfully",
    ],
  ])(
    "keeps %s %s at info although its outcome is processed",
    async (eventType, action, handlerMock, message) => {
      mockValidateRequest.mockResolvedValueOnce({
        oversized: null,
        body: JSON.stringify({ action }),
        signature: "sha256=valid",
        eventType,
      });
      handlerMock.mockResolvedValueOnce(Response.json({ message, ok: true }));

      const response = await POST(new Request("http://localhost/webhook"));

      expect(response.status).toBe(200);
      expect(webhookOutcomeLogs()).toEqual([
        {
          level: "info",
          fields: {
            action,
            eventType,
            outcome: "processed",
            provider: "github",
          },
        },
      ]);
    }
  );

  it("records failed handler responses without marking them processed", async () => {
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
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
    expect(webhookOutcomeLogs()).toEqual([
      {
        level: "info",
        fields: {
          action: "opened",
          eventType: "push",
          outcome: "failed_response",
          provider: "github",
        },
      },
    ]);
  });

  it("records a 200 handler response carrying ok:false as failed", async () => {
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
      body: JSON.stringify({ action: "opened" }),
      signature: "sha256=valid",
      eventType: "push",
    });
    mockHandlePush.mockResolvedValueOnce(
      Response.json({ message: "Installation missing", ok: false })
    );

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    expect(webhookOutcomeLogs()).toEqual([
      {
        level: "info",
        fields: {
          action: "opened",
          eventType: "push",
          outcome: "failed_response",
          provider: "github",
        },
      },
    ]);
  });

  it("returns 500 when an awaited handler persistence path rejects", async () => {
    const observedAt = new Date("2026-08-12T22:00:00.000Z");
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
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

  it("returns a generic 500 for a signed non-JSON body before dispatch", async () => {
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
      body: "not JSON",
      signature: "sha256=valid",
      eventType: "pull_request",
    });

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      message: "Something went wrong",
      ok: false,
    });
    expect(mockHandlePullRequest).not.toHaveBeenCalled();
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
  });

  it("preserves invalid signature rejection before handler dispatch", async () => {
    mockVerifyWebhookSignature.mockReturnValueOnce(false);

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(401);
    expect(mockHandlePullRequestReviewThread).not.toHaveBeenCalled();
    expect(mockHandlePush).not.toHaveBeenCalled();
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
  });

  it("preserves missing signature rejection before handler dispatch", async () => {
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
      body: JSON.stringify({ action: "created" }),
      signature: "",
      eventType: "meta",
    });

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(401);
    expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
    expect(mockHandlePullRequestReviewThread).not.toHaveBeenCalled();
    expect(mockHandlePush).not.toHaveBeenCalled();
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
  });

  it("preserves not-configured acknowledgement before validation", async () => {
    mockIsGitHubConfigured.mockReturnValueOnce(false);

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(mockValidateRequest).not.toHaveBeenCalled();
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
  });

  it("emits one terminal info log for unsupported event acknowledgement", async () => {
    mockValidateRequest.mockResolvedValueOnce({
      oversized: null,
      body: JSON.stringify({ action: "created" }),
      signature: "sha256=valid",
      eventType: "meta",
    });

    const response = await POST(new Request("http://localhost/webhook"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mockHandlePullRequestReviewThread).not.toHaveBeenCalled();
    expect(mockHandlePush).not.toHaveBeenCalled();
    expect(webhookOutcomeLogs()).toEqual([
      {
        level: "info",
        fields: {
          action: "created",
          eventType: "meta",
          outcome: "unsupported_event",
          provider: "github",
        },
      },
    ]);
  });
});

describe("POST /webhooks/github request_completed (ISS-9053)", () => {
  const signature = "sha256=signature-under-test";
  const payloadMarker = "payload-body-under-test";
  const body = JSON.stringify({ action: "completed", marker: payloadMarker });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGitHubConfigured.mockReturnValue(true);
    mockVerifyWebhookSignature.mockReturnValue(true);
    mockValidateRequest.mockResolvedValue({
      oversized: null,
      body,
      signature,
      eventType: "check_run",
    });
    mockHandleCheckRun.mockResolvedValue(Response.json({ ok: true }));
  });

  it("records a processed delivery at info with its path and status", async () => {
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(requestCompletedRecords()).toEqual([
      { level: "info", fields: expect.objectContaining(recordFor(200)) },
    ]);
  });

  it("records a signature rejection without the signature or the payload", async () => {
    mockVerifyWebhookSignature.mockReturnValueOnce(false);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(401);
    expect(mockHandleCheckRun).not.toHaveBeenCalled();
    const records = requestCompletedRecords();
    expect(records).toEqual([
      { level: "info", fields: expect.objectContaining(recordFor(401)) },
    ]);
    expect(JSON.stringify(records)).not.toContain(signature);
    expect(JSON.stringify(records)).not.toContain(payloadMarker);
  });

  it("records a thrown handler at error with its path and status", async () => {
    mockHandleCheckRun.mockRejectedValueOnce(new Error("persistence failed"));

    const response = await POST(webhookRequest());

    expect(response.status).toBe(500);
    expect(requestCompletedRecords()).toEqual([
      { level: "error", fields: expect.objectContaining(recordFor(500)) },
    ]);
  });

  it("records a throw that escapes the route as a 500 and still rethrows it", async () => {
    mockIsGitHubConfigured.mockImplementationOnce(() => {
      throw new Error("configuration read failed");
    });

    await expect(POST(webhookRequest())).rejects.toThrow(
      "configuration read failed"
    );
    expect(requestCompletedRecords()).toEqual([
      { level: "error", fields: expect.objectContaining(recordFor(500)) },
    ]);
  });

  function webhookRequest(): Request {
    return new Request("http://localhost:3002/webhooks/github", {
      body,
      headers: { "x-hub-signature-256": signature },
      method: "POST",
    });
  }

  function recordFor(statusCode: number): Record<string, unknown> {
    return {
      method: "POST",
      path: "/webhooks/github",
      status_code: statusCode,
    };
  }

  function requestCompletedRecords(): { level: string; fields: unknown }[] {
    const byLevel = { error: mockLogError, info: mockLogInfo };
    return Object.entries(byLevel).flatMap(([level, levelMock]) =>
      levelMock.mock.calls
        .filter(([message]) => message === REQUEST_COMPLETED_EVENT)
        .map(([, fields]) => ({ level, fields }))
    );
  }
});

// `request_completed` is the per-request record every route emits (ISS-9053).
// The one-terminal-outcome-log contract these cases pin is about the
// webhook's own line, at whichever level it was emitted (ISS-8450).
function webhookOutcomeLogs(): { fields: unknown; level: string }[] {
  return Object.entries({ debug: mockLogDebug, info: mockLogInfo }).flatMap(
    ([level, levelMock]) =>
      levelMock.mock.calls
        .filter(([message]) => message === ROUTE_TERMINAL_MESSAGE)
        .map(([, fields]) => ({ fields, level }))
  );
}

const ROUTE_TERMINAL_MESSAGE = "[webhook/github] Completed webhook handling";

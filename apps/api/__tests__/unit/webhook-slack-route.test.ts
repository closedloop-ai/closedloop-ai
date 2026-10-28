import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnv,
  mockHandleCreateIdea,
  mockHandleGetStatus,
  mockHeaders,
  mockLogInfo,
  mockScheduleLogFlush,
  mockSlackVerifyWebhookSignature,
} = vi.hoisted(() => ({
  mockEnv: { SLACK_SIGNING_SECRET: "secret" },
  mockHandleCreateIdea: vi.fn(),
  mockHandleGetStatus: vi.fn(),
  mockHeaders: vi.fn(),
  mockLogInfo: vi.fn(),
  mockScheduleLogFlush: vi.fn(),
  mockSlackVerifyWebhookSignature: vi.fn(),
}));

vi.mock("@/env", () => ({ env: mockEnv }));

vi.mock("next/headers", () => ({ headers: mockHeaders }));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: mockLogInfo, warn: vi.fn() },
}));

// Partial: the route now reads its body through this module's bounded reader,
// so only the `request_completed` emit and the flush hook are stubbed. That
// emit is pinned per receiver in webhook-body-caps (ISS-9053), which also pins
// the one flush a delivery schedules. Stubbing the emit silences the wrapper's
// flush too, so `mockScheduleLogFlush` here is the other half of that contract:
// the receiver owns NO terminal flush, and re-adding one turns these red.
vi.mock("@/lib/route-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-utils")>()),
  logRequestCompleted: vi.fn(),
  scheduleLogFlush: mockScheduleLogFlush,
}));

vi.mock("@/app/webhooks/slack/handlers", () => ({
  handleCreateIdea: mockHandleCreateIdea,
  handleGetStatus: mockHandleGetStatus,
}));

vi.mock("@/app/webhooks/slack/webhook-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/webhooks/slack/webhook-utils")>();
  return {
    WHITESPACE_REGEX: actual.WHITESPACE_REGEX,
    slackVerifyWebhookSignature: mockSlackVerifyWebhookSignature,
  };
});

import { POST } from "@/app/webhooks/slack/route";

describe("POST /webhooks/slack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.SLACK_SIGNING_SECRET = "secret";
    mockHeaders.mockResolvedValue(
      new Headers({
        "x-slack-request-timestamp": "123",
        "x-slack-signature": "v0=signature",
      })
    );
    mockSlackVerifyWebhookSignature.mockReturnValue(true);
    mockHandleCreateIdea.mockResolvedValue({ text: "created" });
    mockHandleGetStatus.mockResolvedValue({ text: "status" });
  });

  it("preserves missing config rejection", async () => {
    mockEnv.SLACK_SIGNING_SECRET = "";

    const response = await POST(makeRequest("command=%2Fsymphony"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(mockSlackVerifyWebhookSignature).not.toHaveBeenCalled();
    expect(mockScheduleLogFlush).not.toHaveBeenCalled();
  });

  it("preserves invalid signature rejection", async () => {
    mockSlackVerifyWebhookSignature.mockReturnValueOnce(false);

    const response = await POST(makeRequest("command=%2Fsymphony"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(mockHandleCreateIdea).not.toHaveBeenCalled();
    expect(mockHandleGetStatus).not.toHaveBeenCalled();
    expect(mockScheduleLogFlush).not.toHaveBeenCalled();
  });

  it("rejects a request with no timestamp header", async () => {
    const body = "command=%2Fsymphony";
    mockHeaders.mockResolvedValueOnce(
      new Headers({ "x-slack-signature": "v0=signature" })
    );
    mockSlackVerifyWebhookSignature.mockReturnValueOnce(false);

    const response = await POST(makeRequest(body));

    expect(mockSlackVerifyWebhookSignature).toHaveBeenCalledWith(
      body,
      "",
      "v0=signature",
      "secret"
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      message: "Invalid signature",
      ok: false,
    });
    expect(mockScheduleLogFlush).not.toHaveBeenCalled();
  });

  it("logs one terminal URL verification event without challenge contents", async () => {
    const response = await POST(
      makeRequest(
        JSON.stringify({
          challenge: "secret-challenge",
          type: "url_verification",
        })
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      challenge: "secret-challenge",
    });
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain(
      "secret-challenge"
    );
    expect(mockLogInfo).toHaveBeenCalledWith("[webhook/slack] Event handled", {
      outcome: "url_verification",
      provider: "slack",
    });
  });

  it.each([
    ["create-idea", mockHandleCreateIdea],
    ["status", mockHandleGetStatus],
  ])(
    "logs supported %s subcommand as an allowlisted value",
    async (subcommand, handler) => {
      const body = new URLSearchParams({
        channel_id: "C1",
        command: "/symphony",
        team_id: "T1",
        text: `${subcommand} PRO-1 private details`,
        user_id: "U1",
      }).toString();

      const response = await POST(makeRequest(body));

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: "C1",
          command: "/symphony",
          team_id: "T1",
          text: "PRO-1 private details",
          user_id: "U1",
        })
      );
      expect(mockLogInfo).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain(
        "private details"
      );
      expect(mockLogInfo).toHaveBeenCalledWith(
        "[webhook/slack] Event handled",
        {
          channelId: "C1",
          command: "/symphony",
          outcome: "processed",
          provider: "slack",
          subcommand,
          teamId: "T1",
        }
      );
    }
  );

  it("returns a generic 500 and flushes logs when a handler rejects", async () => {
    const body = new URLSearchParams({
      channel_id: "C1",
      command: "/symphony",
      team_id: "T1",
      text: "status ISS-7984",
      user_id: "U1",
    }).toString();
    mockHandleGetStatus.mockRejectedValueOnce(
      new Error("database unavailable")
    );

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      message: "Something went wrong",
      ok: false,
    });
    expect(mockScheduleLogFlush).not.toHaveBeenCalled();
  });

  it("logs unknown subcommands without raw text or token", async () => {
    const body = new URLSearchParams({
      channel_id: "C1",
      command: "/symphony",
      team_id: "T1",
      text: "secret-project leak",
      user_id: "U1",
    }).toString();

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(200);
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain(
      "secret-project"
    );
    expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain("leak");
    expect(mockLogInfo).toHaveBeenCalledWith("[webhook/slack] Event handled", {
      channelId: "C1",
      command: "/symphony",
      hasText: true,
      outcome: "unknown_subcommand",
      provider: "slack",
      subcommandCategory: "unknown",
      subcommandKnown: false,
      teamId: "T1",
    });
  });

  it("logs unsupported commands once", async () => {
    const body = new URLSearchParams({
      command: "/other",
      team_id: "T1",
      text: "ignored private text",
    }).toString();

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain(
      "ignored private text"
    );
    expect(mockLogInfo).toHaveBeenCalledWith("[webhook/slack] Event handled", {
      command: "/other",
      outcome: "unsupported_command",
      provider: "slack",
      teamId: "T1",
    });
  });
});

function makeRequest(body: string): Request {
  return new Request("http://localhost:3002/webhooks/slack", {
    body,
    method: "POST",
  });
}

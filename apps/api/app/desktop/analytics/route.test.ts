import {
  DesktopAnalyticsAckReason,
  DesktopAnalyticsEventName,
} from "@repo/api/src/types/desktop-analytics";
import {
  DESKTOP_PLUGIN_VERSION_HEADER,
  DesktopAnalyticsRestErrorCode,
} from "@repo/api/src/types/desktop-write-lane";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    clerkUserId: "clerk-user-1",
    user: {
      id: "user-1",
      organizationId: "org-1",
    },
  },
  capture: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(mocks.auth, request),
}));

vi.mock("./service", () => ({
  desktopAnalyticsService: {
    capture: mocks.capture,
  },
}));

import { maxDuration, POST } from "./route";

describe("POST /desktop/analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capture.mockResolvedValue(Result.ok({ captured: true }));
  });

  it("passes valid analytics payloads to the service with the plugin-version header", async () => {
    const payload = analyticsPayload();

    const response = await POST(
      request(payload, { [DESKTOP_PLUGIN_VERSION_HEADER]: "0.16.71" }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { captured: true } });
    expect(mocks.capture).toHaveBeenCalledWith({
      clerkUserId: "clerk-user-1",
      computeTargetId: "target-1",
      organizationId: "org-1",
      pluginVersion: "0.16.71",
      rawBody: payload,
      userId: "user-1",
    });
  });

  it("omits pluginVersion when the plugin-version header is absent", async () => {
    await POST(request(analyticsPayload()), routeContext());

    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ pluginVersion: undefined })
    );
  });

  it("rejects requests without computeTargetId before invoking the service", async () => {
    const response = await POST(
      new NextRequest("https://api.example.test/desktop/analytics", {
        body: JSON.stringify(analyticsPayload()),
        method: "POST",
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "computeTargetId is required",
    });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("rejects oversized payloads before invoking the service", async () => {
    const response = await POST(
      request({ padding: "x".repeat(33_000) }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body).toEqual({
      success: false,
      error: "Request body too large",
    });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON before invoking the service", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/desktop/analytics?computeTargetId=target-1",
        {
          body: "{not-json",
          method: "POST",
        }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid JSON body",
    });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("maps validation rejections to a coded 400 response", async () => {
    mocks.capture.mockResolvedValueOnce(
      Result.err(DesktopAnalyticsAckReason.ValidationFailed)
    );

    const response = await POST(request(analyticsPayload()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid desktop analytics payload",
      code: DesktopAnalyticsRestErrorCode.ValidationFailed,
    });
  });

  // FEA-3425: an ownership rejection must be distinguishable from a disabled
  // capability — the desktop latches and stops on `feature_disabled` but must
  // not latch on a wrong/stale computeTargetId.
  it("maps target-ownership rejections to a coded forbidden distinct from feature-disabled", async () => {
    mocks.capture.mockResolvedValueOnce(Result.err(Status.Forbidden));

    const response = await POST(request(analyticsPayload()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "Forbidden",
      code: DesktopAnalyticsRestErrorCode.TargetNotOwned,
    });
  });

  it("maps feature-disabled rejections to a coded forbidden", async () => {
    mocks.capture.mockResolvedValueOnce(
      Result.err(DesktopAnalyticsAckReason.FeatureDisabled)
    );

    const response = await POST(request(analyticsPayload()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "Forbidden",
      code: DesktopAnalyticsRestErrorCode.FeatureDisabled,
    });
  });

  it("maps rate-limit rejections to a coded 429 response", async () => {
    mocks.capture.mockResolvedValueOnce(
      Result.err(DesktopAnalyticsAckReason.RateLimited)
    );

    const response = await POST(request(analyticsPayload()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toEqual({
      success: false,
      error: "Rate limited",
      code: DesktopAnalyticsRestErrorCode.RateLimited,
    });
  });

  it("maps capture failures to a coded 500 response", async () => {
    mocks.capture.mockResolvedValueOnce(
      Result.err(DesktopAnalyticsAckReason.CaptureFailed)
    );

    const response = await POST(request(analyticsPayload()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Failed to capture desktop analytics",
      code: DesktopAnalyticsRestErrorCode.CaptureFailed,
    });
  });

  it("maps unexpected exceptions to a coded 500 response", async () => {
    mocks.capture.mockRejectedValueOnce(new Error("boom"));

    const response = await POST(request(analyticsPayload()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Failed to capture desktop analytics",
      code: DesktopAnalyticsRestErrorCode.InternalError,
    });
  });

  // FEA-3425: the desktop lane aborts at 10s; the function must outlive it so
  // a slow-but-successful capture commits server-side.
  it("declares an explicit function duration ceiling above the client timeout", () => {
    expect(maxDuration).toBe(15);
  });
});

function analyticsPayload(): Record<string, unknown> {
  return {
    event: DesktopAnalyticsEventName.CommandCompleted,
    occurredAt: "2026-07-23T00:00:00.000Z",
    properties: { command_id: "cmd-1" },
  };
}

function request(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(
    "https://api.example.test/desktop/analytics?computeTargetId=target-1",
    {
      body: JSON.stringify(body),
      headers,
      method: "POST",
    }
  );
}

function routeContext(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({}) };
}

import {
  DesktopAnalyticsAckReason,
  DesktopAnalyticsAttributionModel,
  DesktopAnalyticsEventName,
} from "@repo/api/src/types/desktop-analytics";
import { DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID } from "@repo/api/src/types/desktop-sync-ack-detail";
import {
  DESKTOP_PLUGIN_VERSION_HEADER,
  DesktopAnalyticsRestErrorCode,
} from "@repo/api/src/types/desktop-write-lane";
import { Result, Status } from "@repo/api/src/types/result";
import { log } from "@repo/observability/log";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_SESSION_TOKEN } from "@/__tests__/support/auth/route-auth-callers.test-helpers";
import { FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS } from "@/lib/fixed-window-rate-limiter";
import { REQUEST_COMPLETED_EVENT } from "@/lib/route-utils";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  preAuthCapture: vi.fn(),
  resolveDesktopSession: vi.fn(),
}));

// ISS-11883: only the auth decision is mocked. The real `withAnyAuth` →
// `withDesktopSessionAuth` wrapper runs, so its `request_completed` is tested.
vi.mock("@/lib/auth/desktop-session-auth", () => ({
  resolveDesktopSessionContext: mocks.resolveDesktopSession,
}));

vi.mock("./service", () => ({
  desktopAnalyticsService: {
    capture: mocks.capture,
  },
}));

// ISS-10503: the pre-auth branch bypasses the service (there is no compute
// target to own) and calls the shared handler with the real capture sink —
// mocked here so the route test asserts the PostHog-bound shape.
vi.mock("@/lib/desktop-analytics-capture", () => ({
  aliasDesktopAnalytics: vi.fn(),
  captureDesktopAnalytics: mocks.preAuthCapture,
}));

import { maxDuration, POST } from "./route";

const COMPUTE_TARGET_ID = "11111111-1111-7111-8111-111111111111";
const AUTHORIZED_HEADERS = { authorization: `Bearer ${DESKTOP_SESSION_TOKEN}` };

describe("POST /desktop/analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(log, "info").mockImplementation(() => undefined);
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    mocks.capture.mockResolvedValue(Result.ok({ captured: true }));
    mocks.resolveDesktopSession.mockResolvedValue({
      user: { id: "user-1", organizationId: "org-1", clerkId: "clerk-user-1" },
      organizationId: "org-1",
      clerkOrgId: "org_clerk_1",
    });
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
      computeTargetId: COMPUTE_TARGET_ID,
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
        headers: AUTHORIZED_HEADERS,
        method: "POST",
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "computeTargetId is required",
      details: { reason: DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID },
    });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  // ISS-8734: `ComputeTarget.id` is `@db.Uuid`; a malformed id used to reach
  // the ownership lookup as a P2023 and come back as a 500.
  it("rejects a malformed computeTargetId as a 400 before invoking the service", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/desktop/analytics?computeTargetId=abc",
        {
          body: JSON.stringify(analyticsPayload()),
          headers: AUTHORIZED_HEADERS,
          method: "POST",
        }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "computeTargetId must be a UUID",
      details: { reason: DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID },
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
        `https://api.example.test/desktop/analytics?computeTargetId=${COMPUTE_TARGET_ID}`,
        {
          body: "{not-json",
          headers: AUTHORIZED_HEADERS,
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

  // FEA-3425: an ownership rejection stays coded — skewed desktop builds
  // dispatch on code + status, and `target_not_owned` must keep reading as a
  // wrong/stale computeTargetId, never as a latching capability verdict.
  // PRD-736 P1 removed the `feature_disabled` 403 / `analytics_unavailable`
  // 503 emissions with the retired relay flag, so this is the route's only
  // remaining coded 403.
  it("maps target-ownership rejections to a coded forbidden", async () => {
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
    // ISS-10014: every desktop 429 states the same limiter-derived wait.
    expect(response.headers.get("Retry-After")).toBe(
      String(FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS)
    );
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
    expect(requestCompletedLines()).toEqual([
      expect.objectContaining({
        path: "/desktop/analytics",
        method: "POST",
        status_code: 500,
      }),
    ]);
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

  it("emits exactly one request_completed line for an authenticated desktop-session request (ISS-11883)", async () => {
    const response = await POST(request(analyticsPayload()), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(requestCompletedLines()).toEqual([
      expect.objectContaining({
        path: "/desktop/analytics",
        method: "POST",
        status_code: 200,
      }),
    ]);
  });

  // FEA-3425: the desktop lane aborts at 10s; the function must outlive it so
  // a slow-but-successful capture commits server-side.
  it("declares an explicit function duration ceiling above the client timeout", () => {
    expect(maxDuration).toBe(15);
  });

  // ISS-10503 (PRD-736 D5): the pre-auth mode. Mode selection is the PRESENCE
  // of the Authorization header, so these fixtures deliberately omit it.
  describe("pre-auth mode", () => {
    it("captures an unauthenticated event under the client-supplied distinct id and never touches the service", async () => {
      const response = await POST(
        preAuthRequest(preAuthPayload()),
        routeContext()
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ success: true, data: { captured: true } });
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.preAuthCapture).toHaveBeenCalledWith({
        event: DesktopAnalyticsEventName.FlowStarted,
        distinctId: PRE_AUTH_DISTINCT_ID,
        properties: expect.objectContaining({
          desktop_attribution_model:
            DesktopAnalyticsAttributionModel.PreAuthDistinctId,
          origin: "desktop",
        }),
      });
      // No authenticated-context enrichment exists to stamp: absent, not null.
      const properties = mocks.preAuthCapture.mock.calls[0]?.[0]?.properties;
      expect(properties).not.toHaveProperty("organization_id");
      expect(properties).not.toHaveProperty("compute_target_id");
    });

    it("emits exactly one request_completed line for a pre-auth request (ISS-11448, ISS-11883)", async () => {
      const response = await POST(
        preAuthRequest(preAuthPayload()),
        routeContext()
      );

      expect(response.status).toBe(200);
      expect(mocks.preAuthCapture).toHaveBeenCalledTimes(1);
      expect(requestCompletedLines()).toEqual([
        expect.objectContaining({
          path: "/desktop/analytics",
          method: "POST",
          status_code: 200,
        }),
      ]);
    });

    it("rejects a pre-auth payload without a distinct id", async () => {
      const payload = preAuthPayload();
      // biome-ignore lint/performance/noDelete: building the absent-field fixture
      delete payload.distinctId;

      const response = await POST(preAuthRequest(payload), routeContext());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        success: false,
        code: DesktopAnalyticsRestErrorCode.ValidationFailed,
      });
      expect(mocks.preAuthCapture).not.toHaveBeenCalled();
    });

    it("rejects a distinct id that is not a well-formed v4 UUID", async () => {
      const response = await POST(
        preAuthRequest({
          ...preAuthPayload(),
          // Version nibble 1: a well-formed UUID, but not v4 — the injection
          // control is the v4 shape, not mere UUID-ness.
          distinctId: "11111111-1111-1111-8111-111111111111",
        }),
        routeContext()
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        success: false,
        code: DesktopAnalyticsRestErrorCode.ValidationFailed,
      });
      expect(mocks.preAuthCapture).not.toHaveBeenCalled();
    });

    it("routes a credentialed request to the authenticated path even when the payload carries a distinct id", async () => {
      const response = await POST(request(preAuthPayload()), routeContext());

      expect(response.status).toBe(200);
      expect(mocks.capture).toHaveBeenCalledTimes(1);
      expect(mocks.preAuthCapture).not.toHaveBeenCalled();
    });
  });
});

function analyticsPayload(): Record<string, unknown> {
  return {
    event: DesktopAnalyticsEventName.CommandCompleted,
    occurredAt: "2026-07-23T00:00:00.000Z",
    properties: { command_id: "cmd-1" },
  };
}

const PRE_AUTH_DISTINCT_ID = "22222222-2222-4222-8222-222222222222";

function preAuthPayload(): Record<string, unknown> {
  return {
    event: DesktopAnalyticsEventName.FlowStarted,
    occurredAt: "2026-09-22T00:00:00.000Z",
    properties: { flow_id: PRE_AUTH_DISTINCT_ID, surface: "desktop" },
    distinctId: PRE_AUTH_DISTINCT_ID,
  };
}

function preAuthRequest(body: unknown): NextRequest {
  return new NextRequest("https://api.example.test/desktop/analytics", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

function request(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(
    `https://api.example.test/desktop/analytics?computeTargetId=${COMPUTE_TARGET_ID}`,
    {
      body: JSON.stringify(body),
      // ISS-10503: mode selection reads the Authorization header — the desktop
      // authenticated lane always presents a bearer, so these fixtures do too.
      headers: { ...AUTHORIZED_HEADERS, ...headers },
      method: "POST",
    }
  );
}

function routeContext(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({}) };
}

/** `request_completed` lines at either level: a 5xx is logged at error. */
function requestCompletedLines(): unknown[] {
  return [...vi.mocked(log.info).mock.calls, ...vi.mocked(log.error).mock.calls]
    .filter(([message]) => message === REQUEST_COMPLETED_EVENT)
    .map(([, fields]) => fields);
}

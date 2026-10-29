import { DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID } from "@repo/api/src/types/desktop-sync-ack-detail";
import {
  DESKTOP_PLUGIN_VERSION_HEADER,
  DesktopWriteLaneRestErrorCode,
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
  receive: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(mocks.auth, request),
}));

vi.mock("./service", () => ({
  desktopTelemetryService: {
    receive: mocks.receive,
  },
}));

import { maxDuration, POST } from "./route";

const COMPUTE_TARGET_ID = "11111111-1111-7111-8111-111111111111";

describe("POST /desktop/telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.receive.mockResolvedValue(Result.ok({ received: true }));
  });

  it("passes valid telemetry payloads to the service with the plugin-version header", async () => {
    const payload = telemetryPayload();

    const response = await POST(
      request(payload, { [DESKTOP_PLUGIN_VERSION_HEADER]: "0.16.71" }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { received: true } });
    expect(mocks.receive).toHaveBeenCalledWith({
      clerkUserId: "clerk-user-1",
      computeTargetId: COMPUTE_TARGET_ID,
      organizationId: "org-1",
      pluginVersion: "0.16.71",
      rawBody: payload,
      userId: "user-1",
    });
  });

  it("rejects requests without computeTargetId before invoking the service", async () => {
    const response = await POST(
      new NextRequest("https://api.example.test/desktop/telemetry", {
        body: JSON.stringify(telemetryPayload()),
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
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  // ISS-8734: `ComputeTarget.id` is `@db.Uuid`; a malformed id used to reach
  // the ownership lookup as a P2023 and come back as a 500.
  it("rejects a malformed computeTargetId as a 400 before invoking the service", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/desktop/telemetry?computeTargetId=abc",
        {
          body: JSON.stringify(telemetryPayload()),
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
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it("rejects oversized payloads before invoking the service", async () => {
    const response = await POST(
      request({ padding: "x".repeat(263_000) }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body).toEqual({
      success: false,
      error: "Request body too large",
    });
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON before invoking the service", async () => {
    const response = await POST(
      new NextRequest(
        `https://api.example.test/desktop/telemetry?computeTargetId=${COMPUTE_TARGET_ID}`,
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
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it("maps target-ownership rejections to a coded forbidden", async () => {
    mocks.receive.mockResolvedValueOnce(Result.err(Status.Forbidden));

    const response = await POST(request(telemetryPayload()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "Forbidden",
      code: DesktopWriteLaneRestErrorCode.TargetNotOwned,
    });
  });

  it("maps validation failures to a coded 400 response", async () => {
    mocks.receive.mockResolvedValueOnce(Result.err(Status.BadRequest));

    const response = await POST(request(telemetryPayload()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid desktop telemetry payload",
      code: DesktopWriteLaneRestErrorCode.ValidationFailed,
    });
  });

  it("maps unexpected exceptions to a coded 500 response", async () => {
    mocks.receive.mockRejectedValueOnce(new Error("boom"));

    const response = await POST(request(telemetryPayload()), routeContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Failed to receive desktop telemetry",
      code: DesktopWriteLaneRestErrorCode.InternalError,
    });
  });

  // FEA-3425: the desktop client aborts at 10s; the function must outlive it.
  it("declares an explicit function duration ceiling above the client timeout", () => {
    expect(maxDuration).toBe(15);
  });
});

function telemetryPayload(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    category: "loop_perf",
    severity: "info",
    timestamp: "2026-07-23T00:00:00.000Z",
    trace: { computeTargetId: COMPUTE_TARGET_ID },
  };
}

function request(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(
    `https://api.example.test/desktop/telemetry?computeTargetId=${COMPUTE_TARGET_ID}`,
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

import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  DesktopAgentSessionsAckReason,
} from "@repo/api/src/types/agent-session";
import { Result } from "@repo/api/src/types/result";
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
  sync: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(mocks.auth, request),
}));

vi.mock("./service", () => ({
  desktopAgentSessionsSyncService: {
    sync: mocks.sync,
  },
}));

import { POST } from "./route";

describe("POST /desktop/agent-sessions/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sync.mockResolvedValue(Result.ok({ synced: true }));
  });

  it("passes valid targeted sync payloads to the service", async () => {
    const payload = {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      sessions: [],
    };

    const response = await POST(request(payload), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { synced: true } });
    expect(mocks.sync).toHaveBeenCalledWith({
      clerkUserId: "clerk-user-1",
      computeTargetId: "target-1",
      organizationId: "org-1",
      rawBody: payload,
      userId: "user-1",
    });
  });

  it("rejects oversized payloads before invoking sync", async () => {
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
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("rejects requests without computeTargetId before reading sync data", async () => {
    const response = await POST(
      new NextRequest("https://api.example.test/desktop/agent-sessions/sync", {
        body: JSON.stringify({
          schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
          sessions: [],
        }),
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
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON before invoking sync", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/desktop/agent-sessions/sync?computeTargetId=target-1",
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
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("maps shared feature-disabled rejections to forbidden", async () => {
    mocks.sync.mockResolvedValueOnce(
      Result.err(DesktopAgentSessionsAckReason.FeatureDisabled)
    );

    const response = await POST(
      request({
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        sessions: [],
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ success: false, error: "Forbidden" });
  });

  it("maps shared rate-limit rejections to a 429 response", async () => {
    mocks.sync.mockResolvedValueOnce(
      Result.err(DesktopAgentSessionsAckReason.RateLimited)
    );

    const response = await POST(
      request({
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        sessions: [],
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toEqual({ success: false, error: "Rate limited" });
  });
});

function request(body: unknown): NextRequest {
  return new NextRequest(
    "https://api.example.test/desktop/agent-sessions/sync?computeTargetId=target-1",
    {
      body: JSON.stringify(body),
      method: "POST",
    }
  );
}

function routeContext(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({}) };
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";

const mockState = vi.hoisted(() => ({
  authContext: undefined as AuthContext | undefined,
  launchBootstrapLoop: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockState.authContext, request, context?.params),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/loops/launch-bootstrap-loop", () => ({
  launchBootstrapLoop: mockState.launchBootstrapLoop,
}));

import { POST } from "@/app/catalog/bootstrap/start/route";
import { launchBootstrapLoop } from "@/lib/loops/launch-bootstrap-loop";
import { MISSING_ANTHROPIC_API_KEY_MESSAGE } from "@/lib/loops/loop-dispatch-utils";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const requestBody = { repos: [{ fullName: "acme/widgets" }] };

function post() {
  return POST(
    createMockRequest({
      method: "POST",
      url: "http://localhost:3002/catalog/bootstrap/start",
      body: requestBody,
    }),
    createMockRouteContext({})
  );
}

describe("POST /catalog/bootstrap/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.authContext = createTestAuthContext();
  });

  it("answers a missing Anthropic key with actionable 400 copy", async () => {
    vi.mocked(launchBootstrapLoop).mockResolvedValue({
      ok: false,
      error: "missing_anthropic_api_key",
    });

    const response = await post();

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe(MISSING_ANTHROPIC_API_KEY_MESSAGE);
    // The generic launch_failed copy would blame a desktop app that a Cloud
    // bootstrap never involves.
    expect(json.error).not.toContain("desktop app may be disconnected");
  });

  it("keeps the generic launch_failed 502 unchanged", async () => {
    vi.mocked(launchBootstrapLoop).mockResolvedValue({
      ok: false,
      error: "launch_failed",
    });

    const response = await post();

    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.error).toBe(
      "Loop dispatch failed. The desktop app may be disconnected."
    );
  });
});

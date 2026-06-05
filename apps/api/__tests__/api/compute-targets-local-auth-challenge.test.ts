import { NextRequest } from "next/server";
import { vi } from "vitest";
import { POST } from "@/app/compute-targets/local-auth/challenge/route";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createTestAuthContext,
} from "../utils/auth-helpers";

const mockRegisterJti = vi.fn();
const mockIssueLocalGatewayChallenge = vi.fn();
const mockIsLocalGatewayJwtConfigured = vi.fn();
const mockIsLocalGatewayOriginAllowed = vi.fn();

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));

vi.mock("@/lib/auth/local-gateway-jti-registry", () => ({
  registerJti: (...args: unknown[]) => mockRegisterJti(...args),
}));

vi.mock("@/lib/auth/local-gateway-jwt", () => ({
  isLocalGatewayJwtConfigured: (...args: unknown[]) =>
    mockIsLocalGatewayJwtConfigured(...args),
  issueLocalGatewayChallenge: (...args: unknown[]) =>
    mockIssueLocalGatewayChallenge(...args),
  LOCAL_GATEWAY_CHALLENGE_TTL_SECONDS: 60,
}));

vi.mock("@/lib/auth/local-gateway-origins", () => ({
  isLocalGatewayOriginAllowed: (...args: unknown[]) =>
    mockIsLocalGatewayOriginAllowed(...args),
}));

describe("POST /compute-targets/local-auth/challenge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mockIsLocalGatewayJwtConfigured.mockReturnValue(true);
    mockIsLocalGatewayOriginAllowed.mockImplementation((origin) =>
      Boolean(origin)
    );
    mockIssueLocalGatewayChallenge.mockResolvedValue({
      jwt: "challenge-jwt",
      jti: "jti-123",
      expiresAt: new Date("2026-03-13T12:00:00.000Z"),
    });
  });

  it("registers the challenge jti for one-time use", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/compute-targets/local-auth/challenge",
      body: { origin: "http://localhost:3000" },
      headers: { origin: "http://localhost:3000" },
    });

    const response = await POST(request, {
      params: Promise.resolve({}),
    } as never);

    expect(response.status).toBe(200);
    expect(mockRegisterJti).toHaveBeenCalledWith(
      "jti-123",
      new Date("2026-03-13T12:00:00.000Z")
    );

    const json = await response.json();
    expect(json).toEqual({
      success: true,
      data: {
        challengeToken: "challenge-jwt",
        expiresAt: "2026-03-13T12:00:00.000Z",
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects when the posted origin does not match the request origin header", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/compute-targets/local-auth/challenge",
      body: { origin: "https://app.closedloop.ai" },
      headers: { origin: "https://app-stage.preview.localhost" },
    });

    const response = await POST(request, {
      params: Promise.resolve({}),
    } as never);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "Posted origin does not match request origin",
    });
    expect(mockIssueLocalGatewayChallenge).not.toHaveBeenCalled();
    expect(mockRegisterJti).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects when the request origin header is missing", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/compute-targets/local-auth/challenge",
      body: { origin: "http://localhost:3000" },
    });

    const response = await POST(request, {
      params: Promise.resolve({}),
    } as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Request origin is not trusted",
    });
    expect(mockIssueLocalGatewayChallenge).not.toHaveBeenCalled();
    expect(mockRegisterJti).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves no-store on invalid json parse errors", async () => {
    const request = new NextRequest(
      "http://localhost:3002/compute-targets/local-auth/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }
    );

    const response = await POST(request, {
      params: Promise.resolve({}),
    } as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Invalid JSON body",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

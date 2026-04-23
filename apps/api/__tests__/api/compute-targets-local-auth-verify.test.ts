import { vi } from "vitest";
import { POST } from "@/app/compute-targets/local-auth/verify/route";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createTestAuthContext,
} from "../utils/auth-helpers";

const mockConsumeJti = vi.fn();
const mockVerifyLocalGatewayChallenge = vi.fn();
const mockIsLocalGatewayJwtConfigured = vi.fn();

let mockAuthContext: AuthContext;

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) => String(error),
}));

vi.mock("@/lib/auth/with-api-key-auth", () => ({
  withApiKeyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));

vi.mock("@/lib/auth/local-gateway-jti-registry", () => ({
  consumeJti: (...args: unknown[]) => mockConsumeJti(...args),
}));

vi.mock("@/lib/auth/local-gateway-jwt", () => ({
  isLocalGatewayJwtConfigured: (...args: unknown[]) =>
    mockIsLocalGatewayJwtConfigured(...args),
  verifyLocalGatewayChallenge: (...args: unknown[]) =>
    mockVerifyLocalGatewayChallenge(...args),
}));

describe("POST /compute-targets/local-auth/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mockIsLocalGatewayJwtConfigured.mockReturnValue(true);
    mockConsumeJti.mockReturnValue(true);
  });

  it("returns the ApiResult verify payload on success", async () => {
    mockVerifyLocalGatewayChallenge.mockResolvedValue({
      jti: "jti-123",
      userId: mockAuthContext.user.id,
      orgId: mockAuthContext.user.organizationId,
      origin: "http://localhost:3000",
      expiresAt: "2026-03-13T12:00:00.000Z",
    });

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/compute-targets/local-auth/verify",
      body: {
        challengeToken: "challenge-jwt",
        requestOrigin: "http://localhost:3000",
      },
    });

    const response = await POST(request, {
      params: Promise.resolve({}),
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        ok: true,
        sessionTtlSeconds: 600,
        challengeExpiresAt: "2026-03-13T12:00:00.000Z",
      },
    });
  });

  it("consumes the challenge jti before rejecting a user or org mismatch", async () => {
    mockVerifyLocalGatewayChallenge.mockResolvedValue({
      jti: "jti-123",
      userId: "different-user",
      orgId: mockAuthContext.user.organizationId,
      origin: "http://localhost:3000",
      expiresAt: "2026-03-13T12:00:00.000Z",
    });

    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/compute-targets/local-auth/verify",
      body: {
        challengeToken: "challenge-jwt",
        requestOrigin: "http://localhost:3000",
      },
    });

    const response = await POST(request, {
      params: Promise.resolve({}),
    } as never);

    expect(mockConsumeJti).toHaveBeenCalledWith("jti-123");
    expect(response.status).toBe(403);

    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Challenge was not issued for this API key owner");
  });
});

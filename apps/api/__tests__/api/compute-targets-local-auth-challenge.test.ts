import { vi } from "vitest";
import { POST } from "@/app/compute-targets/local-auth/challenge/route";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createTestAuthContext,
} from "../utils/auth-helpers";

const mockRedisSet = vi.fn();
const mockIssueLocalGatewayChallenge = vi.fn();
const mockIsLocalGatewayJwtConfigured = vi.fn();
const mockIsLocalGatewayOriginAllowed = vi.fn();

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));

vi.mock("@repo/rate-limit", () => ({
  redis: {
    set: (...args: unknown[]) => mockRedisSet(...args),
  },
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
    mockIsLocalGatewayOriginAllowed.mockReturnValue(true);
    mockIssueLocalGatewayChallenge.mockResolvedValue({
      jwt: "challenge-jwt",
      jti: "jti-123",
      expiresAt: new Date("2026-03-13T12:00:00.000Z"),
    });
  });

  it("stores the challenge jti with a TTL derived from the jwt lifetime", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:3002/compute-targets/local-auth/challenge",
      body: { origin: "http://localhost:3000" },
    });

    const response = await POST(request, {
      params: Promise.resolve({}),
    } as never);

    expect(response.status).toBe(200);
    expect(mockRedisSet).toHaveBeenCalledWith(
      "local-auth:jti:jti-123",
      "pending",
      {
        ex: 70,
      }
    );

    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.challengeToken).toBe("challenge-jwt");
  });
});

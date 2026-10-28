import { DESKTOP_POP_SIGNATURE_HEADER } from "@repo/api/src/types/api-key";
import { verifyDesktopBootstrapToken } from "@repo/auth/desktop-bootstrap-jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapTestDb } from "@/__tests__/support/desktop/bootstrap.test-db";
import {
  bootstrapExchangeRequest,
  bootstrapMintInput,
} from "@/__tests__/support/desktop/bootstrap-credentials";
import { hashToken } from "@/lib/auth/token-hash";

vi.mock("server-only", () => ({}));
vi.mock("@repo/database", async () => {
  const { bootstrapTestDb: state } = await import(
    "@/__tests__/support/desktop/bootstrap.test-db"
  );
  return { withDb: state.withDb };
});
const auth = vi.hoisted(() => vi.fn());
vi.mock("@repo/auth/server", () => ({ auth }));

import { POST as mintRoute } from "./route";
import { desktopBootstrapAuthorizeService } from "./service";
import { POST as tokenRoute } from "./token/route";

describe("bootstrap HTTP routes with real PKCE, PoP, JWT and stateful claims", () => {
  beforeEach(() => {
    bootstrapTestDb.reset();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.closedloop.ai");
    vi.stubEnv(
      "DESKTOP_SESSION_JWT_SECRET",
      "bootstrap-test-secret-at-least-thirty-two-bytes"
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T20:00:00Z"));
    auth.mockResolvedValue({
      userId: "user_clerk",
      orgId: null,
      sessionStatus: "pending",
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("mints hash-only code and redeems it once into a pending-user JWT", async () => {
    const response = await mintRoute(mintRequest());
    expect(response.status).toBe(200);
    const { code } = await response.json();
    expect(bootstrapTestDb.tables.desktopBootstrapCode[0].codeHash).toBe(
      hashToken(code)
    );
    expect(JSON.stringify(bootstrapTestDb.tables)).not.toContain(code);
    const exchanged = await tokenRoute(bootstrapExchangeRequest(code));
    expect(exchanged.status).toBe(200);
    const body = await exchanged.json();
    expect(
      await verifyDesktopBootstrapToken(body.bootstrapToken)
    ).toMatchObject({
      clerkUserId: "user_clerk",
      gatewayId: "gateway-1",
      bootstrapId: bootstrapTestDb.tables.desktopBootstrapCode[0].id,
    });
    expect(bootstrapTestDb.tables.desktopBootstrapCode[0].redeemedAt).toEqual(
      new Date()
    );
    expect((await tokenRoute(bootstrapExchangeRequest(code))).status).toBe(401);
  });

  it.each([
    { userId: null, orgId: null, sessionStatus: "signed_out" },
    { userId: "user_clerk", orgId: "org_existing", sessionStatus: "active" },
    { userId: "user_clerk", orgId: null, sessionStatus: "active" },
  ])("refuses non-pending principals: %j", async (principal) => {
    auth.mockResolvedValue(principal);
    expect((await mintRoute(mintRequest())).status).toBe(401);
    expect(bootstrapTestDb.tables.desktopBootstrapCode).toHaveLength(0);
  });

  it.each([
    [{ webAppOrigin: "https://other.example" }, 403],
    [{ gatewayPublicKeyPem: "not-a-key" }, 400],
    [{ redirectUri: "https://attacker.example/cb" }, 400],
    [{ codeChallengeMethod: "plain" }, 400],
  ] as const)("rejects unsafe mint input %j", async (overrides, status) => {
    expect((await mintRoute(mintRequest(overrides))).status).toBe(status);
    expect(bootstrapTestDb.tables.desktopBootstrapCode).toHaveLength(0);
  });

  it.each([
    { codeVerifier: "x".repeat(43) },
    { gatewayId: "other-gateway" },
    { redirectUri: "http://127.0.0.1:49153/cb" },
    { code: "unknown" },
  ])(
    "rejects mismatched redemption %j without consuming the code",
    async (overrides) => {
      const code = await mint();
      expect(
        (await tokenRoute(bootstrapExchangeRequest(code, overrides))).status
      ).toBe(401);
      expect(
        bootstrapTestDb.tables.desktopBootstrapCode[0].redeemedAt
      ).toBeNull();
      expect((await tokenRoute(bootstrapExchangeRequest(code))).status).toBe(
        200
      );
    }
  );

  it("rejects missing proof of possession without consuming the code", async () => {
    const code = await mint();
    const signed = bootstrapExchangeRequest(code);
    const unsigned = new Request(signed.url, {
      method: "POST",
      body: await signed.text(),
    });
    expect((await tokenRoute(unsigned)).status).toBe(403);
    expect(
      bootstrapTestDb.tables.desktopBootstrapCode[0].redeemedAt
    ).toBeNull();
  });

  it("allows exactly one concurrent redemption based on stored claim state", async () => {
    const code = await mint();
    const responses = await Promise.all([
      tokenRoute(bootstrapExchangeRequest(code)),
      tokenRoute(bootstrapExchangeRequest(code)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401,
    ]);
  });

  it("rejects a forged device signature without consuming the code", async () => {
    const code = await mint();
    const request = bootstrapExchangeRequest(code);
    request.headers.set(
      DESKTOP_POP_SIGNATURE_HEADER,
      Buffer.alloc(64).toString("base64url")
    );
    expect((await tokenRoute(request)).status).toBe(403);
    expect(
      bootstrapTestDb.tables.desktopBootstrapCode[0].redeemedAt
    ).toBeNull();
  });

  it("keeps redeemed rows available for the bootstrap token lifetime", async () => {
    const code = await mint();
    expect((await tokenRoute(bootstrapExchangeRequest(code))).status).toBe(200);
    const redeemedId = bootstrapTestDb.tables.desktopBootstrapCode[0].id;
    vi.setSystemTime(Date.now() + 60_001);
    await mint();
    expect(
      bootstrapTestDb.tables.desktopBootstrapCode.some(
        (row) => row.id === redeemedId
      )
    ).toBe(true);
  });

  it("rejects a code expiring before the transaction claim", async () => {
    const code = await mint();
    bootstrapTestDb.beforeNextTransaction(() =>
      vi.setSystemTime(Date.now() + 60_001)
    );
    expect((await tokenRoute(bootstrapExchangeRequest(code))).status).toBe(401);
    expect(
      bootstrapTestDb.tables.desktopBootstrapCode[0].redeemedAt
    ).toBeNull();
  });

  it("rejects expiry at the exact deadline", async () => {
    const code = await mint();
    vi.setSystemTime(Date.now() + 60_000);
    expect((await tokenRoute(bootstrapExchangeRequest(code))).status).toBe(401);
  });
});

function mintRequest(overrides: Record<string, unknown> = {}) {
  const { clerkUserId: _clerkUserId, ...body } = bootstrapMintInput;
  return new Request("http://localhost:3002/desktop/bootstrap-authorize", {
    method: "POST",
    headers: { origin: "https://app.closedloop.ai" },
    body: JSON.stringify({
      ...body,
      webAppOrigin: "https://app.closedloop.ai",
      ...overrides,
    }),
  });
}

async function mint() {
  const result =
    await desktopBootstrapAuthorizeService.mint(bootstrapMintInput);
  if (!result.ok) {
    throw new Error("fixture mint rejected");
  }
  return result.value.code;
}

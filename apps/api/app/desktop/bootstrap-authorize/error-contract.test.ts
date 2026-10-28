import { generateKeyPairSync } from "node:crypto";
import { DesktopBootstrapErrorCode } from "@repo/api/src/types/desktop-bootstrap";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DesktopContract from "../contract";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  mint: vi.fn(),
  redeem: vi.fn(),
  create: vi.fn(),
  rejected: vi.fn(),
  authorizeLogo: vi.fn(),
  ready: vi.fn(async () => true),
}));
vi.mock("./schema-readiness-service", () => ({
  desktopBootstrapSchemaReadinessService: { isReady: mocks.ready },
}));
vi.mock("@/lib/observability/with-request-completed", () => ({
  withRequestCompleted: (handler: unknown) => handler,
}));
vi.mock("@/lib/auth/pending-session-user", () => ({
  resolvePendingSessionPrincipal: mocks.principal,
}));
vi.mock("./service", () => ({
  desktopBootstrapAuthorizeService: { mint: mocks.mint, redeem: mocks.redeem },
}));
vi.mock("../organizations/bootstrap/service", () => ({
  desktopBootstrapOrganizationService: { create: mocks.create },
}));
vi.mock("../organizations/bootstrap/logo-service", () => ({
  desktopBootstrapLogoService: { authorize: mocks.authorizeLogo },
}));
vi.mock("@/app/desktop/contract", async (importOriginal) => {
  const actual = await importOriginal<typeof DesktopContract>();
  return { ...actual, desktopConnectRejected: mocks.rejected };
});

import { DesktopConnectRejectionCause, DesktopConnectStage } from "../contract";
import {
  PUT as authorizeLogo,
  POST as create,
} from "../organizations/bootstrap/route";
import { POST as mint } from "./route";
import { POST as redeem } from "./token/route";

describe("bootstrap error contract", () => {
  it("blocks every bootstrap operation until the schema is ready, then allows retry", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const mintBody = {
      webAppOrigin: "http://localhost:3000",
      gatewayId: "gateway",
      gatewayPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256",
      redirectUri: "http://127.0.0.1:1234/cb",
    };
    mocks.principal.mockResolvedValue({ clerkUserId: "pending-user" });
    const operations = [
      {
        handler: mint,
        body: mintBody,
        service: mocks.mint,
        code: DesktopBootstrapErrorCode.Failed,
      },
      {
        handler: redeem,
        body: tokenBody(),
        service: mocks.redeem,
        code: DesktopBootstrapErrorCode.TokenFailed,
      },
      {
        handler: create,
        body: { name: "Acme", slug: "acme" },
        service: mocks.create,
        code: DesktopBootstrapErrorCode.OrganizationFailed,
      },
      {
        handler: authorizeLogo,
        body: {
          name: "logo.png",
          type: "image/png",
          size: 4,
          sha256: "a".repeat(64),
        },
        service: mocks.authorizeLogo,
        code: DesktopBootstrapErrorCode.OrganizationFailed,
      },
    ];
    for (const operation of operations) {
      mocks.ready.mockResolvedValue(false);
      const response = await operation.handler(request(operation.body));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        code: operation.code,
        retryable: true,
      });
      expect(operation.service).not.toHaveBeenCalled();
      mocks.ready.mockResolvedValue(true);
      operation.service.mockResolvedValue({ ok: true, value: {} });
      expect((await operation.handler(request(operation.body))).status).toBe(
        200
      );
      expect(operation.service).toHaveBeenCalledTimes(1);
    }
  });
  it("validates and authenticates staging requests with the shared error contract", async () => {
    expect((await authorizeLogo(request({}))).status).toBe(400);
    expect(mocks.authorizeLogo).not.toHaveBeenCalled();
    const metadata = {
      name: "logo.png",
      type: "image/png",
      size: 4,
      sha256: "a".repeat(64),
    };
    mocks.authorizeLogo.mockResolvedValue({ ok: false, error: "invalid" });
    expect((await authorizeLogo(request(metadata))).status).toBe(401);
    mocks.authorizeLogo.mockRejectedValue(new Error("storage unavailable"));
    const failure = await authorizeLogo(request(metadata));
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({
      code: DesktopBootstrapErrorCode.OrganizationFailed,
      retryable: true,
    });
    mocks.authorizeLogo.mockResolvedValue({
      ok: true,
      value: { uploadUrl: "https://bucket.s3.amazonaws.com/key" },
    });
    const success = await authorizeLogo(request(metadata));
    expect(success.status).toBe(200);
    expect(success.headers.get("cache-control")).toBe("no-store");
  });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.rejected.mockImplementation((status, code, retryable) =>
      Response.json({ code, retryable }, { status })
    );
  });
  it("distinguishes a session lookup fault from a missing pending session", async () => {
    mocks.principal.mockRejectedValue(new Error("Clerk unavailable"));
    const response = await mint(request({}));
    expect(response.status).toBe(503);
    expect(mocks.rejected).toHaveBeenCalledWith(
      503,
      DesktopBootstrapErrorCode.Failed,
      true,
      {
        stage: DesktopConnectStage.BootstrapAuthorize,
        cause: DesktopConnectRejectionCause.SessionLookupFaulted,
      }
    );
    mocks.principal.mockResolvedValue(null);
    expect(await (await mint(request({}))).json()).toMatchObject({
      code: DesktopBootstrapErrorCode.PendingSessionRequired,
      retryable: false,
    });
  });
  it("keeps token body validation distinct from a service refusal", async () => {
    expect(await (await redeem(request({}))).json()).toMatchObject({
      code: DesktopBootstrapErrorCode.TokenInvalidBody,
    });
    mocks.redeem.mockResolvedValue({ ok: false, error: "invalid" });
    expect(
      await (
        await redeem(
          request({
            code: "code",
            codeVerifier: "a".repeat(43),
            gatewayId: "gateway",
            redirectUri: "http://127.0.0.1:1234/cb",
          })
        )
      ).json()
    ).toMatchObject({ code: DesktopBootstrapErrorCode.TokenInvalid });
  });
  it("preserves organization refusal and optional-logo request contracts", async () => {
    const logo = {
      name: "logo.png",
      type: "image/png",
      size: 4,
      sha256: "a".repeat(64),
    };
    mocks.create.mockResolvedValue({ ok: false, error: "organization_exists" });
    const response = await create(
      request({ name: "Acme", slug: "acme", logo })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: DesktopBootstrapErrorCode.OrganizationAlreadyExists,
      retryable: false,
    });
    expect(mocks.create).toHaveBeenCalledWith({
      bootstrapToken: "bootstrap",
      name: "Acme",
      slug: "acme",
      logo,
    });
  });

  it.each([
    ["pop_failed", 403, DesktopBootstrapErrorCode.ProofOfPossessionRequired],
    ["invalid", 401, DesktopBootstrapErrorCode.TokenInvalid],
  ])("preserves token refusal %s", async (error, status, code) => {
    mocks.redeem.mockResolvedValue({ ok: false, error });
    const response = await redeem(request(tokenBody()));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code, retryable: false });
  });

  it("keeps token and organization provider faults retryable", async () => {
    mocks.redeem.mockRejectedValue(new Error("Provider unavailable"));
    const tokenResponse = await redeem(request(tokenBody()));
    expect(tokenResponse.status).toBe(503);
    expect(await tokenResponse.json()).toMatchObject({
      code: DesktopBootstrapErrorCode.TokenFailed,
      retryable: true,
    });
    mocks.create.mockRejectedValue(new Error("Provider unavailable"));
    const organizationResponse = await create(
      request({ name: "Acme", slug: "acme" })
    );
    expect(organizationResponse.status).toBe(503);
    expect(await organizationResponse.json()).toMatchObject({
      code: DesktopBootstrapErrorCode.OrganizationFailed,
      retryable: true,
    });
  });

  it.each([
    ["already_used", 409, DesktopBootstrapErrorCode.OrganizationAlreadyExists],
    ["invalid", 401, DesktopBootstrapErrorCode.BootstrapInvalid],
  ])("preserves organization refusal %s", async (error, status, code) => {
    mocks.create.mockResolvedValue({ ok: false, error });
    const response = await create(request({ name: "Acme", slug: "acme" }));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code, retryable: false });
  });

  it("rejects missing credentials and malformed organization bodies", async () => {
    const missingToken = request({ name: "Acme", slug: "acme" });
    missingToken.headers.delete("authorization");
    const missingResponse = await create(missingToken);
    expect(missingResponse.status).toBe(401);
    expect(await missingResponse.json()).toMatchObject({
      code: DesktopBootstrapErrorCode.BootstrapRequired,
      retryable: false,
    });
    const invalidResponse = await create(request({}));
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({
      code: DesktopBootstrapErrorCode.OrganizationInvalidBody,
      retryable: false,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

function request(body: unknown) {
  return new Request("http://localhost/desktop/bootstrap-authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer bootstrap",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify(body),
  });
}

function tokenBody() {
  return {
    code: "code",
    codeVerifier: "a".repeat(43),
    gatewayId: "gateway",
    redirectUri: "http://127.0.0.1:1234/cb",
  };
}

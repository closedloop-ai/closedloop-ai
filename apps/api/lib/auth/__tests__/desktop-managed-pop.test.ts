import { generateKeyPairSync, sign } from "node:crypto";
import {
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
} from "@repo/api/src/types/api-key";
import { ApiKeySource } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedApiKeyContextWithMetadata } from "../api-key-context";

const mockIsFeatureEnabled = vi.hoisted(() => vi.fn());

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    isFeatureEnabled: mockIsFeatureEnabled,
  },
}));

import {
  resolveDesktopManagedPopMode,
  verifyDesktopManagedPop,
} from "../desktop-managed-pop";

const NOW_SECONDS = 1_800_000_000;
const NOW = new Date(NOW_SECONDS * 1000);
const GATEWAY_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeKeyContext(
  overrides: Partial<VerifiedApiKeyContextWithMetadata> = {}
): VerifiedApiKeyContextWithMetadata {
  const { publicKey } = generateKeyPairSync("ed25519");
  return {
    apiKeyId: "api-key-1",
    userId: "user-1",
    organizationId: "org-1",
    scopes: ["read", "write", "delete"],
    source: ApiKeySource.DESKTOP_MANAGED,
    gatewayId: GATEWAY_ID,
    boundPublicKey: publicKey
      .export({ format: "pem", type: "spki" })
      .toString(),
    ...overrides,
  };
}

function makeSignedHeaders(input: {
  gatewayId?: string;
  method?: string;
  pathname?: string;
  timestamp?: number;
}): Headers {
  const { privateKey } = generateKeyPairSync("ed25519");
  const timestamp = String(input.timestamp ?? NOW_SECONDS);
  const gatewayId = input.gatewayId ?? GATEWAY_ID;
  const canonical = [
    input.method ?? "POST",
    input.pathname ?? "/compute-targets/local-auth/verify",
    timestamp,
    gatewayId,
  ].join("\n");
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey);

  return new Headers({
    [DESKTOP_POP_GATEWAY_ID_HEADER]: gatewayId,
    [DESKTOP_POP_TIMESTAMP_HEADER]: timestamp,
    [DESKTOP_POP_SIGNATURE_HEADER]: signature.toString("base64url"),
  });
}

function makeSignedPair(
  input: {
    gatewayId?: string;
    method?: string;
    pathname?: string;
    timestamp?: number;
  } = {}
): {
  headers: Headers;
  keyContext: VerifiedApiKeyContextWithMetadata;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const timestamp = String(input.timestamp ?? NOW_SECONDS);
  const gatewayId = input.gatewayId ?? GATEWAY_ID;
  const pathname = input.pathname ?? "/compute-targets/local-auth/verify";
  const method = input.method ?? "POST";
  const canonical = [method, pathname, timestamp, gatewayId].join("\n");
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey);

  return {
    keyContext: makeKeyContext({
      gatewayId,
      boundPublicKey: publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    }),
    headers: new Headers({
      [DESKTOP_POP_GATEWAY_ID_HEADER]: gatewayId,
      [DESKTOP_POP_TIMESTAMP_HEADER]: timestamp,
      [DESKTOP_POP_SIGNATURE_HEADER]: signature.toString("base64url"),
    }),
  };
}

function makeRequest(pathname: string, headers: Headers = new Headers()) {
  return new Request(`https://api.closedloop.ai${pathname}`, {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveDesktopManagedPopMode", () => {
  it("enforces when the server feature flag is enabled", async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    await expect(resolveDesktopManagedPopMode(makeKeyContext())).resolves.toBe(
      "enforce"
    );

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      "desktop-managed-pop-enforcement",
      "user-1"
    );
  });

  it("defaults to monitor when the server feature flag is disabled", async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);

    await expect(resolveDesktopManagedPopMode(makeKeyContext())).resolves.toBe(
      "monitor"
    );
  });

  it("defaults to monitor when feature flag evaluation is unavailable", async () => {
    mockIsFeatureEnabled.mockRejectedValue(new Error("posthog unavailable"));

    await expect(resolveDesktopManagedPopMode(makeKeyContext())).resolves.toBe(
      "monitor"
    );
  });

  it("does not evaluate the feature flag for keys that cannot be enforced", async () => {
    await expect(
      resolveDesktopManagedPopMode(
        makeKeyContext({
          boundPublicKey: null,
          source: ApiKeySource.DESKTOP_MANAGED,
        })
      )
    ).resolves.toBe("monitor");
    await expect(
      resolveDesktopManagedPopMode(
        makeKeyContext({
          gatewayId: null,
          source: ApiKeySource.DESKTOP_MANAGED,
        })
      )
    ).resolves.toBe("monitor");
    await expect(
      resolveDesktopManagedPopMode(
        makeKeyContext({
          boundPublicKey: null,
          gatewayId: null,
          source: ApiKeySource.USER_CREATED,
        })
      )
    ).resolves.toBe("monitor");

    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });
});

describe("verifyDesktopManagedPop", () => {
  it("passes a valid Ed25519 base64url signature", () => {
    const { keyContext, headers } = makeSignedPair();

    const decision = verifyDesktopManagedPop({
      keyContext,
      request: makeRequest("/compute-targets/local-auth/verify", headers),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: true,
      enforceEligible: true,
      mode: "enforce",
      reason: "passed",
    });
  });

  it("returns 401 for missing headers in enforce mode", () => {
    const decision = verifyDesktopManagedPop({
      keyContext: makeKeyContext(),
      request: makeRequest("/compute-targets/local-auth/verify"),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "missing_headers",
      status: 401,
    });
  });

  it("returns 401 for malformed timestamp or signature headers", () => {
    const headers = new Headers({
      [DESKTOP_POP_GATEWAY_ID_HEADER]: GATEWAY_ID,
      [DESKTOP_POP_TIMESTAMP_HEADER]: "not-seconds",
      [DESKTOP_POP_SIGNATURE_HEADER]: "not base64url",
    });

    const decision = verifyDesktopManagedPop({
      keyContext: makeKeyContext(),
      request: makeRequest("/compute-targets/local-auth/verify", headers),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "malformed_headers",
      status: 401,
    });
  });

  it("returns 403 for stale timestamps", () => {
    const { keyContext, headers } = makeSignedPair({
      timestamp: NOW_SECONDS - 61,
    });

    const decision = verifyDesktopManagedPop({
      keyContext,
      request: makeRequest("/compute-targets/local-auth/verify", headers),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "stale_timestamp",
      status: 403,
    });
  });

  it("returns 403 for gateway mismatch", () => {
    const headers = makeSignedHeaders({ gatewayId: "gateway-other" });

    const decision = verifyDesktopManagedPop({
      keyContext: makeKeyContext({ gatewayId: GATEWAY_ID }),
      request: makeRequest("/compute-targets/local-auth/verify", headers),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "gateway_mismatch",
      status: 403,
    });
  });

  it("returns 403 for invalid signatures", () => {
    const { keyContext, headers: invalidHeaders } = makeSignedPair({
      pathname: "/different-path",
    });

    const decision = verifyDesktopManagedPop({
      keyContext,
      request: makeRequest(
        "/compute-targets/local-auth/verify",
        invalidHeaders
      ),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "invalid_signature",
      status: 403,
    });
  });

  it("returns 503 for invalid bound public keys in enforce mode", () => {
    const decision = verifyDesktopManagedPop({
      keyContext: makeKeyContext({ boundPublicKey: "not-a-pem" }),
      request: makeRequest("/compute-targets/local-auth/verify"),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: false,
      enforceEligible: true,
      reason: "verifier_unavailable",
      status: 503,
    });
  });

  it("records invalid bound public keys without rejecting in monitor mode", () => {
    const decision = verifyDesktopManagedPop({
      keyContext: makeKeyContext({ boundPublicKey: "not-a-pem" }),
      request: makeRequest("/compute-targets/local-auth/verify"),
      mode: "monitor",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: true,
      enforceEligible: true,
      reason: "verifier_unavailable",
    });
    expect(decision.status).toBeUndefined();
  });

  it("bypasses USER_CREATED keys even in enforce mode", () => {
    const decision = verifyDesktopManagedPop({
      keyContext: makeKeyContext({
        source: ApiKeySource.USER_CREATED,
        gatewayId: null,
        boundPublicKey: null,
      }),
      request: makeRequest("/compute-targets/local-auth/verify"),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: true,
      enforceEligible: false,
      reason: "not_applicable",
    });
  });

  it("keeps null-bound DESKTOP_MANAGED keys accepted in enforce mode", () => {
    const decision = verifyDesktopManagedPop({
      keyContext: makeKeyContext({ boundPublicKey: null }),
      request: makeRequest("/compute-targets/local-auth/verify"),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: true,
      enforceEligible: false,
      reason: "not_applicable",
    });
  });

  it("keeps DESKTOP_MANAGED keys without a gateway id accepted in enforce mode", () => {
    const decision = verifyDesktopManagedPop({
      keyContext: makeKeyContext({ gatewayId: null }),
      request: makeRequest("/compute-targets/local-auth/verify"),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: true,
      enforceEligible: false,
      reason: "not_applicable",
    });
  });

  it("records monitor-mode failures without rejecting", () => {
    const decision = verifyDesktopManagedPop({
      keyContext: makeKeyContext(),
      request: makeRequest("/compute-targets/local-auth/verify"),
      mode: "monitor",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: true,
      enforceEligible: true,
      reason: "missing_headers",
    });
    expect(decision.status).toBeUndefined();
  });
});

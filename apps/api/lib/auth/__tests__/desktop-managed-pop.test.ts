import { generateKeyPairSync, sign } from "node:crypto";
import {
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
} from "@repo/api/src/types/api-key";
import { ApiKeySource } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_MANAGED_POP_PROVISIONING_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import type { VerifiedApiKeyContextWithMetadata } from "../api-key-context";

const mockIsFeatureEnabled = vi.hoisted(() => vi.fn());

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: mockIsFeatureEnabled,
}));

import {
  DesktopManagedFeatureFlagOutcome,
  evaluateDesktopManagedPopEnforcement,
  isDesktopManagedFeatureFlagEnabled,
  resolveDesktopManagedPopMode,
  verifyDesktopManagedPop,
} from "../desktop-managed-pop";

/**
 * Any registered flag other than the enforcement one: these cases pin the
 * fail-closed BOOLEAN FOLD, which is flag-agnostic. ISS-7778 made the evaluator
 * take a classified, registered descriptor, so a synthetic key string is no
 * longer expressible here.
 */
const ANY_REGISTERED_FLAG = DESKTOP_MANAGED_POP_PROVISIONING_SERVER_FLAG;

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
    input.pathname ?? "/compute-targets/register",
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
  const pathname = input.pathname ?? "/compute-targets/register";
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

  /**
   * BEHAVIOUR CHANGED IN THIS DIFF (ISS-7778), which is why the expectation did.
   * This path used to resolve its OWN distinct ids — clerk AND internal, verdicts
   * ORed — because it carried a private copy of the resolver. ISS-8196 narrowed
   * the CANONICAL resolver to the Clerk id alone and did not reach the copy, so
   * this enforcement flag kept taking a second, independent draw in a namespace
   * PostHog holds no person under: a viewer bucketed OUT on their Clerk id could
   * still be bucketed IN here by coin flip. The copy is gone and this path now
   * evaluates the one id the browser identifies.
   */
  it("evaluates the Clerk distinct id alone when the principal has one", async () => {
    // The clerk read must answer OFF. A blanket `true` would short-circuit the
    // loop on the first id, and every assertion below would then hold under the
    // OLD two-id resolver too — the test could not fail under the mutation it
    // exists to police. Answering `false` first is what forces the question
    // "would a second id have been asked?" to be observable.
    mockIsFeatureEnabled
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      resolveDesktopManagedPopMode({
        ...makeKeyContext(),
        clerkUserId: "clerk-user-1",
      })
    ).resolves.toBe("monitor");

    expect(mockIsFeatureEnabled).toHaveBeenCalledTimes(1);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      "desktop-managed-pop-enforcement",
      "clerk-user-1"
    );
    expect(mockIsFeatureEnabled).not.toHaveBeenCalledWith(
      "desktop-managed-pop-enforcement",
      "user-1"
    );
  });

  // The internal id is still the fallback for a principal that carries no Clerk
  // id — an API key whose owner has none — which would otherwise resolve nothing.
  it("falls back to the internal user id when the principal has no Clerk id", async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    await expect(resolveDesktopManagedPopMode(makeKeyContext())).resolves.toBe(
      "enforce"
    );

    expect(mockIsFeatureEnabled).toHaveBeenCalledTimes(1);
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

  it("defaults to monitor when feature flag evaluation resolves without a decision", async () => {
    mockIsFeatureEnabled.mockResolvedValue(null);

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
      request: makeRequest("/compute-targets/register", headers),
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
      request: makeRequest("/compute-targets/register"),
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
      request: makeRequest("/compute-targets/register", headers),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "malformed_headers",
      status: 401,
    });
  });

  it("returns 401 when only the timestamp header is malformed", () => {
    const { keyContext, headers } = makeSignedPair();
    headers.set(DESKTOP_POP_TIMESTAMP_HEADER, "not-seconds");

    const decision = verifyDesktopManagedPop({
      keyContext,
      request: makeRequest("/compute-targets/register", headers),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "malformed_headers",
      status: 401,
    });
  });

  it("returns 401 when only the signature header is malformed", () => {
    const { keyContext, headers } = makeSignedPair();
    headers.set(DESKTOP_POP_SIGNATURE_HEADER, "not base64url");

    const decision = verifyDesktopManagedPop({
      keyContext,
      request: makeRequest("/compute-targets/register", headers),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "malformed_headers",
      status: 401,
    });
  });

  it("returns 401 for a numeric timestamp outside the safe integer range", () => {
    const { keyContext, headers } = makeSignedPair();
    headers.set(DESKTOP_POP_TIMESTAMP_HEADER, "11111111111111111111");

    const decision = verifyDesktopManagedPop({
      keyContext,
      request: makeRequest("/compute-targets/register", headers),
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
      request: makeRequest("/compute-targets/register", headers),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "stale_timestamp",
      status: 403,
    });
  });

  it("returns 403 for timestamps beyond the future freshness window", () => {
    const { keyContext, headers } = makeSignedPair({
      timestamp: NOW_SECONDS + 61,
    });

    const decision = verifyDesktopManagedPop({
      keyContext,
      request: makeRequest("/compute-targets/register", headers),
      mode: "enforce",
      now: NOW,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "stale_timestamp",
      status: 403,
    });
  });

  it.each([
    { direction: "past", offsetSeconds: -60 },
    { direction: "future", offsetSeconds: 60 },
  ])(
    "accepts a timestamp exactly at the $direction freshness boundary",
    ({ offsetSeconds }) => {
      const { keyContext, headers } = makeSignedPair({
        timestamp: NOW_SECONDS + offsetSeconds,
      });

      const decision = verifyDesktopManagedPop({
        keyContext,
        request: makeRequest("/compute-targets/register", headers),
        mode: "enforce",
        now: NOW,
      });

      expect(decision).toMatchObject({
        accepted: true,
        reason: "passed",
      });
    }
  );

  it("returns 403 for gateway mismatch", () => {
    const headers = makeSignedHeaders({ gatewayId: "gateway-other" });

    const decision = verifyDesktopManagedPop({
      keyContext: makeKeyContext({ gatewayId: GATEWAY_ID }),
      request: makeRequest("/compute-targets/register", headers),
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
      request: makeRequest("/compute-targets/register", invalidHeaders),
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
      request: makeRequest("/compute-targets/register"),
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
      request: makeRequest("/compute-targets/register"),
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
      request: makeRequest("/compute-targets/register"),
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
      request: makeRequest("/compute-targets/register"),
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
      request: makeRequest("/compute-targets/register"),
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
      request: makeRequest("/compute-targets/register"),
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

/**
 * ISS-8132. The route suite mocks `evaluateDesktopManagedPopEnforcement`
 * outright, so it proves the outcome→status MAPPING and nothing about the
 * producer. These cases own the other half: that a real provider throw becomes
 * `Faulted` rather than being flattened into `Disabled`, and — the part the
 * ticket ruled must not change — that the boolean fold every OTHER caller uses
 * still fails closed on exactly that throw.
 */
describe("evaluateDesktopManagedPopEnforcement", () => {
  it("reports Enabled when the evaluated distinct id has the flag on", async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    await expect(
      evaluateDesktopManagedPopEnforcement({
        userId: "user-1",
        clerkUserId: "clerk-user-1",
      })
    ).resolves.toBe(DesktopManagedFeatureFlagOutcome.Enabled);
  });

  it("reports Disabled when the provider answers and no distinct id has the flag on", async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);

    await expect(
      evaluateDesktopManagedPopEnforcement({
        userId: "user-1",
        clerkUserId: "clerk-user-1",
      })
    ).resolves.toBe(DesktopManagedFeatureFlagOutcome.Disabled);
  });

  // THE production outage path, and the one a `catch`-only fix would miss:
  // `isFeatureFlagEnabledForDistinctId` resolves `null` when PostHog answered
  // nothing (ISS-4556 — posthog-node returns undefined on a failed request
  // rather than rejecting), so a real outage never reaches the catch below.
  it("reports Faulted when the provider answers nothing", async () => {
    mockIsFeatureEnabled.mockResolvedValue(null);

    await expect(
      evaluateDesktopManagedPopEnforcement({
        userId: "user-1",
        clerkUserId: "clerk-user-1",
      })
    ).resolves.toBe(DesktopManagedFeatureFlagOutcome.Faulted);
  });

  // The mixed answered-off/unanswered case this suite used to cover needed TWO
  // distinct ids to reach. ISS-7778 put this path on the canonical resolver,
  // which yields at most one, so that input is no longer expressible; the
  // single-id unanswered case above is the reachable form of the same contract.

  it("reports Faulted, distinctly from Disabled, when the provider throws", async () => {
    mockIsFeatureEnabled.mockRejectedValue(new Error("posthog down"));

    await expect(
      evaluateDesktopManagedPopEnforcement({ userId: "user-1" })
    ).resolves.toBe(DesktopManagedFeatureFlagOutcome.Faulted);
  });

  // Fail-closed is preserved for the boolean fold on the `null` path too, not
  // only on the throw — that is the guarantee ISS-8132 ruled must not move.
  it("keeps the boolean fold failing closed when the provider answers nothing", async () => {
    mockIsFeatureEnabled.mockResolvedValue(null);

    await expect(
      isDesktopManagedFeatureFlagEnabled(ANY_REGISTERED_FLAG, {
        userId: "user-1",
      })
    ).resolves.toBe(false);
    await expect(resolveDesktopManagedPopMode(makeKeyContext())).resolves.toBe(
      "monitor"
    );
  });

  // The ruling ISS-8132 must not break: every OTHER caller keeps the old
  // fail-closed reading of the exact input that now produces `Faulted`.
  // `resolveDesktopManagedPopMode` on an unavailable flag is pinned above.
  it("keeps the boolean fold failing closed on a provider throw", async () => {
    mockIsFeatureEnabled.mockRejectedValue(new Error("posthog down"));

    await expect(
      isDesktopManagedFeatureFlagEnabled(ANY_REGISTERED_FLAG, {
        userId: "user-1",
      })
    ).resolves.toBe(false);
  });
});

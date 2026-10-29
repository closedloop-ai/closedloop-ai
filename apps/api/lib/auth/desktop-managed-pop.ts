import { verify as verifySignature } from "node:crypto";
import { ApiKeySource } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  type FeatureFlagIdentity,
  resolveDistinctIdsForIdentity,
} from "@/lib/feature-flag-identity";
import { evaluateServerFeatureFlagForDistinctId } from "@/lib/feature-flags/server-feature-flag-evaluation";
import {
  DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG,
  type RegisteredServerFeatureFlag,
} from "@/lib/feature-flags/server-feature-flags";
import type { VerifiedApiKeyContextWithMetadata } from "./api-key-context";
import {
  BASE64URL_SIGNATURE_PATTERN,
  createEd25519PublicKey,
  POP_TIMESTAMP_FRESHNESS_SECONDS,
  readDesktopPopHeaders,
  TIMESTAMP_SECONDS_PATTERN,
} from "./desktop-pop-utils";

export const DESKTOP_MANAGED_POP_ENFORCEMENT_FLAG =
  DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG.key;

export type DesktopManagedPopMode = "monitor" | "enforce";

export type DesktopManagedPopReason =
  | "passed"
  | "not_applicable"
  | "missing_headers"
  | "malformed_headers"
  | "stale_timestamp"
  | "gateway_mismatch"
  | "invalid_signature"
  | "verifier_unavailable";

export type DesktopManagedPopDecision = {
  accepted: boolean;
  enforceEligible: boolean;
  mode: DesktopManagedPopMode;
  reason: DesktopManagedPopReason;
  status?: 401 | 403 | 503;
};

export type DesktopManagedPopFailure = {
  message: string;
  status: 401 | 403 | 503;
};

/**
 * ISS-7778: an alias of the canonical {@link FeatureFlagIdentity} rather than a
 * second structural copy of it. The copy that used to live here is what let the
 * distinct-id resolver below drift away from the canonical one.
 */
export type DesktopManagedFeatureFlagIdentity = FeatureFlagIdentity;

type DesktopManagedPopVerificationInput = {
  keyContext: VerifiedApiKeyContextWithMetadata & {
    clerkUserId?: string | null;
  };
  request: Request;
  now?: Date;
  mode?: DesktopManagedPopMode;
};

/**
 * Resolve the desktop-managed PoP rollout mode from the server-side feature
 * flag. Missing or unavailable flag evaluation defaults to monitor mode so
 * older Electron clients remain compatible.
 */
export async function resolveDesktopManagedPopMode(
  keyContext: Pick<
    VerifiedApiKeyContextWithMetadata,
    "boundPublicKey" | "gatewayId" | "source" | "userId"
  > & { clerkUserId?: string | null }
): Promise<DesktopManagedPopMode> {
  if (
    keyContext.source !== ApiKeySource.DESKTOP_MANAGED ||
    !(keyContext.boundPublicKey && keyContext.gatewayId)
  ) {
    return "monitor";
  }

  return (await isDesktopManagedPopEnforcementEnabled(keyContext))
    ? "enforce"
    : "monitor";
}

/**
 * Returns whether bound desktop-managed API keys should be treated as protected
 * and enforce PoP. Missing or unavailable flag evaluation stays off so managed
 * keys remain bearer-compatible during rollout.
 */
export async function isDesktopManagedPopEnforcementEnabled(
  identity: DesktopManagedFeatureFlagIdentity
): Promise<boolean> {
  return await isDesktopManagedFeatureFlagEnabled(
    DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG,
    identity
  );
}

/**
 * Fail-closed boolean fold over {@link evaluateDesktopManagedFeatureFlag}: a
 * disabled flag and an unreachable flag provider both read as not-enabled.
 */
export async function isDesktopManagedFeatureFlagEnabled(
  flag: RegisteredServerFeatureFlag,
  identity: DesktopManagedFeatureFlagIdentity
): Promise<boolean> {
  return (
    (await evaluateDesktopManagedFeatureFlag(flag, identity)) ===
    DesktopManagedFeatureFlagOutcome.Enabled
  );
}

/**
 * Evaluate the server-side desktop-managed proof-of-possession policy for a
 * verified API key. This helper never logs secrets or signature material.
 */
export function verifyDesktopManagedPop(
  input: DesktopManagedPopVerificationInput
): DesktopManagedPopDecision {
  const mode = input.mode ?? "monitor";
  const { keyContext, request } = input;

  if (keyContext.source !== ApiKeySource.DESKTOP_MANAGED) {
    return logAndReturn(input, {
      accepted: true,
      enforceEligible: false,
      mode,
      reason: "not_applicable",
    });
  }

  if (!(keyContext.boundPublicKey && keyContext.gatewayId)) {
    return logAndReturn(input, {
      accepted: true,
      enforceEligible: false,
      mode,
      reason: "not_applicable",
    });
  }

  const publicKey = createEd25519PublicKey(keyContext.boundPublicKey);
  if (!publicKey) {
    return logAndReturn(input, toDecision(mode, "verifier_unavailable"));
  }

  const headers = readDesktopPopHeaders(request.headers);
  if (!(headers.gatewayId && headers.timestamp && headers.signature)) {
    return logAndReturn(input, toDecision(mode, "missing_headers"));
  }

  const timestampIsMalformed = !TIMESTAMP_SECONDS_PATTERN.test(
    headers.timestamp
  );
  const signatureIsMalformed = !BASE64URL_SIGNATURE_PATTERN.test(
    headers.signature
  );
  if (timestampIsMalformed || signatureIsMalformed) {
    return logAndReturn(input, toDecision(mode, "malformed_headers"));
  }

  const timestampSeconds = Number(headers.timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return logAndReturn(input, toDecision(mode, "malformed_headers"));
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (
    Math.abs(nowSeconds - timestampSeconds) > POP_TIMESTAMP_FRESHNESS_SECONDS
  ) {
    return logAndReturn(input, toDecision(mode, "stale_timestamp"));
  }

  if (headers.gatewayId !== keyContext.gatewayId) {
    return logAndReturn(input, toDecision(mode, "gateway_mismatch"));
  }

  const pathname = new URL(request.url).pathname;
  const signature = Buffer.from(headers.signature, "base64url");

  const canonical = [
    request.method.toUpperCase(),
    pathname,
    headers.timestamp,
    headers.gatewayId,
  ].join("\n");

  try {
    const signatureValid = verifySignature(
      null,
      Buffer.from(canonical, "utf8"),
      publicKey,
      signature
    );

    return logAndReturn(
      input,
      signatureValid
        ? {
            accepted: true,
            enforceEligible: true,
            mode,
            reason: "passed",
          }
        : toDecision(mode, "invalid_signature")
    );
  } catch (error) {
    return logAndReturn(
      input,
      toDecision(mode, "verifier_unavailable", parseError(error))
    );
  }
}

/**
 * Convert an enforcing PoP decision into the exact HTTP response class required
 * by PLN-323. Accepted monitor decisions do not produce a response.
 */
export function getDesktopManagedPopFailure(
  decision: DesktopManagedPopDecision
): DesktopManagedPopFailure | null {
  if (decision.accepted || !decision.status) {
    return null;
  }

  if (decision.status === 503) {
    return {
      status: 503,
      message: "Desktop managed PoP verifier unavailable",
    };
  }

  return {
    status: decision.status,
    message: "Desktop managed PoP verification failed",
  };
}

/**
 * Resolve rollout mode, evaluate PoP, and return the HTTP failure contract for
 * callers that share desktop-managed PoP enforcement.
 */
export async function getDesktopManagedPopRequestFailure(input: {
  keyContext: VerifiedApiKeyContextWithMetadata & {
    clerkUserId?: string | null;
  };
  request: Request;
}): Promise<DesktopManagedPopFailure | null> {
  const popDecision = verifyDesktopManagedPop({
    keyContext: input.keyContext,
    mode: await resolveDesktopManagedPopMode(input.keyContext),
    request: input.request,
  });
  return getDesktopManagedPopFailure(popDecision);
}

function toDecision(
  mode: DesktopManagedPopMode,
  reason: Exclude<DesktopManagedPopReason, "passed" | "not_applicable">,
  error?: string
): DesktopManagedPopDecision & { error?: string } {
  const statusByReason = {
    missing_headers: 401,
    malformed_headers: 401,
    stale_timestamp: 403,
    gateway_mismatch: 403,
    invalid_signature: 403,
    verifier_unavailable: 503,
  } as const satisfies Record<
    Exclude<DesktopManagedPopReason, "passed" | "not_applicable">,
    401 | 403 | 503
  >;

  return {
    accepted: mode !== "enforce",
    enforceEligible: true,
    mode,
    reason,
    status: mode === "enforce" ? statusByReason[reason] : undefined,
    ...(error ? { error } : {}),
  };
}

function logAndReturn(
  input: DesktopManagedPopVerificationInput,
  decision: DesktopManagedPopDecision & { error?: string }
): DesktopManagedPopDecision {
  const logPayload = {
    apiKeyId: input.keyContext.apiKeyId,
    userId: input.keyContext.userId,
    organizationId: input.keyContext.organizationId,
    source: input.keyContext.source,
    mode: decision.mode,
    reason: decision.reason,
    accepted: decision.accepted,
    enforceEligible: decision.enforceEligible,
    status: decision.status,
    method: input.request.method.toUpperCase(),
    pathname: safePathname(input.request.url),
    hasGatewayId: Boolean(input.keyContext.gatewayId),
    hasBoundPublicKey: Boolean(input.keyContext.boundPublicKey),
    ...(decision.error ? { error: decision.error } : {}),
  };

  if (decision.reason === "passed" || decision.reason === "not_applicable") {
    log.info("desktop_managed_pop_verification", logPayload);
  } else if (decision.reason === "verifier_unavailable") {
    log.error("desktop_managed_pop_verification", logPayload);
  } else {
    log.warn("desktop_managed_pop_verification", logPayload);
  }

  return decision;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "unavailable";
  }
}

/**
 * What a desktop-managed rollout-flag evaluation actually observed.
 *
 * `Faulted` exists because the boolean fold cannot express it: the fail-closed
 * default is deliberate — an unavailable flag keeps managed keys bearer-
 * compatible — but "policy says no" and "we could not ask the policy" are not
 * the same refusal, and a caller that must tell a permanent rejection from a
 * transient one has to see the difference (ISS-8132).
 */
export const DesktopManagedFeatureFlagOutcome = {
  Enabled: "enabled",
  Disabled: "disabled",
  /** The flag provider itself failed — the policy was never asked. */
  Faulted: "faulted",
} as const;
export type DesktopManagedFeatureFlagOutcome =
  (typeof DesktopManagedFeatureFlagOutcome)[keyof typeof DesktopManagedFeatureFlagOutcome];

/**
 * Evaluates a Desktop-managed rollout flag using the same Clerk distinct ID
 * that the browser identifies in PostHog, and reports which of the three things
 * happened.
 *
 * {@link isDesktopManagedFeatureFlagEnabled} is the fail-closed fold over this,
 * so a `Faulted` evaluation still reads as not-enabled everywhere that only
 * needs the boolean.
 *
 * ISS-7778: the distinct ids come from the canonical
 * {@link resolveDistinctIdsForIdentity}. This module used to carry its own
 * resolver, and ISS-8196 narrowed the canonical one WITHOUT it — so this path
 * went on ORing a second, internal-namespace draw that PostHog holds no person
 * under, and a viewer bucketed OUT on their Clerk id could still be bucketed IN
 * here by coin flip. That is the divergence ISS-8196 exists to remove, applied
 * to the one caller it missed; on this ENFORCEMENT flag it means the server now
 * enforces for exactly the cohort the rollout targets.
 */
export async function evaluateDesktopManagedFeatureFlag(
  flag: RegisteredServerFeatureFlag,
  identity: DesktopManagedFeatureFlagIdentity
): Promise<DesktopManagedFeatureFlagOutcome> {
  const distinctIds = resolveDistinctIdsForIdentity(identity);
  let anyUnanswered = false;
  try {
    for (const distinctId of distinctIds) {
      const enabled = await evaluateServerFeatureFlagForDistinctId(
        flag,
        distinctId
      );
      if (enabled === true) {
        return DesktopManagedFeatureFlagOutcome.Enabled;
      }
      // `null` is PostHog saying NOTHING, not saying no (ISS-4556 — a real
      // outage resolves `null` rather than rejecting, so the catch below is the
      // rare path, not the common one). Folding it into `Disabled` would put
      // the outage back on the permanent-refusal arm this split exists to keep
      // it off.
      anyUnanswered ||= enabled === null;
    }
    return anyUnanswered
      ? DesktopManagedFeatureFlagOutcome.Faulted
      : DesktopManagedFeatureFlagOutcome.Disabled;
  } catch (error) {
    log.warn(
      "desktop_managed_pop_feature_flag_unavailable_defaulting_to_disabled",
      {
        flag: flag.key,
        error: parseError(error),
      }
    );
    return DesktopManagedFeatureFlagOutcome.Faulted;
  }
}

/**
 * {@link isDesktopManagedPopEnforcementEnabled} for a caller that must tell a
 * disabled rollout from an unreachable flag provider.
 */
export function evaluateDesktopManagedPopEnforcement(
  identity: DesktopManagedFeatureFlagIdentity
): Promise<DesktopManagedFeatureFlagOutcome> {
  return evaluateDesktopManagedFeatureFlag(
    DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG,
    identity
  );
}

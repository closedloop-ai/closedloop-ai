import {
  createPublicKey,
  type KeyObject,
  verify as verifySignature,
} from "node:crypto";
import { analytics } from "@repo/analytics/server";
import type { VerifiedApiKeyContextWithMetadata } from "@repo/api/src/types/api-key";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

export const DESKTOP_POP_GATEWAY_ID_HEADER = "X-Desktop-Gateway-Id";
export const DESKTOP_POP_TIMESTAMP_HEADER = "X-Desktop-Timestamp";
export const DESKTOP_POP_SIGNATURE_HEADER = "X-Desktop-Signature";

const POP_TIMESTAMP_FRESHNESS_SECONDS = 60;
const TIMESTAMP_SECONDS_PATTERN = /^\d+$/;
const BASE64URL_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

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

type DesktopManagedPopVerificationInput = {
  keyContext: VerifiedApiKeyContextWithMetadata;
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
  >
): Promise<DesktopManagedPopMode> {
  if (
    keyContext.source !== "DESKTOP_MANAGED" ||
    !(keyContext.boundPublicKey && keyContext.gatewayId)
  ) {
    return "monitor";
  }

  if (typeof analytics.isFeatureEnabled !== "function") {
    return "monitor";
  }

  try {
    const enabled = await analytics.isFeatureEnabled(
      "desktop-managed-pop-enforcement",
      keyContext.userId
    );
    return enabled === true ? "enforce" : "monitor";
  } catch (error) {
    log.warn(
      "desktop_managed_pop_feature_flag_unavailable_defaulting_to_monitor",
      {
        error: parseError(error),
      }
    );
    return "monitor";
  }
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

  if (keyContext.source !== "DESKTOP_MANAGED") {
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
    return logAndReturn(input, {
      accepted: true,
      enforceEligible: false,
      mode,
      reason: "verifier_unavailable",
    });
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

  let pathname: string;
  let signature: Buffer;
  try {
    pathname = new URL(request.url).pathname || "/";
    signature = Buffer.from(headers.signature, "base64url");
  } catch (error) {
    return logAndReturn(
      input,
      toDecision(mode, "verifier_unavailable", parseError(error))
    );
  }

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
): { message: string; status: 401 | 403 | 503 } | null {
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

function createEd25519PublicKey(pem: string): KeyObject | null {
  try {
    const key = createPublicKey(pem.trim());
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      return null;
    }
    return key;
  } catch {
    return null;
  }
}

function readDesktopPopHeaders(headers: Headers): {
  gatewayId: string | null;
  timestamp: string | null;
  signature: string | null;
} {
  return {
    gatewayId: normalizeHeaderValue(headers.get(DESKTOP_POP_GATEWAY_ID_HEADER)),
    timestamp: normalizeHeaderValue(headers.get(DESKTOP_POP_TIMESTAMP_HEADER)),
    signature: normalizeHeaderValue(headers.get(DESKTOP_POP_SIGNATURE_HEADER)),
  };
}

function normalizeHeaderValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

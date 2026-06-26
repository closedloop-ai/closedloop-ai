import {
  asRecord,
  extractApiErrorMessage,
  unwrapApiResultData,
} from "./api-response-utils.js";
import type {
  GatewaySigningKeyStore,
  GatewaySigningKeyUnavailableReason,
} from "./gateway-signing-key-store.js";

export type BootstrapClaimPayload = {
  onboardingAttemptId: string;
  webAppOrigin: string;
  gatewayId: string;
  gatewayPublicKeyPem: string;
};

export type BootstrapClaimDiagnostic = {
  reason: GatewaySigningKeyUnavailableReason;
  surface: "bootstrap_claim";
};

export type BootstrapClaimResult =
  | { kind: "claimed"; apiKey: string }
  | { kind: "manual_fallback"; reason: GatewaySigningKeyUnavailableReason }
  | {
      kind: "failed";
      statusCode?: number;
      code?: string;
      retryable?: boolean;
      error: string;
    };

/**
 * Returns whether a failed managed-key claim should be retried by Desktop.
 * An explicit contract `retryable` value from the server wins over status-code fallback.
 */
export function isRetryableBootstrapClaimFailure(
  result: BootstrapClaimResult
): boolean {
  if (result.kind !== "failed") {
    return false;
  }
  if (result.retryable !== undefined) {
    return result.retryable;
  }
  return result.statusCode === 502 || result.statusCode === 503;
}

export type ClaimDesktopManagedApiKeyOptions = {
  apiOrigin: string;
  onboardingAttemptId: string;
  webAppOrigin: string;
  gatewayId: string;
  signingKeys: Pick<GatewaySigningKeyStore, "getOrCreate">;
  bootstrapToken?: string;
  fetchImpl?: typeof fetch;
  onDiagnostic?: (diagnostic: BootstrapClaimDiagnostic) => void;
};

/**
 * Builds the exact Phase A bootstrap claim body required for Phase B-capable Desktop.
 */
export function buildBootstrapClaimPayload(
  input: BootstrapClaimPayload
): BootstrapClaimPayload {
  const payload = {
    onboardingAttemptId: input.onboardingAttemptId.trim(),
    webAppOrigin: input.webAppOrigin.trim(),
    gatewayId: input.gatewayId.trim(),
    gatewayPublicKeyPem: input.gatewayPublicKeyPem.trim(),
  };
  if (
    !(
      payload.onboardingAttemptId &&
      payload.webAppOrigin &&
      payload.gatewayId &&
      payload.gatewayPublicKeyPem
    )
  ) {
    throw new Error(
      "bootstrap claim requires onboardingAttemptId, webAppOrigin, gatewayId, and gatewayPublicKeyPem"
    );
  }
  return payload;
}

/**
 * Claims a Desktop-managed API key, or returns manual fallback before any network call if PoP is unavailable.
 */
export async function claimDesktopManagedApiKey(
  options: ClaimDesktopManagedApiKeyOptions
): Promise<BootstrapClaimResult> {
  const keyPair = options.signingKeys.getOrCreate(options.gatewayId);
  if (!keyPair.ok) {
    options.onDiagnostic?.({
      surface: "bootstrap_claim",
      reason: keyPair.reason,
    });
    return { kind: "manual_fallback", reason: keyPair.reason };
  }

  let payload: BootstrapClaimPayload;
  try {
    payload = buildBootstrapClaimPayload({
      onboardingAttemptId: options.onboardingAttemptId,
      webAppOrigin: options.webAppOrigin,
      gatewayId: options.gatewayId,
      gatewayPublicKeyPem: keyPair.keyPair.publicKeySpkiPem,
    });
  } catch (error) {
    return {
      kind: "failed",
      error:
        error instanceof Error
          ? error.message
          : "invalid bootstrap claim payload",
    };
  }

  const fetchFn = options.fetchImpl ?? fetch;
  let url: URL;
  try {
    url = new URL("/desktop/bootstrap/claim", options.apiOrigin);
  } catch {
    return {
      kind: "failed",
      error: "invalid apiOrigin",
    };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const bootstrapToken = options.bootstrapToken?.trim();
  if (bootstrapToken) {
    headers.Authorization = `Bearer ${bootstrapToken}`;
  }

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      kind: "failed",
      statusCode: 502,
      error: "bootstrap claim request failed",
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const contractError = extractDesktopContractError(body);
    return {
      kind: "failed",
      statusCode: response.status,
      ...(contractError.code ? { code: contractError.code } : {}),
      ...(contractError.retryable === undefined
        ? {}
        : { retryable: contractError.retryable }),
      error:
        extractApiErrorMessage(body) ??
        `bootstrap claim failed (${response.status})`,
    };
  }

  const apiKey = extractApiKey(body);
  if (!apiKey) {
    return {
      kind: "failed",
      statusCode: response.status,
      error: "bootstrap claim response missing apiKey",
    };
  }

  return { kind: "claimed", apiKey };
}

function extractDesktopContractError(body: unknown): {
  code?: string;
  retryable?: boolean;
} {
  const record = asRecord(body);
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.retryable === "boolean"
      ? { retryable: record.retryable }
      : {}),
  };
}

function extractApiKey(body: unknown): string | null {
  const payload = unwrapApiResultData(body);
  for (const key of ["apiKey", "cloudApiKey", "key"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

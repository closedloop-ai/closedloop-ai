import type { ApiKeyProvenance } from "./api-key-store.js";
import { unwrapApiResultData } from "./api-response-utils.js";
import {
  type DesktopPopSigner,
  LOCAL_AUTH_VERIFY_PATH,
} from "./desktop-pop.js";
import {
  buildManagedDesktopPopHeaders,
  type DesktopPopUnavailableReporter,
} from "./desktop-pop-sign-utils.js";

export type VerifyChallengeOptions = {
  challengeToken: string;
  requestOrigin: string;
  userAgent?: string;
  apiOrigin: string;
  apiKey: string;
  apiKeyProvenance?: ApiKeyProvenance;
  signDesktopRequest?: DesktopPopSigner;
  onDesktopPopUnavailable?: DesktopPopUnavailableReporter;
};

export type VerifyChallengeResult =
  | { ok: true; sessionTtlSeconds: number }
  | { ok: false; error: string; statusCode?: number };

const VERIFY_TIMEOUT_MS = 5000;

/** Verify a challenge token with the API server using the desktop API key. */
export async function verifyChallenge(
  options: VerifyChallengeOptions
): Promise<VerifyChallengeResult> {
  const url = `${options.apiOrigin}/compute-targets/local-auth/verify`;

  const body: Record<string, string> = {
    challengeToken: options.challengeToken,
    requestOrigin: options.requestOrigin,
  };
  if (options.userAgent) {
    body.userAgent = options.userAgent;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const headers = await buildVerifyHeaders(options);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.ok) {
      const payload = unwrapApiResultData(await response.json());
      if (
        payload.ok === true &&
        typeof payload.sessionTtlSeconds === "number"
      ) {
        return { ok: true, sessionTtlSeconds: payload.sessionTtlSeconds };
      }
      return {
        ok: false,
        error: "unexpected response format",
        statusCode: response.status,
      };
    }

    let errorMessage = `verify failed (${response.status})`;
    try {
      const errorData = (await response.json()) as { error?: string };
      if (errorData.error) {
        errorMessage = errorData.error;
      }
    } catch {
      // ignore parse errors
    }

    return { ok: false, error: errorMessage, statusCode: response.status };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "verify request timed out", statusCode: 504 };
    }
    const message = error instanceof Error ? error.message : "network error";
    return { ok: false, error: message, statusCode: 502 };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildVerifyHeaders(
  options: VerifyChallengeOptions
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.apiKey}`,
  };
  if (
    options.apiKeyProvenance !== "DESKTOP_MANAGED" ||
    !options.signDesktopRequest
  ) {
    return headers;
  }

  const popHeaders = await buildManagedDesktopPopHeaders({
    apiKeyProvenance: options.apiKeyProvenance,
    signDesktopRequest: options.signDesktopRequest,
    request: {
      method: "POST",
      pathname: LOCAL_AUTH_VERIFY_PATH,
    },
    surface: LOCAL_AUTH_VERIFY_PATH,
    unavailableMessage:
      "PoP signing unavailable for local-auth verification; continuing bearer-only compatibility mode",
    onUnavailable: options.onDesktopPopUnavailable,
  });
  if (popHeaders) {
    return { ...headers, ...popHeaders };
  }
  return headers;
}

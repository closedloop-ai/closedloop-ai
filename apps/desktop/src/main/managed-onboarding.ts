import { asRecord, extractApiErrorMessage } from "./api-response-utils.js";
import {
  normalizeAndValidateOrigin,
  normalizeWebAppOrigin,
} from "./origin-policy.js";

export const DESKTOP_ONBOARDING_PROTOCOL_VERSION = "1";

export type TrustedDesktopConfig = {
  apiOrigin: string;
  relayOrigin: string;
  onboardingProtocolVersion: string;
};

export type TrustedDesktopConfigResult =
  | { kind: "ok"; config: TrustedDesktopConfig }
  | {
      kind: "failed";
      reason: TrustedDesktopConfigFailureReason;
      statusCode?: number;
      retryable: boolean;
      error: string;
    };

export type TrustedDesktopConfigFailureReason =
  | "invalid_origin"
  | "request_failed"
  | "http_error"
  | "invalid_response"
  | "unsupported_protocol";

export type FetchTrustedDesktopConfigOptions = {
  webAppOrigin: string;
  fetchImpl?: typeof fetch;
};

export type SingleManagedOnboardingRetryOptions<T> = {
  operation: () => Promise<T>;
  shouldRetry: (result: T) => boolean;
  delayMs: number;
  sleep?: (delayMs: number) => Promise<void>;
  isCancelled?: () => boolean;
};

/**
 * Runs one retryable managed-onboarding operation while respecting shutdown.
 */
export async function withSingleManagedOnboardingRetry<T>(
  options: SingleManagedOnboardingRetryOptions<T>
): Promise<T> {
  const first = await options.operation();
  if (!options.shouldRetry(first)) {
    return first;
  }

  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }));
  await sleep(options.delayMs);

  if (options.isCancelled?.()) {
    return first;
  }

  return options.operation();
}

/**
 * Fetches and validates the trusted Desktop config from a user-confirmed web app origin.
 */
export async function fetchTrustedDesktopConfig(
  options: FetchTrustedDesktopConfigOptions
): Promise<TrustedDesktopConfigResult> {
  let webAppOrigin: string;
  let url: URL;
  try {
    webAppOrigin = normalizeWebAppOrigin(options.webAppOrigin);
    url = new URL("/.well-known/closedloop-desktop.json", webAppOrigin);
  } catch {
    return {
      kind: "failed",
      reason: "invalid_origin",
      retryable: false,
      error: "invalid webAppOrigin",
    };
  }

  const fetchFn = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return {
      kind: "failed",
      reason: "request_failed",
      statusCode: 502,
      retryable: true,
      error: "trusted config request failed",
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    return {
      kind: "failed",
      reason: "http_error",
      statusCode: response.status,
      retryable: response.status === 503,
      error:
        extractApiErrorMessage(body) ??
        `trusted config failed (${response.status})`,
    };
  }

  const parsed = parseTrustedDesktopConfig(body);
  if (!parsed.ok) {
    return {
      kind: "failed",
      reason: parsed.reason,
      statusCode: response.status,
      retryable: false,
      error:
        parsed.reason === "unsupported_protocol"
          ? "trusted config protocol is unsupported"
          : "trusted config response is invalid",
    };
  }

  return { kind: "ok", config: parsed.config };
}

/**
 * Validates the exact well-known response contract.
 */
export function parseTrustedDesktopConfig(
  body: unknown
):
  | { ok: true; config: TrustedDesktopConfig }
  | { ok: false; reason: "invalid_response" | "unsupported_protocol" } {
  const record = asRecord(body);
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "apiOrigin,onboardingProtocolVersion,relayOrigin") {
    return { ok: false, reason: "invalid_response" };
  }

  if (
    typeof record.apiOrigin !== "string" ||
    typeof record.relayOrigin !== "string" ||
    typeof record.onboardingProtocolVersion !== "string"
  ) {
    return { ok: false, reason: "invalid_response" };
  }

  if (
    record.onboardingProtocolVersion !== DESKTOP_ONBOARDING_PROTOCOL_VERSION
  ) {
    return { ok: false, reason: "unsupported_protocol" };
  }

  try {
    return {
      ok: true,
      config: {
        apiOrigin: normalizeAndValidateOrigin(record.apiOrigin),
        relayOrigin: normalizeAndValidateOrigin(record.relayOrigin),
        onboardingProtocolVersion: record.onboardingProtocolVersion,
      },
    };
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
}

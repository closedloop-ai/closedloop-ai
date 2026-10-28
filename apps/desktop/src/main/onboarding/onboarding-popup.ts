import { z } from "zod";
import {
  extractApiErrorMessage,
  isAbortTimeoutError,
  unwrapApiResultData,
} from "../util/api-response-utils.js";
import { desktopClientAttributionHeaders } from "../util/desktop-client-attribution-provider.js";

export const ONBOARDING_STATUS_PATH = "/onboarding";
export const ONBOARDING_WIZARD_PATH = "/onboarding";

/**
 * Wall-clock budget for the status GET, sized to match the sibling desktop API
 * client (`src/main/auth/managed-key-provision.ts`). Without it a wedged cloud API leaves the
 * promise pending forever: the `try`/`catch` below only covers a THROW, never a
 * HANG, so `resolveOnboardingPopupDecision`'s fail-open branch would be
 * unreachable in exactly the situation it was written for.
 */
const REQUEST_TIMEOUT_MS = 10_000;

const onboardingStatusSchema = z.object({
  wizardCompleted: z.boolean(),
});

export type OnboardingStatusFetchResult =
  | { kind: "ok"; wizardCompleted: boolean }
  | {
      kind: "failed";
      reason: OnboardingStatusFailureReason;
      statusCode?: number;
      error: string;
    };

export type OnboardingStatusFailureReason =
  | "request_failed"
  | "http_error"
  | "invalid_response";

export type FetchOnboardingStatusOptions = {
  apiOrigin: string;
  apiKey: string;
  /**
   * Overrides {@link REQUEST_TIMEOUT_MS}. Unlike `fetchJsonAndParse`'s
   * same-named option, omitting it does NOT leave the request unbounded — the
   * default applies, because a hang here silently swallows the reminder.
   */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Calls GET /onboarding on the cloud API and returns the desktop-relevant
 * `wizardCompleted` flag. Validates the response shape with Zod.
 *
 * The request is bounded by an `AbortSignal.timeout`, which also aborts the
 * response body read, so every outcome — including a hung API — settles as
 * either `ok` or `failed` rather than leaving the caller awaiting forever.
 */
export async function fetchOnboardingStatus(
  options: FetchOnboardingStatusOptions
): Promise<OnboardingStatusFetchResult> {
  const url = new URL(ONBOARDING_STATUS_PATH, options.apiOrigin);
  const fetchFn = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: "GET",
      headers: {
        ...desktopClientAttributionHeaders(),
        Accept: "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {
      kind: "failed",
      reason: "request_failed",
      error: "onboarding status request failed",
    };
  }

  let body: unknown = null;
  let bodyReadTimedOut = false;
  try {
    body = await response.json();
  } catch (error) {
    // The same signal aborts the RESPONSE BODY read, so a server that answers
    // headers and then stalls rejects here rather than in the fetch `catch`
    // above. Record it: otherwise a client-side timeout falls through to
    // `invalid_response` and blames the server for a body it never sent.
    bodyReadTimedOut = isAbortTimeoutError(error);
    body = null;
  }

  if (!response.ok) {
    return {
      kind: "failed",
      reason: "http_error",
      statusCode: response.status,
      error:
        extractApiErrorMessage(body) ??
        `onboarding status failed (${response.status})`,
    };
  }

  if (bodyReadTimedOut) {
    return {
      kind: "failed",
      reason: "request_failed",
      statusCode: response.status,
      error: "onboarding status request timed out",
    };
  }

  const parsed = onboardingStatusSchema.safeParse(unwrapApiResultData(body));
  if (!parsed.success) {
    return {
      kind: "failed",
      reason: "invalid_response",
      statusCode: response.status,
      error: "onboarding status response is invalid",
    };
  }

  return { kind: "ok", wizardCompleted: parsed.data.wizardCompleted };
}

export type OnboardingPopupDecision = "skip" | "suppress" | "show";

export type ResolveOnboardingPopupDecisionInput = {
  /** Has the user completed local desktop setup (onboarding + sandbox + API key)? */
  setupComplete: boolean;
  /** Persisted permanent-dismiss flag from SettingsStore. */
  dismissedPermanent: boolean;
  /**
   * Result of fetchOnboardingStatus. Omit when setup is incomplete or the user
   * has already permanently dismissed — the decision will short-circuit to "skip".
   */
  statusResult?: OnboardingStatusFetchResult;
};

/**
 * Pure decision function for what to do with the onboarding reminder popup on
 * launch. Fails open: when the status fetch fails, still show the reminder so
 * the user is nudged.
 */
export function resolveOnboardingPopupDecision(
  input: ResolveOnboardingPopupDecisionInput
): OnboardingPopupDecision {
  if (!input.setupComplete || input.dismissedPermanent) {
    return "skip";
  }
  if (input.statusResult?.kind === "ok" && input.statusResult.wizardCompleted) {
    return "suppress";
  }
  return "show";
}

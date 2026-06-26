import { z } from "zod";
import {
  extractApiErrorMessage,
  unwrapApiResultData,
} from "./api-response-utils.js";

export const ONBOARDING_STATUS_PATH = "/onboarding";
export const ONBOARDING_WIZARD_PATH = "/onboarding";

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
  fetchImpl?: typeof fetch;
};

/**
 * Calls GET /onboarding on the cloud API and returns the desktop-relevant
 * `wizardCompleted` flag. Validates the response shape with Zod.
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
        Accept: "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
    });
  } catch {
    return {
      kind: "failed",
      reason: "request_failed",
      error: "onboarding status request failed",
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
      error:
        extractApiErrorMessage(body) ??
        `onboarding status failed (${response.status})`,
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

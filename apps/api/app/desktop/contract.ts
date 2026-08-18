import { NextResponse } from "next/server";

export const DESKTOP_NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/** Exact success body returned by POST /desktop/onboarding-attempt. */
export type OnboardingAttemptResponse = {
  onboardingAttemptId: string;
  expiresAt: string;
};

/** Exact success body returned by POST /desktop/bootstrap/claim. */
export type BootstrapClaimResponse = {
  apiKey: string;
  source: "DESKTOP_MANAGED";
  gatewayId: string;
};

/**
 * PRD-532 §5.5 (PR-K / M8): exact success body returned by
 * POST /desktop/managed-key/provision. The session-authenticated provisioning
 * endpoint mints the same DESKTOP_MANAGED `sk_live_*` relay key as the
 * onboarding-attempt bootstrap claim, so it returns the identical wire
 * contract. Backend-only (never surfaced to a renderer or logged).
 */
export type DesktopManagedKeyProvisionResponse = BootstrapClaimResponse;

/** Exact non-2xx error body required by the desktop onboarding contract. */
export type DesktopContractErrorBody<TCode extends string = string> = {
  code: TCode;
  retryable: boolean;
};

/**
 * Returns an exact JSON error body for desktop onboarding/bootstrap routes.
 */
export function desktopContractError<TCode extends string>(
  status: number,
  code: TCode,
  retryable: boolean
): NextResponse<DesktopContractErrorBody<TCode>> {
  return NextResponse.json(
    { code, retryable },
    { status, headers: DESKTOP_NO_STORE_HEADERS }
  );
}

/**
 * Returns an exact JSON success body for desktop onboarding/bootstrap routes.
 */
export function desktopContractSuccess<TBody>(
  body: TBody,
  status = 200
): NextResponse<TBody> {
  return NextResponse.json(body, {
    status,
    headers: DESKTOP_NO_STORE_HEADERS,
  });
}

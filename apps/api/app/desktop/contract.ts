import { NextResponse } from "next/server";

export const DESKTOP_NO_STORE_HEADERS = { "Cache-Control": "no-store" };

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

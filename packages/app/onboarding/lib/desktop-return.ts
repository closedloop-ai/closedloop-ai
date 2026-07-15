import type { DesktopDeviceSessionDetails } from "../types";

/**
 * Custom protocol the desktop app registers to receive the browser→desktop
 * completion signal. The scheme handler is desktop-side work; the web app only
 * builds the URL and attempts a best-effort hand-off.
 */
export const DESKTOP_RETURN_PROTOCOL = "closedloop-desktop:";
const DESKTOP_RETURN_COMPLETION_PATH = "//onboarding/complete";

/**
 * Build the browser→desktop return URL after approval (FEA-2218 / PLN-843
 * §System browser return).
 *
 * SECURITY: the return channel carries ONLY a non-secret completion signal —
 * the user-facing verification code (already displayed to the user and useless
 * without the desktop-held device-session secret + device key) and the session
 * status. A custom-protocol link can be hijacked by another local app
 * registering the same scheme, so it must never carry refresh tokens, exchange
 * tokens, authorization codes, verifiers, or device-session secrets. The
 * desktop completes credential exchange out-of-band via its locally held secret
 * and bound device key (and polling remains the guaranteed fallback). This
 * function reads only `userCode` and `status` from the non-secret detail, so no
 * secret field can leak even if the detail shape grows.
 */
export function buildDesktopReturnUrl(
  detail: Pick<DesktopDeviceSessionDetails, "userCode" | "status">
): string {
  const params = new URLSearchParams({
    code: detail.userCode,
    status: detail.status,
  });
  return `${DESKTOP_RETURN_PROTOCOL}${DESKTOP_RETURN_COMPLETION_PATH}?${params.toString()}`;
}

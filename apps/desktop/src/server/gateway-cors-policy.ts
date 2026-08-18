import { ADDITIONAL_TRUSTED_WEB_APP_ORIGINS } from "../shared/contracts.js";
import { isLoopbackIPv4 } from "../shared/network-utils.js";

/**
 * CORS origin-allow policy for the desktop gateway, extracted from `router.ts`
 * so the origin allowlist and matching logic live in one focused, testable
 * module instead of growing the grandfathered router.
 *
 * The gateway trusts, in order:
 *  1. the configured (prod) `webAppOrigin`;
 *  2. the first-party additional origins (stage/preview) in
 *     `ADDITIONAL_TRUSTED_WEB_APP_ORIGINS`, allowed even under
 *     prod-origins-only since they are known first-party origins;
 *  3. loopback origins, unless `prodOriginsOnly` is set.
 */

export type GatewayOriginPolicy = {
  webAppOrigin: string;
  prodOriginsOnly: boolean;
};

/** Two origins are equal when their URL `origin` components match exactly. */
export function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** A loopback browser origin (localhost / 127.0.0.0-8 / ::1 / *.localhost). */
export function isLoopbackOrigin(originValue: string): boolean {
  try {
    const parsed = new URL(originValue);
    const h = parsed.hostname;
    return (
      h === "localhost" ||
      h === "::1" ||
      h === "[::1]" ||
      isLoopbackIPv4(h) ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Whether a browser `Origin` header is allowed by the gateway CORS policy.
 * A missing origin is allowed (non-browser / same-origin); the literal string
 * `"null"` (opaque origin) is rejected.
 */
export function isOriginAllowed(
  origin: string | null | undefined,
  policy: GatewayOriginPolicy
): boolean {
  if (!origin) {
    return true;
  }
  if (origin === "null") {
    return false;
  }
  if (sameOrigin(origin, policy.webAppOrigin)) {
    return true;
  }
  if (
    ADDITIONAL_TRUSTED_WEB_APP_ORIGINS.some((trusted) =>
      sameOrigin(origin, trusted)
    )
  ) {
    return true;
  }
  if (policy.prodOriginsOnly) {
    return false;
  }
  return isLoopbackOrigin(origin);
}

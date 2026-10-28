import { isLocalTrustedAuthActive } from "@repo/auth/auth-mode";

/**
 * ISS-10078: the request header that asks `app/layout.tsx` to throw, so a
 * browser can reach the error-recovery document `app/global-error.tsx` renders
 * into, under the enforcing CSP `proxy.ts` then applies to the same request.
 * Read by `e2e/global-error-csp-nonce.local-trusted.spec.ts`.
 */
export const ROOT_LAYOUT_FAILURE_VALIDATION_HEADER =
  "x-root-layout-failure-validation";

export const ROOT_LAYOUT_FAILURE_VALIDATION_HEADER_VALUE = "1";

/**
 * True only on the containerized e2e host. Two independent locks, and the
 * header counts for nothing without both:
 * - `ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED`, server-only and set in exactly
 *   one place, the `app-visual` compose service;
 * - the `local_trusted` auth guard, which is false wherever `AUTH_MODE` is
 *   unset and THROWS under `NODE_ENV=production` or a Vercel
 *   `production`/`preview` deploy, so no Vercel deployment can pass it.
 *
 * The gate is checked first so a deployment that never sets it evaluates
 * nothing else.
 */
export function isRootLayoutFailureValidationRequest(
  gate: string | undefined,
  requestHeaders: Pick<Headers, "get">
): boolean {
  return (
    gate === "true" &&
    requestHeaders.get(ROOT_LAYOUT_FAILURE_VALIDATION_HEADER) ===
      ROOT_LAYOUT_FAILURE_VALIDATION_HEADER_VALUE &&
    isLocalTrustedAuthActive()
  );
}

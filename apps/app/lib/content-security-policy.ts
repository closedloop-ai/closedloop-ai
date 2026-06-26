/**
 * Whether the (report-only) Content-Security-Policy should be attached by the
 * middleware for the current deployment.
 *
 * Enabled only when CSP_ENABLED === "true" AND the deployment is not a Vercel
 * preview. Report-only CSP on ephemeral preview / e2e deployments yields no
 * actionable signal but floods Datadog RUM with `csp_violation` errors that
 * bury real prod signal (FEA-1466): the preview API host is derived per
 * deployment and the e2e harness drives the app against hosts that never match
 * the build-time `connect-src` allowlist. Real prod and stage (both Vercel
 * `production` targets, VERCEL_ENV !== "preview") retain the policy.
 */
export function shouldEnableContentSecurityPolicy(
  cspEnabled: string | undefined,
  vercelEnv: string | undefined
): boolean {
  return cspEnabled === "true" && vercelEnv !== "preview";
}

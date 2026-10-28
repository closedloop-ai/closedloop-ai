/**
 * The machine-readable `reason` a gateway 401 carries.
 *
 * `GatewayRouter.isAuthorizedGatewayRequest` returns a distinct reason per
 * rejection branch, and the router puts that same value on the wire
 * (`{ error: "unauthorized", reason }`) and on the security activity event's
 * `activityDetail`. The reason — not the 401 — is what tells one rejection
 * cause from another.
 *
 * These values are a cross-process contract with already-installed browser and
 * relay clients: add a member, never re-word an existing one.
 */
export const AuthReason = {
  OriginNotAllowed: "origin not allowed in prod-origins-only mode",
  SessionTokenWithoutOrigin: "session token present but Origin header missing",
  SessionStoreMissing: "session store not configured",
  SessionTokenInvalid: "invalid or expired session token, or origin mismatch",
  NoCredential: "no credential provided",
  BrowserSessionRequired: "session token required for browser requests",
} as const;

export type AuthReason = (typeof AuthReason)[keyof typeof AuthReason];

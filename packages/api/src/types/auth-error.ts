/**
 * Codes carried on authentication-layer error responses so a client can tell a
 * SESSION failure apart from a RESOURCE failure when both arrive as HTTP 403.
 *
 * ISS-5095. The web shell's re-auth surface latches on 401 and no longer on a
 * bare 403, because a 403 from an ordinary read means "this resource is not
 * yours", not "your session is dead" — laundering the former into the latter
 * blanked the whole workspace with a false "Your session expired". But the auth
 * wrapper itself also answers 403, from `resolveOrgHeader`, and THAT one is
 * session-level: the request named an organization this caller is not a member
 * of (an org-switch race, or a membership revoked mid-session). Every
 * authenticated request carries the org header, so that condition fails every
 * query at once and re-authenticating is the only way out.
 *
 * (As originally shipped, that 403 also covered a Clerk lookup that failed
 * outright. It no longer does — see the ISS-5118 paragraph below, which is what
 * split that case off. The list above is current, not historical.)
 *
 * Keying that case on a code rather than on the status is what lets both
 * statements be true at the same time. The code is additive and optional on the
 * wire: a client that does not know it simply sees a 403 as before.
 *
 * ISS-5118 then split that 403 in two, because `resolveOrgHeader` was answering
 * it for two different questions. "You are not a member of that organization" is
 * an AUTHORIZATION answer — the lookup succeeded and said no. "We could not
 * reach Clerk to ask" is an AVAILABILITY failure — nobody decided anything. They
 * had the same code, so an outage read as a spike in legitimate denials, and the
 * user was told to re-authenticate for a condition re-authenticating cannot fix.
 * The availability case is now {@link AuthErrorCode.OrgUnverifiable}, delivered
 * as a retryable 503 rather than a 403.
 */
export const AuthErrorCode = {
  /**
   * The caller is not a member of the requested organization. A session-level
   * authorization DECISION, not a per-resource one — clients may treat it like a
   * 401 for re-auth purposes.
   */
  OrgForbidden: "org_forbidden",
  /**
   * The requested organization could not be verified because the identity
   * provider lookup failed (ISS-5118). An AVAILABILITY failure, not an
   * authorization decision: nothing about the caller's access is known, so the
   * honest answer is "we could not check", never "you do not have access" and
   * never "sign in again".
   *
   * Carried on a 503 because the condition is transient and the request is safe
   * to repeat. Note that the shared query client does not currently auto-retry
   * any response-backed error, 5xx included, so this classification makes the
   * server truthful — wiring an actual retry affordance is a follow-up.
   */
  OrgUnverifiable: "org_unverifiable",
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/**
 * The API-response `error` string for {@link AuthErrorCode.OrgUnverifiable},
 * canonical here so the server cannot drift into telling the user to
 * re-authenticate for a provider outage.
 *
 * Scope note: this is the wire copy. It is NOT what the shared client toast
 * renders — `resolveFriendlyError` only templates codes in the `LoopErrorCode`
 * vocabulary, and `org_unverifiable` is not one, so a client using that path
 * shows its generic failure copy and carries this string in the technical
 * details. Adding a friendly template is a follow-up, not something this
 * constant delivers on its own.
 */
export const ORG_UNVERIFIABLE_MESSAGE =
  "Couldn't verify your organization. Try again.";

/**
 * Which codes mark a SESSION failure the user recovers from by re-authenticating.
 *
 * Exhaustive by construction: `Record<AuthErrorCode, boolean>` means a newly
 * added code fails typecheck until it is deliberately classified, rather than
 * defaulting into "not a session failure" and silently losing the re-auth
 * affordance (or, worse, inheriting one it should not have).
 */
const SESSION_AUTH_ERROR_CODES: Record<AuthErrorCode, boolean> = {
  [AuthErrorCode.OrgForbidden]: true,
  // An outage is not a dead session. Re-authenticating cannot fix it, so this
  // must NOT latch the re-auth surface.
  [AuthErrorCode.OrgUnverifiable]: false,
};

const SESSION_AUTH_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  Object.entries(SESSION_AUTH_ERROR_CODES)
    .filter(([, isSessionFailure]) => isSessionFailure)
    .map(([code]) => code)
);

/** True when `code` marks a session-level auth failure delivered as a 403. */
export function isSessionAuthErrorCode(code: string | undefined): boolean {
  return code !== undefined && SESSION_AUTH_ERROR_CODE_SET.has(code);
}

const AUTH_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  Object.keys(SESSION_AUTH_ERROR_CODES)
);

/**
 * True when `code` is any known {@link AuthErrorCode} — i.e. the server
 * explicitly tagged this response at the auth layer.
 *
 * Deliberately broader than {@link isSessionAuthErrorCode}, which answers the
 * narrower "is re-authenticating the fix". A client needs both questions
 * separately: EVERY tagged code is a statement about the request's identity
 * rather than about the resource, so every one of them belongs to the shell —
 * but only some of them are fixed by signing in again. Derived from the
 * exhaustive `Record` above so a new code joins this set automatically.
 */
export function isAuthErrorCode(
  code: string | undefined
): code is AuthErrorCode {
  return code !== undefined && AUTH_ERROR_CODE_SET.has(code);
}

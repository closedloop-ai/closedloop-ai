/**
 * The bound on the signed-out bounce between a protected URL and the auth
 * entry page (`apps/app/proxy.ts`).
 *
 * ISS-11429. A browser that holds a Clerk session cookie the SERVER refuses
 * bounces forever, and both halves of the bounce are individually correct:
 *
 *  - `(authenticated)/layout.tsx` reads no `userId`, so it calls
 *    `redirectToSignUp()`, which sends the visitor to
 *    `/sign-up?redirect_url=<the protected URL>`;
 *  - Clerk's `<SignUp>` embed sees the session the CLIENT still believes in,
 *    renders no form, and navigates straight to that `redirect_url`.
 *
 * Neither side counts the round trips, so the cycle has no ceiling. Measured on
 * the prod host over 14 days (Datadog RUM, paged `/api/v2/rum/events/search`):
 * one session logged 316 `/sign-up` views, 314 of them `route_change` views
 * whose own referrer was `/sign-up?redirect_url=https://app.closedloop.ai/
 * closedloop-ai/issues/ISS-10754` — the page referring itself, at soft-
 * navigation speed, with no signed-in user id on any of them.
 *
 * This module is the counter, and it lives in a leaf — like
 * `app-route-redirects.ts` — so the decision is unit-testable without
 * standing up the Clerk middleware chain. It decides only; the proxy builds the
 * response.
 *
 * NARROW ON PURPOSE. The guard is armed only for a request that is already in
 * the pathological state: an auth entry path, carrying a return URL, from a
 * browser that presents a Clerk session cookie while the server reports nobody
 * signed in. A healthy multi-step sign-up never satisfies that conjunction — it
 * has no session cookie before completion and a resolvable `userId` after — so
 * the ceiling cannot fire part-way through somebody's real sign-up and clear
 * the credentials they were about to use. Counting bounces by VOLUME alone
 * would do exactly that, which is a worse defect than the loop.
 */

/** The `redirect_url` Clerk both sets and consumes on the auth entry pages. */
export const AUTH_RETURN_PARAM = "redirect_url";

/**
 * The bounce counter. Short-lived by design: the loop runs at soft-navigation
 * speed, so a window of two minutes is several hundred iterations, while a
 * visitor who simply returns to sign up later starts from zero rather than
 * inheriting a stale count.
 */
export const AUTH_BOUNCE_COOKIE = "cl_auth_bounce";
export const AUTH_BOUNCE_COOKIE_MAX_AGE_SECONDS = 120;

/**
 * Bounces tolerated before the guard intervenes. Above one so a single
 * legitimate re-entry (a session that genuinely refreshes on the second try) is
 * not treated as a loop, and low enough that the user waits milliseconds rather
 * than watching 300 navigations.
 */
export const AUTH_BOUNCE_CEILING = 3;

/**
 * Cookie-name prefixes Clerk uses for the session material a browser presents.
 * Matched by PREFIX because the deployed instance suffixes them
 * (`__session_<instance>`, `__client_uat_<instance>`), so an exact-name list
 * would silently clear nothing in production — the one environment this guard
 * exists for.
 */
const CLERK_SESSION_COOKIE_PREFIXES: readonly string[] = [
  "__session",
  "__client_uat",
  "__clerk",
  "__refresh",
];

/**
 * The prefix whose VALUE says whether the browser claims a session, and the
 * value Clerk writes when it claims none.
 *
 * Presence alone is not the signal, and reading it that way was a real defect
 * rather than a theoretical one: clerk-js writes `__client_uat=0` for every
 * SIGNED-OUT browser that has merely loaded it, and development instances write
 * `__clerk_db_jwt` from the first page load. Gating on names alone therefore
 * made "presents a Clerk cookie while the server reports nobody signed in" the
 * ORDINARY signed-out state rather than a pathological one — so an ordinary
 * visitor working through a multi-step sign-up could cross the ceiling and have
 * the credentials they were mid-way through establishing deleted underneath
 * them. That is a worse defect than the loop, which is the whole reason this
 * module refuses to count by volume.
 */
const CLERK_SIGNED_IN_CLAIM_PREFIX = "__client_uat";
const CLERK_SIGNED_OUT_CLAIM_VALUE = "0";

/** Auth entry paths Clerk's signed-out redirects target. */
const AUTH_ENTRY_PATHS: readonly string[] = ["/sign-up", "/sign-in"];

export const AuthBounceAction = {
  /** Still under the ceiling: record this bounce and let the request proceed. */
  Count: "count",
  /** Over the ceiling: stop bouncing and land on a terminal auth page. */
  Break: "break",
} as const;
export type AuthBounceAction =
  (typeof AuthBounceAction)[keyof typeof AuthBounceAction];

export type AuthBounceRequest = {
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  /** Raw `AUTH_BOUNCE_COOKIE` value, or undefined on a first bounce. */
  readonly bounceCookieValue: string | undefined;
  /**
   * Every cookie the request presented. VALUES are carried, not just names:
   * whether the browser claims a session is a property of the value.
   */
  readonly cookies: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  /** Whether `auth()` resolved a user for this request. */
  readonly isSignedIn: boolean;
};

export type AuthBounceDecision =
  | { readonly action: typeof AuthBounceAction.Count; readonly count: number }
  | {
      readonly action: typeof AuthBounceAction.Break;
      /**
       * The refused session cookies to clear, alongside stripping the return
       * URL — which alone terminates nothing, because the embed falls back to
       * its own default destination and the cycle resumes.
       *
       * HOW FAR THE CLEARING REACHES DEPENDS ON THE INSTANCE, and on a
       * PRODUCTION one it is a bound rather than an end (raised in review). The
       * state clerk-js rebuilds from there is the httpOnly `__client` cookie on
       * the FAPI host (`clerk.closedloop.ai`), set host-only, which no response
       * from `app.closedloop.ai` can expire — `__session` and `__client_uat` are
       * only what clerk-js writes back to the app domain after asking FAPI. So
       * the next `/sign-up` is served the same session again and the cycle
       * resumes with the counter reset: the loop is broken every
       * `AUTH_BOUNCE_CEILING` hops onto a real form instead of running
       * unbounded, which is what the measured 316-view session needed, and is
       * strictly less than ending the session. On a DEVELOPMENT instance
       * `__clerk_db_jwt` lives on the app domain and the clearing is terminal,
       * which is why it reads as sufficient locally. Ending the session for real
       * means revoking the `sid` through the Backend API or a client
       * `signOut()`; both are larger decisions than this guard, and neither is
       * implemented here.
       */
      readonly staleSessionCookieNames: readonly string[];
    };

/**
 * Whether this request is even shaped like a bounce: an auth entry path
 * carrying a return URL.
 *
 * Exported so the proxy's lazy-`auth()` gate asks THIS question rather than
 * restating the path rule. A second copy of it in the proxy would let the two
 * disagree — a new auth entry path added here would keep paying for `auth()`
 * nowhere, and the guard would go quietly inert on it.
 */
export function isAuthBounceCandidate(
  pathname: string,
  searchParams: URLSearchParams
): boolean {
  return isAuthEntryPath(pathname) && searchParams.has(AUTH_RETURN_PARAM);
}

/**
 * The bounce decision for one request, or `null` when this request is not part
 * of a bounce at all (which is almost every request).
 */
export function resolveAuthBounce(
  request: AuthBounceRequest
): AuthBounceDecision | null {
  if (!isAuthBounceCandidate(request.pathname, request.searchParams)) {
    return null;
  }
  // Signed in, or presenting nothing to be refused: not the pathological state.
  if (request.isSignedIn) {
    return null;
  }
  // The browser must actively CLAIM a session the server just refused. A
  // signed-out browser carrying Clerk's own signed-out marker is not in the
  // pathological state and must never reach the ceiling.
  if (!claimsSignedIn(request.cookies)) {
    return null;
  }
  const staleSessionCookieNames = selectClerkSessionCookieNames(
    request.cookies.map(({ name }) => name)
  );
  if (staleSessionCookieNames.length === 0) {
    return null;
  }

  const count = parseBounceCount(request.bounceCookieValue) + 1;
  if (count > AUTH_BOUNCE_CEILING) {
    return { action: AuthBounceAction.Break, staleSessionCookieNames };
  }
  return { action: AuthBounceAction.Count, count };
}

/**
 * The terminal URL for a broken bounce: the same auth entry page with the
 * return URL removed, so nothing on it names a destination that re-enters the
 * redirect.
 */
export function buildAuthBounceBreakUrl(url: URL): URL {
  const target = new URL(url.toString());
  target.searchParams.delete(AUTH_RETURN_PARAM);
  return target;
}

function isAuthEntryPath(pathname: string): boolean {
  return AUTH_ENTRY_PATHS.some(
    (entry) => pathname === entry || pathname.startsWith(`${entry}/`)
  );
}

/**
 * Whether the browser presents a Clerk cookie asserting an ACTIVE session.
 *
 * `__client_uat` is the authority when present, because it is the one Clerk
 * writes for signed-out browsers too and its value is the discriminator. With
 * no `__client_uat` at all, a non-empty `__session` is the claim.
 */
function claimsSignedIn(
  cookies: readonly { readonly name: string; readonly value: string }[]
): boolean {
  const signedInClaim = cookies.find(({ name }) =>
    name.startsWith(CLERK_SIGNED_IN_CLAIM_PREFIX)
  );
  if (signedInClaim) {
    return (
      signedInClaim.value !== "" &&
      signedInClaim.value !== CLERK_SIGNED_OUT_CLAIM_VALUE
    );
  }
  return cookies.some(
    ({ name, value }) => name.startsWith("__session") && value !== ""
  );
}

function selectClerkSessionCookieNames(
  cookieNames: readonly string[]
): readonly string[] {
  return cookieNames.filter((name) =>
    CLERK_SESSION_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * The counter carried by the cookie, clamped into `[0, AUTH_BOUNCE_CEILING]`.
 *
 * The value is browser-supplied, so every impossible spelling for a count is
 * reachable here and none of them may become a measurement: a negative, a
 * fraction, a magnitude past the safe-integer range, a blank string that
 * `Number("")` would read as a confident `0`, and anything non-numeric. All of
 * them read as "no bounce recorded" rather than being coerced into a number
 * this module then reasons about. That direction is deliberate and cannot be
 * turned against anyone: the cookie is per-browser, so the worst a forged value
 * buys its own sender is today's unguarded behavior.
 */
function parseBounceCount(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(AUTH_BOUNCE_CEILING, parsed);
}

/**
 * Every `Set-Cookie` deletion the break must emit for one refused cookie name.
 *
 * `ResponseCookies.delete(name)` sends a host-only, default-path expiry, and in
 * production that removes NOTHING: Clerk sets `__session` and `__client_uat` on
 * the eTLD+1 (`Domain=.closedloop.ai`) so they are shared with subdomains, and
 * a host-only expiry beside a `Domain`-scoped cookie merely adds a second empty
 * one the browser sends alongside the original. The default PATH is the other
 * half — a break served on `/sign-up/sso-callback` defaults to that path, which
 * never matches a cookie stored at `/`.
 *
 * So both variants are emitted, each explicitly at `path: "/"`. A host with no
 * parent label (`localhost`) yields the host-only deletion alone.
 *
 * They must reach the response as APPENDED `Set-Cookie` headers
 * ({@link serializeCookieDeletion}), not through `response.cookies`: that map is
 * keyed by name alone, so writing one name twice keeps only the last scope and
 * silently drops the other half of the pair.
 */
export function buildStaleSessionCookieDeletions(
  names: readonly string[],
  host: string
): readonly {
  readonly name: string;
  readonly path: string;
  readonly domain?: string;
}[] {
  const parentDomain = resolveParentDomain(host);
  return names.flatMap((name) => {
    const hostOnly = { name, path: "/" };
    if (!parentDomain) {
      return [hostOnly];
    }
    return [hostOnly, { domain: `.${parentDomain}`, name, path: "/" }];
  });
}

/**
 * The registrable parent of a host, or `null` when it has none to speak of.
 *
 * Dropping the leading label is the whole rule, which is right for the hosts
 * this app answers on (`app.closedloop.ai` → `closedloop.ai`) and deliberately
 * conservative elsewhere: a bare hostname, an IP literal, or a two-label host
 * yields `null` and only the host-only deletion is emitted. A wrong guess here
 * would emit a `Domain` the browser rejects, which costs the deletion; it can
 * never widen one, because a browser refuses a `Domain` it is not a subdomain
 * of.
 */
function resolveParentDomain(host: string): string | null {
  const hostname = host.split(":")[0] ?? "";
  const labels = hostname.split(".");
  if (labels.length < 3) {
    return null;
  }
  return labels.slice(1).join(".");
}

/**
 * One deletion as a `Set-Cookie` value.
 *
 * Both `Expires` in the past and `Max-Age=0` are emitted: `Max-Age` wins where
 * it is honoured, and `Expires` covers the rest. `HttpOnly`/`Secure` are
 * deliberately absent — neither participates in the (name, domain, path) match
 * that decides which stored cookie a deletion removes, and asserting `Secure`
 * would make the deletion fail over plain HTTP.
 */
export function serializeCookieDeletion(deletion: {
  readonly name: string;
  readonly path: string;
  readonly domain?: string;
}): string {
  const attributes = [
    `${deletion.name}=`,
    `Path=${deletion.path}`,
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0",
  ];
  if (deletion.domain) {
    attributes.splice(2, 0, `Domain=${deletion.domain}`);
  }
  return attributes.join("; ");
}

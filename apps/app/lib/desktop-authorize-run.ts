import { fromBase64Url, toBase64Url } from "@repo/api/src/types/base64url";
import {
  DESKTOP_AUTHORIZE_PATHNAME,
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  DESKTOP_AUTHORIZE_RUN_COOKIE,
  DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS,
  DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS,
  parseDesktopSignInMethod,
  providerForSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import { parseDesktopAuthorizeParams } from "@repo/app/onboarding/lib/desktop-authorize-params";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isDesktopAuthorizeRunPathname } from "./desktop-org-return";
import { SIGN_IN_PATHNAME } from "./github-connect-redirect";

/**
 * The pending desktop authorize run, carried in a cookie across the Clerk round
 * trip (ISS-11396 / PLN-2118).
 *
 * The desktop opens the authorize URL in the system browser and waits on its
 * loopback listener. The proxy writes the run here on a visit to the authorize
 * page and bounces a signed-in page request back to it while the run is
 * pending, so no web hop (onboarding completion, a mid-onboarding GitHub
 * connect) has to carry the authorize query string for the desktop to resume.
 *
 * Only the desktop's own open (`Sec-Fetch-Site: none`), a same-origin
 * navigation, or a browser that sends no `Sec-Fetch-Site` arms a run; a
 * cross-site or same-site navigation to the authorize page never creates or
 * replaces one, so a link on another site cannot plant a run that later
 * bounces the user.
 *
 * The run is bound to the first signed-in user who reaches it, and only that
 * user is ever bounced to it; no other user takes it over. Handing back to the
 * desktop consumes it: the run stays in the cookie marked `consumed` until its
 * original ceiling, so a revisit of the same authorize URL (Back, refresh)
 * cannot re-arm it, while a new `state` is a new run.
 *
 * The cookie is an input to an auth boundary and is validated on every read,
 * never trusted: its shape, its age against the desktop's own callback ceiling,
 * the loopback-only `redirect_uri` inside it, and that its `state` is the one
 * its own query carries. `POST /desktop/authorize` stays the authoritative
 * validator of everything that gates the mint.
 *
 * Leaf module, like `github-connect-redirect.ts`: the proxy calls these and does
 * nothing else, so every decision is unit-testable without the Clerk middleware.
 */

const DESKTOP_AUTHORIZE_RUN_COOKIE_VERSION = 1;

const desktopAuthorizeRunSchema = z
  .object({
    v: z.literal(DESKTOP_AUTHORIZE_RUN_COOKIE_VERSION),
    query: z.string(),
    state: z.string(),
    issuedAt: z.number().int().refine(Number.isSafeInteger),
    userId: z.string().min(1).optional(),
    consumed: z.literal(true).optional(),
  })
  .strict();

export type DesktopAuthorizeRun = z.infer<typeof desktopAuthorizeRunSchema>;

export type DesktopAuthorizeRunCookieUpdate =
  | { kind: "set"; value: string; maxAgeSeconds: number }
  | { kind: "clear" };

/** The pending run a request carries, and what its response does to the cookie. */
export type DesktopAuthorizeRunResolution = {
  run: DesktopAuthorizeRun | null;
  update: DesktopAuthorizeRunCookieUpdate | null;
};

/** The auth fields the bounce decision reads, as the proxy's `auth()` returns them. */
export type DesktopAuthorizeRunAuthState = {
  userId: string | null;
  orgSlug?: string | null;
};

type SearchParamValue = string | string[] | undefined;

/**
 * The desktop's callback ceiling for the run's sign-in method: the cookie must
 * not outlive the listener it resumes. An OAuth method gets the OAuth ceiling;
 * email, and an unknown or absent method, get the longer email one.
 */
export function desktopAuthorizeRunMaxAgeMs(query: string): number {
  const method = parseDesktopSignInMethod(
    new URLSearchParams(query).get(DESKTOP_AUTHORIZE_QUERY_PARAMS.provider)
  );
  return method && providerForSignInMethod(method)
    ? DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS
    : DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS;
}

/**
 * A new run for an authorize-page `search` string, or `null` when the query
 * does not parse as a desktop authorize request (the page's own error card
 * handles that) or cannot be serialized.
 */
export function createDesktopAuthorizeRun(
  query: string,
  now: number
): DesktopAuthorizeRun | null {
  const state = parseRunQueryState(query);
  if (state === null) {
    return null;
  }
  const run: DesktopAuthorizeRun = {
    v: DESKTOP_AUTHORIZE_RUN_COOKIE_VERSION,
    query,
    state,
    issuedAt: now,
  };
  return encodeDesktopAuthorizeRunCookie(run) === null ? null : run;
}

/**
 * base64url JSON, or `null` when the run holds a character outside the Latin1
 * range `btoa` accepts — a hostile `state` must cost the run, not the request.
 */
export function encodeDesktopAuthorizeRunCookie(
  run: DesktopAuthorizeRun
): string | null {
  try {
    return toBase64Url(JSON.stringify(run));
  } catch {
    return null;
  }
}

/**
 * The valid pending run a cookie value carries at `now`, or `null`. Every
 * failure — malformed, an unknown or extra key, issued in the future or past the
 * run's ceiling, a query that no longer parses (including a non-loopback
 * `redirect_uri`), or a `state` its own query does not carry — means no run.
 */
export function parseDesktopAuthorizeRunCookie(
  value: string | undefined,
  now: number
): DesktopAuthorizeRun | null {
  if (!value) {
    return null;
  }
  const json = fromBase64Url(value);
  if (json === null) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = desktopAuthorizeRunSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const run = parsed.data;
  const age = now - run.issuedAt;
  if (age < 0 || age > desktopAuthorizeRunMaxAgeMs(run.query)) {
    return null;
  }
  if (parseRunQueryState(run.query) !== run.state) {
    return null;
  }
  return run;
}

/**
 * The run the cookie should hold after a visit to the authorize page with
 * `query`, or `null` when the query is not a desktop authorize request.
 *
 * `issuedAt` is written ONCE per run: a re-visit whose `state` matches the
 * existing valid run keeps it whole — consumed or not, so Back or refresh after
 * the hand-back cannot re-arm it. The post-sign-up bounce back to this page
 * would otherwise move `issuedAt` past the new account's `createdAt` and report
 * every sign-up as a sign-in (ISS-11395). A different `state` is a new run and
 * replaces it.
 */
export function nextDesktopAuthorizeRunCookie(
  existing: DesktopAuthorizeRun | null,
  query: string,
  now: number
): DesktopAuthorizeRun | null {
  const candidate = createDesktopAuthorizeRun(query, now);
  if (candidate === null) {
    return null;
  }
  if (existing !== null && existing.state === candidate.state) {
    return existing;
  }
  return candidate;
}

/**
 * The pending run for this request, and what the response must do to the
 * cookie: write it on an arming GET to the authorize page (either spelling)
 * whose query parses, clear a cookie that is present but invalid, and otherwise
 * leave it.
 */
export function resolveDesktopAuthorizeRunCookie(
  request: NextRequest,
  now: number
): DesktopAuthorizeRunResolution {
  const rawCookie = request.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)?.value;
  const existing = parseDesktopAuthorizeRunCookie(rawCookie, now);

  if (
    isDesktopAuthorizeRunPageRequest(request) &&
    mayArmDesktopAuthorizeRun(request)
  ) {
    const next = nextDesktopAuthorizeRunCookie(
      existing,
      request.nextUrl.search,
      now
    );
    const value =
      next !== null && next !== existing
        ? encodeDesktopAuthorizeRunCookie(next)
        : null;
    if (next !== null && value !== null) {
      return {
        run: next,
        update: {
          kind: "set",
          value,
          maxAgeSeconds: Math.ceil(
            desktopAuthorizeRunMaxAgeMs(next.query) / 1000
          ),
        },
      };
    }
    if (next !== null) {
      return { run: next, update: null };
    }
  }

  if (rawCookie !== undefined && existing === null) {
    return { run: null, update: { kind: "clear" } };
  }
  return { run: existing, update: null };
}

/**
 * Options mirror the GitHub OAuth state cookie: `httpOnly`, `secure` in
 * production, `SameSite=Lax` because it must survive the top-level redirect back
 * from Clerk and GitHub (`Strict` would drop it), `path=/`.
 */
export function applyDesktopAuthorizeRunCookieUpdate(
  response: NextResponse,
  update: DesktopAuthorizeRunCookieUpdate
): void {
  if (update.kind === "clear") {
    response.cookies.set(DESKTOP_AUTHORIZE_RUN_COOKIE, "", {
      maxAge: 0,
      path: "/",
    });
    return;
  }
  response.cookies.set(DESKTOP_AUTHORIZE_RUN_COOKIE, update.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: update.maxAgeSeconds,
    path: "/",
  });
}

/**
 * Whether a request should be sent back to the pending run's consent page.
 *
 * Only an unconsumed run, only for the signed-in user it is bound to (see
 * {@link claimDesktopAuthorizeRun}), and only with an ACTIVE org: with no org
 * there is nothing to consent for yet, and org creation's own return
 * (ISS-11272) already lands on the authorize page. Only a GET that is not a
 * router prefetch — client soft navigations (RSC requests) are included,
 * because that is how onboarding completion reaches the dashboard. Never the
 * authorize page itself (the loop guard), API/internal routes, or the
 * unauthenticated auth routes a run is still passing through.
 */
export function shouldBounceToDesktopAuthorizeRun(
  request: NextRequest,
  authState: DesktopAuthorizeRunAuthState,
  run: DesktopAuthorizeRun | null
): boolean {
  return (
    run !== null &&
    run.consumed !== true &&
    isDesktopAuthorizeRunBounceCandidate(request) &&
    Boolean(authState.userId && authState.orgSlug) &&
    run.userId === authState.userId
  );
}

/**
 * The auth-independent half of {@link shouldBounceToDesktopAuthorizeRun}, so
 * the proxy resolves `auth()` only for a request that could be bounced.
 */
export function isDesktopAuthorizeRunBounceCandidate(
  request: NextRequest
): boolean {
  return (
    request.method === "GET" &&
    !request.headers.has(NEXT_ROUTER_PREFETCH_HEADER) &&
    !isExemptFromDesktopAuthorizeRunBounce(request.nextUrl.pathname)
  );
}

/**
 * ISS-11127: the proxy schedules a sign-in analytics report only on a full
 * document navigation that could be bounced. Every report costs a Clerk
 * lookup, so prefetches, RSC soft navigations and API calls are excluded, and
 * the authorize page is excluded because it schedules its own report.
 */
export function isDesktopSignInAnalyticsReportRequest(
  request: NextRequest
): boolean {
  return (
    isDesktopAuthorizeRunBounceCandidate(request) &&
    request.headers.get(SEC_FETCH_DEST_HEADER) === SEC_FETCH_DEST_DOCUMENT
  );
}

/**
 * The BARE authorize path plus the run's stored query; the proxy's org-slug
 * redirect then scopes it to the session's active org.
 */
export function buildDesktopAuthorizeRunUrl(
  run: DesktopAuthorizeRun,
  requestUrl: NextRequest["nextUrl"]
): URL {
  const url = requestUrl.clone();
  url.pathname = DESKTOP_AUTHORIZE_PATHNAME;
  url.search = run.query;
  return url;
}

/**
 * The bounce back to a pending run's consent page is temporary by nature (it
 * stops once the run is consumed or expires). 307 per PLN-2118.
 */
export const DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS = 307;

/** Next's header on a `<Link>` prefetch; a prefetch is not a navigation. */
const NEXT_ROUTER_PREFETCH_HEADER = "next-router-prefetch";

/** Routes a run passes through while signed out or mid-handshake. */
const DESKTOP_AUTHORIZE_RUN_EXEMPT_ROUTES: readonly string[] = [
  SIGN_IN_PATHNAME,
  "/sign-up",
  "/sso-callback",
  "/connect",
];

const DESKTOP_AUTHORIZE_RUN_EXEMPT_PREFIXES: readonly string[] = [
  "/api/",
  "/trpc/",
  "/_next/",
];

function isExemptFromDesktopAuthorizeRunBounce(pathname: string): boolean {
  return (
    isDesktopAuthorizeRunPathname(pathname) ||
    DESKTOP_AUTHORIZE_RUN_EXEMPT_PREFIXES.some((prefix) =>
      pathname.startsWith(prefix)
    ) ||
    DESKTOP_AUTHORIZE_RUN_EXEMPT_ROUTES.some(
      (route) => pathname === route || pathname.startsWith(`${route}/`)
    )
  );
}

/**
 * The `state` an authorize query carries when it parses as a full desktop
 * authorize request (loopback-only `redirect_uri`, every required param), or
 * `null`.
 */
function parseRunQueryState(query: string): string | null {
  const parsed = parseDesktopAuthorizeParams(
    searchParamsToRecord(new URLSearchParams(query))
  );
  return parsed.ok ? parsed.params.state : null;
}

function searchParamsToRecord(
  searchParams: URLSearchParams
): Record<string, SearchParamValue> {
  const record: Record<string, SearchParamValue> = Object.create(null);
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    record[key] = values.length === 1 ? values[0] : values;
  }
  return record;
}

/**
 * Binds the pending run to the signed-in user it resumes for, so the bounce
 * never sends one account's pending desktop pairing to a different account
 * signed in later on the same browser.
 *
 * The run is often written signed out, before Clerk has decided who the user
 * is, so the first signed-in user to reach it — on the authorize page or on any
 * bounce candidate — claims it. A run another user already claimed is never
 * taken over, wherever this user is: it is left in place for its owner and is
 * not this request's run, so it is neither bounced to nor rewritten. A consumed
 * run is left alone. `issuedAt` never moves (ISS-11395).
 */
export async function claimDesktopAuthorizeRun(
  resolved: DesktopAuthorizeRunResolution,
  request: NextRequest,
  resolveUserId: () => Promise<string | null>,
  now: number
): Promise<DesktopAuthorizeRunResolution> {
  const { run } = resolved;
  if (run === null || run.consumed === true) {
    return resolved;
  }
  if (
    !(
      isDesktopAuthorizeRunPageRequest(request) ||
      isDesktopAuthorizeRunBounceCandidate(request)
    )
  ) {
    return resolved;
  }
  const userId = await resolveUserId();
  if (!userId || run.userId === userId) {
    return resolved;
  }
  if (run.userId !== undefined) {
    return { run: null, update: resolved.update };
  }
  const claimed: DesktopAuthorizeRun = { ...run, userId };
  const value = encodeDesktopAuthorizeRunCookie(claimed);
  if (value === null) {
    return { run: null, update: resolved.update };
  }
  return {
    run: claimed,
    update: {
      kind: "set",
      value,
      maxAgeSeconds: desktopAuthorizeRunRemainingMaxAgeSeconds(claimed, now),
    },
  };
}

function isDesktopAuthorizeRunPageRequest(request: NextRequest): boolean {
  return (
    request.method === "GET" &&
    isDesktopAuthorizeRunPathname(request.nextUrl.pathname)
  );
}

/**
 * What `DELETE /api/desktop/authorize-run` does to the request's cookie when
 * the consent page hands back to the desktop: a valid run is kept, marked
 * consumed, until its original ceiling (so a revisit of the same authorize URL
 * cannot re-arm it); anything else is cleared.
 */
export function consumeDesktopAuthorizeRunCookie(
  request: NextRequest,
  now: number
): DesktopAuthorizeRunCookieUpdate {
  const run = parseDesktopAuthorizeRunCookie(
    request.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)?.value,
    now
  );
  const value =
    run === null
      ? null
      : encodeDesktopAuthorizeRunCookie({ ...run, consumed: true });
  if (run === null || value === null) {
    return { kind: "clear" };
  }
  return {
    kind: "set",
    value,
    maxAgeSeconds: desktopAuthorizeRunRemainingMaxAgeSeconds(run, now),
  };
}

/** A rewrite of an existing run keeps its original ceiling, never a fresh one. */
function desktopAuthorizeRunRemainingMaxAgeSeconds(
  run: DesktopAuthorizeRun,
  now: number
): number {
  return Math.max(
    1,
    Math.ceil(
      (desktopAuthorizeRunMaxAgeMs(run.query) - (now - run.issuedAt)) / 1000
    )
  );
}

/**
 * Whether this authorize-page request may create or replace the run. A browser
 * that sends no `Sec-Fetch-Site` predates Fetch Metadata and keeps arming.
 */
function mayArmDesktopAuthorizeRun(request: NextRequest): boolean {
  const site = request.headers.get(SEC_FETCH_SITE_HEADER);
  return site === null || DESKTOP_AUTHORIZE_RUN_ARMING_FETCH_SITES.has(site);
}

const SEC_FETCH_SITE_HEADER = "sec-fetch-site";

/** The desktop's own open reports `none`; the app's own navigations `same-origin`. */
const DESKTOP_AUTHORIZE_RUN_ARMING_FETCH_SITES: ReadonlySet<string> = new Set([
  "none",
  "same-origin",
]);

const SEC_FETCH_DEST_HEADER = "sec-fetch-dest";
const SEC_FETCH_DEST_DOCUMENT = "document";

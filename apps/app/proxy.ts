import { analyticsMiddleware } from "@repo/analytics/proxy";
import { authMiddleware } from "@repo/auth/proxy";
import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import { noseconeOptions, securityMiddleware } from "@repo/security/proxy";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { env } from "./env";
import {
  RedirectStatus,
  requiresOrgSlugResolution,
  resolveRedirect,
  resolveRedirectSearchParams,
  shouldRewriteLegacyIssueUnfurl,
} from "./lib/app-route-redirects";
import {
  AUTH_BOUNCE_COOKIE,
  AUTH_BOUNCE_COOKIE_MAX_AGE_SECONDS,
  AuthBounceAction,
  type AuthBounceDecision,
  buildAuthBounceBreakUrl,
  buildStaleSessionCookieDeletions,
  isAuthBounceCandidate,
  resolveAuthBounce,
  serializeCookieDeletion,
} from "./lib/auth-bounce-guard";
import {
  buildConnectSrc,
  enforcesContentSecurityPolicy,
  shouldEnableContentSecurityPolicy,
} from "./lib/content-security-policy";
import {
  applyDesktopAuthorizeRunCookieUpdate,
  buildDesktopAuthorizeRunUrl,
  claimDesktopAuthorizeRun,
  DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS,
  type DesktopAuthorizeRun,
  isDesktopAuthorizeRunBounceCandidate,
  isDesktopSignInAnalyticsReportRequest,
  resolveDesktopAuthorizeRunCookie,
  shouldBounceToDesktopAuthorizeRun,
} from "./lib/desktop-authorize-run";
import { scheduleDesktopSignInAnalyticsReport } from "./lib/desktop-sign-in-analytics";
import { getPossibleElectronHostnames } from "./lib/engineer/electron-probe";
import { appEnvironment } from "./lib/environment";
import {
  buildGitHubConnectRedirectUrl,
  shouldDeepLinkGitHubConnect,
} from "./lib/github-connect-redirect";
import { isRootLayoutFailureValidationRequest } from "./lib/root-layout-failure-validation";
import { withoutSettingsSelfInterception } from "./lib/settings-self-interception";

const ELECTRON_HOSTNAMES = getPossibleElectronHostnames().map(
  ({ hostname }) => hostname
);

// Clerk middleware wraps other middleware in its callback
export default authMiddleware(
  async (auth, request) => {
    // ISS-11429: ahead of everything else, because a request already in the
    // bounce must not be handed to the stages that produced it. The BREAK
    // short-circuits; the COUNT only stamps the response the chain settles on,
    // so it is applied at the bottom rather than here.
    const bounce = await authBounce(auth, request);
    if (bounce?.action === AuthBounceAction.Break) {
      const breakResponse = breakAuthBounce(request, bounce);
      applySecurityHeaders(breakResponse, await securityHeaders());
      return breakResponse;
    }

    // PLN-2118: the pending desktop authorize run is resolved once per request
    // and its cookie written onto WHICHEVER response this returns — the
    // signed-out connect redirect, the org-slug redirect, or `next()` — so the
    // run survives every hop without any hop carrying it.
    const now = Date.now();
    const desktopRun = await claimDesktopAuthorizeRun(
      resolveDesktopAuthorizeRunCookie(request, now),
      request,
      async () => (await auth()).userId,
      now
    );
    if (isDesktopSignInAnalyticsReportRequest(request)) {
      scheduleDesktopSignInAnalyticsReport(desktopRun.run, auth);
    }
    const response = await handleRequest(auth, request, desktopRun.run);
    if (desktopRun.update) {
      applyDesktopAuthorizeRunCookieUpdate(response, desktopRun.update);
    }
    stampAuthBounce(request, response, bounce);
    return response;
  },
  // Clerk resolves these options PER REQUEST when they are given as a callback
  // (`clerkMiddleware`: `typeof params === "function" ? await params(req)`),
  // and builds the CSP header from the resolved object. The policy is a
  // callback rather than a literal only because `reportOnly` needs the host the
  // browser actually used — one prod build answers on both `app.closedloop.ai`
  // and its Vercel deployment alias, and only the former may enforce. Every
  // other field below is still build-time.
  (request) => ({
    contentSecurityPolicy: servesContentSecurityPolicy(request)
      ? {
          // FEA-4149: strict CSP; reports flow to the csp-report Datadog
          // intake (report-to below), which attributed the `unsafe-eval`
          // violations: zod v4's JIT object-parser codegen (a `Function("")`
          // capability probe plus `Doc.compile()`), not posthog-js. Remediated
          // at the source — `lib/zod-jitless.ts`, imported first by
          // `instrumentation-client.ts`. Deliberately NOT adding `unsafe-eval`
          // here: it would re-open string-to-code execution for the entire
          // script-src, and a `script-src` hash cannot authorize codegen —
          // only `unsafe-eval` gates `eval`/`Function`.
          strict: true,
          // ISS-8437: enforced on stage AND prod. Which deployments enforce is
          // `enforcesContentSecurityPolicy`'s call, not this call site's —
          // enforcement BLOCKS a directive gap instead of logging it, in the
          // user's browser, with nothing server-side to notice, so the
          // predicate keeps the deployment classification in one place.
          //
          // The host is read from `host` because it is the host the browser
          // addressed, which is what decides whether the origin `resolveApiOrigin` derives from it is in
          // `connect-src` at all.
          reportOnly: !(
            isRootLayoutFailureValidation(request) ||
            enforcesContentSecurityPolicy(
              env.NEXT_PUBLIC_API_URL!,
              appEnvironment,
              request.headers.get("host")?.split(":")[0] ?? ""
            )
          ),
          directives: {
            "base-uri": ["none"],
            "connect-src": buildConnectSrc({
              apiUrl: env.NEXT_PUBLIC_API_URL!,
              environment: appEnvironment,
              gaMeasurementId: env.NEXT_PUBLIC_GA_MEASUREMENT_ID,
              electronHostnames: ELECTRON_HOSTNAMES,
              // The transcripts bucket (reads) AND the attachment buckets —
              // the attachment upload is a browser fetch PUT
              // (packages/app/shared/lib/s3-upload.ts), so a bucket listed in
              // CSP_EXTRA_IMG_SRC usually belongs here too (ISS-7475).
              extraSources: env.CSP_EXTRA_CONNECT_SRC ?? [],
              realtimeUrl: env.REALTIME_PUBLIC_URL,
              docSyncUrl: env.DOC_SYNC_PUBLIC_URL,
            }),
            // `self` and `https://img.clerk.com` are Clerk's own
            // DEFAULT_DIRECTIVES values, restated so this array is the whole
            // effective `img-src`. Clerk MERGES a directive it already owns
            // (`handleExistingDirective`) but REPLACES one it does not, and
            // nothing here pins which branch is taken: `packages/auth` asks
            // for `^7.2.3` while `7.2.5` resolves, so a lockfile refresh can
            // move it with no code change in this file. Unlike `apps/web`,
            // this policy ENFORCES on prod (ISS-8437), so losing the defaults
            // would BLOCK every same-origin image and every Clerk avatar in
            // the user's browser rather than emit a report line. Restating
            // them is free today — the merge dedupes into one Set — and
            // removes the dependency on Clerk's branch.
            //
            // `connect-src` above no longer has that dependency either
            // (ISS-9123): `buildConnectSrc` states `self` in its own returned
            // array, so the app's own origin survives whichever branch Clerk
            // takes instead of riding in on its defaults plus the host it
            // `add()`s.
            "img-src": [
              "self",
              "https://img.clerk.com",
              "data:",
              // GitHub avatars rendered across Branch/PR/session surfaces.
              "https://avatars.githubusercontent.com",
              // Priority badges in rendered session markdown (ISS-7475 M2).
              "https://img.shields.io",
              // Per-environment presigned-URL hosts (the file-attachments S3
              // bucket); same env contract as connect-src above.
              ...(env.CSP_EXTRA_IMG_SRC ?? []),
            ],
          },
          reportTo: env.CSP_REPORT_URI,
        }
      : undefined,
  })
);

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    // Do not use String.raw here! Next.js can't statically analyze String.raw, so this breaks the build.
    // `health$` skips exactly `/health`, the ECS health check (ISS-11832).
    "/((?!_next|health$|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};

/**
 * Resolve every path-level redirect this app owns in ONE pass, so a request
 * that needs both a legacy document-route rewrite (`/prds/:slug` and the other
 * detail prefixes → `/documents/:slug`, ISS-12855; the FEA-4137 `/features` →
 * `/issues` list rename) and the org-slug prefix costs a single round trip
 * instead of one per rewrite.
 *
 * `auth()` stays lazy: it is only awaited once the pathname is known to name an
 * org-scoped route directory.
 */
async function routeRedirect(
  auth: ClerkMiddlewareAuth,
  request: NextRequest,
  desktopRun: DesktopAuthorizeRun | null
): Promise<NextResponse | null> {
  const pathname = request.nextUrl.pathname;

  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/trpc/") ||
    pathname.startsWith("/_next/")
  ) {
    return null;
  }

  let authStatePromise: ReturnType<ClerkMiddlewareAuth> | undefined;
  const resolveAuth = () => {
    authStatePromise ??= auth();
    return authStatePromise;
  };

  // PLN-2118 resume: while a desktop authorize run is pending, a signed-in page
  // navigation anywhere else goes back to its consent page. This is what covers
  // onboarding completion, the GitHub-connect return, and Clerk's static
  // landing with no per-hop code. The bare path it lands on is scoped to the
  // active org by the redirect below, on the next request.
  const bounce = await bounceToDesktopAuthorizeRun(
    request,
    desktopRun,
    resolveAuth
  );
  if (bounce) {
    return bounce;
  }

  // Two INDEPENDENT reasons this request may need the auth state. They are
  // evaluated separately so neither silently depends on the other's route
  // table: the connect deep link sits under `/settings/...`, which
  // `requiresOrgSlugResolution` also matches today, but nesting the check
  // inside that branch would make the flow's reachability an accident of
  // `AUTHENTICATED_ROUTE_DIRECTORIES` — dropping `settings` from that list
  // would disable the deep link with no compile-time or test signal.
  const needsOrgSlug = requiresOrgSlugResolution(pathname);
  const needsConnectDeepLink = shouldDeepLinkGitHubConnect(pathname);

  // Lazy auth: only pathnames that actually depend on it pay for it, and the
  // two reasons share ONE await rather than resolving auth twice.
  let orgSlug: string | null = null;
  if (needsOrgSlug || needsConnectDeepLink) {
    const authState = await resolveAuth();
    orgSlug = needsOrgSlug ? (authState.orgSlug ?? null) : null;

    // A SIGNED-OUT desktop authorize request goes to the GitHub-first connect
    // entry instead of the generic sign-in embed (PRD-562). The click that
    // opened this URL said "Connect to GitHub", so the page it lands on is
    // GitHub's own authorize screen rather than a provider chooser.
    //
    // Decided here rather than in the desktop build because installed desktop
    // versions are skewed: keying off the URL they already open means every
    // shipped build gets this flow without a desktop release.
    if (needsConnectDeepLink && !authState.userId) {
      // Temporary by nature: this fires only while the caller is signed OUT, so
      // the same URL must reach the app itself once they are not.
      return NextResponse.redirect(
        buildGitHubConnectRedirectUrl(request.nextUrl),
        RedirectStatus.Temporary
      );
    }
  }

  if (
    shouldRewriteLegacyIssueUnfurl(
      pathname,
      orgSlug,
      request.headers.get("user-agent")
    )
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    url.searchParams.set("redirect_url", request.nextUrl.toString());
    return NextResponse.rewrite(url);
  }

  const redirect = resolveRedirect(
    pathname,
    orgSlug,
    request.nextUrl.searchParams
  );
  if (!redirect) {
    return null;
  }

  // Clone (rather than build) the incoming URL so the query string — the
  // `?version=3` deep links the legacy-route compat window exists to preserve —
  // survives the redirect untouched.
  const url = request.nextUrl.clone();
  url.pathname = redirect.pathname;

  // ISS-5011: a retired route whose successor is one tab of a larger surface is
  // not reached by pathname alone, so overlay the query that selects it.
  //
  // `remove` runs first: the destination gives some keys precedence over the one
  // the forward sets, so leaving them on the clone silently beats the forward.
  // `/organization?github=bogus` is the case — Settings treats any nonempty
  // `github`/`google`/`linear` as an OAuth callback and forces Integrations,
  // landing the user on a tab their URL does not name (whitlockk, PR #4501).
  //
  // Then `set` (not append), so the forward's own tab wins over a stale one on
  // the incoming bookmark. Every unrelated key the clone carried — the
  // `?version=3` deep links this compat window exists for — is left untouched.
  const redirectSearchParams = resolveRedirectSearchParams(pathname, orgSlug);
  if (redirectSearchParams) {
    for (const key of redirectSearchParams.remove) {
      url.searchParams.delete(key);
    }
    for (const [key, value] of Object.entries(redirectSearchParams.set)) {
      url.searchParams.set(key, value);
    }
  }

  // ISS-4570: the status comes from the resolver, which is the only thing that
  // knows whether this redirect's target depends on the caller. A flat status
  // here made the FEA-3955 `/features` alias temporary against its own spec
  // (it now lands on `/documents/:slug` for a detail link, ISS-12855);
  // hardcoding the permanent one instead would cache a user-specific org prefix
  // in every browser that follows it.
  return NextResponse.redirect(url, redirect.status);
}

const securityHeaders = securityMiddleware(noseconeOptions);

async function handleRequest(
  auth: ClerkMiddlewareAuth,
  request: NextRequest,
  desktopRun: DesktopAuthorizeRun | null
): Promise<NextResponse> {
  const securityHeadersResponse = await securityHeaders();

  const redirectResponse = await routeRedirect(auth, request, desktopRun);
  if (redirectResponse) {
    applySecurityHeaders(redirectResponse, securityHeadersResponse);
    return redirectResponse;
  }

  const requestHeaders = withoutSettingsSelfInterception(
    request.nextUrl.pathname,
    request.headers
  );
  const response = requestHeaders
    ? NextResponse.next({ request: { headers: requestHeaders } })
    : NextResponse.next();
  const analyticsResponse = await analyticsMiddleware(response)(request);
  applySecurityHeaders(analyticsResponse, securityHeadersResponse);
  return analyticsResponse;
}

function applySecurityHeaders(
  target: NextResponse,
  securityHeadersResponse: Response
): void {
  securityHeadersResponse.headers.forEach((value, key) => {
    if (key.startsWith("x-middleware-")) {
      return;
    }

    target.headers.set(key, value);
  });
}

/**
 * The ISS-11429 bounce decision for this request.
 *
 * `auth()` is awaited only for a request that is already shaped like a bounce —
 * an auth entry path carrying a return URL — so the overwhelming majority of
 * requests pay nothing for this stage. The signed-in state is the load-bearing
 * half of the discriminator: the guard must fire for a browser presenting a
 * session the server refuses, and must stay inert for one that is simply
 * partway through a real sign-up.
 */
async function authBounce(
  auth: ClerkMiddlewareAuth,
  request: NextRequest
): Promise<AuthBounceDecision | null> {
  const { pathname, searchParams } = request.nextUrl;
  if (!isAuthBounceCandidate(pathname, searchParams)) {
    return null;
  }

  const authState = await auth();
  return resolveAuthBounce({
    bounceCookieValue: request.cookies.get(AUTH_BOUNCE_COOKIE)?.value,
    cookies: request.cookies
      .getAll()
      .map(({ name, value }) => ({ name, value })),
    isSignedIn: Boolean(authState.userId),
    pathname,
    searchParams,
  });
}

/**
 * Breaks the bounce: land on the auth entry with no return URL, and delete the
 * session cookies the server has now refused `AUTH_BOUNCE_CEILING` times.
 *
 * Both halves are needed. The loop is driven from the CLIENT — the embed
 * navigating to a session it believes in — so a redirect that only strips
 * `redirect_url` leaves that belief intact and the embed resumes against its own
 * default destination. No capability is lost: the cleared session is one every
 * server hop in this window has already declined, so the visitor is being shown
 * the sign-up form they could not reach rather than losing one they could use.
 *
 * It is a BOUND, not an end, on a production instance — see
 * `AuthBounceDecision.staleSessionCookieNames` for why the FAPI-host `__client`
 * cookie is out of this response's reach and what ending the session would
 * actually take.
 */
function breakAuthBounce(
  request: NextRequest,
  decision: Extract<
    AuthBounceDecision,
    { action: typeof AuthBounceAction.Break }
  >
): NextResponse {
  const response = NextResponse.redirect(
    buildAuthBounceBreakUrl(request.nextUrl),
    RedirectStatus.Temporary
  );
  // APPENDED headers, not `response.cookies`: that map is keyed by name alone,
  // so writing one name twice keeps only the last scope. Both are needed —
  // `cookies.delete(name)` sends a host-only, default-path expiry, which removes
  // none of the eTLD+1-scoped cookies Clerk actually sets in production, and a
  // break served on `/sign-up/sso-callback` would default to that path.
  const deletions = buildStaleSessionCookieDeletions(
    decision.staleSessionCookieNames,
    request.headers.get("host") ?? ""
  );
  for (const deletion of deletions) {
    response.headers.append("set-cookie", serializeCookieDeletion(deletion));
  }
  // The counter is deliberately LEFT STANDING. Clearing it reset the ceiling on
  // every break, so a break that failed to remove the cookies turned the bound
  // into a rate limit — three counted bounces, break, three more, forever.
  // Keeping it costs nothing: the break's own target carries no `redirect_url`,
  // so the next request is not a candidate and this stage adds no redirect of
  // its own, while the 120s expiry retires the count on its own.
  return response;
}

/** Records a tolerated bounce on whichever response the chain settled on. */
function stampAuthBounce(
  request: NextRequest,
  response: NextResponse,
  decision: AuthBounceDecision | null
): void {
  if (decision?.action !== AuthBounceAction.Count) {
    return;
  }
  response.cookies.set({
    httpOnly: true,
    maxAge: AUTH_BOUNCE_COOKIE_MAX_AGE_SECONDS,
    name: AUTH_BOUNCE_COOKIE,
    path: "/",
    sameSite: "lax",
    // Derived from the address the request arrived on, not hardcoded: a
    // `Secure` cookie is dropped over plain HTTP, which would leave the guard
    // silently inert on a local http://localhost run.
    secure: request.nextUrl.protocol === "https:",
    value: String(decision.count),
  });
}

async function bounceToDesktopAuthorizeRun(
  request: NextRequest,
  desktopRun: DesktopAuthorizeRun | null,
  resolveAuth: () => ReturnType<ClerkMiddlewareAuth>
): Promise<NextResponse | null> {
  if (!(desktopRun && isDesktopAuthorizeRunBounceCandidate(request))) {
    return null;
  }
  const authState = await resolveAuth();
  if (!shouldBounceToDesktopAuthorizeRun(request, authState, desktopRun)) {
    return null;
  }
  return NextResponse.redirect(
    buildDesktopAuthorizeRunUrl(desktopRun, request.nextUrl),
    DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS
  );
}

function servesContentSecurityPolicy(request: NextRequest): boolean {
  return (
    shouldEnableContentSecurityPolicy(env.CSP_ENABLED, env.VERCEL_ENV) ||
    isRootLayoutFailureValidation(request)
  );
}

/**
 * ISS-10078: the e2e root-layout-failure request is served under the ENFORCING
 * policy even on the one host that opens it, which otherwise serves none, so
 * the browser runs `app/global-error.tsx`'s document the way stage and prod
 * do. Never true on a deployment; the predicate says why.
 */
function isRootLayoutFailureValidation(request: NextRequest): boolean {
  return isRootLayoutFailureValidationRequest(
    env.ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED,
    request.headers
  );
}

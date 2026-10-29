import { DESKTOP_AUTHORIZE_QUERY_PARAMS } from "@repo/api/src/types/desktop-authorize-url";

/**
 * The desktop OAuth/PKCE handoff routes carry their whole request in the query
 * string, and every one of them renders under `apps/app/app/layout.tsx`, which
 * mounts `<AnalyticsProvider>`. posthog-js reads `window.location.href` when it
 * builds the default property bag, so those values ride along on every event it
 * sends — autocapture clicks, rageclicks, web vitals, heatmaps — not only the
 * `$pageview` this package captures by hand (ISS-8295).
 *
 * This module names the params whose VALUE must never leave the browser for a
 * third-party analytics processor. It is the single source for that set; the
 * `$pageview`-scoped redaction (ISS-8173) belongs to the same list.
 */

type DesktopAuthorizeParamKey = keyof typeof DESKTOP_AUTHORIZE_QUERY_PARAMS;

/**
 * The ALLOW-list, and it is deliberately the allow-list rather than its
 * complement: everything in {@link DESKTOP_AUTHORIZE_QUERY_PARAMS} is treated as
 * sensitive unless it is named here. A deny-list enumerating today's secrets
 * fails OPEN the next time a param is added to that wire contract — the new
 * value would simply not be redacted, and nothing would say so. Subtracting an
 * explicit safe set instead fails CLOSED: a new member is masked from the day it
 * exists, and the worst a missing entry costs is one un-analysable dimension.
 *
 * Typed as keys of the canonical const, so a member that is renamed or deleted
 * on the wire fails `tsc` here instead of silently exempting nothing.
 *
 * Each of these is a fixed, low-cardinality flow dimension worth keeping legible
 * in analytics: the PKCE method (`S256`), the OS the desktop app runs on, which
 * sign-in method the person picked, and whether the door was framed as sign-up
 * or sign-in. None identifies a person, a device, or a session.
 */
const ANALYTICS_SAFE_DESKTOP_AUTHORIZE_PARAMS: readonly DesktopAuthorizeParamKey[] =
  ["codeChallengeMethod", "platform", "provider", "framing"];

/**
 * The desktop pairing authorization code, read by
 * `apps/app/app/(authenticated)/[orgSlug]/settings/integrations/desktop/connect/page.tsx`.
 * That route types the param inline and there is no canonical const to import,
 * so it is spelled here — the only name in this module that is not derived.
 */
const AUTHORIZATION_CODE_PARAM = "code";

/**
 * The signed-out detour's destination param — `GITHUB_CONNECT_REDIRECT_PARAM`
 * in `apps/app/lib/github-connect-redirect.ts`, which a package cannot import
 * (root AGENTS.md: server packages never reach into `apps/app/lib/`). The two
 * spellings are pinned together by a drift test on the side that CAN see both,
 * `apps/app/lib/__tests__/analytics-redaction-drift.test.ts`.
 *
 * This is the URL a signed-out user actually lands on, and it is the reason the
 * list above is not sufficient on its own (whitlockk review). `apps/app/proxy.ts`
 * redirects an unauthenticated desktop-authorize request to
 * `/connect/github?redirect_url=<the whole authorize URL, encoded>`, so `state`
 * and `code_challenge` are no longer top-level params — they are characters
 * inside THIS param's value. posthog-js's `maskQueryParams` splits on `&`/`=`
 * and compares the top-level key only; it never unwraps a nested url, so
 * without this entry the PKCE challenge and the CSRF token ride through
 * untouched on the exact route the flow sends people to.
 *
 * Masking the whole value is the only shape the masker can express, and the
 * cost is bounded and stated: the KEY survives, so "an authenticated redirect
 * happened here" stays analysable; the destination path does not. That is the
 * same trade every other entry here makes, applied to a param whose value is a
 * whole URL.
 */
const CONNECT_REDIRECT_TARGET_PARAM = "redirect_url";

/**
 * Query-param names whose value is masked out of every URL posthog-js derives
 * from `window.location.href`.
 *
 * Values only: posthog-js replaces the value and keeps the key, the path, and
 * every other param. That is the intended trade — dropping `$current_url`
 * outright would take heatmaps and path analytics with it.
 */
export const SENSITIVE_QUERY_PARAMS: readonly string[] =
  buildSensitiveQueryParams();

/**
 * Stands in for a sensitive query-param VALUE in anything handed to a
 * third-party analytics sink. The KEY is kept: it is what tells a reader that
 * an authorize/connect handoff happened at all, and dropping the pair entirely
 * would also collapse two distinct query-only navigations into one url.
 * Desktop replay uses it for a record id in a link's route (ISS-12259).
 */
export const ANALYTICS_REDACTION_MARKER = "[redacted]";

/** {@link SENSITIVE_QUERY_PARAMS} as a lookup, built once for every consumer. */
export const SENSITIVE_QUERY_PARAM_KEYS: ReadonlySet<string> = new Set(
  SENSITIVE_QUERY_PARAMS
);

function buildSensitiveQueryParams(): readonly string[] {
  const safeKeys = new Set<string>(ANALYTICS_SAFE_DESKTOP_AUTHORIZE_PARAMS);
  const sensitive: string[] = Object.entries(DESKTOP_AUTHORIZE_QUERY_PARAMS)
    .filter(([key]) => !safeKeys.has(key))
    .map(([, wireName]) => wireName);
  sensitive.push(AUTHORIZATION_CODE_PARAM, CONNECT_REDIRECT_TARGET_PARAM);
  return sensitive;
}

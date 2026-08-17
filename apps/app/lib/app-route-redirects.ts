import {
  DocumentType,
  LEGACY_TYPE_ROUTE_PREFIXES,
  TYPE_ROUTE_PREFIX,
} from "@repo/api/src/types/document";
import { isReservedOrgSlug } from "@repo/api/src/types/reserved-slugs";
import {
  SETTINGS_INTEGRATION_CALLBACK_PARAMS,
  SettingsTab,
} from "@/app/(authenticated)/[orgSlug]/settings/settings-tabs";

/**
 * Path-level redirect decisions for the app proxy (`apps/app/proxy.ts`).
 *
 * These live in a leaf module — like the gateway guard — so the routing
 * decisions are unit-testable without standing up the Clerk middleware chain.
 * `resolveRedirect` plus `resolveRedirectSearchParams` are the whole decision:
 * the proxy calls them and does nothing else, so a test of them is a test of
 * production behavior. They are two accessors over ONE decision — both delegate
 * to `resolveRetiredListSuccessor`, so a successor can never gain a path
 * rewrite without its query, or vice versa.
 */

// The Issue route prefix and its retired `/features` alias come from the
// document contract, which owns them ("a future prefix rename only edits this
// map"). Re-declaring the strings here is exactly the drift that map exists to
// prevent. `TYPE_ROUTE_PREFIX` is Partial, so a missing entry degrades to "no
// rename" rather than a hardcoded fallback that would silently disagree with it.
const ISSUE_ROUTE_SEGMENT = TYPE_ROUTE_PREFIX[DocumentType.Feature];
const LEGACY_ISSUE_ROUTE_SEGMENTS = new Set<string>(
  LEGACY_TYPE_ROUTE_PREFIXES[DocumentType.Feature] ?? []
);

// Document routes derive from the same contract; the rest are app surfaces with
// no document type behind them.
const DOCUMENT_ROUTE_DIRECTORIES: string[] = [
  ...Object.values(TYPE_ROUTE_PREFIX),
  ...Object.values(LEGACY_TYPE_ROUTE_PREFIXES).flat(),
].filter((prefix): prefix is string => Boolean(prefix));

/**
 * Top-level directories that live under the org-scoped `/{orgSlug}/...` layout.
 * A request that names one of these as its FIRST segment is missing its org
 * prefix and gets redirected to the active org's copy of the route.
 */
const AUTHENTICATED_ROUTE_DIRECTORIES = new Set<string>([
  "my-tasks",
  "inbox",
  "loops",
  "agents",
  "judges-analytics",
  "teams",
  "build",
  "settings",
  "search",
  "users",
  "dashboard",
  "insights",
  "branches",
  // Retired (ISS-5011) but still listed: it is the SOURCE of a retired-route
  // forward below, so a bare `/organization` must still resolve the org slug in
  // order to reach its successor in one hop. `webhooks` is absent for the
  // mirror-image reason — that route was deleted outright with no successor, so
  // claiming it still lives under `/{orgSlug}/...` would be stale.
  "organization",
  "sessions",
  ...DOCUMENT_ROUTE_DIRECTORIES,
]);

// `"/a/b".split("/")` is `["", "a", "b"]`, so segment 1 is the first real one.
const FIRST_SEGMENT_INDEX = 1;
const SECOND_SEGMENT_INDEX = 2;

// ISS-4477: the retired Loops LIST route forwards to Sessions, its successor.
// The forward lives HERE in the proxy — not in the `[orgSlug]/loops/page.tsx`
// Server Component's `redirect()` — for the same reason the `/features` rename
// does (see below): a `redirect()`-only page reached via the App Router's
// soft-navigation / RSC path degrades to an in-stream client redirect that
// stalls at the original URL or trips the root error boundary ("This page
// couldn't load"), which is exactly how the e2e `loops list route redirects to
// Sessions` failed. A proxy redirect runs before any rendering, so it can't
// degrade. ONLY the bare list forwards; the still-functional sub-routes
// (`/loops/[id]`, `/loops/usage`, `/loops/monitoring`) are left untouched.
//
// ISS-5011 adds `/organization` on the same mechanism, for the same reason. That
// route was a leftover stub — a heading, the subtitle "Manage your organization
// settings", and a read-only name/slug card with nothing to manage — while
// `/settings` had long since grown a real, working Organization tab. Two routes
// claimed the same territory and the orphan one promised what it could not do,
// so the stub is gone and its URL forwards to the surface that actually owns
// org settings. The forward carries `?tab=organization` because landing on
// `/settings` alone would drop the user on the default Profile tab — i.e. it
// would still not deliver what the old URL promised.
type RetiredListRouteSuccessor = {
  segment: string;
  // Query the successor needs in order to land on the SAME subject matter the
  // retired route named. A successor that is one tab of a larger surface is not
  // reached by its pathname alone.
  //
  // The destination is free to IGNORE this query, so wiring a successor here is
  // only half the contract: `resolveInitialTab` in `settings/page.tsx` drops any
  // tab outside the caller's allowlist and silently falls back to Profile. The
  // day a successor tab goes admin-only or behind a flag, this forward quietly
  // recreates the broken promise it exists to keep, so a successor query must be
  // checked against the destination's own allowlist — which
  // `settings/__tests__/page.test.tsx` now executes for this entry rather than
  // leaving it to review.
  searchParams?: Readonly<Record<string, string>>;
  // Query keys the DESTINATION gives precedence over `searchParams` above, and
  // which must therefore be cleared off the forward. Without this, a bookmarked
  // `/organization?github=bogus` arrives at Settings carrying an integration
  // callback key, which outranks `?tab=` and lands the user on Integrations
  // while the URL still says `tab=organization` (wongk, PR #4501).
  overriddenSearchParams?: readonly string[];
};

/**
 * The whole query overlay a retired route's successor needs applied to the
 * redirect the proxy is already issuing.
 *
 * One value, not two accessors, because the two halves are one decision: a
 * successor that sets `tab` but fails to clear the keys that outrank `tab` has
 * not selected a tab at all.
 */
export type RetiredRouteSearchParamOverlay = {
  // Set (not appended), so the forward's own value beats a stale one carried by
  // the incoming bookmark.
  set: Readonly<Record<string, string>>;
  // Deleted before `set` is applied.
  remove: readonly string[];
};

// A `Map`, not an object literal: the lookup key is a raw URL segment, so a
// plain-object registry would resolve `/constructor` (or `/__proto__`) to an
// inherited property and hand back a truthy non-successor.
const RETIRED_LIST_ROUTE_SUCCESSORS = new Map<
  string,
  RetiredListRouteSuccessor
>([
  ["loops", { segment: "sessions" }],
  // `SettingsTab.Organization` rather than the literal: the tab ids are the
  // Settings page's own wire contract (`settings-tabs.ts`), and re-declaring
  // "organization" here is the drift that module exists to prevent.
  [
    "organization",
    {
      segment: "settings",
      searchParams: { tab: SettingsTab.Organization },
      overriddenSearchParams: SETTINGS_INTEGRATION_CALLBACK_PARAMS,
    },
  ],
]);

/**
 * Whether resolving this pathname needs the active org slug — i.e. whether its
 * first segment could be an org-scoped route directory rather than an org slug.
 *
 * The proxy uses this to keep `auth()` lazy: it is only awaited for pathnames
 * whose shape actually depends on the answer, matching the pre-FEA-4137
 * behavior of resolving auth after the route-directory check rather than on
 * every request.
 */
export function requiresOrgSlugResolution(pathname: string): boolean {
  const firstSegment = pathname.split("/")[FIRST_SEGMENT_INDEX];
  if (!firstSegment) {
    return false;
  }
  if (isReservedOrgSlug(firstSegment)) {
    return false;
  }
  return AUTHENTICATED_ROUTE_DIRECTORIES.has(firstSegment);
}

/**
 * The two redirect statuses this app issues, and the rule for choosing between
 * them.
 *
 * A permanent redirect is cached by the browser — often indefinitely, with no
 * way to reach the users who already hold one. It is therefore only legal on a
 * target that is a pure function of the requested URL. A URL whose target
 * depends on WHO asked resolves differently for the next caller, so caching it
 * hands one user's answer to everyone else who types that URL.
 */
export const RedirectStatus = {
  // Every caller-dependent redirect: the missing-org-prefix rewrite, the
  // empty-search forward, the retired-route forwards (`/loops`,
  // `/organization`). Also the DEFAULT — a new rewrite is temporary until
  // someone proves its target is URL-deterministic.
  Temporary: 302,
  // The FEA-3955 `/features` → `/issues` rename, which that spec called for
  // verbatim ("add a permanent `/features/*` → `/issues/*` redirect"), and only
  // on a path that already carries its org prefix.
  //
  // 308 rather than 301: 301 permits a client to rewrite the method to GET, and
  // this alias fronts a whole route subtree rather than one GET page. 308 keeps
  // the method and body intact, which is also what Next's own
  // `permanentRedirect()` and `next.config` `permanent: true` emit.
  Permanent: 308,
} as const;
export type RedirectStatus =
  (typeof RedirectStatus)[keyof typeof RedirectStatus];

export type AppRouteRedirect = {
  pathname: string;
  status: RedirectStatus;
};

/**
 * Resolve the pathname this request should be redirected to and the status to
 * redirect it with, or `null` when it is already canonical and no redirect is
 * warranted.
 *
 * The status rides along with the pathname rather than being decided by the
 * caller because only this function knows WHICH rewrites it applied, and that is
 * what the choice turns on (see {@link RedirectStatus}). The proxy issued a flat
 * 302 for every redirect before ISS-4570, which contradicted FEA-3955's spec;
 * the fix could not be a one-character edit at the `NextResponse.redirect` call
 * because the same call serves both kinds.
 *
 * Two rewrites compose here, in one pass, so a legacy link costs ONE redirect
 * rather than one per rewrite:
 *
 * 1. **FEA-4137 `/features` → `/issues`.** That change renamed the Feature
 *    artifact to Issue and moved both the list and detail routes. Legacy
 *    `/features` links — Slack unfurls, MCP-emitted URLs, PR bodies, external
 *    bookmarks — must keep resolving, so the rename is a redirect, not a
 *    removal.
 *
 *    This belongs HERE, in the proxy, and NOT in a `redirect()`-only Server
 *    Component page. That page also exported an async `generateMetadata` which
 *    awaited `headers()` plus a `fetch` for OG tags; the metadata await commits
 *    the response before the page's `redirect()` throws, so Next could no
 *    longer send a redirect status and degraded it to an in-stream client-side
 *    RSC redirect. Performing that took Next's `AppRouter` MPA branch
 *    (`location.replace()` then `throw unresolvedThenable`), truncating
 *    AppRouter's hook list mid-render — every legacy link died on React error
 *    #310 and rendered the root error boundary instead of navigating. A proxy
 *    redirect runs before any rendering, so it cannot degrade that way. Do NOT
 *    move this back into a page, and do NOT drop the alias (compat window;
 *    removal is human-approval-gated).
 *
 * 2. **Org-slug prefix.** A bare `/my-tasks` becomes `/{orgSlug}/my-tasks`.
 *
 * Rewrite 1 alone is permanent; rewrite 2 — and therefore any request that needs
 * both — is not. `/features/ISS-6` is ONE URL shared by every user and resolves
 * to each caller's own org, so a cached 308 on it would send the next org's
 * members somewhere they cannot read.
 *
 * The legacy `FEA-###` slug is deliberately NOT rewritten to its canonical
 * `ISS-###` form here, preserving the choice #3886 documented. `findBySlug`
 * matches `slug: { in: expandSlugAliases(slug) }` — set membership, not ordered
 * fallback — so both forms resolve the same row and canonicalizing the URL buys
 * nothing but costs a second redirect on `/issues/FEA-###` links that work
 * today. ISS-4405 decided to preserve that alias contract for this work.
 *
 * Two collisions make the route-directory position ambiguous, and both are
 * resolved before any rename is applied:
 *
 * - `features` is a legal ORG slug, so `/features/...` is only a legacy route
 *   when the first segment is not the caller's own org. Guessing from the
 *   segment text rewrote a document slug (`/prds/features` → `/prds/issues`)
 *   and looped an org literally named `features`.
 * - Reserved top-level routes are Clerk catch-alls (`/sign-in/[[...sign-in]]`),
 *   not org-scoped app routes, so nothing inside them is a document route —
 *   without this, `/sign-in/features` was rewritten to `/sign-in/issues` and
 *   never reached the sign-in page.
 *
 * The path is query-aware only for empty Search: the caller redirects to a
 * clone of the incoming URL, so unrelated query keys still survive untouched.
 *
 * @param orgSlug The caller's active org slug, or `null` when unresolved (no
 *   active org, or {@link requiresOrgSlugResolution} said it was not needed).
 */
export function resolveRedirect(
  pathname: string,
  orgSlug: string | null,
  searchParams?: URLSearchParams
): AppRouteRedirect | null {
  const segments = pathname.split("/");
  const firstSegment = segments[FIRST_SEGMENT_INDEX];

  if (!firstSegment || isReservedOrgSlug(firstSegment)) {
    return null;
  }

  const { firstSegmentIsRouteDirectory, routeSegmentIndex } =
    resolveRouteSegmentPosition(segments, orgSlug);

  const routeSegment = segments[routeSegmentIndex];
  if (
    routeSegment === "search" &&
    searchParams &&
    isBlankSearchValue(searchParams.get("q")) &&
    isBlankSearchValue(searchParams.get("tagId"))
  ) {
    segments[routeSegmentIndex] = "my-tasks";
  }
  let renamedLegacyIssueRoute = false;
  if (
    ISSUE_ROUTE_SEGMENT &&
    routeSegment &&
    LEGACY_ISSUE_ROUTE_SEGMENTS.has(routeSegment)
  ) {
    segments[routeSegmentIndex] = ISSUE_ROUTE_SEGMENT;
    renamedLegacyIssueRoute = true;
  }

  // ISS-4477 / ISS-5011: forward a RETIRED route (`.../loops`, `.../organization`
  // — and only the bare route, nothing after it) to its successor. Applied after
  // the org-slug position is resolved and before the `/${orgSlug}` prefix is
  // added, so a bare `/loops` and an org-scoped `/{orgSlug}/loops` both land on
  // `.../sessions` in ONE hop. Any query the successor needs rides along via
  // `resolveRedirectSearchParams`, which reads the same entry.
  const successor = resolveRetiredListSuccessor(pathname, orgSlug);
  if (successor) {
    segments[routeSegmentIndex] = successor.segment;
  }

  let targetPathname = segments.join("/");
  if (firstSegmentIsRouteDirectory && orgSlug) {
    targetPathname = `/${orgSlug}${targetPathname}`;
  }

  if (targetPathname === pathname) {
    return null;
  }

  // Keyed on `firstSegmentIsRouteDirectory` rather than "an org prefix was
  // actually added": when it is true but the org is unresolved, the SAME URL
  // lands on `/issues/...` for a signed-out caller and `/{org}/issues/...` for a
  // signed-in one. Two answers for one URL is precisely what must not be cached.
  return {
    pathname: targetPathname,
    status:
      renamedLegacyIssueRoute && !firstSegmentIsRouteDirectory
        ? RedirectStatus.Permanent
        : RedirectStatus.Temporary,
  };
}

/**
 * Whether the segment at {@link routeSegmentIndex} is the LAST meaningful one —
 * i.e. the route is a bare list with nothing after it. A trailing slash (kept
 * verbatim by `skipTrailingSlashRedirect`) splits into a trailing empty string,
 * so both an absent next segment and an empty trailing one count as bare.
 */
function isTrailingListSegment(
  segments: string[],
  routeSegmentIndex: number
): boolean {
  const nextSegment = segments[routeSegmentIndex + 1];
  return nextSegment === undefined || nextSegment === "";
}

function isBlankSearchValue(value: string | null): boolean {
  return value === null || value.trim() === "";
}

export function shouldRewriteLegacyIssueUnfurl(
  pathname: string,
  orgSlug: string | null,
  userAgent: string | null
): boolean {
  if (!userAgent?.toLowerCase().includes("slackbot")) {
    return false;
  }

  const segments = pathname.split("/");
  const firstSegment = segments[FIRST_SEGMENT_INDEX];
  if (!firstSegment || isReservedOrgSlug(firstSegment)) {
    return false;
  }

  const { routeSegmentIndex } = resolveRouteSegmentPosition(segments, orgSlug);
  const routeSegment = segments[routeSegmentIndex];

  return Boolean(routeSegment && LEGACY_ISSUE_ROUTE_SEGMENTS.has(routeSegment));
}

/**
 * The retired-route successor that applies to this pathname, or `null` when the
 * path names no retired route (or names one with something after it, which is a
 * still-live sub-route rather than the retired bare route).
 *
 * This is the ONE retired-route decision. Both `resolveRedirect` (which
 * takes the successor's segment) and `resolveRedirectSearchParams` (which takes
 * its query) read it, so a successor cannot acquire a path rewrite without its
 * query or a query without its rewrite — the drift that would land a forwarded
 * user on `/settings`'s default Profile tab while the code claimed otherwise.
 */
function resolveRetiredListSuccessor(
  pathname: string,
  orgSlug: string | null
): RetiredListRouteSuccessor | null {
  const segments = pathname.split("/");
  const firstSegment = segments[FIRST_SEGMENT_INDEX];
  if (!firstSegment || isReservedOrgSlug(firstSegment)) {
    return null;
  }

  const { routeSegmentIndex } = resolveRouteSegmentPosition(segments, orgSlug);

  const routeSegment = segments[routeSegmentIndex];
  const successor = routeSegment
    ? RETIRED_LIST_ROUTE_SUCCESSORS.get(routeSegment)
    : undefined;
  if (!(successor && isTrailingListSegment(segments, routeSegmentIndex))) {
    return null;
  }

  return successor;
}

/**
 * The query overlay the proxy must apply to the redirect it is already issuing
 * for a retired route, or `null` when the successor needs none.
 *
 * Separate from {@link resolveRedirect} because the proxy clones the
 * incoming URL — preserving the caller's own query untouched, which the legacy
 * `?version=3` deep links depend on — and then applies this overlay. Keys are
 * set, not appended, so a stale `?tab=` on an old `/organization` bookmark
 * cannot beat the tab the forward exists to select; and the destination's
 * higher-precedence keys are removed first, so a bookmarked
 * `/organization?github=bogus` cannot land on Integrations while its own URL
 * still says `tab=organization`.
 */
export function resolveRedirectSearchParams(
  pathname: string,
  orgSlug: string | null
): RetiredRouteSearchParamOverlay | null {
  const successor = resolveRetiredListSuccessor(pathname, orgSlug);
  const set = successor?.searchParams;
  const remove = successor?.overriddenSearchParams;
  if (!(set || remove)) {
    return null;
  }
  return { set: set ?? {}, remove: remove ?? [] };
}

/**
 * Whether the path is a BARE retired route source — `/organization`, `/loops`,
 * with nothing after it.
 *
 * This is the one case where the `firstSegment !== orgSlug` disambiguation used
 * everywhere else gets the wrong answer. An org may legally be slugged
 * `organization` (it is not in `RESERVED_ORG_SLUGS`), and for that org the
 * equality check reads `/organization` as its own org prefix, drops through to
 * `[orgSlug]/page.tsx`, and lands the user on `/organization/my-tasks` — so the
 * one org whose members are most likely to type the retired URL is the only one
 * the forward silently skips (wongk, PR #4501). A single segment that names a
 * retired route cannot be an org-scoped route *inside* that org anyway: there is
 * nothing after it to scope. Resolving it as the retired source instead sends
 * that org to `/organization/settings?tab=organization`, which is the surface
 * the URL asked for.
 */
function isBareRetiredRouteSource(segments: string[]): boolean {
  const firstSegment = segments[FIRST_SEGMENT_INDEX];
  return Boolean(
    firstSegment &&
      RETIRED_LIST_ROUTE_SUCCESSORS.has(firstSegment) &&
      isTrailingListSegment(segments, FIRST_SEGMENT_INDEX)
  );
}

type RouteSegmentPosition = {
  firstSegmentIsRouteDirectory: boolean;
  routeSegmentIndex: number;
};

/**
 * Where the ROUTE segment sits, and whether the first segment is a route
 * directory (a path missing its org prefix) rather than the caller's org slug.
 *
 * One helper rather than three copies: every resolver in this module has to
 * answer the same question first, and a copy that drifts — as the bare
 * retired-source case above shows — changes which URL a redirect targets.
 */
function resolveRouteSegmentPosition(
  segments: string[],
  orgSlug: string | null
): RouteSegmentPosition {
  const firstSegment = segments[FIRST_SEGMENT_INDEX];
  const firstSegmentIsRouteDirectory = Boolean(
    firstSegment &&
      AUTHENTICATED_ROUTE_DIRECTORIES.has(firstSegment) &&
      (firstSegment !== orgSlug || isBareRetiredRouteSource(segments))
  );

  return {
    firstSegmentIsRouteDirectory,
    routeSegmentIndex: firstSegmentIsRouteDirectory
      ? FIRST_SEGMENT_INDEX
      : SECOND_SEGMENT_INDEX,
  };
}

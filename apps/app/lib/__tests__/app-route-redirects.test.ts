import { describe, expect, it } from "vitest";
import {
  BASE_SETTINGS_TABS,
  SETTINGS_INTEGRATION_CALLBACK_PARAMS,
  SettingsIntegrationCallbackParam,
  SettingsTab,
} from "@/app/(authenticated)/[orgSlug]/settings/settings-tabs";
import {
  RedirectStatus,
  requiresOrgSlugResolution,
  resolveRedirect,
  resolveRedirectSearchParams,
  shouldRewriteLegacyIssueUnfurl,
} from "../app-route-redirects";

const ORG = "acme";

/**
 * The pathname half of the resolver's decision. The suites below are about WHERE
 * a request lands; the status half — WHICH redirect a browser may cache — has
 * its own suite at the bottom, and is pinned end-to-end through the proxy in
 * `__tests__/proxy-redirect-status.test.ts`.
 */
function redirectPath(
  pathname: string,
  orgSlug: string | null,
  searchParams?: URLSearchParams
): string | null {
  return resolveRedirect(pathname, orgSlug, searchParams)?.pathname ?? null;
}

describe("resolveRedirect — FEA-4137 /features → /issues compat", () => {
  it("maps an org-scoped legacy detail route", () => {
    expect(redirectPath("/acme/features/ISS-6", ORG)).toBe(
      "/acme/issues/ISS-6"
    );
  });

  it("maps a bare legacy detail route and prefixes the org in ONE hop", () => {
    expect(redirectPath("/features/ISS-6", ORG)).toBe("/acme/issues/ISS-6");
  });

  // The legacy FEA- slug is deliberately preserved (see the module docs): the
  // by-slug resolver matches on an alias SET, so rewriting it to ISS- would
  // change nothing but the URL. ISS-4405 keeps that alias contract in place.
  it("renames the route but preserves the legacy FEA- slug alias", () => {
    expect(redirectPath("/acme/features/FEA-592", ORG)).toBe(
      "/acme/issues/FEA-592"
    );
    expect(redirectPath("/features/FEA-1", ORG)).toBe("/acme/issues/FEA-1");
    expect(redirectPath("/acme/issues/FEA-1", ORG)).toBeNull();
  });

  it("maps the legacy list route, which FEA-4137 left with no page at all", () => {
    expect(redirectPath("/acme/features", ORG)).toBe("/acme/issues");
    expect(redirectPath("/features", ORG)).toBe("/acme/issues");
  });

  it("emits no redirect for an already-canonical path (fixed point)", () => {
    expect(redirectPath("/acme/issues/ISS-6", ORG)).toBeNull();
    expect(redirectPath("/acme/issues", ORG)).toBeNull();
    expect(redirectPath("/acme/my-tasks", ORG)).toBeNull();
  });

  it("still prefixes the org on non-legacy bare routes", () => {
    expect(redirectPath("/my-tasks", ORG)).toBe("/acme/my-tasks");
    expect(redirectPath("/issues/ISS-6", ORG)).toBe("/acme/issues/ISS-6");
  });

  it("leaves unrelated and non-route paths alone", () => {
    expect(redirectPath("/", ORG)).toBeNull();
    expect(redirectPath("/sign-in", ORG)).toBeNull();
    expect(redirectPath("/onboarding", ORG)).toBeNull();
  });
});

/**
 * Regressions for the two collisions a text-only "is this segment `features`?"
 * rule got wrong: `features` is BOTH a route directory and a legal org slug, so
 * the route-directory position has to be resolved against the caller's org
 * before the rename is applied.
 */
describe("resolveRedirect — `features` as a slug or an org slug", () => {
  it("does not rewrite a document slug that happens to be 'features'", () => {
    // The bug: `/prds/features` is /{routeDir}/{slug}, so segment 2 is a SLUG.
    // Rewriting it produced `/prds/issues` — a different document.
    expect(redirectPath("/prds/features", ORG)).toBe("/acme/prds/features");
    expect(redirectPath("/documents/features", ORG)).toBe(
      "/acme/documents/features"
    );
    expect(redirectPath("/acme/prds/features", ORG)).toBeNull();
  });

  it("does not loop when the caller's org slug is literally 'features'", () => {
    // The bug: segment 1 was read as the legacy route, rewriting the ORG out of
    // the path and then re-prefixing it — `/features/issues/ISS-6` became
    // `/features/issues/issues/ISS-6`, and again on every following request.
    expect(redirectPath("/features/issues/ISS-6", "features")).toBe(null);
    expect(redirectPath("/features/my-tasks", "features")).toBeNull();
  });

  it("still maps the legacy route INSIDE an org slugged 'features'", () => {
    expect(redirectPath("/features/features/ISS-6", "features")).toBe(
      "/features/issues/ISS-6"
    );
  });

  it("treats a bare legacy path as a route for every other org", () => {
    expect(redirectPath("/features/ISS-6", "features")).toBeNull();
    expect(redirectPath("/features/ISS-6", ORG)).toBe("/acme/issues/ISS-6");
  });

  it("leaves every canonical route of an org slugged 'features' alone", () => {
    expect(redirectPath("/features/settings", "features")).toBeNull();
    expect(redirectPath("/features/prds/PRD-1", "features")).toBe(null);
  });

  it("still prepends the org when the org slug is 'issues'", () => {
    // The bare path is renamed to `/issues/...` first, so an equality check
    // against the RENAMED first segment mistook it for the org prefix and
    // skipped the prepend, landing on no detail route at all.
    expect(redirectPath("/features/ISS-6", "issues")).toBe(
      "/issues/issues/ISS-6"
    );
    expect(redirectPath("/my-tasks", "issues")).toBe("/issues/my-tasks");
  });
});

/**
 * ISS-4477: the retired Loops LIST route forwards to Sessions in the proxy (a
 * `redirect()`-only page degrades under the App Router soft-nav path). Only the
 * bare list forwards; the still-functional sub-routes are left alone.
 */
describe("resolveRedirect — ISS-4477 /loops list → /sessions", () => {
  it("forwards the bare list and prefixes the org in ONE hop", () => {
    expect(redirectPath("/loops", ORG)).toBe("/acme/sessions");
  });

  it("forwards the org-scoped list", () => {
    expect(redirectPath("/acme/loops", ORG)).toBe("/acme/sessions");
  });

  // `skipTrailingSlashRedirect` is on, so `/loops/` and `/{org}/loops/` reach
  // the proxy verbatim with a trailing empty segment. Both trailing-slash forms
  // must still forward to Sessions (a bare list), or they fall through to the
  // `redirect()`-only page this proxy exists to avoid — which also drops the
  // query string. The proxy clones the incoming URL, so the trailing slash and
  // query string ride along untouched.
  it("forwards the bare list with a trailing slash (skipTrailingSlashRedirect)", () => {
    expect(redirectPath("/loops/", ORG)).toBe("/acme/sessions/");
    expect(redirectPath("/acme/loops/", ORG)).toBe("/acme/sessions/");
  });

  it("leaves the still-functional loop sub-routes alone (only prefixes the org)", () => {
    expect(redirectPath("/loops/LOOP-1", ORG)).toBe("/acme/loops/LOOP-1");
    expect(redirectPath("/acme/loops/LOOP-1", ORG)).toBeNull();
    expect(redirectPath("/acme/loops/usage", ORG)).toBeNull();
    expect(redirectPath("/acme/loops/monitoring", ORG)).toBeNull();
  });

  it("emits no redirect for the successor list itself (fixed point)", () => {
    expect(redirectPath("/acme/sessions", ORG)).toBeNull();
  });
});

/**
 * Reserved top-level routes are Clerk catch-alls, not org-scoped app routes, so
 * nothing inside them is a document route to rename.
 */
describe("resolveRedirect — reserved top-level routes", () => {
  it("never rewrites inside a Clerk catch-all", () => {
    expect(redirectPath("/sign-in/features", ORG)).toBeNull();
    expect(redirectPath("/sign-up/features", ORG)).toBeNull();
    expect(redirectPath("/sign-in/features/FEA-1", ORG)).toBeNull();
    expect(redirectPath("/onboarding/features", ORG)).toBeNull();
  });
});

describe("requiresOrgSlugResolution (keeps auth() lazy in the proxy)", () => {
  it("is true only when the first segment is an org-scoped route directory", () => {
    expect(requiresOrgSlugResolution("/issues/ISS-6")).toBe(true);
    expect(requiresOrgSlugResolution("/features/ISS-6")).toBe(true);
    expect(requiresOrgSlugResolution("/my-tasks")).toBe(true);
  });

  it("is false once the path already carries an org slug", () => {
    expect(requiresOrgSlugResolution("/acme/issues/ISS-6")).toBe(false);
  });

  // These pass on the route-directory check, not the `isReservedOrgSlug` guard:
  // no RESERVED_ORG_SLUGS entry is currently also an org-scoped route
  // directory, so that guard is unreachable defense-in-depth (retained from the
  // pre-FEA-4137 behavior rather than dropped). Asserting it here would be a
  // test that passes for the wrong reason.
  it("is false for top-level routes outside the org-scoped layout", () => {
    expect(requiresOrgSlugResolution("/sign-in")).toBe(false);
    expect(requiresOrgSlugResolution("/onboarding")).toBe(false);
    expect(requiresOrgSlugResolution("/rum-validation")).toBe(false);
    expect(requiresOrgSlugResolution("/")).toBe(false);
  });
});

describe("resolveRedirect — empty org search", () => {
  it("redirects empty search params to my tasks before the page renders", () => {
    expect(redirectPath("/acme/search", ORG, new URLSearchParams())).toBe(
      "/acme/my-tasks"
    );
    expect(redirectPath("/search", ORG, new URLSearchParams())).toBe(
      "/acme/my-tasks"
    );
    expect(
      redirectPath(
        "/acme/search",
        ORG,
        new URLSearchParams("slack_unfurl_cache_bust=1")
      )
    ).toBe("/acme/my-tasks");
    expect(redirectPath("/acme/search", ORG, new URLSearchParams("q="))).toBe(
      "/acme/my-tasks"
    );
    expect(
      redirectPath("/acme/search", ORG, new URLSearchParams("tagId="))
    ).toBe("/acme/my-tasks");
    expect(
      redirectPath("/acme/search", ORG, new URLSearchParams("q=%20&tagId=%20"))
    ).toBe("/acme/my-tasks");
  });

  it("keeps populated search routes on the search page", () => {
    expect(
      redirectPath("/acme/search", ORG, new URLSearchParams("q=feature"))
    ).toBeNull();
    expect(
      redirectPath("/acme/search", ORG, new URLSearchParams("tagId=tag_1"))
    ).toBeNull();
  });
});

/**
 * ISS-5011: `/organization` was an orphan stub — an "Organization" heading, the
 * subtitle "Manage your organization settings", and a read-only name/slug card
 * with nothing to manage — while `/settings` already owned a real Organization
 * tab. The stub is deleted and its URL forwards to that tab, on the same
 * retired-route mechanism ISS-4477 built for `/loops` → `/sessions`.
 *
 * Both halves are asserted here because either alone is a broken fix: the
 * pathname without the query drops the arriving user on the default Profile tab
 * — still not delivering what the old URL promised.
 */
describe("resolveRedirect — ISS-5011 /organization → /settings", () => {
  it("forwards the org-scoped stub to the Settings surface", () => {
    expect(redirectPath("/acme/organization", ORG)).toBe("/acme/settings");
  });

  it("forwards the bare stub and prefixes the org in ONE hop", () => {
    expect(redirectPath("/organization", ORG)).toBe("/acme/settings");
  });

  it("forwards both trailing-slash forms (skipTrailingSlashRedirect)", () => {
    expect(redirectPath("/organization/", ORG)).toBe("/acme/settings/");
    expect(redirectPath("/acme/organization/", ORG)).toBe("/acme/settings/");
  });

  it("selects the Organization TAB, not just the Settings surface", () => {
    expect(resolveRedirectSearchParams("/acme/organization", ORG)?.set).toEqual(
      {
        tab: SettingsTab.Organization,
      }
    );
    expect(resolveRedirectSearchParams("/organization", ORG)?.set).toEqual({
      tab: SettingsTab.Organization,
    });
  });

  /**
   * wongk, PR #4501: Settings gives any nonempty integration-callback key
   * precedence over `?tab=`, so a bookmarked `/organization?github=bogus` would
   * land on Integrations while its own URL still said `tab=organization`. The
   * forward has to clear the keys that outrank the tab it exists to select.
   */
  it("clears the destination's higher-precedence callback keys", () => {
    const overlay = resolveRedirectSearchParams("/acme/organization", ORG);

    expect(overlay?.remove).toEqual(SETTINGS_INTEGRATION_CALLBACK_PARAMS);
    expect(overlay?.remove).toContain(SettingsIntegrationCallbackParam.GitHub);
    expect(overlay?.remove).toContain(SettingsIntegrationCallbackParam.Google);
    expect(overlay?.remove).toContain(SettingsIntegrationCallbackParam.Linear);
  });

  /**
   * closedloop-ai-stage, PR #4501: the destination is free to IGNORE the tab the
   * forward sends. `resolveInitialTab` drops any tab outside the caller's
   * allowlist and falls back to Profile with nothing on screen saying why, so
   * the day this tab goes admin-only or behind a flag the forward silently
   * recreates the broken promise it exists to keep. This executes that coupling
   * against the base (non-admin) allowlist rather than leaving it to review;
   * `settings/__tests__/page.test.tsx` drives the same query through the real
   * destination page.
   */
  it("sends a tab the destination's base allowlist actually accepts", () => {
    const overlay = resolveRedirectSearchParams("/acme/organization", ORG);

    expect(BASE_SETTINGS_TABS).toContain(overlay?.set.tab);
  });

  it("emits no redirect for the successor itself (fixed point, no loop)", () => {
    expect(redirectPath("/acme/settings", ORG)).toBeNull();
    expect(resolveRedirectSearchParams("/acme/settings", ORG)).toBeNull();
  });

  it("asks for no query on a successor that needs none (/loops → /sessions)", () => {
    expect(resolveRedirectSearchParams("/acme/loops", ORG)).toBeNull();
    expect(resolveRedirectSearchParams("/loops", ORG)).toBeNull();
  });

  // The stub had no sub-routes, so anything after it is a genuine 404 rather
  // than a surface to forward — same rule the live `/loops/[id]` routes get.
  it("does not forward a path with something after the retired segment", () => {
    expect(redirectPath("/acme/organization/members", ORG)).toBeNull();
    expect(
      resolveRedirectSearchParams("/acme/organization/members", ORG)
    ).toBeNull();
  });

  it("does not loop when the caller's org slug is literally 'organization'", () => {
    expect(redirectPath("/organization/settings", "organization")).toBeNull();
    expect(
      resolveRedirectSearchParams("/organization/settings", "organization")
    ).toBeNull();
  });

  /**
   * wongk, PR #4501: `organization` is not a RESERVED_ORG_SLUGS entry, so an org
   * can legally be slugged `organization`. For that org the
   * `firstSegment !== orgSlug` disambiguation read the bare retired URL as its
   * own org prefix, found no second segment, and dropped through to
   * `[orgSlug]/page.tsx` — landing the one set of users most likely to type the
   * retired URL on `/organization/my-tasks` instead of the successor. The bare
   * source is now resolved before that disambiguation.
   */
  it("forwards the BARE retired route for an org slugged 'organization'", () => {
    expect(redirectPath("/organization", "organization")).toBe(
      "/organization/settings"
    );
    expect(
      resolveRedirectSearchParams("/organization", "organization")
    ).toEqual({
      set: { tab: SettingsTab.Organization },
      remove: SETTINGS_INTEGRATION_CALLBACK_PARAMS,
    });
  });

  it("forwards the bare trailing-slash form for that same org", () => {
    expect(redirectPath("/organization/", "organization")).toBe(
      "/organization/settings/"
    );
    expect(
      resolveRedirectSearchParams("/organization/", "organization")?.set
    ).toEqual({ tab: SettingsTab.Organization });
  });

  // Same collision class, different retired route: the fix belongs to the
  // registry, not to one entry, so `/loops` must behave identically for an org
  // slugged `loops`.
  it("forwards the bare /loops route for an org slugged 'loops'", () => {
    expect(redirectPath("/loops", "loops")).toBe("/loops/sessions");
  });

  // The override is scoped to the BARE source only. A live sub-route inside an
  // org with the colliding slug is still that org's own route, not a forward.
  it("leaves a sub-route inside the colliding org alone", () => {
    expect(redirectPath("/organization/my-tasks", "organization")).toBeNull();
    expect(redirectPath("/loops/LOOP-1", "loops")).toBeNull();
  });

  // The successor registry is keyed by a raw URL segment, so an inherited
  // Object property must not resolve to a truthy non-successor.
  it("treats an inherited Object key as no successor", () => {
    expect(resolveRedirectSearchParams("/acme/constructor", ORG)).toBeNull();
    expect(resolveRedirectSearchParams("/acme/__proto__", ORG)).toBeNull();
    expect(redirectPath("/acme/constructor", ORG)).toBeNull();
  });
});

/**
 * ISS-5011: `/webhooks` was next-forge boilerplate that has 404'd since the
 * initial commit — `getAppPortal()` returns undefined whenever `SVIX_TOKEN` is
 * unset, and Svix is not configured. It was deleted outright, with no successor
 * surface to forward to, so it must no longer be claimed as an org-scoped route
 * directory: leaving it listed would make a bare `/webhooks` resolve the org
 * slug and redirect to a path that has no page.
 */
describe("resolveRedirect — ISS-5011 /webhooks removal", () => {
  it("no longer treats webhooks as an org-scoped route directory", () => {
    expect(requiresOrgSlugResolution("/webhooks")).toBe(false);
    expect(redirectPath("/webhooks", ORG)).toBeNull();
  });

  it("still resolves the surviving route directories", () => {
    // Guards the assertion above against passing because the whole set broke.
    expect(requiresOrgSlugResolution("/organization")).toBe(true);
    expect(requiresOrgSlugResolution("/settings")).toBe(true);
    expect(requiresOrgSlugResolution("/sessions")).toBe(true);
  });
});

describe("shouldRewriteLegacyIssueUnfurl", () => {
  const slackbotUserAgent =
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";

  it("rewrites Slackbot legacy issue links to the metadata fallback path", () => {
    expect(
      shouldRewriteLegacyIssueUnfurl(
        "/acme/features/ISS-4405",
        ORG,
        slackbotUserAgent
      )
    ).toBe(true);
    expect(
      shouldRewriteLegacyIssueUnfurl(
        "/features/ISS-4405",
        null,
        slackbotUserAgent
      )
    ).toBe(true);
  });

  it("leaves humans and canonical issue links on the normal redirect path", () => {
    expect(
      shouldRewriteLegacyIssueUnfurl(
        "/acme/features/ISS-4405",
        ORG,
        "Mozilla/5.0"
      )
    ).toBe(false);
    expect(
      shouldRewriteLegacyIssueUnfurl(
        "/acme/issues/ISS-4405",
        ORG,
        slackbotUserAgent
      )
    ).toBe(false);
  });
});

/**
 * ISS-4570: FEA-3955 specced the `/features/*` → `/issues/*` rename as a
 * PERMANENT redirect; the proxy shipped a flat 302 for every redirect it
 * resolved, so the spec and the code disagreed.
 *
 * The status could not simply be flipped at the `NextResponse.redirect` call,
 * because one resolver serves two kinds. A permanent redirect is cached by the
 * browser — often indefinitely, and unreachable afterwards — so it is only legal
 * on a target that is a pure function of the URL. The rename of an already
 * org-scoped path is; everything else here depends on who is asking.
 */
describe("resolveRedirect — ISS-4570 permanent vs temporary status", () => {
  it("marks the org-scoped legacy rename permanent", () => {
    expect(resolveRedirect("/acme/features/ISS-6", ORG)?.status).toBe(
      RedirectStatus.Permanent
    );
    expect(resolveRedirect("/acme/features", ORG)?.status).toBe(
      RedirectStatus.Permanent
    );
    expect(
      resolveRedirect("/features/features/ISS-6", "features")?.status
    ).toBe(RedirectStatus.Permanent);
  });

  it("keeps the rename temporary when it also injects the org prefix", () => {
    // `/features/ISS-6` is ONE URL every org shares, and it resolves to the
    // caller's own org. Caching it would send the next org's members to /acme.
    expect(resolveRedirect("/features/ISS-6", ORG)?.status).toBe(
      RedirectStatus.Temporary
    );
    expect(resolveRedirect("/features", ORG)?.status).toBe(
      RedirectStatus.Temporary
    );
  });

  it("keeps that same URL temporary when no org resolves", () => {
    // The unresolved-org target differs from the resolved-org one above, which
    // is exactly what makes the URL uncacheable — so keying the decision on
    // "was a prefix actually added" would be wrong here.
    const redirect = resolveRedirect("/features/ISS-6", null);

    expect(redirect?.pathname).toBe("/issues/ISS-6");
    expect(redirect?.status).toBe(RedirectStatus.Temporary);
  });

  it("keeps every non-rename redirect temporary", () => {
    expect(resolveRedirect("/my-tasks", ORG)?.status).toBe(
      RedirectStatus.Temporary
    );
    expect(resolveRedirect("/acme/loops", ORG)?.status).toBe(
      RedirectStatus.Temporary
    );
    expect(resolveRedirect("/acme/organization", ORG)?.status).toBe(
      RedirectStatus.Temporary
    );
    expect(
      resolveRedirect("/acme/search", ORG, new URLSearchParams())?.status
    ).toBe(RedirectStatus.Temporary);
  });
});

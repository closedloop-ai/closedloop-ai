"use client";

import { useAuth, useOrganization } from "@repo/auth/client";
import { useLocalTrustedIdentity } from "@repo/auth/local-trusted-client";
import { useRouteParams } from "@repo/navigation/use-route-params";

export function useOrgSlug(): string {
  const params = useRouteParams();
  const { organization, isLoaded } = useOrganization();
  const { isSignedIn } = useAuth();
  const localTrustedIdentity = useLocalTrustedIdentity();

  const orgSlug = typeof params.orgSlug === "string" ? params.orgSlug : "";
  if (orgSlug) {
    return orgSlug;
  }

  if (organization?.slug) {
    return organization.slug;
  }

  // ISS-10335: the synthetic session's org, when there is one. Below Clerk, so
  // a real deployment is untouched — the identity is `null` there by
  // construction, resolved server-side only under `AUTH_MODE=local_trusted`.
  if (localTrustedIdentity) {
    return localTrustedIdentity.orgSlug;
  }

  // No orgSlug route param and no resolved active org. This covers two cases
  // that are indistinguishable here and both benign:
  //   1. Clerk still loading org data (pre-load window), or
  //   2. Clerk loaded but the active organization has not yet propagated —
  //      the transient state on "/" while the sidebar renders and the page
  //      client-redirects to "/{orgSlug}/dashboard".
  // Returning "" is the established "slug not yet available" contract every
  // call site already tolerates (branch above returns "" too); the real slug
  // arrives on the next render. Throwing here (FEA-2404) surfaced as a real-prod
  // RUM error and guards nothing: the (authenticated) layout already redirects
  // unauthenticated users to sign-in server-side. Keep a dev-only throw so
  // genuine misuse (calling this outside any authenticated route) is still
  // caught locally and in tests without crashing production.
  //
  // Gate the throw on isSignedIn: during sign-out the (authenticated) subtree
  // is briefly still mounted with Clerk loaded and no active org, which is a
  // benign transient — not misuse. Only a signed-in caller with no resolvable
  // org is anomalous enough to surface in dev.
  if (isLoaded && isSignedIn && process.env.NODE_ENV !== "production") {
    throw new Error(
      "No active organization — useOrgSlug must be called within an authenticated route"
    );
  }

  return "";
}

/**
 * Org slug for building nav targets from the authenticated shell, which renders
 * ABOVE the `[orgSlug]` gate.
 *
 * ISS-6567: `useOrgSlug` returns the URL's slug, and on a gated view that names
 * an org the user is not a member of. Combining it with entity ids fetched for
 * the *active* org mints hybrid cross-org URLs (`/other-org/teams/<my-org
 * team>/…`) that Next.js prefetches into the user's history.
 *
 * ISS-7344: there is no safe fallback for the window before Clerk resolves an
 * org. The URL slug is the *worst* guess there, not a neutral one — mid-switch
 * it already names the org being switched TO while the cache still holds the
 * org being switched FROM, which is precisely the hybrid URL above, minted
 * before the clearing effect runs. So this returns "" until the active org is
 * known, the same "slug not yet available" contract `useOrgSlug` already uses.
 * Callers render above the `[orgSlug]` gate and must hold their org-scoped
 * links while it is empty rather than name an org this hook cannot vouch for.
 *
 * ISS-10335 adds ONE fallback, and it does not reopen the above: the synthetic
 * session's org, which the server resolved before the document was sent. It is
 * a fact, not a guess — there is no switch to be mid-way through, because
 * `AUTH_MODE=local_trusted` has exactly one org for the process's lifetime — and
 * it is `null` on every real deployment, so the ISS-7344 window is unchanged
 * where that ticket lives.
 *
 * What that buys is CLIENT-side org path building, and only that.
 * `useOrgPathBuilder` reads this hook, and an empty answer makes it emit the
 * org-relative path UNPREFIXED: `buildOrgPath("/my-tasks")` becomes
 * `/my-tasks`, which the `[orgSlug]` route then matches with
 * `orgSlug = "my-tasks"`, and the shell comes to rest on `/my-tasks/dashboard` —
 * an org route named after a landing segment, where no org-scoped read can
 * resolve. A request that ENTERS on an unscoped URL never reaches this hook:
 * the middleware decides that redirect before React runs, and the synthetic
 * session reaches it through `packages/auth/proxy.ts` instead.
 */
export function useNavOrgSlug(): string {
  const { organization } = useOrganization();
  const localTrustedIdentity = useLocalTrustedIdentity();
  return organization?.slug ?? localTrustedIdentity?.orgSlug ?? "";
}

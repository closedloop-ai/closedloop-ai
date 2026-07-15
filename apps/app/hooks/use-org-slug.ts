"use client";

import { useAuth, useOrganization } from "@repo/auth/client";
import { useRouteParams } from "@repo/navigation/use-route-params";

export function useOrgSlug(): string {
  const params = useRouteParams();
  const { organization, isLoaded } = useOrganization();
  const { isSignedIn } = useAuth();

  const orgSlug = typeof params.orgSlug === "string" ? params.orgSlug : "";
  if (orgSlug) {
    return orgSlug;
  }

  if (organization?.slug) {
    return organization.slug;
  }

  // No orgSlug route param and no resolved active org. This covers two cases
  // that are indistinguishable here and both benign:
  //   1. Clerk still loading org data (pre-load window), or
  //   2. Clerk loaded but the active organization has not yet propagated —
  //      the transient state on "/" while the sidebar renders and the page
  //      client-redirects to "/{orgSlug}/my-tasks".
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

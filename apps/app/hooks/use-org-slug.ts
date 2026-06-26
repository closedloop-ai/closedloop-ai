"use client";

import { useOrganization } from "@repo/auth/client";
import { useRouteParams } from "@repo/navigation/use-route-params";

export function useOrgSlug(): string {
  const params = useRouteParams();
  const { organization, isLoaded } = useOrganization();

  const orgSlug = typeof params.orgSlug === "string" ? params.orgSlug : "";
  if (orgSlug) {
    return orgSlug;
  }

  if (organization?.slug) {
    return organization.slug;
  }

  // Clerk still loading org data — return empty to avoid crashing components
  // that render outside [orgSlug] routes (e.g. sidebar at "/").
  // Once Clerk loads, a re-render provides the real slug.
  if (!isLoaded) {
    return "";
  }

  throw new Error(
    "No active organization — useOrgSlug must be called within an authenticated route"
  );
}

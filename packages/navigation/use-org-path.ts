"use client";

import type { OrgPathBuilder } from "./navigation-adapter";
import { useNavigationAdapter } from "./provider";

/**
 * Returns a builder for org-scoped in-app hrefs. Replaces direct
 * `/${orgSlug}/…` string interpolation in shared/feature code so the slug —
 * a web-URL concern — stays inside the web navigation adapter rather than
 * leaking through the auth identity port.
 *
 * @example
 *   const buildOrgPath = useOrgPath();
 *   <Link href={buildOrgPath(`/users/${userId}`)}>…</Link>
 */
export function useOrgPath(): OrgPathBuilder {
  return useNavigationAdapter().useOrgPathBuilder();
}

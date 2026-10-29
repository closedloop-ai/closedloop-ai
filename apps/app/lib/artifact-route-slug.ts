import { DOCUMENT_ROUTE_PREFIX } from "@repo/api/src/types/document";

/**
 * The slug an `/{orgSlug}/documents/{slug}` detail path names, when `orgSlug`
 * is the session's active org; null for any other path — a list route, a route
 * nested under a detail page, a path with no org segment, or a link into
 * another org.
 *
 * Every document type reads its document from the browser on
 * `/documents/[slug]` (ISS-12855). A legacy per-type prefix never reaches a
 * render, because `resolveRedirect` (`apps/app/lib/app-route-redirects.ts`)
 * rewrites it to `/documents` and the proxy redirects before this component
 * exists.
 *
 * The org check matters because slugs are per-org sequences resolved in the
 * active org: before `OrgIdentityProvider` switches to the URL's org,
 * `/other-org/documents/ISS-12` would read, and join the room of, the CURRENT
 * org's ISS-12 (tamsinb PR review).
 */
export function resolveClientFetchedArtifactSlug(
  pathname: string,
  activeOrgSlug: string | null | undefined
): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 3) {
    return null;
  }
  const [orgSlug, prefix, slug] = segments;
  if (orgSlug !== activeOrgSlug) {
    return null;
  }
  if (prefix !== DOCUMENT_ROUTE_PREFIX) {
    return null;
  }
  try {
    return decodeURIComponent(slug);
  } catch {
    return null;
  }
}

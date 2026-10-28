/**
 * Re-anchor an authenticated in-app path onto a different organization slug.
 *
 * Every authenticated route is `/[orgSlug]/…`, so renaming the active
 * organization invalidates the first segment of whatever the user is looking
 * at. Swapping that segment keeps them where they were, which the legacy slug
 * editor could not do — it always sent them to `/{slug}/settings` because that
 * was the only page that owned the control.
 */
export function replaceOrgSlugSegment(
  pathname: string,
  nextOrgSlug: string
): string {
  const [, currentOrgSlug, ...rest] = pathname.split("/");

  // No org segment to swap (`/`, or an empty pathname mid-hydration). Landing
  // on the org root is the honest answer: it is a real page for the renamed
  // org, and inventing a deeper path we were never on would be a guess.
  if (!currentOrgSlug) {
    return `/${nextOrgSlug}`;
  }

  return `/${[nextOrgSlug, ...rest].join("/")}`;
}

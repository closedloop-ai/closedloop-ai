import { isPathSafeSlug } from "@repo/api/src/types/reserved-slugs";
import { buildSearchParams } from "@repo/app/shared/lib/format-utils";
import { notFound, redirect } from "next/navigation";

/**
 * FEA-3983/3970: Agent Monitoring is removed (superseded by Sessions, which now
 * owns the session list, status/harness/owner facets, and per-session detail).
 * This route is kept only as a temporary redirect so bookmarks and inbox links
 * to the old screen land on Sessions instead of 404ing. Monitoring's URL facets
 * (`status`, `harness`, `userId`) share names with the Sessions facet params, so
 * forwarding the query string preserves a filtered link's intent; params Sessions
 * does not model are ignored harmlessly.
 *
 * Temporary (307), not permanent (308): the destination is expected to remain
 * Sessions, but a 308 is aggressively cached by browsers and would be near-
 * impossible to repoint later. `orgSlug` is checked for path safety before it is
 * interpolated so an attacker-controlled encoded slug (e.g. `%2Fevil.example`)
 * cannot forge an open redirect to an off-site host. `isPathSafeSlug` is looser
 * than `orgSlugSchema` on purpose so a legacy Clerk-id-fallback slug (`org_...`)
 * still forwards instead of 404ing.
 */
export default async function MonitoringRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  if (!isPathSafeSlug(orgSlug)) {
    notFound();
  }
  // Reuse the shared filter serializer (drops undefined/null, appends every
  // value of a multi-value facet) so a filtered link survives the redirect.
  const serialized = buildSearchParams(await searchParams).toString();
  redirect(`/${orgSlug}/sessions${serialized ? `?${serialized}` : ""}`);
}
